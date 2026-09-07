import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptionCues } from '../src/shared/subtitles.js';
import { transcribeBlob, transcribeChunk } from '../src/shared/providers.js';
import { processItem } from '../src/shared/pipeline.js';
import { DEFAULT_SETTINGS } from '../src/shared/settings.js';

const settings={...DEFAULT_SETTINGS,asrApiKey:'test-key',asrBaseUrl:'https://speech.test/v1',asrMode:'speech',preferNativeSubtitles:false,translateEnabled:false};
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});

test('text-only speech results remain one cue at their measured audio region, regardless of sentence lengths',()=>{
  const result=transcriptionCues({text:'<|zh|>短。后面是明显更长的一句话！'},15.25,3.5,{textTiming:'speech'});
  assert.equal(result.timing,'speech');
  assert.deepEqual(result.cues,[{start:15.25,end:18.75,source:'短。后面是明显更长的一句话！',text:'短。后面是明显更长的一句话！'}]);
  assert.deepEqual(transcriptionCues({text:'<|zh|> '},15,2,{textTiming:'speech'}),{cues:[],timing:'speech'});
});

test('valid provider timestamps take precedence over speech boundaries and stay absolute',()=>{
  const result=transcriptionCues({text:'整句',segments:[{start:0.4,end:1.1,text:'第一句'},{start:2.2,end:9,text:'第二句'}]},100,4,{textTiming:'speech'});
  assert.equal(result.timing,'precise');
  assert.deepEqual(result.cues.map(({start,end})=>[start,end]),[[100.4,101.1],[102.2,104]]);
  const invalid=transcriptionCues({text:'无效时间戳时保留完整短句。',segments:[{start:NaN,end:1,text:'错误'}]},20,3,{textTiming:'speech'});
  assert.equal(invalid.timing,'speech');
  assert.equal(invalid.cues.length,1);
  assert.equal(invalid.cues[0].start,20);
});

test('speech upload carries its timing policy through text-only and precise responses',async()=>{
  const previousFetch=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async()=>json(++calls===1?{text:'一句。又一句。'}:{segments:[{start:0.2,end:1,text:'真实时间戳'}]});
  try {
    const blob=new Blob([new Uint8Array(64)]);
    const first=await transcribeBlob(blob,'audio.wav',40,4,settings,undefined,undefined,{textTiming:'speech'});
    assert.equal(first.cues.length,1);assert.equal(first.timing,'speech');assert.equal(first.cues[0].start,40);assert.equal(first.cues[0].end,44);
    const second=await transcribeBlob(blob,'audio.wav',60,4,settings,undefined,undefined,{textTiming:'speech'});
    assert.equal(second.timing,'precise');assert.equal(second.cues[0].start,60.2);assert.equal(second.cues[0].end,61);
    assert.equal(calls,2);
  } finally {globalThis.fetch=previousFetch;}
});

test('quiet speech selected by activity detection is uploaded instead of discarded by the legacy RMS gate',async()=>{
  const previousFetch=globalThis.fetch;
  const samples=new Float32Array(16000).fill(0.0001);
  const chunk={start:0,end:samples.length,offset:123,duration:1,timing:'speech'};
  let calls=0;
  globalThis.fetch=async(_url,options)=>{
    calls++;
    const wav=new DataView(await options.body.get('file').arrayBuffer());
    assert.equal(wav.getUint32(40,true),samples.length*2);
    assert.notEqual(wav.getInt16(44,true),0);
    return json({text:'低音量人声。'});
  };
  try {
    const result=await transcribeChunk(samples,16000,chunk,settings);
    assert.equal(calls,1);assert.equal(result.timing,'speech');assert.equal(result.cues[0].start,123);
    const legacy=await transcribeChunk(samples,16000,{...chunk,timing:undefined},settings);
    assert.equal(calls,1);assert.equal(legacy.cues.length,0);
  } finally {globalThis.fetch=previousFetch;}
});

// Minimal IndexedDB transaction mock exercises the real checkpoint/track code.
function memoryDatabase() {
  const stores={tracks:new Map(),checkpoints:new Map()};
  const db={close(){},transaction(name) {
    const tx={objectStore:()=>({
      get(key) {const req={result:stores[name].get(key)};queueMicrotask(()=>tx.oncomplete?.());return req;},
      put(row) {stores[name].set(row.id,row);const req={result:row.id};queueMicrotask(()=>tx.oncomplete?.());return req;},
    })};
    return tx;
  }};
  return {db,indexedDB:{open() {const req={result:db};queueMicrotask(()=>req.onsuccess?.());return req;}}};
}

async function withPipeline(samples,operation) {
  const previous={fetch:globalThis.fetch,AudioContext:globalThis.AudioContext,indexedDB:globalThis.indexedDB};
  const database=memoryDatabase();
  const calls={uploads:0,downloads:0,decodes:0};
  const bytes=new Uint8Array(64);
  bytes.set([102,116,121,112],4);
  globalThis.indexedDB=database.indexedDB;
  globalThis.AudioContext=class {
    async decodeAudioData() {calls.decodes++;return {sampleRate:16000,duration:samples.length/16000,length:samples.length,numberOfChannels:1,getChannelData:()=>samples};}
    async close() {}
  };
  globalThis.fetch=async(url,options)=>{
    const parsed=new URL(url);
    if(parsed.pathname==='/x/web-interface/nav') return json({data:{wbi_img:{img_url:'https://i.test/'+ 'a'.repeat(32)+'.png',sub_url:'https://i.test/'+'b'.repeat(32)+'.png'}}});
    if(parsed.pathname.includes('/playurl')) return json({code:0,data:{dash:{duration:30,audio:[{baseUrl:'https://test.bilivideo.com/audio.m4s'}]}}});
    if(parsed.hostname==='test.bilivideo.com') {calls.downloads++;return new Response(bytes);}
    if(parsed.hostname==='speech.test') {
      calls.uploads++;
      if(calls.uploads===calls.failUpload) return new Response('{}',{status:401});
      const wav=new DataView(await options.body.get('file').arrayBuffer());
      assert.ok(wav.getUint32(40,true)/2/16000<=6.01);
      return json({text:'短。较长的第二句话。'});
    }
    throw new Error('Unexpected test URL: '+url);
  };
  try {await operation(calls);}
  finally {
    database.db.onversionchange?.();
    Object.assign(globalThis,previous);
  }
}

test('speech pipeline preserves long pauses without stretching to metadata duration and reuses completed cache',async()=>{
  const rate=16000,samples=new Float32Array(rate*13);
  for(const [start,end] of [[2,3],[10,11]]) for(let i=start*rate;i<end*rate;i++) samples[i]=0.1*Math.sin(i*2*Math.PI*220/rate);
  await withPipeline(samples,async calls=>{
    const item={bvid:'BV1test00000',cid:1,title:'mock speech',duration:30};
    const {track}=await processItem(item,settings,true,undefined,()=>{});
    assert.equal(track.mode,'speech');assert.equal(track.timing,'speech');assert.equal(calls.uploads,2);
    assert.equal(track.cues.length,2);
    assert.ok(track.cues[0].start>=1.8 && track.cues[0].start<=2.1);
    assert.ok(track.cues[0].end>=2.9 && track.cues[0].end<=3.2);
    assert.ok(track.cues[1].start>=9.8 && track.cues[1].start<=10.1);
    assert.ok(track.cues[1].end>=10.9 && track.cues[1].end<=11.2);
    const cached=await processItem(item,settings,false,undefined,()=>{});
    assert.equal(cached.status,'cached');assert.equal(calls.uploads,2);assert.equal(calls.downloads,1);
  });
});

test('silent speech input reports no speech without uploading or falling back to estimated modes',async()=>{
  await withPipeline(new Float32Array(16000*5),async calls=>{
    await assert.rejects(processItem({bvid:'BV1test00000',cid:2,title:'silence',duration:5},settings,true,undefined,()=>{}),/未检测到.*语音/);
    assert.equal(calls.uploads,0);assert.equal(calls.decodes,1);
  });
});

test('speech retry restores already recognized regions after a later upload fails',async()=>{
  const rate=16000,samples=new Float32Array(rate*13);
  for(const [start,end] of [[2,3],[10,11]]) for(let i=start*rate;i<end*rate;i++) samples[i]=0.1*Math.sin(i*2*Math.PI*220/rate);
  await withPipeline(samples,async calls=>{
    const item={bvid:'BV1test00000',cid:3,title:'resume speech',duration:13};
    const sequential={...settings,asrConcurrency:1};
    calls.failUpload=2;
    await assert.rejects(processItem(item,sequential,false,undefined,()=>{}),/401/);
    assert.equal(calls.uploads,2);
    const {track}=await processItem(item,sequential,false,undefined,()=>{});
    assert.equal(calls.uploads,3);assert.equal(track.requestCount,1);
    assert.equal(track.cues.length,2);assert.equal(track.timing,'speech');
  });
});
