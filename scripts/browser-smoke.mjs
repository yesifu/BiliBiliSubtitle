import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodeWav } from '../src/shared/audio.js';

const root=path.resolve(import.meta.dirname,'..');
const playwright=process.env.BILI_PLAYWRIGHT_PATH ? await import(pathToFileURL(process.env.BILI_PLAYWRIGHT_PATH).href) : await import('playwright');
const executablePath=process.env.BILI_BROWSER_PATH || undefined;
const artifacts=path.join(root,'.browser-test');
await mkdir(artifacts,{recursive:true});
const profile=await mkdtemp(path.join(artifacts,'profile-'));
const context=await playwright.chromium.launchPersistentContext(profile,{
  headless:true,executablePath,channel:executablePath?undefined:'chromium',viewport:{width:1200,height:900},
  args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`,'--no-first-run','--disable-gpu'],
});
try {
  const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker',{timeout:20000}).catch(error=>{
    throw new Error('The isolated test browser did not start the unpacked extension. Use an installed extension-capable Chromium build through BILI_BROWSER_PATH; no existing Chrome profile is needed.',{cause:error});
  });
  const id=new URL(worker.url()).host;
  const errors=[];
  context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  const options=await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.waitForSelector('input[type="password"]');
  await options.waitForFunction(()=>!document.querySelector('#settings-fields').disabled);
  await options.screenshot({path:path.join(artifacts,'options.png'),fullPage:true});
  assert.equal(await options.locator('input[type="password"]').count(),2);
  assert.equal(await options.locator('#translateEnabled').isChecked(),false);
  assert.equal(await options.locator('#translation-settings').isVisible(),false);
  assert.equal(await options.locator('#processing').count(),0);
  assert.equal(await options.locator('#asr-model-select option').count(),4);
  assert.equal(await options.locator('#asr-model-select').inputValue(),'Qwen/Qwen3-ASR-1.7B');
  assert.equal(await options.locator('#asr-model-select option').first().getAttribute('value'),'Qwen/Qwen3-ASR-1.7B');
  assert.equal(await options.locator('#asrModel').inputValue(),'Qwen/Qwen3-ASR-1.7B');
  assert.match(await options.locator('#asr-mode-timing').textContent(),/对应音频片段/);
  assert.doesNotMatch(await options.locator('#asr-mode-timing').textContent(),/SenseVoice/);
  assert.equal(await options.locator('#register-siliconflow').getAttribute('href'),'https://cloud.siliconflow.cn/i/cW7ksWMh');
  assert.equal(await options.locator('#subtitles').getAttribute('open'),null);
  await options.setViewportSize({width:390,height:844});
  assert.equal(await options.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await options.screenshot({path:path.join(artifacts,'options-narrow.png'),fullPage:true});
  await options.setViewportSize({width:1200,height:900});
  await options.locator('input[name="asrProvider"][value="openai"]').check();
  assert.equal(await options.locator('#asr-model-select').inputValue(),'whisper-1');
  await options.locator('input[name="asrProvider"][value="siliconflow"]').check();
  assert.equal(await options.locator('#asr-model-select').inputValue(),'Qwen/Qwen3-ASR-1.7B');
  assert.equal(await options.locator('#asrBaseUrl').inputValue(),'https://api.siliconflow.cn/v1');
  await options.locator('#translateEnabled').check();
  await options.locator('#translation-model-select').waitFor({state:'visible'});
  await options.locator('#targetLanguage').fill('English');
  await options.locator('#translateEnabled').uncheck();
  assert.equal(await options.locator('#translation-settings').isVisible(),false);
  await options.locator('#translateEnabled').check();
  assert.equal(await options.locator('#targetLanguage').inputValue(),'English');
  await options.locator('#targetLanguage').fill('简体中文');
  await options.locator('#subtitles > summary').click();
  await options.screenshot({path:path.join(artifacts,'options-translation.png'),fullPage:true});
  await options.locator('#translationBaseUrl').fill('');
  await options.locator('#translation-model-select').selectOption('__custom__');
  await options.locator('#translationModel').fill('');
  await options.locator('#translateEnabled').uncheck();
  await options.locator('#subtitles > summary').click();
  await options.locator('#asrApiKey').fill('test-key-only');
  assert.equal(await options.locator('#asrMode').inputValue(),'speech');
  await options.locator('#preferNativeSubtitles').uncheck();
  await options.locator('#subtitles > summary').click();
  await options.locator('#fontSize').fill('2');
  await options.locator('#subtitles > summary').click();
  await options.locator('#save-settings').click();
  await options.locator('#fontSize-error').waitFor({state:'visible'});
  assert.equal(await options.locator('#fontSize').evaluate(el=>el===document.activeElement),true);
  await options.locator('#fontSize').fill('22');
  await options.locator('#backgroundTransparency').evaluate(el=>{el.value='80';el.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.equal(await options.locator('#backgroundTransparency-value').textContent(),'80%');
  assert.equal(await options.locator('#preview-original').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(12, 13, 16, 0.2)');
  await options.setViewportSize({width:390,height:844});
  assert.equal(await options.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await options.screenshot({path:path.join(artifacts,'options-transparency-narrow.png'),fullPage:true});
  await options.setViewportSize({width:1200,height:900});
  await options.locator('#save-settings').click();
  await options.waitForFunction(()=>document.querySelector('#save-status').dataset.tone==='success');
  assert.equal(await worker.evaluate(async()=> (await chrome.storage.local.get('settings')).settings.asrApiKey),'test-key-only');
  assert.equal(await worker.evaluate(async()=> (await chrome.storage.local.get('settings')).settings.asrModel),'Qwen/Qwen3-ASR-1.7B');
  assert.equal(await worker.evaluate(async()=> (await chrome.storage.local.get('settings')).settings.asrModelPreferenceVersion),1);
  assert.equal(await worker.evaluate(async()=> (await chrome.storage.local.get('settings')).settings.backgroundTransparency),80);
  assert.equal(await worker.evaluate(async()=> (await chrome.storage.local.get('settings')).settings.translationModel),'Qwen/Qwen2.5-7B-Instruct');
  await options.route('**/v1/models?*',async route=>{
    assert.equal(route.request().headers().authorization,'Bearer test-key-only');
    assert.equal(new URL(route.request().url()).searchParams.get('sub_type'),'speech-to-text');
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:[
      {id:'FunAudioLLM/SenseVoiceSmall'},{id:'Qwen/Qwen3-ASR-1.7B'},
      {id:'XingChenAGI/XingChenASR-Diarize-V3.0'},{id:'XingChenAGI/XingChenASR-V3.2'},
      {id:'XingChenAGI/XingChenASR-V3.2-Ultra'},{id:'XingChenAGI/XingChenGSR-V1.0'},
    ]})});
  });
  await options.locator('#refresh-asr-models').click();
  await options.waitForFunction(()=>document.querySelector('#asr-models-status').textContent.includes('6 个'));
  assert.equal(await options.locator('#asr-model-select option').count(),7);
  assert.equal(await options.locator('#asr-model-select').inputValue(),'Qwen/Qwen3-ASR-1.7B');
  assert.equal(await options.locator('#asrModel').inputValue(),'Qwen/Qwen3-ASR-1.7B');
  await options.screenshot({path:path.join(artifacts,'options-qwen-models.png'),fullPage:true});
  await options.unroute('**/v1/models?*');
  console.log('Compact settings, responsive layout, translation disclosure and validation of collapsed fields verified.');
  await worker.evaluate(()=>chrome.storage.local.remove('settings'));
  const rules=await worker.evaluate(()=>chrome.declarativeNetRequest.getDynamicRules());
  assert.equal(rules.length,1);
  console.log('Extension installed, service worker active, options rendered, DNR rule loaded.');
  let popup=await context.newPage();
  await popup.setViewportSize({width:400,height:790});
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.locator('#context-empty').waitFor({state:'visible'});
  await popup.screenshot({path:path.join(artifacts,'popup-empty.png'),fullPage:true});
  const stats=await popup.evaluate(()=>chrome.runtime.sendMessage({type:'CACHE_STATS'}));
  assert.equal(stats.ok,true);
  await options.evaluate(async()=>{const {saveSettings}=await import('./src/shared/settings.js');await saveSettings({translateEnabled:true});});
  const missing=await popup.evaluate(()=>chrome.runtime.sendMessage({type:'START_JOB',url:'https://www.bilibili.com/video/BV1xx411c7mD',scope:'current'}));
  assert.equal(missing.ok,false);assert.match(missing.error,/Key/);
  const offscreen=await worker.evaluate(async()=>{
    await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['BLOBS'],justification:'Verify audio pipeline initialization.'});
    return chrome.runtime.sendMessage({target:'offscreen',type:'OFFSCREEN_STATUS'});
  });
  assert.equal(offscreen.ok,true);
  await worker.evaluate(()=>chrome.offscreen.closeDocument());
  console.log('Popup empty state, missing-key validation, IndexedDB and offscreen document verified.');

  // Real extension contexts and IndexedDB, deterministic Bilibili/provider fixtures.
  // No user keys and no billed provider calls are used in this test.
  const bvid='BV1xx411c7mD';
  const videoUrl=`https://www.bilibili.com/video/${bvid}/`;
  const samples=new Float32Array(16000*18);
  for(let i=0;i<samples.length;i++) samples[i]=Math.sin(i*2*Math.PI*440/16000)*0.2;
  const wav=Buffer.from(await encodeWav(samples).arrayBuffer());
  const speechSamples=new Float32Array(16000*18);
  for(const [start,end] of [[4,5.4],[15,16.3]]) {
    for(let i=Math.round(start*16000);i<Math.round(end*16000);i++) speechSamples[i]=Math.sin(i*2*Math.PI*440/16000)*0.2;
  }
  const speechWav=Buffer.from(await encodeWav(speechSamples).arrayBuffer());
  let fixtureAudio=wav;
  let asrCalls=0,translationCalls=0,cancelMode=false,asrInFlight=0,translationFailure=false,translationDelay=0;
  let nativeAvailable=true,rejectAsrCount=0,allowSecondAudio=false;
  let speechFixture=false;
  const speechTexts=['First speech. Entire segment.','Later speech. Kept at fifteen.'];
  const apiHeaders={ 'Content-Type':'application/json','Access-Control-Allow-Origin':'*' };
  const fulfill=(route,body)=>route.fulfill({status:200,headers:apiHeaders,body:JSON.stringify(body)});
  const fixtureView={code:0,data:{bvid,title:'测试课程 · 理解声音',pic:'',pages:[{page:1,cid:11,part:'第一课',duration:18},{page:2,cid:12,part:'无音轨',duration:18}],ugc_season:{title:'测试合集',ep_count:2,sections:[{episodes:[{bvid,cid:11,title:'第一课'},{bvid:'BV2xx411c7mD',cid:22,title:'第二课'}]}]}}};
  const mockRoute=async route=>{
    const url=new URL(route.request().url());
    if(url.hostname==='www.bilibili.com') return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:'<!doctype html><html><head><meta charset="utf-8"><title>测试视频</title></head><body style="margin:0;background:#eee7dc"><main style="width:960px;margin:50px auto"><h1>理解声音 · 字幕集成测试</h1><div class="bpx-player-container" style="position:relative;width:960px;height:540px;background:linear-gradient(135deg,#243c35,#596456)"><video style="width:100%;height:100%" controls></video></div></main></body></html>'});
    if(url.hostname==='api.bilibili.com') {
      if(url.pathname.endsWith('/view')) return fulfill(route,fixtureView);
      if(url.pathname.endsWith('/nav')) return fulfill(route,{code:0,data:{wbi_img:{img_url:'https://i0.hdslb.com/bfs/wbi/'+'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/bfs/wbi/'+'b'.repeat(32)+'.png'}}});
      if(url.pathname.endsWith('/playurl')) return fulfill(route,{code:0,data:{dash:{duration:18,audio:url.searchParams.get('cid')==='12'&&!allowSecondAudio?[]:[{bandwidth:32000,baseUrl:'https://test.bilivideo.com/audio.wav'}]}}});
      if(url.pathname.endsWith('/v2')) return fulfill(route,{code:0,data:{subtitle:{subtitles:nativeAvailable?[{lan:'en',lan_doc:'English',subtitle_url:'https://test.hdslb.com/native.json'}]:[]}}});
      return route.fulfill({status:404,body:'Unmocked API'});
    }
    if(url.hostname==='test.bilivideo.com') return route.fulfill({status:200,contentType:fixtureAudio===wav||fixtureAudio===speechWav?'audio/wav':'audio/mp4',body:fixtureAudio});
    if(url.hostname==='test.hdslb.com') return fulfill(route,{body:[{from:1,to:4,content:'Native caption.'}]});
    if(url.hostname==='api.siliconflow.cn') {
      assert.equal(route.request().headers().authorization,'Bearer test-key-only');
      if(url.pathname.endsWith('/transcriptions')) {
        asrCalls++;asrInFlight++;
        try {
          if(rejectAsrCount>0) {rejectAsrCount--;return route.fulfill({status:415,headers:apiHeaders,body:'{}'});}
          if(cancelMode) await new Promise(resolve=>setTimeout(resolve,1500));
          if(speechFixture) return await fulfill(route,{text:speechTexts[asrCalls-1]});
          return await fulfill(route,{text:'Hello world. This is the complete lesson.'});
        } finally {asrInFlight--;}
      }
      if(url.pathname.endsWith('/completions')) {
        assert.equal(asrInFlight,0,'translation must wait until every ASR request is finished');
        translationCalls++;
        if(translationDelay) await new Promise(resolve=>setTimeout(resolve,translationDelay));
        if(translationFailure) return route.fulfill({status:401,headers:apiHeaders,body:'{"error":"test translation failure"}'});
        const body=route.request().postDataJSON();
        const lines=JSON.parse(body.messages[1].content).lines;
        return fulfill(route,{choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:lines.map(line=>({id:line.id,text:'完整识别后的中文字幕。'}))})}}]});
      }
    }
    return route.continue();
  };
  await context.route('**/*',mockRoute);
  // Route worker fetches using the browser's network stack as well as page fetches.
  await options.evaluate(async()=>{
    const {saveSettings}=await import('./src/shared/settings.js');
    await saveSettings({asrApiKey:'test-key-only',translateEnabled:true,asrMode:'timed',preferNativeSubtitles:false,chunkSeconds:8,translationBatchSize:2});
  });
  const videoPage=await context.newPage();
  await videoPage.goto(videoUrl);
  await videoPage.locator('#bst-ai-subtitle-host').waitFor();
  const info=await popup.evaluate(url=>chrome.runtime.sendMessage({type:'GET_VIDEO_CONTEXT',url}),videoUrl);
  assert.equal(info.ok,true,info.error);assert.equal(info.data.groups.pages.length,2);assert.equal(info.data.groups.season.length,2);
  await worker.evaluate(()=>chrome.offscreen.createDocument({url:'offscreen.html',reasons:['BLOBS'],justification:'Exercise real background audio execution with deterministic test responses.'}));
  const browserCDP=await context.browser().newBrowserCDPSession();
  const targets=await browserCDP.send('Target.getTargets');
  const target=targets.targetInfos.find(t=>t.url===`chrome-extension://${id}/offscreen.html`);
  assert.ok(target);
  const {sessionId}=await browserCDP.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});
  let commandId=0;
  const commands=new Map();
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{
    const messageId=++commandId;
    const timer=setTimeout(()=>reject(new Error('CDP timeout: '+method)),10000);
    commands.set(messageId,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    browserCDP.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:messageId,method,params})}).catch(reject);
  });
  browserCDP.on('Target.receivedMessageFromTarget',event=>{
    if(event.sessionId!==sessionId) return;
    const message=JSON.parse(event.message);
    if(message.id) {
      const pending=commands.get(message.id);commands.delete(message.id);
      if(message.error) pending?.reject(new Error(message.error.message));else pending?.resolve(message.result);
    } else if(message.method==='Fetch.requestPaused') {
      const {requestId,request}=message.params;
      const adapter={
        request:()=>({url:()=>request.url,headers:()=>Object.fromEntries(Object.entries(request.headers).map(([k,v])=>[k.toLowerCase(),v])),postDataJSON:()=>JSON.parse(request.postData)}),
        continue:()=>cdp('Fetch.continueRequest',{requestId}),
        fulfill:({status=200,headers={},contentType,body=''})=>cdp('Fetch.fulfillRequest',{requestId,responseCode:status,responseHeaders:Object.entries({...headers,...(contentType?{'Content-Type':contentType}:{})}).map(([name,value])=>({name,value})),body:Buffer.from(body).toString('base64')}),
      };
      void mockRoute(adapter).catch(error=>{if(!/Invalid InterceptionId|Invalid interceptionId|Session closed|Target closed/.test(error.message)) errors.push(error.message);});
    }
  });
  await cdp('Fetch.enable',{patterns:[{urlPattern:'https://*',requestStage:'Request'}]});
  const run=async(scope='current',force=false)=>{
    const response=await popup.evaluate(args=>chrome.runtime.sendMessage(args),{type:'START_JOB',url:videoUrl,scope,force});
    assert.equal(response.ok,true,response.error);
    return response.data;
  };
  const waitState=async(predicate)=>{
    const end=Date.now()+25000;
    let status;
    while(Date.now()<end) {
      status=(await popup.evaluate(()=>chrome.runtime.sendMessage({type:'GET_STATUS'}))).data;
      if(status && predicate(status)) return status;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw new Error('Task did not reach expected state: '+JSON.stringify(status));
  };
  const waitJob=()=>waitState(status=>status.state!=='running');
  // Exercise the actual offscreen AudioContext and multipart uploads. Only the
  // remote ASR response is mocked; decode, segmentation, IndexedDB and the
  // content-script player's seek events run in their real extension contexts.
  await cdp('Runtime.evaluate',{expression:`(() => {
    globalThis.speechSmoke = {decodes: [], uploads: []};
    const decode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = function (...args) {
      return decode.apply(this, args).then(audio => {
        speechSmoke.decodes.push({sampleRate: audio.sampleRate, length: audio.length, duration: audio.duration});
        return audio;
      });
    };
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      const file = body instanceof FormData ? body.get('file') : null;
      if (file instanceof Blob) speechSmoke.uploads.push(file.arrayBuffer().then(bytes => {
        const view = new DataView(bytes);
        return {size: bytes.byteLength, format: view.getUint16(20, true), sampleRate: view.getUint32(24, true), dataBytes: view.getUint32(40, true)};
      }));
      return send.call(this, body);
    };
    speechSmoke.restore = () => {
      AudioContext.prototype.decodeAudioData = decode;
      XMLHttpRequest.prototype.send = send;
    };
  })()`});
  fixtureAudio=speechWav;speechFixture=true;
  await options.evaluate(async()=>{
    const {saveSettings}=await import('./src/shared/settings.js');
    await saveSettings({asrApiKey:'test-key-only',translateEnabled:false,asrMode:'speech',asrConcurrency:1,preferNativeSubtitles:false});
  });
  await run();
  const speechJob=await waitJob();
  assert.equal(speechJob.state,'completed',JSON.stringify(speechJob));
  const speechTrack=(await popup.evaluate(bvid=>chrome.runtime.sendMessage({type:'GET_TRACK',bvid,cid:11}),bvid)).data;
  assert.equal(speechTrack.timing,'speech');assert.equal(speechTrack.mode,'speech');
  assert.equal(speechTrack.cues.length,2,'punctuation must not invent timings inside a text-only speech segment');
  assert.equal(speechTrack.requestCount,2);assert.equal(speechTrack.partCount,2);
  assert.equal(asrCalls,2);assert.equal(translationCalls,0);
  assert.deepEqual(speechTrack.cues.map(cue=>cue.text),speechTexts);
  assert.ok(speechTrack.cues[0].start>=3.8 && speechTrack.cues[0].start<=4);
  assert.ok(speechTrack.cues[0].end>=5.4 && speechTrack.cues[0].end<=5.6);
  assert.ok(speechTrack.cues[1].start>=14.8 && speechTrack.cues[1].start<=15,'long pauses must retain the original absolute offset');
  assert.ok(speechTrack.cues[1].end>=16.3 && speechTrack.cues[1].end<=16.5);
  const observed=(await cdp('Runtime.evaluate',{expression:'(async () => ({decodes: speechSmoke.decodes, uploads: await Promise.all(speechSmoke.uploads)}))()',awaitPromise:true,returnByValue:true})).result.value;
  await cdp('Runtime.evaluate',{expression:'speechSmoke.restore()'});
  assert.deepEqual(observed.decodes,[{sampleRate:16000,length:18*16000,duration:18}]);
  assert.equal(observed.uploads.length,2);
  for(const [i,upload] of observed.uploads.entries()) {
    assert.equal(upload.format,1);assert.equal(upload.sampleRate,16000);
    assert.equal(upload.size,44+upload.dataBytes);
    const seconds=upload.dataBytes/(2*upload.sampleRate);
    assert.ok(seconds>0 && seconds<=6);
    assert.ok(Math.abs(seconds-(speechTrack.cues[i].end-speechTrack.cues[i].start))<1/16000);
  }
  const loadSpeechMedia=()=>videoPage.evaluate(async data=>{
    const video=document.querySelector('video');
    video.src=URL.createObjectURL(new Blob([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],{type:'audio/wav'}));
    await new Promise(resolve=>video.addEventListener('loadedmetadata',resolve,{once:true}));
    video.pause();
  },speechWav.toString('base64'));
  const speechSeek=async(seconds,expected)=>{
    await videoPage.evaluate(seconds=>new Promise(resolve=>{
      const video=document.querySelector('video');
      video.addEventListener('seeked',resolve,{once:true});video.currentTime=seconds;
    }),seconds);
    assert.equal(await videoPage.locator('.translation').textContent(),expected);
    assert.equal(await videoPage.locator('.captions').isVisible(),Boolean(expected));
  };
  await videoPage.waitForFunction(()=>document.querySelector('#bst-ai-subtitle-host')?.shadowRoot.querySelector('.toggle-status')?.textContent==='语音分段');
  await loadSpeechMedia();
  await speechSeek(15.4,speechTexts[1]);await speechSeek(4.3,speechTexts[0]);await speechSeek(8,'');
  await videoPage.evaluate(()=>document.querySelector('video').playbackRate=2);
  await speechSeek(15.8,speechTexts[1]);await speechSeek(2,'');await speechSeek(16.7,'');
  await run();
  assert.equal((await waitJob()).results[0].status,'cached');assert.equal(asrCalls,2);
  await videoPage.reload();
  await videoPage.waitForFunction(()=>document.querySelector('#bst-ai-subtitle-host')?.shadowRoot.querySelector('.toggle-status')?.textContent==='语音分段');
  await loadSpeechMedia();await speechSeek(15.4,speechTexts[1]);
  assert.equal(asrCalls,2,'reloading a speech track must reuse the cached captions');
  await videoPage.screenshot({path:path.join(artifacts,'player-speech-seek.png')});
  console.log('Speech mode: real AudioContext decode, two bounded WAV uploads, absolute offsets across long silence, whole-segment text, cache, paused/2x seek, gap clearing and speech badge verified.');
  await options.evaluate(()=>chrome.runtime.sendMessage({type:'CLEAR_CACHE'}));
  fixtureAudio=wav;speechFixture=false;asrCalls=0;translationCalls=0;
  await options.evaluate(async()=>{
    const {saveSettings}=await import('./src/shared/settings.js');
    await saveSettings({asrApiKey:'test-key-only',translateEnabled:true,asrMode:'timed',preferNativeSubtitles:false,chunkSeconds:8,translationBatchSize:2});
  });
  await run('pages');
  const job=await waitJob();
  assert.equal(job.state,'completed',JSON.stringify(job));assert.equal(job.results[0].status,'completed');assert.equal(job.results[1].status,'failed');
  assert.equal(asrCalls,3);assert.equal(translationCalls,3);
  const track=(await popup.evaluate(bvid=>chrome.runtime.sendMessage({type:'GET_TRACK',bvid,cid:11}),bvid)).data;
  assert.equal(track.cues.length,6);assert.equal(track.timing,'approximate');
  assert.equal(track.settings.bilingual,true);assert.equal(track.asrApiKey,undefined);
  await videoPage.evaluate(async data=>{
    const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));
    const video=document.querySelector('video');
    video.src=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));
    await new Promise(resolve=>video.addEventListener('loadedmetadata',resolve,{once:true}));
    video.currentTime=1;
  },wav.toString('base64'));
  await videoPage.locator('#bst-ai-subtitle-host .translation').waitFor({state:'visible'});
  assert.match(await videoPage.locator('#bst-ai-subtitle-host .translation').textContent(),/中文字幕/);
  assert.equal(await videoPage.locator('.toggle-status').textContent(),'估算时间轴');
  await videoPage.screenshot({path:path.join(artifacts,'player-subtitles.png')});
  // Display changes must persist independently of subtitle availability and recognition cache.
  const displaySettings=(await popup.evaluate(()=>chrome.runtime.sendMessage({type:'GET_DISPLAY_SETTINGS'}))).data;
  assert.deepEqual(displaySettings,{backgroundTransparency:24});
  const savedBeforeDisplay=await worker.evaluate(async()=> (await chrome.storage.local.get('settings')).settings);
  await videoPage.getByRole('button',{name:'字幕显示设置',exact:true}).click();
  const transparencySlider=videoPage.getByRole('slider',{name:'背景透明度',exact:true});
  await transparencySlider.focus();
  await transparencySlider.press('End');
  assert.equal(await videoPage.locator('.caption-line.translation').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(12, 13, 16, 0)');
  assert.equal(await videoPage.locator('.caption-line.source').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(12, 13, 16, 0)');
  assert.equal(await videoPage.locator('.captions').evaluate(el=>getComputedStyle(el).opacity),'1');
  assert.equal(await videoPage.locator('.caption-line.translation').evaluate(el=>getComputedStyle(el).opacity),'1');
  await options.waitForFunction(()=>document.querySelector('#backgroundTransparency').value==='100');
  await transparencySlider.press('Home');
  await options.waitForFunction(()=>document.querySelector('#backgroundTransparency').value==='0');
  assert.equal(await videoPage.locator('.caption-line.translation').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(12, 13, 16)');
  const otherVideo=await context.newPage();
  await otherVideo.goto(videoUrl+'?p=2');
  await otherVideo.waitForFunction(()=>document.querySelector('#bst-ai-subtitle-host')?.shadowRoot.querySelector('input[type="range"]')?.value==='0');
  assert.equal(await otherVideo.locator('.captions').isVisible(),false);
  await options.evaluate(async()=>{
    const {loadSettings,saveSettings}=await import('./src/shared/settings.js');
    await saveSettings({...await loadSettings(),backgroundTransparency:80});
  });
  for(const page of [videoPage,otherVideo]) await page.waitForFunction(()=>document.querySelector('#bst-ai-subtitle-host')?.shadowRoot.querySelector('input[type="range"]')?.value==='80');
  await otherVideo.close();
  await videoPage.reload();
  await videoPage.waitForFunction(()=>document.querySelector('#bst-ai-subtitle-host')?.shadowRoot.querySelector('input[type="range"]')?.value==='80');
  await videoPage.evaluate(async data=>{
    const video=document.querySelector('video');
    video.src=URL.createObjectURL(new Blob([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],{type:'audio/wav'}));
    await new Promise(resolve=>video.addEventListener('loadedmetadata',resolve,{once:true}));
    video.currentTime=1;
  },wav.toString('base64'));
  await videoPage.locator('.caption-line.translation').waitFor({state:'visible'});
  await videoPage.getByRole('button',{name:'字幕显示设置',exact:true}).click();
  assert.equal(await videoPage.locator('.caption-line.translation').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(12, 13, 16, 0.2)');
  await videoPage.screenshot({path:path.join(artifacts,'player-transparency.png')});
  await videoPage.getByRole('button',{name:'恢复显示默认值',exact:true}).click();
  await options.waitForFunction(()=>document.querySelector('#backgroundTransparency').value==='24');
  assert.deepEqual(await worker.evaluate(async()=> (await chrome.storage.local.get('settings')).settings),savedBeforeDisplay);
  assert.equal(asrCalls,3);assert.equal(translationCalls,3);
  console.log('Subtitle transparency: live background only, keyboard endpoints, options save/sync, reload, uncached video and reset verified without ASR or translation requests.');
  const timelineFixture={bvid,cid:11,title:'Timeline regression',targetLanguage:'简体中文',timing:'precise',cues:[
    {start:1,end:3,text:'第一句',source:'First'},
    {start:6,end:9,text:'第二句',source:'Second'},
    {start:6.5,end:7.5,text:'重叠句',source:'Overlap'},
    {start:12,end:16,text:'最后一句',source:'Last'},
  ]};
  const replaceTrack=async value=>{
    await options.evaluate(async value=>{
      const {putTrack}=await import('./src/shared/cache.js');
      const {loadSettings}=await import('./src/shared/settings.js');
      await putTrack(value,await loadSettings());
    },value);
    await videoPage.getByRole('button',{name:'重新读取',exact:true}).click();
    await videoPage.waitForFunction(()=>!document.querySelector('#bst-ai-subtitle-host').shadowRoot.querySelector('.status').textContent.includes('读取当前'));
  };
  await replaceTrack({...timelineFixture,timing:'whole-approximate'});
  assert.equal(await videoPage.locator('.toggle-status').textContent(),'估算时间轴');
  await replaceTrack(timelineFixture);
  assert.equal(await videoPage.locator('.toggle-status').textContent(),'已开启');
  const seek=async(seconds,expected)=>{
    await videoPage.evaluate(seconds=>new Promise(resolve=>{
      const video=document.querySelector('video');
      video.addEventListener('seeked',resolve,{once:true});
      video.currentTime=seconds;
    }),seconds);
    // Check immediately after seeked, with no wait for periodic timeupdate or playback.
    assert.equal(await videoPage.locator('.translation').textContent(),expected);
    assert.equal(await videoPage.locator('.captions').isVisible(),Boolean(expected));
  };
  await seek(13,'最后一句');await seek(2,'第一句');await seek(4,'');await seek(7,'第二句\n重叠句');await seek(9,'');
  await videoPage.evaluate(()=>document.querySelector('video').playbackRate=2);
  await seek(12.1,'最后一句');await seek(1.1,'第一句');
  await videoPage.evaluate(()=>document.querySelector('video').play());
  await seek(6.1,'第二句');
  await videoPage.evaluate(()=>document.querySelector('video').pause());
  for(let i=0;i<6;i++) await videoPage.getByRole('button',{name:'字幕提前 0.5 秒',exact:true}).click();
  await videoPage.waitForFunction(()=>document.querySelector('#bst-ai-subtitle-host').shadowRoot.querySelector('.hint').textContent.includes('本集已保存'));
  assert.equal((await popup.evaluate(bvid=>chrome.runtime.sendMessage({type:'GET_SUBTITLE_DELAY',bvid,cid:11}),bvid)).data.delay,-3);
  assert.equal((await popup.evaluate(bvid=>chrome.runtime.sendMessage({type:'GET_SUBTITLE_DELAY',bvid,cid:12}),bvid)).data.delay,0);
  await seek(4,'第二句\n重叠句');
  await videoPage.evaluate(()=>{globalThis.testOverlay=document.querySelector('#bst-ai-subtitle-host');history.pushState({},'',location.pathname+'?t=4&start_progress=4000');});
  await videoPage.waitForTimeout(1100);
  assert.equal(await videoPage.evaluate(()=>document.querySelector('#bst-ai-subtitle-host')===globalThis.testOverlay),true,'Timestamp-only URL updates must preserve the player and calibration');
  await seek(10,'最后一句');
  await videoPage.reload();
  await videoPage.waitForFunction(()=>document.querySelector('#bst-ai-subtitle-host')?.shadowRoot.querySelector('.stepper output')?.textContent==='-3.0 s');
  await videoPage.evaluate(async data=>{
    const video=document.querySelector('video');
    video.src=URL.createObjectURL(new Blob([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],{type:'audio/wav'}));
    await new Promise(resolve=>video.addEventListener('loadedmetadata',resolve,{once:true}));
  },wav.toString('base64'));
  await seek(4,'第二句\n重叠句');
  await videoPage.getByRole('button',{name:'字幕显示设置',exact:true}).click();
  await videoPage.screenshot({path:path.join(artifacts,'player-delay.png')});
  await videoPage.getByRole('button',{name:'恢复显示默认值',exact:true}).click();
  await videoPage.waitForFunction(()=>document.querySelector('#bst-ai-subtitle-host').shadowRoot.querySelector('.hint').textContent.includes('本集已保存'));
  assert.equal((await popup.evaluate(bvid=>chrome.runtime.sendMessage({type:'GET_SUBTITLE_DELAY',bvid,cid:11}),bvid)).data.delay,0);
  assert.equal(asrCalls,3);assert.equal(translationCalls,3);
  const {settings:trackDisplay,translationPending,...cachedTrack}=track;
  await replaceTrack(cachedTrack);
  console.log('Forward/backward seeks, gaps, overlaps, paused/2x playback, per-P calibration, URL parameter changes, refresh and reset verified without provider calls.');
  await videoPage.evaluate(()=>{document.querySelector('video').currentTime=17.99;});
  await videoPage.evaluate(()=>{history.pushState({},'',location.pathname+'?p=2');});
  await videoPage.waitForFunction(()=>!document.querySelector('#bst-ai-subtitle-host') || document.querySelector('#bst-ai-subtitle-host').shadowRoot.querySelector('.captions').hidden);
  const exported=(await popup.evaluate(bvid=>chrome.runtime.sendMessage({type:'EXPORT_TRACK',bvid,cid:11,format:'srt'}),bvid)).data;
  assert.match(exported.content,/中文字幕/);assert.match(exported.content,/Hello world/);
  await run();
  assert.equal((await waitJob()).results[0].status,'cached');assert.equal(asrCalls,3);
  cancelMode=true;
  await run('current',true);
  await waitState(status=>status.phase==='transcribing');
  await popup.evaluate(()=>chrome.runtime.sendMessage({type:'CANCEL_JOB'}));
  assert.equal((await waitJob()).state,'cancelled');
  while(asrInFlight>0) await new Promise(resolve=>setTimeout(resolve,50));
  cancelMode=false;
  await options.evaluate(async()=>{const {saveSettings}=await import('./src/shared/settings.js');await saveSettings({asrApiKey:'test-key-only',translateEnabled:true,asrMode:'whole',preferNativeSubtitles:false,translationBatchSize:2});});
  const priorAsrCalls=asrCalls;
  translationFailure=true;
  await run();
  const failedTranslation=await waitJob();
  assert.equal(failedTranslation.state,'failed');
  assert.equal(failedTranslation.results[0].phase,'translating');
  assert.match(failedTranslation.error,/字幕翻译/);
  assert.equal(asrCalls,priorAsrCalls+1,'Whole mode must submit one file, without slicing');
  const fallback=(await popup.evaluate(bvid=>chrome.runtime.sendMessage({type:'GET_TRACK',bvid,cid:11}),bvid)).data;
  assert.equal(fallback.targetLanguage,'');assert.equal(fallback.settings.bilingual,false);
  assert.equal(fallback.translationPending,true,'Original remains available when translation fails');
  const biliTabs=await worker.evaluate(()=>chrome.tabs.query({url:'https://www.bilibili.com/*'}));
  await popup.addInitScript(({tabId,url})=>{chrome.tabs.query=async()=>[{id:tabId,url}];},{tabId:biliTabs[0].id,url:videoUrl});
  await popup.reload();
  await popup.locator('#translation-toggle').waitFor({state:'visible'});
  await popup.waitForFunction(()=>!document.querySelector('#translation-toggle').disabled);
  assert.equal(await popup.locator('#translation-toggle').isChecked(),true);
  const failedCallCount=translationCalls;
  await popup.locator('#translation-toggle').uncheck();
  await popup.waitForFunction(()=>document.querySelector('#action-message').textContent.includes('翻译已关闭'));
  assert.equal(await worker.evaluate(async()=>(await chrome.storage.local.get('settings')).settings.translateEnabled),false);
  await popup.reload();
  await popup.waitForFunction(()=>!document.querySelector('#translation-toggle').disabled);
  assert.equal(await popup.locator('#translation-toggle').isChecked(),false);
  await popup.locator('#export-srt').waitFor({state:'visible'});
  assert.equal(await popup.locator('#track-badge').textContent(),'原文字幕');
  assert.equal(await popup.locator('#start-label').textContent(),'生成原文字幕');
  await popup.screenshot({path:path.join(artifacts,'popup-translation-off.png'),fullPage:true});
  await run();
  assert.equal((await waitJob()).state,'completed');
  assert.equal(asrCalls,priorAsrCalls+1);assert.equal(translationCalls,failedCallCount,'Turning translation off must not call the translator');
  await popup.locator('#translation-toggle').check();
  await popup.waitForFunction(()=>document.querySelector('#action-message').textContent.includes('翻译已开启'));
  translationFailure=false;
  await run();
  assert.equal((await waitJob()).state,'completed');
  assert.equal(asrCalls,priorAsrCalls+1,'Translation retry must reuse saved recognition without a second audio upload');
  const whole=(await popup.evaluate(bvid=>chrome.runtime.sendMessage({type:'GET_TRACK',bvid,cid:11}),bvid)).data;
  assert.equal(whole.timing,'whole-approximate');assert.equal(whole.requestCount,1);assert.equal(whole.mode,'whole');
  translationDelay=1500;
  await run('current',true);
  await waitState(status=>status.phase==='translating');
  const inFlightTranslationCalls=translationCalls;
  await popup.locator('#translation-toggle').uncheck();
  const stoppedTranslation=await waitJob();
  assert.equal(stoppedTranslation.state,'completed',JSON.stringify(stoppedTranslation));
  assert.equal(translationCalls,inFlightTranslationCalls);
  const stoppedOriginal=(await popup.evaluate(bvid=>chrome.runtime.sendMessage({type:'GET_TRACK',bvid,cid:11}),bvid)).data;
  assert.equal(stoppedOriginal.targetLanguage,'');
  translationDelay=0;
  if(process.env.BILI_TEST_AUDIO) {
    fixtureAudio=await readFile(process.env.BILI_TEST_AUDIO);
    await options.evaluate(async()=>{const {saveSettings}=await import('./src/shared/settings.js');await saveSettings({asrApiKey:'test-key-only',translateEnabled:true,asrMode:'compressed',preferNativeSubtitles:false,compressedChunkSeconds:120,translationBatchSize:50});});
    const beforeCompressed=asrCalls;
    await run();
    const compressedJob=await waitJob();
    assert.equal(compressedJob.state,'completed',JSON.stringify(compressedJob));
    const compressed=(await popup.evaluate(bvid=>chrome.runtime.sendMessage({type:'GET_TRACK',bvid,cid:11}),bvid)).data;
    assert.equal(compressed.mode,'compressed');assert.equal(compressed.requestCount,compressed.partCount);
    assert.equal(asrCalls-beforeCompressed,compressed.partCount);
    assert.ok(compressed.cues.at(-1).end>600);
    console.log(`Real AAC fixture: ${compressed.partCount} lossless M4A chunks through offscreen and mock ASR verified.`);
    fixtureAudio=wav;
  }
  await options.evaluate(async()=>{const {saveSettings}=await import('./src/shared/settings.js');await saveSettings({asrApiKey:'test-key-only',translateEnabled:true,preferNativeSubtitles:true,chunkSeconds:8,translationBatchSize:2});});
  await run();
  assert.equal((await waitJob()).state,'completed');
  const native=(await popup.evaluate(bvid=>chrome.runtime.sendMessage({type:'GET_TRACK',bvid,cid:11}),bvid)).data;
  assert.equal(native.timing,'native');assert.equal(native.cues[0].start,1);
  await run('season');
  await popup.close();
  popup=await context.newPage();
  const tabs=await worker.evaluate(()=>chrome.tabs.query({url:'https://www.bilibili.com/*'}));
  await popup.addInitScript(({tabId,url})=>{
    chrome.tabs.query=async()=>[{id:tabId,url}];
  },{tabId:tabs[0].id,url:videoUrl});
  await popup.setViewportSize({width:400,height:790});
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const collection=await waitJob();
  assert.equal(collection.results.length,2);assert.ok(collection.results.every(r=>['completed','cached'].includes(r.status)));
  await popup.locator('#video-card').waitFor({state:'visible'});
  await popup.locator('#export-srt').waitFor({state:'visible'});
  await popup.screenshot({path:path.join(artifacts,'popup-ready.png'),fullPage:true});
  const downloadPromise=popup.waitForEvent('download');
  await popup.locator('#export-srt').click();
  const download=await downloadPromise;
  await download.saveAs(path.join(artifacts,'exported.srt'));
  assert.match(await readFile(path.join(artifacts,'exported.srt'),'utf8'),/Native caption/);
  const clear=await options.evaluate(()=>chrome.runtime.sendMessage({type:'CLEAR_CACHE'}));
  assert.equal(clear.ok,true);assert.equal(clear.data.count,0);
  // Automatic work is triggered by the real content script, including visibility and playback.
  await videoPage.evaluate(()=>history.pushState({},'',location.pathname));
  await videoPage.bringToFront();
  await options.evaluate(async()=>{const {saveSettings}=await import('./src/shared/settings.js');await saveSettings({asrApiKey:'test-key-only',translateEnabled:false,asrMode:'whole',preferNativeSubtitles:true});});
  await popup.reload();
  await popup.waitForFunction(()=>!document.querySelector('#auto-toggle').disabled);
  const beforeAutoAsr=asrCalls,beforeAutoTranslation=translationCalls;
  await popup.locator('#auto-toggle').check();
  await options.waitForFunction(()=>document.querySelector('#autoEnabled').checked);
  await videoPage.bringToFront();
  const skipped=await waitState(status=>status.automatic && status.state==='completed');
  assert.equal(skipped.results[0].status,'skipped');assert.equal(asrCalls,beforeAutoAsr);assert.equal(translationCalls,beforeAutoTranslation);
  await popup.locator('#auto-toggle').uncheck();
  await popup.waitForFunction(()=>!document.querySelector('#auto-toggle').disabled);
  nativeAvailable=false;allowSecondAudio=true;
  await options.evaluate(async()=>{const {saveSettings}=await import('./src/shared/settings.js');await saveSettings({asrApiKey:'test-key-only',translateEnabled:false,asrMode:'whole',preferNativeSubtitles:false});});
  await popup.locator('#auto-toggle').check();
  await videoPage.bringToFront();
  const automaticCurrent=await waitState(status=>status.automatic && status.state==='completed' && status.id!==skipped.id);
  assert.equal(automaticCurrent.results[0].cid,11);assert.equal(asrCalls,beforeAutoAsr+1);assert.equal(translationCalls,beforeAutoTranslation);
  await popup.locator('#follow-toggle').check();
  await options.waitForFunction(()=>document.querySelector('#followNext').checked);
  await videoPage.bringToFront();
  await videoPage.evaluate(async()=>{const video=document.querySelector('video');video.currentTime=1;await video.play();});
  const automaticNext=await waitState(status=>status.autoKind==='next' && status.state==='completed');
  assert.equal(automaticNext.results[0].cid,12);assert.equal(asrCalls,beforeAutoAsr+2);assert.equal(translationCalls,beforeAutoTranslation);
  await popup.locator('#auto-toggle').uncheck();
  await popup.waitForFunction(()=>!document.querySelector('#follow-toggle').disabled);
  await popup.locator('#follow-toggle').uncheck();
  await popup.waitForFunction(()=>!document.querySelector('#follow-toggle').disabled);
  await videoPage.evaluate(()=>document.querySelector('video').pause());
  const currentPreferences=await worker.evaluate(async()=>(await chrome.storage.local.get('settings')).settings);
  assert.equal(currentPreferences.autoEnabled,false);assert.equal(currentPreferences.followNext,false);
  await options.waitForFunction(()=>!document.querySelector('#autoEnabled').checked && !document.querySelector('#followNext').checked);
  console.log('Real content script: native subtitle skip, automatic current video, next-P-only playback prefetch and translation-off verified.');

  // A large directory is selected with checkboxes; old 20-item settings do not restrict it.
  fixtureView.data.pages=Array.from({length:200},(_,i)=>({page:i+1,cid:100+i,part:`第 ${i+1} 课`,duration:18}));
  const largeUrl=videoUrl+'?p=3';
  await videoPage.goto(largeUrl);
  await popup.close();popup=await context.newPage();
  await popup.setViewportSize({width:400,height:790});
  await popup.addInitScript(({tabId,url})=>{chrome.tabs.query=async()=>[{id:tabId,url}];},{tabId:tabs[0].id,url:largeUrl});
  await popup.goto(`chrome-extension://${id}/popup.html`);await popup.locator('#video-card').waitFor({state:'visible'});
  await popup.locator('#scope-select').selectOption('selected');
  await popup.locator('#select-none').click();
  assert.equal(await popup.locator('#start-button').isDisabled(),true);
  await popup.locator('#selection-search').fill('P200');await popup.locator('#select-all').click();
  await popup.locator('#selection-search').fill('');
  await popup.locator('#selection-list input').first().check();
  assert.equal(await popup.locator('#selection-count').textContent(),'已选 2 个');
  await popup.screenshot({path:path.join(artifacts,'popup-selection.png'),fullPage:true});
  await popup.reload();await popup.locator('#video-card').waitFor({state:'visible'});
  await popup.locator('#scope-select').selectOption('selected');
  assert.equal(await popup.locator('#selection-count').textContent(),'已选 2 个');
  const beforeSelected=asrCalls;
  await popup.locator('#start-button').click();
  const selectedJob=await waitState(status=>status.total===2 && status.state==='completed' && status.id!==automaticNext.id);
  assert.deepEqual(selectedJob.results.map(item=>item.cid),[100,299]);assert.equal(asrCalls,beforeSelected+2);

  // Actual upload failure falls through to another format without user action.
  rejectAsrCount=1;
  const fallbackJob=await popup.evaluate(url=>chrome.runtime.sendMessage({type:'START_JOB',url,scope:'current',force:true}),largeUrl);
  assert.equal(fallbackJob.ok,true);
  const recovered=await waitState(status=>status.id===fallbackJob.data.id && status.state==='completed');
  assert.equal(recovered.results[0].status,'completed');
  const recoveredTrack=(await popup.evaluate(bvid=>chrome.runtime.sendMessage({type:'GET_TRACK',bvid,cid:102}),bvid)).data;
  assert.equal(recoveredTrack.mode,'timed');
  if(process.env.BILI_TEST_AUDIO) {
    fixtureAudio=await readFile(process.env.BILI_TEST_AUDIO);
    rejectAsrCount=2;
    const m4aFallback=await popup.evaluate(url=>chrome.runtime.sendMessage({type:'START_JOB',url,scope:'current',force:true}),largeUrl);
    assert.equal(m4aFallback.ok,true);
    await waitState(status=>status.id===m4aFallback.data.id && status.state==='completed');
    const m4aTrack=(await popup.evaluate(bvid=>chrome.runtime.sendMessage({type:'GET_TRACK',bvid,cid:102}),bvid)).data;
    assert.equal(m4aTrack.mode,'timed');assert.ok(m4aTrack.cues.at(-1).end>600);
    fixtureAudio=wav;
    console.log('Real M4A: failed whole upload and compressed upload both recover through WAV recognition.');
  }
  console.log('200P checkbox selection persists across popup reloads, selected-only execution and automatic format fallback verified.');
  console.log('Full ASR → translation → cache → player overlay pipeline verified with fixture APIs.');
  console.log('Partial batch failures, cache hits, cancellation, native subtitle reuse, SPA hide and exports verified.');
  console.log('Collection continues after popup closes; ready popup, file download and cache clearing verified.');
  console.log('Whole mode one-upload path, stage-specific errors and translation retry without re-ASR verified.');
  console.log('Translation toggle, persistent original-only preference, immediate original fallback and stopping an in-flight translation verified.');
  assert.deepEqual(errors,[]);
  console.log(`Screenshots: ${artifacts}`);
} finally {await context.close();}
