import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './shared/settings.js';
import { ASR_MODELS, TRANSLATION_MODELS, fetchModels } from './shared/models.js';

const $ = (id) => document.getElementById(id);
const form = $('settings-form');
const fields = $('settings-fields');
const saveButton = $('save-settings');
const discardButton = $('discard-changes');
const status = $('save-status');
const settingKeys = [
  'asrProvider', 'asrBaseUrl', 'asrApiKey', 'asrModel', 'asrMode',
  'translationBaseUrl', 'translationApiKey', 'translationModel',
  'targetLanguage', 'sourceLanguage', 'translateEnabled',
  'preferNativeSubtitles', 'bilingual', 'fontSize', 'bottomOffset', 'backgroundTransparency',
  'autoEnabled', 'followNext',
];
const booleanKeys = new Set(['translateEnabled', 'preferNativeSubtitles', 'bilingual', 'autoEnabled', 'followNext']);
const numberKeys = new Set(['fontSize', 'bottomOffset', 'backgroundTransparency']);
const fieldNames = {
  asrBaseUrl: '识别 API 基础地址', translationBaseUrl: '翻译 API 基础地址',
  asrModel: '识别模型', asrMode: '音频识别模式', translationModel: '翻译模型',
  targetLanguage: '翻译目标语言', sourceLanguage: '音频语言',
  fontSize: '字幕字号', bottomOffset: '距底部距离', asrConcurrency: '识别并发数',
  backgroundTransparency: '背景透明度',
  chunkSeconds: 'WAV 小切片时长', translationBatchSize: '翻译批量大小',
  compressedChunkSeconds: '压缩分段时长', asrTimeoutSeconds: '识别请求超时', translationTimeoutSeconds: '翻译请求超时',
  maxAudioMB: '音频大小上限', maxDurationMinutes: '音频时长上限', collectionLimit: '合集处理上限',
};
const presets = {
  siliconflow: { asrBaseUrl: 'https://api.siliconflow.cn/v1', asrModel: 'FunAudioLLM/SenseVoiceSmall' },
  openai: { asrBaseUrl: 'https://api.openai.com/v1', asrModel: 'whisper-1' },
};
const modes = {
  whole: {
    description: '失败自动换分段识别，再失败换兼容识别。',
    timing: 'SenseVoice 不返回时间戳，整段字幕的时间仅为粗略估算。',
  },
  compressed: {
    description: '分段上传音轨，失败自动换兼容识别。',
    timing: '服务未返回时间戳时，字幕时间按分段估算。',
  },
  timed: {
    description: '使用短音频逐段识别，耗时较长。',
    timing: '可细化时间估算；精确对齐仍需服务返回时间戳。',
  },
};

let savedSettings = null;
let savedSignature = '';
let ready = false;
let saving = false;
let cacheBusy = false;
let externalLoad=0;
const modelLists={asr:[...ASR_MODELS],translation:[...TRANSLATION_MODELS]};
let modelProvider='siliconflow';
const modelRequests={asr:0,translation:0};

function renderModels(kind) {
  const input=$(kind==='asr'?'asrModel':'translationModel');
  const select=$(`${kind}-model-select`);
  const ids=[...new Set([...modelLists[kind],...(input.value?[input.value]:[])])];
  select.replaceChildren(...ids.map(id=>new Option(id,id)),new Option('自定义模型…','__custom__'));
  select.value=input.value || '__custom__';
  input.hidden=select.value!=='__custom__';
}

async function refreshModels(kind) {
  const button=$(`refresh-${kind}-models`),status=$(`${kind}-models-status`);
  const base=$(kind==='asr'?'asrBaseUrl':'translationBaseUrl').value;
  const ownKey=$(kind==='asr'?'asrApiKey':'translationApiKey').value;
  let key=ownKey;
  let endpoint;
  try {
    endpoint=parseEndpoint(base);
    if(kind==='translation' && !key && endpoint.origin===parseEndpoint($('asrBaseUrl').value).origin) key=$('asrApiKey').value;
    if(!key.trim()) throw new Error('请先填写 API 密钥。');
  } catch(error) {status.textContent=error.message;return;}
  const version=++modelRequests[kind];
  button.disabled=true;status.textContent='正在获取可用模型…';
  try {
    if(!await chrome.permissions.request({origins:[permissionOrigin(endpoint)]})) throw new Error('请允许访问模型服务。');
    const ids=await fetchModels(base,key,kind);
    if(version!==modelRequests[kind] || $(kind==='asr'?'asrBaseUrl':'translationBaseUrl').value!==base) return;
    modelLists[kind]=ids;renderModels(kind);
    status.textContent=ids.length?`已获取 ${ids.length} 个模型。`:'服务未返回可用模型，可手动填写。';
  } catch(error) {status.textContent=error.message;}
  finally {button.disabled=false;}
}

function setStatus(message, tone = 'neutral') {
  if (status.textContent !== message) status.textContent = message;
  status.dataset.tone = tone;
  $('save-indicator').dataset.tone = tone;
}

function rawSettings() {
  return Object.fromEntries(settingKeys.map((key) => {
    if (key === 'asrProvider') {
      return [key, form.querySelector('input[name="asrProvider"]:checked')?.value || 'siliconflow'];
    }
    return [key, booleanKeys.has(key) ? $(key).checked : $(key).value];
  }));
}

function signature() {
  return JSON.stringify(rawSettings());
}

function populate(settings) {
  for (const key of settingKeys) {
    const value = settings[key] ?? DEFAULT_SETTINGS[key];
    if (key === 'asrProvider') {
      for (const radio of form.querySelectorAll('input[name="asrProvider"]')) {
        radio.checked = radio.value === value;
      }
    } else if (booleanKeys.has(key)) {
      $(key).checked = Boolean(value);
    } else {
      // Preserve a language configured by another extension surface.
      if (key === 'sourceLanguage' && !Array.from($(key).options).some((option) => option.value === String(value))) {
        $(key).add(new Option(String(value), String(value)));
      }
      $(key).value = String(value);
    }
  }
  hideKeys();
  if(settings.asrProvider!==modelProvider) {
    modelProvider=settings.asrProvider;
    modelLists.asr=modelProvider==='siliconflow'?[...ASR_MODELS]:['whisper-1'];
  }
  renderModels('asr');renderModels('translation');
  updateDerivedUI();
}

function hideKeys() {
  for (const button of form.querySelectorAll('[data-reveal]')) {
    $(button.dataset.reveal).type = 'password';
    button.textContent = '显示';
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', `显示${button.dataset.reveal === 'asrApiKey' ? '语音识别' : '字幕翻译'} API 密钥`);
  }
}

function clearError(id) {
  const input = $(id);
  const error = $(`${id}-error`);
  input?.removeAttribute('aria-invalid');
  if (error) {
    error.hidden = true;
    error.textContent = '';
  }
}

function clearErrors() {
  for (const key of settingKeys) clearError(key);
}

function fieldError(id, message) {
  if(['asrModel','translationModel'].includes(id)) $(id).hidden=false;
  // Reveal invalid fields even when their section is collapsed.
  for (let parent = $(id).parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') parent.open = true;
    if (parent.id === 'translation-settings') parent.hidden = false;
  }
  $(id).setAttribute('aria-invalid', 'true');
  const error = $(`${id}-error`);
  error.textContent = message;
  error.hidden = false;
}

function parseEndpoint(value) {
  const text = value.trim();
  if (!text) throw new Error('请填写 API 基础地址。');
  if (/[\s\\]/.test(text)) throw new Error('地址中不能包含空白字符或反斜杠。');
  if (!/^https?:\/\//i.test(text)) throw new Error('请填写以 https:// 开头的完整地址；本机服务可使用 HTTP。');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('地址格式不正确，请填写完整的 API 基础地址。');
  }
  if (url.username || url.password) throw new Error('地址中不能包含账号或密码，请将密钥填写在独立的密钥栏中。');
  // Also reject empty query/fragment delimiters, which URL.search/hash omit.
  if (/[?#]/.test(text)) throw new Error('地址中不能包含查询参数（?）或片段（#）。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('远程服务必须使用 HTTPS；HTTP 仅支持 localhost 或 127.0.0.1。');
  }
  return url;
}

function permissionOrigin(url) {
  // Chrome host match patterns cover all ports; paths are not permission scopes.
  // Credential reuse below deliberately compares URL.origin, including the port.
  return `${url.protocol}//${url.hostname}/*`;
}

function validateForm() {
  clearErrors();
  const values = rawSettings();
  const endpoints = {};
  const errors = [];
  const fail = (key, message) => {
    fieldError(key, message);
    errors.push(key);
  };

  for (const key of settingKeys) {
    if (typeof values[key] === 'string') values[key] = values[key].trim();
  }
  for (const key of ['asrBaseUrl', 'translationBaseUrl']) {
    try {
      endpoints[key] = parseEndpoint(values[key]);
      values[key] = endpoints[key].href.replace(/\/+$/, '');
    } catch (error) {
      if (key === 'translationBaseUrl' && !values.translateEnabled) {
        values[key] = savedSettings?.[key] || DEFAULT_SETTINGS[key];
      } else {
        fail(key, error.message);
      }
    }
  }
  for (const key of ['asrModel', 'translationModel', 'targetLanguage', 'sourceLanguage']) {
    if (!values.translateEnabled && ['translationModel', 'targetLanguage'].includes(key) && !values[key]) {
      values[key] = savedSettings?.[key] || DEFAULT_SETTINGS[key];
    }
    if (!values[key]) fail(key, `请填写${fieldNames[key]}。`);
  }
  if (!Object.hasOwn(modes, values.asrMode)) fail('asrMode', '请选择整段直传、压缩大分段或 WAV 小切片。');
  for (const key of numberKeys) {
    const input = $(key);
    const value = input.valueAsNumber;
    const min = Number(input.min);
    const max = Number(input.max);
    if (!Number.isInteger(value) || value < min || value > max) {
      fail(key, `${fieldNames[key]}须为 ${min}–${max} 之间的整数。`);
    }
    values[key] = value;
  }
  if (values.translateEnabled && !values.translationApiKey && endpoints.asrBaseUrl && endpoints.translationBaseUrl
      && endpoints.asrBaseUrl.origin !== endpoints.translationBaseUrl.origin) {
    fail('translationApiKey', '翻译与识别地址不同源，请填写独立的翻译密钥，或改用同源地址。');
  }
  if (errors.length) {
    setStatus(`有 ${errors.length} 项需要修改，请检查标红字段。`, 'error');
    $(errors[0]).focus();
    return null;
  }
  // Keep a blank translation key blank in storage; the shared runtime owns reuse.
  const activeEndpoints = [endpoints.asrBaseUrl, ...(values.translateEnabled ? [endpoints.translationBaseUrl] : [])];
  return { settings: values, origins: [...new Set(activeEndpoints.map(permissionOrigin))] };
}

function updateDerivedUI() {
  const mode = modes[$('asrMode').value] || modes.whole;
  for (const [id, value] of Object.entries({
    'asr-mode-description': mode.description,
    'asr-mode-timing': mode.timing,
  })) {
    if ($(id).textContent !== value) $(id).textContent = value;
  }
  const translationEnabled = $('translateEnabled').checked;
  $('register-siliconflow').hidden = form.querySelector('input[name="asrProvider"]:checked')?.value!=='siliconflow';
  $('translation-state').textContent = translationEnabled ? '已开启' : '已关闭';
  $('translation-settings').hidden = !translationEnabled;
  $('translateEnabled').setAttribute('aria-expanded', String(translationEnabled));
  $('translateEnabled-hint').textContent = translationEnabled ? '识别后翻译，原文字幕可先使用。' : '关闭时只生成原文字幕。';
  $('bilingual').disabled = !translationEnabled;
  const reuseNote = $('key-reuse-status');
  let text;
  let tone = 'neutral';
  try {
    const asr = parseEndpoint($('asrBaseUrl').value);
    const translation = parseEndpoint($('translationBaseUrl').value);
    if ($('translationApiKey').value.trim()) {
      text = '使用独立翻译密钥。';
      tone = 'success';
    } else if (asr.origin === translation.origin) {
      text = $('asrApiKey').value.trim() ? '将复用识别密钥。' : '请先填写识别密钥，或在此填入独立密钥。';
      tone = 'success';
    } else {
      text = '服务地址不同，请填写独立翻译密钥。';
      tone = translationEnabled ? 'warning' : 'neutral';
    }
  } catch {
    text = '请检查 API 地址。';
  }
  if (reuseNote.textContent !== text) reuseNote.textContent = text;
  reuseNote.dataset.tone = tone;

  const preview = $('subtitle-preview');
  const size = Math.min(48, Math.max(14, $('fontSize').valueAsNumber || DEFAULT_SETTINGS.fontSize));
  const offsetValue = $('bottomOffset').valueAsNumber;
  const offset = Number.isFinite(offsetValue) ? offsetValue : DEFAULT_SETTINGS.bottomOffset;
  preview.style.setProperty('--subtitle-font-size', `${size}px`);
  const transparency = $('backgroundTransparency').valueAsNumber;
  preview.style.setProperty('--subtitle-background-alpha', `${100 - transparency}%`);
  $('backgroundTransparency-value').textContent = `${transparency}%`;
  $('backgroundTransparency').setAttribute('aria-valuetext', `${transparency}%${transparency === 100 ? '，全透明' : ''}`);
  preview.style.setProperty('--subtitle-bottom', `${Math.min(88, Math.max(30, offset * 0.5 + 20))}px`);
  $('preview-translation').hidden = !translationEnabled;
  $('preview-original').hidden = translationEnabled && !$('bilingual').checked;
  preview.querySelector('.preview-subtitles').classList.toggle('is-original-only', !translationEnabled);
  preview.setAttribute('aria-label', `字幕样式预览：字号 ${size} 像素，${translationEnabled ? ($('bilingual').checked ? '原文与译文双语显示' : '仅显示译文') : '仅显示原文'}。`);
}

function updateDirtyState() {
  if (!ready || saving) return;
  const dirty = signature() !== savedSignature;
  discardButton.disabled = !dirty;
  setStatus(dirty ? '未保存' : '已载入', dirty ? 'dirty' : 'neutral');
}

function onFormEdit(event) {
  if (!event.target.matches('input, select')) return;
  clearError(event.target.id);
  if (['asrBaseUrl', 'translationBaseUrl', 'translateEnabled'].includes(event.target.id)) clearError('translationApiKey');
  updateDerivedUI();
  updateDirtyState();
}

function setSaving(value) {
  saving = value;
  fields.disabled = value || !ready;
  form.setAttribute('aria-busy', String(value));
  saveButton.textContent = value ? '正在保存…' : '保存设置';
  discardButton.disabled = value || signature() === savedSignature;
  updateDerivedUI();
}

// Do not insert an await (including permissions.contains) before request(). Chrome
// must receive the permission request in the Save click / submit user gesture.
async function onSave(event) {
  event.preventDefault();
  if (!ready || saving) return;
  const candidate = validateForm();
  if (!candidate) return;

  let permissionRequest;
  try {
    permissionRequest = chrome.permissions.request({ origins: candidate.origins });
  } catch {
    setStatus('无法申请服务访问权限，请从 Chrome 扩展的设置入口打开此页。', 'error');
    return;
  }
  setSaving(true);
  hideKeys();
  setStatus('正在申请所选服务的访问权限…');
  let stage = 'permission';
  try {
    const granted = await permissionRequest;
    if (!granted) {
      setStatus('未获得服务访问权限，设置尚未保存。允许访问后请重试。', 'error');
      return;
    }
    stage = 'save';
    setStatus('正在保存到本机…');
    const nextSettings = { ...savedSettings, ...candidate.settings,
      asrConcurrency:2,compressedChunkSeconds:120,chunkSeconds:25,
      asrTimeoutSeconds:180,translationTimeoutSeconds:180,translationBatchSize:50,
      maxAudioMB:300,maxDurationMinutes:180,collectionLimit:500,
    };
    const stored = await saveSettings(nextSettings);
    savedSettings = { ...nextSettings, ...stored };
    populate(savedSettings);
    savedSignature = signature();
    setStatus('已保存', 'success');
  } catch {
    // Do not expose exceptions that may contain endpoint credentials or API keys.
    setStatus(stage === 'permission'
      ? '服务访问权限申请失败，请确认地址有效后重试。设置尚未保存。'
      : '保存失败，请检查配置后重试。页面保留了你的更改。', 'error');
  } finally {
    setSaving(false);
    saveButton.focus({ preventScroll: true });
  }
}

async function initialize() {
  ready = false;
  fields.disabled = true;
  form.setAttribute('aria-busy', 'true');
  $('load-notice').hidden = true;
  $('retry-load').disabled = true;
  setStatus('正在读取本机设置…');
  try {
    const loaded = await loadSettings();
    if (loaded != null && (typeof loaded !== 'object' || Array.isArray(loaded))) {
      throw new Error('Unexpected settings response');
    }
    savedSettings = { ...DEFAULT_SETTINGS, ...loaded };
    populate(savedSettings);
    savedSignature = signature();
    ready = true;
    fields.disabled = false;
    discardButton.disabled = true;
    setStatus('已载入');
  } catch {
    $('load-error').textContent = '未能读取本机设置。请确认扩展已启用，然后重试；现有设置不会被覆盖。';
    $('load-notice').hidden = false;
    setStatus('本机设置读取失败，请点击“重新读取设置”。', 'error');
  } finally {
    form.setAttribute('aria-busy', 'false');
    $('retry-load').disabled = false;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} ${units[unit]}`;
}

function renderCacheStats(response) {
  const data = response?.data;
  if (response?.ok !== true || !Number.isSafeInteger(data?.count) || data.count < 0
      || !Number.isSafeInteger(data?.bytes) || data.bytes < 0) {
    throw new Error('Unexpected cache response');
  }
  $('cache-count').textContent = data.count.toLocaleString('zh-CN');
  $('cache-bytes').textContent = formatBytes(data.bytes);
  const checkpointsKnown = Number.isSafeInteger(data.checkpoints) && data.checkpoints >= 0;
  $('cache-checkpoints-row').hidden = !checkpointsKnown;
  $('cache-checkpoints').textContent = checkpointsKnown ? data.checkpoints.toLocaleString('zh-CN') : '—';
}

function setCacheBusy(value) {
  cacheBusy = value;
  for (const id of ['refresh-cache', 'clear-cache', 'confirm-clear-cache', 'cancel-clear-cache']) {
    $(id).disabled = value;
  }
}

function setCacheStatus(message, tone = 'neutral') {
  $('cache-status').textContent = message;
  $('cache-status').dataset.tone = tone;
}

async function refreshCache() {
  if (cacheBusy) return;
  setCacheBusy(true);
  setCacheStatus('正在读取缓存…');
  try {
    renderCacheStats(await chrome.runtime.sendMessage({ type: 'CACHE_STATS' }));
    setCacheStatus('');
  } catch {
    $('cache-count').textContent = '—';
    $('cache-bytes').textContent = '—';
    $('cache-checkpoints').textContent = '—';
    $('cache-checkpoints-row').hidden = true;
    setCacheStatus('暂时无法读取缓存，请稍后点击“刷新”重试。', 'error');
  } finally {
    setCacheBusy(false);
  }
}

function closeCacheConfirmation() {
  $('cache-confirm').hidden = true;
  $('clear-cache').setAttribute('aria-expanded', 'false');
}

async function clearCache() {
  if (cacheBusy || $('cache-confirm').hidden) return;
  setCacheBusy(true);
  setCacheStatus('正在清空缓存…');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
    if (response?.ok === false) {
      setCacheStatus(response.error === '请先取消正在运行的任务，再清空字幕缓存。'
        ? '正在处理字幕，暂时无法清空缓存。请等待任务完成，或先取消任务再重试。'
        : '缓存清理被拒绝，请确认没有正在运行的字幕任务后重试。', 'error');
      return;
    }
    renderCacheStats(response);
    closeCacheConfirmation();
    setCacheStatus('缓存清理已完成，设置与密钥保留。', 'success');
  } catch {
    setCacheStatus('未能确认缓存清理结果，请刷新检查或重试。', 'error');
  } finally {
    setCacheBusy(false);
    ($('cache-confirm').hidden ? $('clear-cache') : $('confirm-clear-cache')).focus({ preventScroll: true });
  }
}

form.addEventListener('submit', onSave);
form.addEventListener('input', onFormEdit);
form.addEventListener('change', (event) => {
  if (event.target.name === 'asrProvider' && event.target.checked) {
    const preset = presets[event.target.value];
    if (preset) {
      $('asrBaseUrl').value = preset.asrBaseUrl;
      $('asrModel').value = preset.asrModel;
      modelLists.asr=event.target.value==='siliconflow'?[...ASR_MODELS]:['whisper-1'];
      modelProvider=event.target.value;
      renderModels('asr');
      clearError('asrBaseUrl');
      clearError('asrModel');
      clearError('translationApiKey');
    }
  }
  onFormEdit(event);
});

for (const button of form.querySelectorAll('[data-reveal]')) {
  button.addEventListener('click', () => {
    const input = $(button.dataset.reveal);
    const revealing = input.type === 'password';
    input.type = revealing ? 'text' : 'password';
    button.textContent = revealing ? '隐藏' : '显示';
    button.setAttribute('aria-pressed', String(revealing));
    button.setAttribute('aria-label', `${revealing ? '隐藏' : '显示'}${input.id === 'asrApiKey' ? '语音识别' : '字幕翻译'} API 密钥`);
  });
}

$('use-asr-url').addEventListener('click', () => {
  $('translationBaseUrl').value = $('asrBaseUrl').value;
  clearError('translationBaseUrl');
  clearError('translationApiKey');
  updateDerivedUI();
  updateDirtyState();
  $('translationBaseUrl').focus();
});

for(const kind of ['asr','translation']) {
  $(`refresh-${kind}-models`).addEventListener('click',()=>void refreshModels(kind));
  $(`${kind}-model-select`).addEventListener('change',()=>{
    const select=$(`${kind}-model-select`),input=$(kind==='asr'?'asrModel':'translationModel');
    input.hidden=select.value!=='__custom__';
    if(input.hidden) input.value=select.value;else input.focus();
    clearError(input.id);updateDirtyState();
  });
}

discardButton.addEventListener('click', () => {
  if (!savedSettings || saving) return;
  populate(savedSettings);
  clearErrors();
  discardButton.disabled = true;
  setStatus('已撤销更改');
  saveButton.focus();
});

$('retry-load').addEventListener('click', initialize);
$('refresh-cache').addEventListener('click', refreshCache);
$('clear-cache').setAttribute('aria-controls', 'cache-confirm');
$('clear-cache').setAttribute('aria-expanded', 'false');
$('clear-cache').addEventListener('click', () => {
  if (cacheBusy) return;
  $('cache-confirm').hidden = false;
  $('clear-cache').setAttribute('aria-expanded', 'true');
  $('cancel-clear-cache').focus();
});
$('cancel-clear-cache').addEventListener('click', () => {
  closeCacheConfirmation();
  $('clear-cache').focus();
});
$('confirm-clear-cache').addEventListener('click', clearCache);
$('cache-confirm').addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !cacheBusy) {
    event.preventDefault();
    closeCacheConfirmation();
    $('clear-cache').focus();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) hideKeys();
});

chrome.storage.onChanged.addListener(async(changes,area)=>{
  if(area!=='local' || !changes.settings || !ready || saving) return;
  const version=++externalLoad;
  const next=await loadSettings().catch(()=>null);
  if(!next || version!==externalLoad || saving) return;
  const raw=rawSettings();
  const edits={};
  for(const key of settingKeys) {
    const previous=booleanKeys.has(key)?Boolean(savedSettings[key]):String(savedSettings[key]);
    if(raw[key]!==previous) edits[key]=raw[key];
  }
  savedSettings=next;
  populate(next);savedSignature=signature();
  if(Object.keys(edits).length) populate({...next,...edits});
  updateDirtyState();
});

window.addEventListener('beforeunload', (event) => {
  if (ready && (saving || signature() !== savedSignature)) {
    event.preventDefault();
    event.returnValue = '';
  }
});

populate(DEFAULT_SETTINGS);
void initialize();
void refreshCache();
