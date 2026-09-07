import test from 'node:test';
import assert from 'node:assert/strict';

test('cancel during asynchronous status commit cannot dispatch a billable job',async()=>{
  const oldChrome=globalThis.chrome;
  const oldFetch=globalThis.fetch;
  const store={settings:{asrApiKey:'test-only'}};
  const sent=[];
  let listener,offscreenExists=false,releaseCommit,commitStarted;
  const committed=new Promise(resolve=>{commitStarted=resolve;});
  const commitGate=new Promise(resolve=>{releaseCommit=resolve;});
  const id='test-extension';
  const noop=async()=>{};
  globalThis.chrome={
    runtime:{id,getURL:file=>`chrome-extension://${id}/${file}`,onMessage:{addListener:fn=>{listener=fn;}},onInstalled:{addListener(){}},onStartup:{addListener(){}},
      getContexts:async()=>offscreenExists?[{contextType:'OFFSCREEN_DOCUMENT'}]:[],
      sendMessage:async message=>{sent.push(message);return {ok:true,data:null};}},
    storage:{local:{get:async key=>({[key]:store[key]}),set:async values=>{
      Object.assign(store,structuredClone(values));
      if(values.job?.state==='running') {commitStarted();await commitGate;}
    },setAccessLevel:noop}},
    permissions:{contains:async()=>true},declarativeNetRequest:{updateDynamicRules:noop},
    action:{setBadgeText:noop,setBadgeBackgroundColor:noop},
    offscreen:{createDocument:async()=>{offscreenExists=true;}},
    tabs:{query:async()=>[],sendMessage:noop},
  };
  globalThis.fetch=async()=>new Response(JSON.stringify({code:0,data:{bvid:'BV1xx411c7mD',title:'Test',pages:[{page:1,cid:11,duration:18}]}}),{headers:{'Content-Type':'application/json'}});
  const dispatch=message=>new Promise(resolve=>listener(message,{id,url:`chrome-extension://${id}/popup.html`},resolve));
  try {
    await import('../src/background.js?cancel-regression');
    const started=dispatch({type:'START_JOB',url:'https://www.bilibili.com/video/BV1xx411c7mD',scope:'current'});
    await committed;
    assert.equal((await dispatch({type:'CANCEL_JOB'})).ok,true);
    releaseCommit();
    const result=await started;
    assert.equal(result.ok,true);
    assert.equal(result.data.state,'cancelled');
    assert.equal(store.job.state,'cancelled');
    assert.equal(sent.some(message=>message.type==='OFFSCREEN_START'),false);
    assert.ok(sent.find(message=>message.type==='OFFSCREEN_CANCEL').jobId);
  } finally {releaseCommit();globalThis.chrome=oldChrome;globalThis.fetch=oldFetch;}
});
