import test from 'node:test';
import assert from 'node:assert/strict';
import { rankAudioSources } from '../src/shared/bilibili.js';
import { requestJSON } from '../src/shared/network.js';
import { transcribeBlob, translateCues } from '../src/shared/providers.js';
import { normalizeSettings, recognitionVariant, trackVariant } from '../src/shared/settings.js';
import { downloadAudio } from '../src/shared/audio.js';
import { canUploadWhole, uploadByteLimit } from '../src/shared/pipeline.js';

test('traditional returned CDN URLs rank before peer endpoints without rewriting signatures',()=>{
  const urls=rankAudioSources([{bandwidth:64000,codecs:'mp4a.40.2',baseUrl:'https://peer.mcdn.bilivideo.cn/a?sign=keep',backupUrl:['https://upos.bilivideo.com/a?sign=keep']},{bandwidth:128000,codecs:'mp4a.40.2',baseUrl:'https://other.bilivideo.com/b'}]);
  assert.deepEqual(urls.map(s=>new URL(s.url).hostname),['upos.bilivideo.com','other.bilivideo.com','peer.mcdn.bilivideo.cn']);
  assert.equal(new URL(urls[0].url).searchParams.get('sign'),'keep');
});
test('old settings migrate to whole mode; recognition survives translation and timeout changes',()=>{
  const settings=normalizeSettings({asrApiKey:'secret',translateEnabled:true});
  assert.equal(settings.asrMode,'whole');assert.equal(settings.asrTimeoutSeconds,600);
  const changed=normalizeSettings({...settings,targetLanguage:'English',translationModel:'other',asrTimeoutSeconds:900});
  assert.equal(recognitionVariant(settings),recognitionVariant(changed));
  assert.equal(recognitionVariant(settings),recognitionVariant({...settings,chunkSeconds:8,compressedChunkSeconds:60}));
  assert.notEqual(trackVariant(settings),trackVariant(changed));
  assert.equal(normalizeSettings({collectionLimit:200}).collectionLimit,200);
});
test('whole upload sends the unmodified original compressed bytes once',async()=>{
  const originalFetch=globalThis.fetch;
  const settings=normalizeSettings({asrApiKey:'test-key'});
  const bytes=new Uint8Array([0,0,0,20,102,116,121,112,105,115,111,53,9,8,7,6,5,4,3,2]);
  let calls=0;
  globalThis.fetch=async(url,options)=>{
    calls++;assert.match(url,/audio\/transcriptions$/);
    const file=options.body.get('file');assert.equal(file.name,'audio.m4a');assert.equal(file.type,'audio/mp4');
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()),bytes);
    return new Response(JSON.stringify({text:'The complete transcript.'}),{headers:{'Content-Type':'application/json'}});
  };
  try {
    const result=await transcribeBlob(new Blob([bytes],{type:'audio/mp4'}),'audio.m4a',0,704,settings);
    assert.equal(calls,1);assert.equal(result.cues.at(-1).end,704);
  } finally {globalThis.fetch=originalFetch;}
});
test('timeouts identify the actual service, endpoint and configured wait',async()=>{
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));
  try {
    await assert.rejects(requestJSON('https://example.test/v1/chat/completions',{}, {timeout:20,retries:0,label:'字幕翻译'}),error=>error.code==='TIMEOUT' && /字幕翻译.*example.test\/v1\/chat\/completions/.test(error.message));
  } finally {globalThis.fetch=originalFetch;}
});
test('translation timeout shrinks the batch and retains valid mappings',async()=>{
  const originalFetch=globalThis.fetch;
  const seen=[];
  let first=true;
  globalThis.fetch=async(_url,options)=>{
    const body=JSON.parse(options.body);
    const lines=JSON.parse(body.messages[1].content).lines;
    seen.push(lines.length);
    if(first) {first=false;return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));}
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:lines.map(row=>({id:row.id,text:'译'+row.text}))})}}]}));
  };
  try {
    const result=await translateCues([0,1,2,3].map(i=>({start:i,end:i+1,source:String(i),text:String(i)})),{...normalizeSettings({asrApiKey:'test'}),translationTimeoutSeconds:0.02,translationBatchSize:4});
    assert.deepEqual(seen,[4,2,2]);assert.deepEqual(result.map(r=>r.text),['译0','译1','译2','译3']);
  } finally {globalThis.fetch=originalFetch;}
});
test('stalled audio connection falls over to next CDN within configured deadline',async()=>{
  const originalFetch=globalThis.fetch;
  let calls=0;
  globalThis.fetch=(_url,{signal})=>{
    calls++;
    if(calls===1) return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));
    return Promise.resolve(new Response(new Uint8Array(128),{headers:{'Content-Length':'128'}}));
  };
  try {
    const bytes=await downloadAudio(['https://one.bilivideo.com/a','https://two.bilivideo.com/a'],1000,undefined,()=>{},{connectTimeout:20,stallTimeout:20,totalTimeout:1000});
    assert.equal(bytes.byteLength,128);assert.equal(calls,2);
  } finally {globalThis.fetch=originalFetch;}
});
test('translation checkpoints avoid duplicate billed requests after a later batch fails',async()=>{
  const originalFetch=globalThis.fetch;
  const cache=new Map(), seen=[];
  let fail=true;
  globalThis.fetch=async(_url,options)=>{
    const body=JSON.parse(options.body),lines=JSON.parse(body.messages[1].content).lines;
    seen.push(lines[0].text);
    if(fail && lines[0].text==='2') return new Response('{}',{status:401});
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:lines.map(row=>({id:row.id,text:'译'+row.text}))})}}]}));
  };
  const checkpoint={get:async key=>cache.get(key),put:async(key,value)=>cache.set(key,value)};
  const cues=[0,1,2,3].map(i=>({start:i,end:i+1,source:String(i),text:String(i)}));
  const settings=normalizeSettings({asrApiKey:'test',translationBatchSize:2});
  try {
    await assert.rejects(translateCues(cues,settings,undefined,()=>{},checkpoint),/401/);
    assert.ok(cache.size>=1);
    fail=false;
    const result=await translateCues(cues,settings,undefined,()=>{},checkpoint);
    assert.deepEqual(seen,['0','2','2']);assert.equal(result[3].text,'译3');
  } finally {globalThis.fetch=originalFetch;}
});
test('whole-upload and compressed caps are conservative for the selected request format',()=>{
  const compatible=normalizeSettings({asrProvider:'openai'});
  assert.equal(uploadByteLimit(compatible),24_000_000);
  assert.equal(canUploadWhole(30_000_000,700,compatible),false);
  assert.equal(canUploadWhole(30_000_000,700,normalizeSettings()),true);
});
test('adaptive batch checkpoints resume per cue even when a new run starts with larger batches',async()=>{
  const originalFetch=globalThis.fetch;
  const cache=new Map(),seen=[];
  let phase='first';
  globalThis.fetch=async(_url,options)=>{
    const rows=JSON.parse(JSON.parse(options.body).messages[1].content).lines;
    seen.push(rows.map(r=>r.text).join(','));
    if(phase==='first' && rows.length===4) return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));
    if(phase==='first' && rows[0].text==='2') return new Response('{}',{status:401});
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({translations:rows.map(r=>({id:r.id,text:'译'+r.text}))})}}]}));
  };
  const checkpoint={get:async key=>cache.get(key),put:async(key,value)=>cache.set(key,value)};
  const cues=[0,1,2,3].map(i=>({source:String(i),text:String(i),start:i,end:i+1}));
  const settings={...normalizeSettings({translationBatchSize:4}),translationTimeoutSeconds:0.02};
  try {
    await assert.rejects(translateCues(cues,settings,undefined,()=>{},checkpoint),/401/);
    phase='retry';
    const result=await translateCues(cues,settings,undefined,()=>{},checkpoint);
    assert.deepEqual(seen,['0,1,2,3','0,1','2,3','2,3']);
    assert.equal(result[0].text,'译0');
  } finally {globalThis.fetch=originalFetch;}
});
