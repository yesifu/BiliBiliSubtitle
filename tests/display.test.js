import test from 'node:test';
import assert from 'node:assert/strict';
import {getSubtitleDelay,setSubtitleDelay} from '../src/shared/display.js';

test('calibration is isolated per P, validates writes, resets without touching keys or transcripts',async()=>{
  const previous=globalThis.chrome;
  const data={settings:{asrApiKey:'test-key'},job:{state:'completed'}};
  globalThis.chrome={storage:{local:{
    get:async key=>({[key]:data[key]}),
    set:async values=>Object.assign(data,values),
    remove:async key=>{delete data[key];},
  }}};
  try {
    const bvid='BV1xx411c7mD';
    assert.equal(await getSubtitleDelay(bvid,11),0);
    await setSubtitleDelay(bvid,11,-3);
    await setSubtitleDelay(bvid,12,2.5);
    assert.equal(await getSubtitleDelay(bvid,11),-3);
    assert.equal(await getSubtitleDelay(bvid,12),2.5);
    for(const value of [NaN,Infinity,-31,31,0.1,'-3',null]) await assert.rejects(setSubtitleDelay(bvid,11,value));
    await assert.rejects(setSubtitleDelay('settings',11,1));
    await assert.rejects(setSubtitleDelay(bvid,-1,1));
    assert.equal(await getSubtitleDelay(bvid,11),-3);
    await setSubtitleDelay(bvid,11,0);
    await setSubtitleDelay(bvid,12,0);
    assert.deepEqual(data,{settings:{asrApiKey:'test-key'},job:{state:'completed'}});
  } finally {globalThis.chrome=previous;}
});
