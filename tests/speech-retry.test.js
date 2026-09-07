import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeBlob } from '../src/shared/providers.js';
import { DEFAULT_SETTINGS } from '../src/shared/settings.js';

const settings={...DEFAULT_SETTINGS,asrApiKey:'test-key',asrBaseUrl:'https://speech.test/v1'};
const transcribe=(signal,options={textTiming:'speech'})=>transcribeBlob(new Blob(['audio']),'audio.wav',20,4,settings,signal,undefined,options);

async function withXHR(responses,operation,{onWait}={}) {
  const previousXHR=globalThis.XMLHttpRequest,previousTimeout=globalThis.setTimeout;
  const calls=[],waits=[];
  globalThis.XMLHttpRequest=class {
    constructor() {this.upload={};}
    open() {}
    setRequestHeader() {}
    getResponseHeader(name) {return name==='Retry-After'?this.response.retryAfter || null:null;}
    abort() {this.onabort?.();}
    send(body) {
      this.response=responses[Math.min(calls.length,responses.length-1)];
      calls.push(body);
      queueMicrotask(()=>{
        this.upload.onload?.();
        if(this.response.error==='network') {this.onerror();return;}
        if(this.response.error==='timeout') {this.ontimeout();return;}
        this.status=this.response.status || 200;
        this.responseText=JSON.stringify(this.response.body || {text:'识别成功。'});
        this.onload();
      });
    }
  };
  globalThis.setTimeout=(callback,milliseconds,...args)=>{
    waits.push(milliseconds);
    const timer=previousTimeout(callback,0,...args);
    queueMicrotask(()=>onWait?.());
    return timer;
  };
  try {await operation({calls,waits});}
  finally {globalThis.XMLHttpRequest=previousXHR;globalThis.setTimeout=previousTimeout;}
}

test('speech retries an explicit temporary failure twice with one-second then two-second backoff',async()=>{
  await withXHR([{status:429},{status:502},{status:200}],async({calls,waits})=>{
    const result=await transcribe();
    assert.equal(calls.length,3);assert.deepEqual(waits,[1000,2000]);
    assert.equal(result.timing,'speech');assert.equal(result.cues[0].start,20);
    assert.equal(calls[0],calls[1]);assert.equal(calls[1],calls[2]);
  });
});

test('speech caps retries at two and propagates the final temporary HTTP error',async()=>{
  for(const status of [429,502,503,504]) {
    await withXHR([{status}],async({calls,waits})=>{
      await assert.rejects(transcribe(),error=>error.status===status);
      assert.equal(calls.length,3);assert.deepEqual(waits,[1000,2000]);
    });
  }
});

test('speech honors Retry-After and does not retry earlier than a long server cooldown',async()=>{
  await withXHR([{status:503,retryAfter:'5'},{status:200}],async({calls,waits})=>{
    await transcribe();assert.equal(calls.length,2);assert.deepEqual(waits,[5000]);
  });
  await withXHR([{status:429,retryAfter:'120'}],async({calls,waits})=>{
    await assert.rejects(transcribe(),error=>error.status===429);
    assert.equal(calls.length,1);assert.deepEqual(waits,[]);
  });
});

test('speech Retry-After HTTP dates also postpone the next upload',async()=>{
  await withXHR([{status:503,retryAfter:new Date(Date.now()+10000).toUTCString()},{status:200}],async({calls,waits})=>{
    await transcribe();assert.equal(calls.length,2);assert.equal(waits.length,1);
    assert.ok(waits[0]>8000 && waits[0]<=10000);
  });
});

test('speech authentication, billing, unsupported HTTP, network and timeout failures are not retried',async()=>{
  for(const response of [{status:400},{status:401},{status:402},{status:403},{status:404},{status:413},{status:500},{error:'network'},{error:'timeout'}]) {
    await withXHR([response],async({calls,waits})=>{
      await assert.rejects(transcribe());assert.equal(calls.length,1);assert.deepEqual(waits,[]);
    });
  }
});

test('legacy upload mode keeps its existing no-retry behavior',async()=>{
  await withXHR([{status:503}],async({calls,waits})=>{
    await assert.rejects(transcribe(undefined,{}),error=>error.status===503);
    assert.equal(calls.length,1);assert.deepEqual(waits,[]);
  });
});

test('cancellation interrupts speech backoff before another upload is sent',async()=>{
  const controller=new AbortController();
  await withXHR([{status:429},{status:200}],async({calls,waits})=>{
    await assert.rejects(transcribe(controller.signal),{name:'AbortError'});
    assert.equal(calls.length,1);assert.deepEqual(waits,[1000]);
  },{onWait:()=>controller.abort()});
});
