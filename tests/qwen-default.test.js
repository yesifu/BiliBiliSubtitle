import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, normalizeSettings, recognitionVariant } from '../src/shared/settings.js';
import { ASR_MODELS } from '../src/shared/models.js';
import { cacheId } from '../src/shared/cache.js';
import { transcribeBlob } from '../src/shared/providers.js';

const qwen = 'Qwen/Qwen3-ASR-1.7B';
const senseVoice = 'FunAudioLLM/SenseVoiceSmall';

async function withStoredSettings(settings, run) {
  const originalChrome = globalThis.chrome;
  const store = settings === undefined ? {} : {settings: structuredClone(settings)};
  let writes = 0;
  globalThis.chrome = {
    storage: {local: {
      get: async key => ({[key]: structuredClone(store[key])}),
      set: async data => { writes++; Object.assign(store, structuredClone(data)); },
    }},
    runtime: {sendMessage: async () => ({ok: true})},
  };
  try { await run(store, () => writes); }
  finally { globalThis.chrome = originalChrome; }
}

test('new installations use Qwen on SiliconFlow and retain the other starter models', async () => {
  assert.equal(DEFAULT_SETTINGS.asrModel, qwen);
  assert.equal(DEFAULT_SETTINGS.asrModelPreferenceVersion, 1);
  assert.equal(ASR_MODELS[0], qwen);
  assert.ok(ASR_MODELS.includes(senseVoice));
  assert.ok(ASR_MODELS.includes('TeleAI/TeleSpeechASR'));
  await withStoredSettings(undefined, async () => {
    const settings = await loadSettings();
    assert.equal(settings.asrModel, qwen);
    assert.equal(settings.asrProvider, 'siliconflow');
    assert.equal(settings.asrBaseUrl, 'https://api.siliconflow.cn/v1');
    assert.equal(settings.asrModelPreferenceVersion, 1);
    assert.equal(settings.translateEnabled, false);
  });
});

test('the previous SiliconFlow default migrates once while keeping keys and user preferences', async () => {
  const previous = {
    asrProvider: 'siliconflow', asrBaseUrl: 'https://api.siliconflow.cn/v1/', asrModel: senseVoice,
    asrApiKey: 'existing-asr-test-key', translationApiKey: 'existing-translation-test-key',
    translationBaseUrl: 'https://translator.test/v1', translationModel: 'chosen-translator',
    targetLanguage: 'English', sourceLanguage: 'ja', translateEnabled: true, translationPreferenceVersion: 1,
    fontSize: 30, bottomOffset: 90, backgroundTransparency: 80, bilingual: false,
    autoEnabled: true, followNext: true, preferNativeSubtitles: false,
    asrMode: 'compressed', compressedChunkSeconds: 60, asrConcurrency: 3, asrTimeoutSeconds: 900,
  };
  await withStoredSettings(previous, async (store, writes) => {
    const migrated = await loadSettings();
    assert.deepEqual(migrated, normalizeSettings({...previous, asrModel: qwen, asrModelPreferenceVersion: 1}));
    assert.deepEqual(store.settings, migrated);
    assert.equal(writes(), 1);
    assert.deepEqual(await loadSettings(), migrated);
    assert.equal(writes(), 1, 'reading migrated settings must not migrate again');
    await saveSettings({...migrated, asrModel: senseVoice});
    assert.equal((await loadSettings()).asrModel, senseVoice, 'a later explicit SenseVoice choice must persist');
    assert.equal(writes(), 2);
  });
});

test('legacy settings with omitted built-in provider, endpoint or model adopt Qwen', async () => {
  for (const legacy of [
    {asrModel: senseVoice},
    {asrProvider: 'siliconflow', asrBaseUrl: 'https://api.siliconflow.cn/v1'},
    {},
  ]) {
    await withStoredSettings({...legacy, asrApiKey: 'existing-test-key'}, async store => {
      const settings = await loadSettings();
      assert.equal(settings.asrModel, qwen);
      assert.equal(settings.asrApiKey, 'existing-test-key');
      assert.equal(store.settings.asrModelPreferenceVersion, 1);
    });
  }
});

test('Qwen migration preserves custom models, alternate providers and custom gateways', async () => {
  for (const choice of [
    {asrModel: 'TeleAI/TeleSpeechASR'},
    {asrModel: 'XingChenAGI/XingChenASR-V3.2'},
    {asrProvider: 'openai', asrBaseUrl: 'https://api.openai.com/v1', asrModel: 'whisper-1'},
    {asrProvider: 'openai', asrModel: senseVoice},
    {asrBaseUrl: 'https://gateway.test/v1', asrModel: senseVoice},
    {asrBaseUrl: 'https://api.siliconflow.cn/custom/v1', asrModel: senseVoice},
  ]) {
    const previous = {...choice, asrApiKey: 'keep-test-key', translationPreferenceVersion: 1, translateEnabled: true};
    await withStoredSettings(previous, async (store, writes) => {
      const settings = await loadSettings();
      assert.deepEqual(settings, normalizeSettings({...previous, asrModelPreferenceVersion: 1}));
      assert.equal(store.settings.asrModelPreferenceVersion, 1);
      await loadSettings();
      assert.equal(writes(), 1);
    });
  }
});

test('ASR and translation preference migrations remain independent', async () => {
  for (const asrModelPreferenceVersion of [undefined, 1]) {
    await withStoredSettings({asrModel: senseVoice, asrModelPreferenceVersion, translateEnabled: true}, async store => {
      const settings = await loadSettings();
      assert.equal(settings.asrModel, asrModelPreferenceVersion === 1 ? senseVoice : qwen);
      assert.equal(settings.translateEnabled, false, 'the old automatic translation default still migrates off');
      assert.equal(store.settings.translationPreferenceVersion, 1);
      await saveSettings({...settings, translateEnabled: true});
      assert.equal((await loadSettings()).translateEnabled, true, 'explicit translation opt-in must survive later loads');
    });
  }
});

test('Qwen recognition and subtitle cache keys cannot reuse an old SenseVoice timeline', () => {
  const current = normalizeSettings();
  const previous = {...current, asrModel: senseVoice};
  assert.notEqual(recognitionVariant(current), recognitionVariant(previous));
  for (const translateEnabled of [false, true]) {
    assert.notEqual(
      cacheId('BV1xx411c7mD', 11, {...current, translateEnabled}),
      cacheId('BV1xx411c7mD', 11, {...previous, translateEnabled}),
    );
  }
});

test('Qwen uses the existing SiliconFlow upload endpoint and timing follows the actual response', async () => {
  const originalFetch = globalThis.fetch;
  const originalXHR = globalThis.XMLHttpRequest;
  const payloads = [
    {text: 'First. Second.', segments: [{start: 1.25, end: 3.5, text: 'First.'}, {start: 5, end: 8.75, text: 'Second.'}]},
    {text: 'First. Second.'},
  ];
  let requests = 0;
  globalThis.XMLHttpRequest = undefined;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.siliconflow.cn/v1/audio/transcriptions');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer fixture-key');
    assert.equal(options.body.get('model'), qwen);
    assert.equal(options.body.get('file').name, 'audio.wav');
    assert.equal(options.body.has('response_format'), false);
    assert.equal(options.body.has('timestamp_granularities[]'), false);
    return new Response(JSON.stringify(payloads[requests++]), {headers: {'Content-Type': 'application/json'}});
  };
  try {
    const settings = normalizeSettings({asrApiKey: 'fixture-key'});
    const blob = new Blob(['fixture'], {type: 'audio/wav'});
    const precise = await transcribeBlob(blob, 'audio.wav', 30, 10, settings);
    assert.equal(precise.timing, 'precise');
    assert.deepEqual(precise.cues.map(({start, end}) => [start, end]), [[31.25, 33.5], [35, 38.75]]);
    const approximate = await transcribeBlob(blob, 'audio.wav', 30, 10, settings);
    assert.equal(approximate.timing, 'approximate', 'Qwen text without timestamps must not be labeled precise');
    assert.equal(approximate.cues[0].start, 30);
    assert.equal(approximate.cues.at(-1).end, 40);
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalXHR === undefined) delete globalThis.XMLHttpRequest;
    else globalThis.XMLHttpRequest = originalXHR;
  }
});
