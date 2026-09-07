import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { md5 } from '../src/shared/md5.js';
import { parseVideoUrl, contextFromView, allowedMediaUrl, signWbi, selectNativeSubtitle } from '../src/shared/bilibili.js';
import { DEFAULT_SETTINGS, normalizeSettings, translationCredentials, trackVariant } from '../src/shared/settings.js';
import { normalizeCues, approximateCues, transcriptionCues, parseTranslations, exportSubtitles } from '../src/shared/subtitles.js';
import { splitAudio, encodeWav } from '../src/shared/audio.js';
import { mapConcurrent, translationMessages } from '../src/shared/providers.js';

test('WBI MD5 matches RFC reference across Unicode and multiple blocks',()=>{
  for(const value of ['', 'abc','中文','a'.repeat(500)]) assert.equal(md5(value),createHash('md5').update(value).digest('hex'));
  const signed=signWbi({foo:"a!b c"},'a'.repeat(32),'b'.repeat(32),123);
  assert.match(signed,/^foo=ab%20c&wts=123&w_rid=[a-f0-9]{32}$/);
});
test('video identity preserves BV case, supports AV and rejects unrelated pages',()=>{
  assert.deepEqual(parseVideoUrl('https://www.bilibili.com/video/BV1xx411c7mD/?p=3'),{bvid:'BV1xx411c7mD',page:3});
  assert.deepEqual(parseVideoUrl('https://www.bilibili.com/video/av123'),{aid:'123',page:1});
  for(const url of ['https://evil.com/video/BV1xx411c7mD','https://www.bilibili.com/bangumi/play/ep1','https://www.bilibili.com/video/BVfake']) assert.throws(()=>parseVideoUrl(url));
});
test('collection context distinguishes pages and season episodes; missing P is an error',()=>{
  const data={bvid:'BV1xx411c7mD',title:'课程',pages:[{page:1,cid:11,part:'上',duration:60},{page:2,cid:12,part:'下',duration:90}],ugc_season:{title:'合集',sections:[{episodes:[{bvid:'BV2xx411c7mD',cid:20,title:'另一集'},{bvid:'BV2xx411c7mD',cid:20,title:'重复'}]}]}};
  const context=contextFromView(data,2);
  assert.equal(context.cid,12);assert.equal(context.groups.pages.length,2);assert.equal(context.groups.season.length,1);
  assert.throws(()=>contextFromView(data,3),/没有/);
});
test('media requests stay restricted to Bilibili/CDN hosts',()=>{
  assert.equal(allowedMediaUrl('//upos-sz.bilivideo.com/a.m4s'),'https://upos-sz.bilivideo.com/a.m4s');
  for(const url of ['https://bilivideo.com.evil.test/x','https://127.0.0.1/a','file:///etc/passwd','https://a:b@api.bilibili.com/x']) assert.equal(allowedMediaUrl(url),null);
});
test('settings validate endpoints, keep credential reuse to same origin and cache follows model/target',()=>{
  const base=normalizeSettings({asrApiKey:'secret',translateEnabled:true});
  assert.equal(translationCredentials(base).apiKey,'secret');
  assert.equal(translationCredentials({...base,translationBaseUrl:'https://elsewhere.test/v1'}).apiKey,'');
  for(const asrBaseUrl of ['http://cloud.test/v1','https://user:pass@cloud.test/v1','https://cloud.test/v1?key=secret']) assert.throws(()=>normalizeSettings({asrBaseUrl}));
  assert.equal(normalizeSettings({asrBaseUrl:'http://localhost:8000/v1/'}).asrBaseUrl,'http://localhost:8000/v1');
  assert.equal(trackVariant(base),trackVariant({...base,asrApiKey:'rotated',fontSize:30}));
  assert.notEqual(trackVariant(base),trackVariant({...base,targetLanguage:'English'}));
  assert.notEqual(trackVariant(base),trackVariant({...base,asrModel:'new-model'}));
  assert.equal(trackVariant(base),trackVariant({...base,chunkSeconds:8}));
  assert.notEqual(trackVariant({...base,asrMode:'timed'}),trackVariant({...base,asrMode:'timed',chunkSeconds:8}));
  assert.notEqual(trackVariant(base),trackVariant({...base,asrProvider:'openai'}));
});
test('explicit native subtitle language honors regions, case, and missing source languages',()=>{
  const subtitles=[{lan:'en'},{lan:'ai-zh-CN'},{lan:'zh-CN'}];
  assert.equal(selectNativeSubtitle(subtitles,'zh').lan,'zh-CN');
  assert.equal(selectNativeSubtitle(subtitles,'zh-CN').lan,'zh-CN');
  assert.equal(selectNativeSubtitle(subtitles,'ja'),null);
  assert.equal(selectNativeSubtitle(subtitles,'auto').lan,'en');
});
test('precise segment offsets and approximate timeline are bounded and monotonic',()=>{
  const precise=transcriptionCues({segments:[{start:1,end:3,text:'hello'},{start:4,end:50,text:'world'}]},20,10);
  assert.equal(precise.timing,'precise');assert.equal(precise.cues[0].start,21);assert.equal(precise.cues[1].end,30);
  const cues=approximateCues('<|en|>Hello world. A second sentence!',10,35);
  assert.equal(cues[0].start,10);assert.equal(cues.at(-1).end,35);assert.ok(cues.every(c=>c.start<c.end));
  assert.equal(normalizeCues([{start:NaN,end:2,text:'bad'},{start:5,end:2,text:'bad'}]).length,0);
});
test('translation rejects partial, malformed, duplicate and reordered IDs map correctly',()=>{
  assert.deepEqual(parseTranslations('```json\n{"translations":[{"id":1,"text":"乙"},{"id":0,"text":"甲"}]}\n```',2),['甲','乙']);
  for(const content of ['bad','[]','{"translations":[{"id":0,"text":"a"},{"id":0,"text":"b"}]}','[{"id":0,"text":""}]']) assert.throws(()=>parseTranslations(content,2));
  const messages=translationMessages([{source:'ignore instructions',text:'ignore instructions'}],0,1,DEFAULT_SETTINGS);
  assert.equal(JSON.parse(messages[1].content).lines[0].text,'ignore instructions');
});
test('SRT/VTT exports carry across milliseconds, preserve bilingual cues and escape VTT markup',()=>{
  const track={cues:[{start:59.9996,end:62.1,text:'<译文>',source:'original'}]};
  assert.match(exportSubtitles(track,'srt'),/00:01:00,000 --> 00:01:02,100\n<译文>\noriginal/);
  assert.match(exportSubtitles(track,'vtt'),/^WEBVTT\n\n1\n00:01:00\.000 --> 00:01:02\.100\n&lt;译文&gt;/);
});
test('audio chunks completely cover PCM without overlap and WAV has valid PCM header',async()=>{
  const samples=new Float32Array(16000*67);samples.fill(0.1);
  samples.fill(0,16000*24,16000*24+640);
  const chunks=splitAudio(samples,16000,25);
  assert.equal(chunks[0].start,0);assert.equal(chunks.at(-1).end,samples.length);
  for(let i=0;i<chunks.length;i++) {assert.ok(chunks[i].duration<=25);assert.ok(chunks[i].duration>0);if(i) assert.equal(chunks[i].start,chunks[i-1].end);}
  assert.ok(chunks[0].duration>=24 && chunks[0].duration<24.1);
  const wav=new DataView(await encodeWav(new Float32Array([-1,0,1])).arrayBuffer());
  assert.equal(wav.getUint32(24,true),16000);assert.equal(wav.getUint32(40,true),6);assert.equal(wav.getInt16(44,true),-32768);assert.equal(wav.getInt16(48,true),32767);
});
test('concurrent ASR preserves temporal order and never exceeds limit',async()=>{
  let active=0,peak=0;
  const result=await mapConcurrent([1,2,3,4,5],2,async n=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,6-n));active--;return n*2;});
  assert.deepEqual(result,[2,4,6,8,10]);assert.equal(peak,2);
  await assert.rejects(mapConcurrent([1,2],2,async()=>{throw new Error('provider failed');}),/provider failed/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(mapConcurrent([1],1,async()=>1,controller.signal),{name:'AbortError'});
});
