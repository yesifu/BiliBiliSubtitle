export const DEFAULT_SETTINGS = Object.freeze({
  asrProvider: 'siliconflow',
  asrBaseUrl: 'https://api.siliconflow.cn/v1',
  asrApiKey: '',
  asrModel: 'FunAudioLLM/SenseVoiceSmall',
  translationBaseUrl: 'https://api.siliconflow.cn/v1',
  translationApiKey: '',
  translationModel: 'Qwen/Qwen2.5-7B-Instruct',
  targetLanguage: '简体中文',
  sourceLanguage: 'auto',
  translateEnabled: false,
  autoEnabled: false,
  followNext: false,
  translationPreferenceVersion: 1,
  preferNativeSubtitles: true,
  bilingual: true,
  fontSize: 22,
  bottomOffset: 64,
  backgroundTransparency: 24,
  asrConcurrency: 2,
  asrMode: 'whole',
  compressedChunkSeconds: 120,
  asrTimeoutSeconds: 600,
  translationTimeoutSeconds: 180,
  chunkSeconds: 25,
  translationBatchSize: 50,
  maxAudioMB: 300,
  maxDurationMinutes: 180,
  collectionLimit: 500,
});

export function validateBaseUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('API 地址格式不正确。'); }
  const loopback = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('API 地址必须使用 HTTPS，本机 localhost / 127.0.0.1 可使用 HTTP。');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含账号、密码、查询参数或片段。');
  return url.href.replace(/\/+$/, '');
}

export function normalizeSettings(input = {}) {
  const s = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(s)) {
    if (input[key] !== undefined) s[key] = input[key];
  }
  for (const key of ['asrBaseUrl', 'translationBaseUrl']) s[key] = validateBaseUrl(s[key]);
  for (const key of ['asrApiKey', 'asrModel', 'translationApiKey', 'translationModel', 'targetLanguage', 'sourceLanguage']) {
    s[key] = String(s[key] ?? '').trim();
  }
  if (!s.asrModel || !s.translationModel || !s.targetLanguage) throw new Error('模型名称和目标语言不能为空。');
  for (const key of ['translateEnabled', 'preferNativeSubtitles', 'bilingual', 'autoEnabled', 'followNext']) s[key] = Boolean(s[key]);
  const bounds = {fontSize:[14,48],bottomOffset:[0,300],backgroundTransparency:[0,100],asrConcurrency:[1,4],chunkSeconds:[8,30],compressedChunkSeconds:[30,600],asrTimeoutSeconds:[60,1800],translationTimeoutSeconds:[30,600],translationBatchSize:[1,100],maxAudioMB:[10,300],maxDurationMinutes:[1,180],collectionLimit:[1,500]};
  for (const [key,[min,max]] of Object.entries(bounds)) {
    const value = Number(s[key]);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} 必须在 ${min}–${max} 之间。`);
    s[key] = Math.round(value);
  }
  s.asrProvider = s.asrProvider === 'siliconflow' ? 'siliconflow' : 'openai';
  s.asrMode = ['whole','compressed','timed'].includes(s.asrMode) ? s.asrMode : 'whole';
  return s;
}

export async function loadSettings() {
  const result = await chrome.storage.local.get('settings');
  if(result.settings && result.settings.translationPreferenceVersion!==1) {
    // 1.2 changes the old auto-enabled default once; later explicit choices persist.
    const settings=normalizeSettings({...result.settings,translateEnabled:false,translationPreferenceVersion:1});
    await chrome.storage.local.set({settings});
    return settings;
  }
  return normalizeSettings(result.settings);
}

export async function saveSettings(input) {
  const settings = normalizeSettings(input);
  await chrome.storage.local.set({ settings });
  await chrome.runtime.sendMessage({type:'SETTINGS_UPDATED'}).catch(() => {});
  return settings;
}

export function translationCredentials(settings) {
  const sameOrigin = new URL(settings.translationBaseUrl).origin === new URL(settings.asrBaseUrl).origin;
  return { baseUrl: settings.translationBaseUrl, apiKey: settings.translationApiKey || (sameOrigin ? settings.asrApiKey : ''), model: settings.translationModel };
}

export function trackVariant(settings) {
  if(!settings.translateEnabled) return JSON.stringify([4,'original',recognitionVariant(settings)]);
  return JSON.stringify([3,settings.translateEnabled,settings.targetLanguage,recognitionVariant(settings),settings.translationBaseUrl,settings.translationModel]);
}

// Recognition survives translation provider/language changes and timeout changes.
export function recognitionVariant(s) {
  const slice=s.asrMode==='timed'?s.chunkSeconds:s.asrMode==='compressed'?s.compressedChunkSeconds:null;
  return JSON.stringify([2,s.sourceLanguage,s.preferNativeSubtitles,s.asrProvider,s.asrBaseUrl,s.asrModel,s.asrMode,slice]);
}
