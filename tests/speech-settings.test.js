import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSettings, saveSettings, normalizeSettings, recognitionVariant, trackVariant } from '../src/shared/settings.js';
import { fallbackModes, withRecognitionFallback } from '../src/shared/recognition-policy.js';

test('legacy whole-video SiliconFlow settings move to speech once and preserve subsequent choices', async()=>{
  const original=globalThis.chrome;
  const data={settings:{...normalizeSettings({asrMode:'whole',asrApiKey:'test-existing-key',asrModel:'Qwen/Qwen3-ASR-1.7B',translateEnabled:true,backgroundTransparency:80}),asrTimingPreferenceVersion:undefined}};
  let writes=0;
  globalThis.chrome={storage:{local:{get:async key=>({[key]:structuredClone(data[key])}),set:async input=>{writes++;Object.assign(data,structuredClone(input));}}},runtime:{sendMessage:async()=>{}}};
  try {
    const old=structuredClone(data.settings);
    const next=await loadSettings();
    assert.deepEqual(next,normalizeSettings({...old,asrMode:'speech',asrTimingPreferenceVersion:1}));
    assert.equal(writes,1);
    assert.equal((await loadSettings()).asrMode,'speech');
    assert.equal(writes,1);
    await saveSettings({...next,asrMode:'whole'});
    assert.equal((await loadSettings()).asrMode,'whole');
    assert.equal(writes,2);
  } finally {globalThis.chrome=original;}
});

test('speech migration preserves explicit other modes and compatible services', async()=>{
  const original=globalThis.chrome;
  try {
    for(const input of [
      {asrMode:'timed'}, {asrMode:'compressed'},
      {asrMode:'whole',asrProvider:'openai',asrModel:'whisper-1',asrBaseUrl:'https://api.openai.com/v1'},
      {asrMode:'whole',asrBaseUrl:'https://gateway.example/v1'},
    ]) {
      const before={...normalizeSettings(input),asrTimingPreferenceVersion:undefined};
      globalThis.chrome={storage:{local:{get:async()=>({settings:before}),set:async()=>{}}}};
      assert.deepEqual(await loadSettings(),normalizeSettings({...before,asrTimingPreferenceVersion:1}));
    }
  } finally {globalThis.chrome=original;}
});

test('speech cache cannot reuse whole-text estimates, original or translated',()=>{
  const speech=normalizeSettings();
  assert.equal(speech.asrMode,'speech');
  for(const asrMode of ['whole','compressed','timed']) {
    const old={...speech,asrMode};
    assert.notEqual(recognitionVariant(speech),recognitionVariant(old));
    for(const translateEnabled of [true,false]) assert.notEqual(trackVariant({...speech,translateEnabled}),trackVariant({...old,translateEnabled}));
  }
});

test('failed speech recognition never silently falls back to estimated long tracks',async()=>{
  assert.deepEqual(fallbackModes('speech'),['speech']);
  const calls=[];
  await assert.rejects(withRecognitionFallback('speech',undefined,async mode=>{calls.push(mode);throw new Error('decoding failed');}),/decoding failed/);
  assert.deepEqual(calls,['speech']);
});
