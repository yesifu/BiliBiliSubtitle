import { loadSettings, translationCredentials } from './shared/settings.js';
import { getVideoContext } from './shared/bilibili.js';
import { getTrack, getCheckpoint, cacheStats, clearCache } from './shared/cache.js';
import { exportSubtitles } from './shared/subtitles.js';
import { selectItems } from './shared/selection.js';
import { createAutoQueue } from './shared/auto-queue.js';
import { parseVideoUrl } from './shared/bilibili.js';
import { getSubtitleDelay, setSubtitleDelay } from './shared/display.js';

let creatingOffscreen;
let starting=false;
let cancellationRequested=false;
let pendingJobId=null;
let statusWrite=Promise.resolve();
let displayWrite=Promise.resolve();
let delayWrite=Promise.resolve();
const contextCache=new Map();
const OFFSCREEN_URL=chrome.runtime.getURL('offscreen.html');
const automatic=createAutoQueue({
  storage:()=>chrome.storage.session,
  getSettings:loadSettings,getContext:context,getStatus,
  start:entry=>startJob({url:entry.visitUrl,automatic:true,autoKind:entry.kind,autoItem:entry.item}),
  cancel:jobId=>offscreen('OFFSCREEN_CANCEL',{jobId}),
  tabExists:async(id,url)=>{try {const tab=await chrome.tabs.get(id);return sameVideo(tab.url,url);} catch {return false;}},
});

function sameVideo(a,b) {
  try {return JSON.stringify(parseVideoUrl(a))===JSON.stringify(parseVideoUrl(b));} catch {return false;}
}
const safePreferences=settings=>({translateEnabled:settings.translateEnabled,targetLanguage:settings.targetLanguage,autoEnabled:settings.autoEnabled,followNext:settings.followNext});

async function installRules() {
  await chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds:[101],addRules:[{
    id:101,priority:1,
    action:{type:'modifyHeaders',requestHeaders:[{header:'Referer',operation:'set',value:'https://www.bilibili.com/'}]},
    condition:{initiatorDomains:[chrome.runtime.id],requestDomains:['api.bilibili.com','bilivideo.com','bilivideo.cn','bilivideo.net','acgvideo.com','hdslb.com'],resourceTypes:['xmlhttprequest']},
  }]});
  // Keys stay inaccessible to content scripts, including scripts running on Bilibili.
  await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
}
chrome.runtime.onInstalled.addListener(()=>{void installRules();});
chrome.runtime.onStartup.addListener(()=>{void installRules();});

async function hasOffscreen() {
  return (await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[OFFSCREEN_URL]})).length>0;
}
async function ensureOffscreen() {
  if(await hasOffscreen()) return;
  if(!creatingOffscreen) creatingOffscreen=chrome.offscreen.createDocument({url:'offscreen.html',reasons:['BLOBS'],justification:'下载音频并在内存中解码、生成 WAV Blob，完整识别后缓存字幕。'}).finally(()=>{creatingOffscreen=null;});
  await creatingOffscreen;
}
const offscreen = (type,data={}) => chrome.runtime.sendMessage({target:'offscreen',type,...data});

async function saveStatus(job) {
  // Serialize writes so a slow earlier storage operation cannot overwrite completion.
  statusWrite=statusWrite.catch(()=>{}).then(async()=>{
    await chrome.storage.local.set({job});
    await chrome.action.setBadgeText({text:job.state==='running' ? `${Math.round(job.progress*100)}%` : job.state==='failed' ? '!' : ''});
    await chrome.action.setBadgeBackgroundColor({color:job.state==='failed'?'#b42318':'#ed4d4d'});
  });
  await statusWrite;
}

async function getStatus(ignorePreparing=false) {
  if(await hasOffscreen()) {
    const response=await offscreen('OFFSCREEN_STATUS').catch(()=>null);
    if(response?.data) return response.data;
  }
  const {job}=await chrome.storage.local.get('job');
  if(job?.state==='running' && (!starting || ignorePreparing)) {
    const stopped={...job,state:'failed',phase:'failed',detail:'浏览器关闭或扩展重载导致任务中断，重新开始会复用已完成的视频缓存。',error:'任务已中断。',updatedAt:Date.now()};
    await saveStatus(stopped);
    return stopped;
  }
  return job || null;
}

async function context(url) {
  const cached=contextCache.get(url);
  if(cached && Date.now()-cached.time<45000) return cached.data;
  const data=await getVideoContext(url);
  if(contextCache.size>30) contextCache.clear();
  contextCache.set(url,{data,time:Date.now()});
  return data;
}

async function notifyTabs(message,excludeTabId) {
  const tabs=await chrome.tabs.query({url:'https://www.bilibili.com/*'});
  await Promise.allSettled(tabs.filter(tab=>tab.id!==excludeTabId).map(tab=>chrome.tabs.sendMessage(tab.id,message)));
}

async function startJob(message) {
  if(starting) throw new Error('正在准备任务，请稍等。');
  starting=true;
  cancellationRequested=false;
  try {
    if((await getStatus(true))?.state==='running') throw new Error('已有字幕任务正在运行，请等待完成或先取消。');
    const settings=await loadSettings();
    if(!message.automatic && settings.translateEnabled && !translationCredentials(settings).apiKey) throw new Error('请在设置中填写 API Key。翻译与识别使用不同域名时，需要分别填写 Key。');
    for(const base of [settings.asrBaseUrl,...(settings.translateEnabled?[settings.translationBaseUrl]:[])]) {
      const endpoint=new URL(base);
      const origin=`${endpoint.protocol}//${endpoint.hostname}/*`;
      if(!await chrome.permissions.contains({origins:[origin]})) throw new Error('尚未授权访问自定义 API，请打开设置并重新保存以授权。');
    }
    await installRules();
    const info=message.automatic ? null : await context(message.url);
    const scope=message.scope || 'current';
    let items=message.automatic ? [message.autoItem] : selectItems(info,scope,message.selection);
    if(!items?.length) throw new Error('未找到所选范围的视频，请选择当前视频。');
    // Never silently truncate a requested collection.
    if(items.length>500) throw new Error('单次最多处理 500 个视频，请使用自由选择。');
    settings.collectionLimit=500;
    settings.maxAudioMB=300;settings.maxDurationMinutes=180;
    items=items.map(({bvid,cid,title,duration,page,cover})=>({bvid,cid,title,duration,page,cover}));
    if(cancellationRequested) throw new Error('任务准备已取消。');
    const job={id:crypto.randomUUID(),state:'running',phase:'queued',currentIndex:0,total:items.length,currentTitle:items[0].title,progress:0,detail:'准备开始',results:[],createdAt:Date.now(),updatedAt:Date.now(),automatic:Boolean(message.automatic),autoKind:message.autoKind};
    pendingJobId=job.id;
    await ensureOffscreen();
    if(cancellationRequested) throw new Error('任务准备已取消。');
    await saveStatus(job);
    if(cancellationRequested) {
      const cancelled={...job,state:'cancelled',phase:'cancelled',detail:'任务准备已取消。'};
      await saveStatus(cancelled);
      return cancelled;
    }
    try {
      const response=await offscreen('OFFSCREEN_START',{job,settings,items,force:Boolean(message.force)});
      if(!response?.ok) throw new Error(response?.error || '音频处理页面未启动。');
      if(cancellationRequested) await offscreen('OFFSCREEN_CANCEL',{jobId:job.id});
    } catch(error) {
      if(cancellationRequested) {
        const cancelled={...job,state:'cancelled',phase:'cancelled',detail:'任务准备已取消。'};
        await saveStatus(cancelled);return cancelled;
      }
      await saveStatus({...job,state:'failed',phase:'failed',error:error.message,detail:error.message});throw error;
    }
    return job;
  } finally {starting=false;pendingJobId=null;}
}

async function trackWithDisplay(bvid,cid) {
  const settings=await loadSettings();
  let track=await getTrack(bvid,Number(cid),settings);
  if(!track && settings.translateEnabled) track=await getTrack(bvid,Number(cid),{...settings,translateEnabled:false});
  if(!track) {
    const transcript=await getCheckpoint(bvid,Number(cid),settings);
    if(transcript?.cues?.length) track={...transcript,bvid,cid:Number(cid),title:transcript.title || bvid,targetLanguage:'',cues:transcript.cues.map(c=>({...c,text:c.source || c.text}))};
  }
  return track ? {...track,translationPending:settings.translateEnabled && !track.targetLanguage,settings:{bilingual:Boolean(track.targetLanguage)&&settings.bilingual,fontSize:settings.fontSize,bottomOffset:settings.bottomOffset,backgroundTransparency:settings.backgroundTransparency}} : null;
}

async function handle(message,sender) {
  switch(message.type) {
    case 'GET_SUBTITLE_DELAY':
      return {delay:await getSubtitleDelay(message.bvid,message.cid)};
    case 'SET_SUBTITLE_DELAY': {
      if(sender.frameId!==0 || !sender.tab?.id || !sameVideo(sender.url,message.url)) throw new Error('无效的视频页面。');
      delayWrite=delayWrite.catch(()=>{}).then(async()=>{
        const info=await context(sender.url);
        if(info.bvid!==message.bvid || info.cid!==Number(message.cid)) throw new Error('字幕与当前视频不匹配。');
        const delay=await setSubtitleDelay(info.bvid,info.cid,message.value);
        await notifyTabs({type:'SUBTITLE_DELAY_UPDATED',bvid:info.bvid,cid:info.cid},sender.tab.id);
        return {delay};
      });
      return delayWrite;
    }
    case 'GET_DISPLAY_SETTINGS':
      return {backgroundTransparency:(await loadSettings()).backgroundTransparency};
    case 'SET_BACKGROUND_TRANSPARENCY': {
      const isPlayer=sender.frameId===0 && sender.tab?.id && /^https:\/\/www\.bilibili\.com\/video\//.test(sender.url || '');
      if(!isPlayer || !Number.isInteger(message.value) || message.value<0 || message.value>100) throw new Error('无效的字幕透明度。');
      // Only this display preference can be changed by the player; never accept keys or model settings.
      displayWrite=displayWrite.catch(()=>{}).then(async()=>{
        const settings={...await loadSettings(),backgroundTransparency:message.value};
        await chrome.storage.local.set({settings});
        await notifyTabs({type:'DISPLAY_SETTINGS_UPDATED'},sender.tab.id);
        return {backgroundTransparency:settings.backgroundTransparency};
      });
      return displayWrite;
    }
    case 'GET_TRANSLATION_PREFERENCE': {
      return safePreferences(await loadSettings());
    }
    case 'SET_TRANSLATION_PREFERENCE': {
      if(sender.url!==chrome.runtime.getURL('popup.html') || typeof message.enabled!=='boolean') throw new Error('请通过插件弹窗切换翻译。');
      if(message.enabled && (await getStatus())?.state==='running') throw new Error('请等待当前任务结束后再开启翻译。');
      const settings={...await loadSettings(),translateEnabled:message.enabled,translationPreferenceVersion:1};
      await chrome.storage.local.set({settings});
      if(!message.enabled && await hasOffscreen()) await offscreen('OFFSCREEN_DISABLE_TRANSLATION');
      await notifyTabs({type:'SETTINGS_UPDATED'});
      return safePreferences(settings);
    }
    case 'SET_AUTO_PREFERENCE': {
      if(sender.url!==chrome.runtime.getURL('popup.html') || !['autoEnabled','followNext'].includes(message.key) || typeof message.enabled!=='boolean') throw new Error('请通过插件界面设置自动识别。');
      const settings={...await loadSettings(),[message.key]:message.enabled};
      await chrome.storage.local.set({settings});
      await automatic.settingsChanged();
      await notifyTabs({type:'SETTINGS_UPDATED'});
      return safePreferences(settings);
    }
    case 'VIDEO_VISIT': {
      if(sender.frameId!==0 || !sender.tab?.id || !sameVideo(sender.url,message.url)) throw new Error('无效的视频页面。');
      if(!message.visible) return null;
      await automatic.visit(message.url,sender.tab.id,Boolean(message.playing));return null;
    }
    case 'GET_AUTO_STATUS': return automatic.status();
    case 'GET_VIDEO_CONTEXT': return context(message.url);
    case 'GET_STATUS': return getStatus();
    case 'GET_TRACK': return trackWithDisplay(message.bvid,message.cid);
    case 'START_JOB':
      if(sender.url!==chrome.runtime.getURL('popup.html')) throw new Error('请通过插件弹窗开始任务。');
      return startJob(message);
    case 'CANCEL_JOB':
      cancellationRequested=true;
      if(chrome.storage.session) await automatic.stop();
      if(await hasOffscreen()) await offscreen('OFFSCREEN_CANCEL',{jobId:pendingJobId});
      return null;
    case 'OPEN_OPTIONS': await chrome.runtime.openOptionsPage();return null;
    case 'SETTINGS_UPDATED':
      if(!(await loadSettings()).translateEnabled && await hasOffscreen()) await offscreen('OFFSCREEN_DISABLE_TRANSLATION');
      await automatic.settingsChanged();
      await notifyTabs({type:'SETTINGS_UPDATED'});return null;
    case 'CACHE_STATS': return cacheStats();
    case 'CLEAR_CACHE':
      if((await getStatus())?.state==='running' || starting) throw new Error('请先取消正在运行的任务，再清空字幕缓存。');
      await clearCache();await notifyTabs({type:'SETTINGS_UPDATED'});return cacheStats();
    case 'EXPORT_TRACK': {
      const track=await trackWithDisplay(message.bvid,message.cid);
      if(!track) throw new Error('此视频还没有生成字幕。');
      const format=message.format==='vtt'?'vtt':'srt';
      // The popup creates a Blob download, avoiding broad downloads permission.
      return {filename:`${track.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,120)}.${format}`,content:exportSubtitles(track,format,track.settings.bilingual),mime:format==='vtt'?'text/vtt':'application/x-subrip'};
    }
    case 'JOB_PROGRESS':
      if(sender.url!==OFFSCREEN_URL) throw new Error('无效的任务状态来源。');
      await saveStatus(message.job);
      if(message.job.state!=='running') await automatic.resume();
      return null;
    case 'TRACK_READY':
      if(sender.url!==OFFSCREEN_URL) throw new Error('无效的字幕来源。');
      await notifyTabs({type:'TRACK_READY',bvid:message.bvid,cid:message.cid});return null;
    default: throw new Error('未知的插件请求。');
  }
}

chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id || !message || message.target==='offscreen') return;
  handle(message,sender).then(data=>respond({ok:true,data}),error=>respond({ok:false,error:error.message || '操作失败。'}));
  return true;
});
