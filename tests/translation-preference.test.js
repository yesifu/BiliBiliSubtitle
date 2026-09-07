import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSettings,saveSettings,normalizeSettings,trackVariant,recognitionVariant} from '../src/shared/settings.js';

test('translation defaults off, migrates old automatic setting once, and remembers explicit opt-in',async()=>{
  const oldChrome=globalThis.chrome;
  const store={settings:{asrApiKey:'existing-key',translateEnabled:true,asrMode:'compressed',compressedChunkSeconds:120}};
  globalThis.chrome={storage:{local:{get:async key=>({[key]:store[key]}),set:async data=>Object.assign(store,data)}},runtime:{sendMessage:async()=>({ok:true})}};
  try {
    const migrated=await loadSettings();
    assert.equal(migrated.translateEnabled,false);
    assert.equal(migrated.asrApiKey,'existing-key');
    assert.equal(migrated.asrMode,'compressed');
    await saveSettings({...migrated,translateEnabled:true});
    assert.equal((await loadSettings()).translateEnabled,true);
    await saveSettings({...migrated,translateEnabled:false});
    assert.equal((await loadSettings()).translateEnabled,false);
  } finally {globalThis.chrome=oldChrome;}
});
test('original-only cache does not depend on translation model, target language or credentials',()=>{
  const original=normalizeSettings();
  assert.equal(original.translateEnabled,false);
  const changed={...original,targetLanguage:'English',translationBaseUrl:'https://other.test/v1',translationModel:'different',translationApiKey:'rotated'};
  assert.equal(trackVariant(original),trackVariant(changed));
  assert.equal(recognitionVariant(original),recognitionVariant({...changed,translateEnabled:true}));
  assert.notEqual(trackVariant(original),trackVariant({...original,translateEnabled:true}));
});
