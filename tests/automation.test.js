import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoQueue } from '../src/shared/auto-queue.js';
import { selectItems, selectableItems, nextItem } from '../src/shared/selection.js';
import { normalizeSettings } from '../src/shared/settings.js';
import { withRecognitionFallback } from '../src/shared/recognition-policy.js';
import { fetchModels } from '../src/shared/models.js';

const pages=Array.from({length:200},(_,i)=>({bvid:'BV13Q4y1C7hS',cid:100+i,page:i+1,title:`第 ${i+1} 课`,duration:60}));
const info={...pages[0],groups:{pages,season:[pages[0]]},seasonTotal:1};

test('200P selection deduplicates, preserves directory order and rejects foreign IDs',()=>{
  assert.equal(selectableItems(info).length,200);
  assert.deepEqual(selectItems(info,'selected',['BV13Q4y1C7hS:299','BV13Q4y1C7hS:100']).map(i=>i.page),[1,200]);
  assert.throws(()=>selectItems(info,'selected',['foreign:1']),/目录外/);
  assert.throws(()=>selectItems(info,'selected',[]),/请选择/);
  assert.equal(nextItem(info).page,2);
  assert.equal(nextItem({...info,...pages[199]}),null);
});

test('recognition changes formats in order and stops on auth/rate-limit/cancel',async()=>{
  const order=[];
  assert.equal(await withRecognitionFallback('whole',undefined,async mode=>{order.push(mode);if(mode!=='timed') throw new Error('timeout');return 'ok';}),'ok');
  assert.deepEqual(order,['whole','compressed','timed']);
  for(const status of [401,402,403,404,429]) {
    let calls=0;
    await assert.rejects(withRecognitionFallback('whole',undefined,async()=>{calls++;throw Object.assign(new Error('provider'),{status});}));
    assert.equal(calls,1);
  }
  const controller=new AbortController();let calls=0;
  await assert.rejects(withRecognitionFallback('whole',controller.signal,async()=>{calls++;controller.abort();throw new Error('timeout');}),{name:'AbortError'});
  assert.equal(calls,1);
});

function harness(overrides={}) {
  const memory={};let job=null;const started=[],cancelled=[];
  let settings=normalizeSettings({autoEnabled:true,followNext:true,...overrides});
  const queue=createAutoQueue({
    storage:()=>({get:async key=>structuredClone({[key]:memory[key]}),set:async value=>Object.assign(memory,structuredClone(value))}),
    getSettings:async()=>settings,getContext:async()=>info,getStatus:async()=>job,
    start:async entry=>{started.push(entry);job={id:entry.key,state:'running',automatic:true,autoKind:entry.kind};},
    cancel:async id=>{cancelled.push(id);job=null;},tabExists:async()=>true,
  });
  return {queue,started,cancelled,settings:value=>{settings={...settings,...value};},finish:()=>{job=null;},busy:()=>{job={state:'running'};}};
}

test('automatic navigation recognizes current and only next P; repeats do not duplicate',async()=>{
  const h=harness();
  await h.queue.visit('video',1,true);
  await h.queue.visit('video',1,true);
  assert.equal(h.started.length,1);assert.equal(h.started[0].item.page,1);
  h.finish();await h.queue.resume();
  assert.equal(h.started.length,2);assert.equal(h.started[1].item.page,2);
  h.finish();await h.queue.resume();await h.queue.visit('video',1,true);
  assert.equal(h.started.length,2,'must never recursively preload all 200 parts');
});

test('follow starts only during playback; switching off cancels matching automatic work',async()=>{
  const h=harness({autoEnabled:false});
  await h.queue.visit('video',1,false);assert.equal(h.started.length,0);
  await h.queue.visit('video',1,true);assert.equal(h.started[0].item.page,2);
  h.settings({followNext:false});await h.queue.settingsChanged();
  assert.equal(h.cancelled.length,1);assert.equal((await h.queue.status()).queued,0);
});

test('pending automatic work waits for manual jobs and cancellation clears queued requests',async()=>{
  const h=harness();h.busy();
  await h.queue.visit('video',1,true);assert.equal(h.started.length,0);
  assert.equal((await h.queue.status()).queued,2);
  await h.queue.stop();h.finish();await h.queue.resume();await h.queue.visit('video',1,true);
  assert.equal(h.started.length,0);
});

test('explicitly re-enabling automatic recognition allows retrying an interrupted video',async()=>{
  const h=harness({followNext:false});
  await h.queue.visit('video',1,false);
  h.settings({autoEnabled:false});await h.queue.settingsChanged();
  h.settings({autoEnabled:true});await h.queue.settingsChanged();
  await h.queue.visit('video',1,false);
  assert.equal(h.started.length,2);
});

test('model refresh queries ASR and chat separately and keeps auth at configured origin',async()=>{
  const previous=globalThis.fetch;const seen=[];
  globalThis.fetch=async(url,options)=>{seen.push(String(url));assert.equal(options.headers.Authorization,'Bearer test-only');return new Response(JSON.stringify({data:[{id:'TeleAI/TeleSpeechASR'},{id:'TeleAI/TeleSpeechASR'}]}));};
  try {
    assert.deepEqual(await fetchModels('https://api.siliconflow.cn/v1','test-only','asr'),['TeleAI/TeleSpeechASR']);
    await fetchModels('https://api.siliconflow.cn/v1','test-only','translation');
    assert.deepEqual(seen.map(url=>new URL(url).searchParams.get('sub_type')),['speech-to-text','chat']);
  } finally {globalThis.fetch=previous;}
});
