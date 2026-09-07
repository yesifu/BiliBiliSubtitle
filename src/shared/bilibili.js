import { md5 } from './md5.js';
import { requestJSON, checkAbort } from './network.js';
import { normalizeCues } from './subtitles.js';

const API = 'https://api.bilibili.com';
const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
let wbiKeys;

export function parseVideoUrl(value) {
  const url = new URL(value);
  if (url.hostname !== 'www.bilibili.com' || url.protocol !== 'https:') throw new Error('请打开 B 站视频页面后使用插件。');
  const match = url.pathname.match(/^\/video\/(BV[0-9a-zA-Z]{10}|av\d+)(?:\/|$)/i);
  if (!match) throw new Error('当前页面不是受支持的 BV / av 视频页面。');
  const page = Math.max(1,parseInt(url.searchParams.get('p'),10) || 1);
  return /^av/i.test(match[1]) ? {aid:match[1].slice(2),page} : {bvid:'BV'+match[1].slice(2),page};
}

async function api(path, params, signal) {
  const query = typeof params === 'string' ? params : new URLSearchParams(params).toString();
  const result = await requestJSON(`${API}${path}?${query}`,{credentials:'include'},{signal,timeout:15000,label:'B 站视频信息'});
  if (result.code !== 0) {
    const reason = result.code===-101 ? '请先登录 B 站' : result.code===-404 ? '视频不存在或已下架' : result.code===-412 || result.code===-352 ? 'B 站风控限制，请稍后重试' : result.code===-403 ? '当前账号无法访问此视频' : 'B 站接口不可用';
    const error = new Error(`${reason}（${result.code}）。`);
    error.code = result.code;
    throw error;
  }
  return result.data;
}

export function signWbi(params, imgKey, subKey, now=Math.floor(Date.now()/1000)) {
  const joined = imgKey + subKey;
  const mixin = MIXIN.map(i=>joined[i] || '').join('').slice(0,32);
  const values = {...params,wts:now};
  const query = Object.keys(values).sort().map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(values[key]).replace(/[!'()*]/g,''))}`).join('&');
  return query + '&w_rid=' + md5(query+mixin);
}

async function signedApi(path,params,signal) {
  if (!wbiKeys || Date.now()-wbiKeys.time>3600000) {
    // A logged-out nav response still includes the public WBI image keys.
    const nav = await requestJSON(`${API}/x/web-interface/nav`,{credentials:'include'},{signal,timeout:12000,label:'B 站音轨签名'});
    const wbi = nav.data?.wbi_img;
    const key = value => new URL(value).pathname.split('/').pop().split('.')[0];
    if (!wbi?.img_url || !wbi?.sub_url) throw new Error('未能获取 B 站音频签名，请刷新视频页面后重试。');
    wbiKeys = {img:key(wbi.img_url),sub:key(wbi.sub_url),time:Date.now()};
  }
  try { return await api(path,signWbi(params,wbiKeys.img,wbiKeys.sub),signal); }
  catch (error) { if (error.code===-403 || error.code===-352) wbiKeys=null; throw error; }
}

export function contextFromView(data, page=1) {
  const base = {bvid:data.bvid,title:data.title,cover:data.pic || ''};
  const pages = (data.pages || []).map(p => ({...base,cid:Number(p.cid),page:Number(p.page),title:data.pages.length>1 ? `${data.title} · P${p.page} ${p.part}` : data.title,duration:Number(p.duration)||0}));
  const current = pages.find(p=>p.page===page);
  if (!current) throw new Error(`这个视频没有第 ${page} P。`);
  const episodes = data.ugc_season?.sections?.flatMap(s=>s.episodes || []) || [];
  const seen = new Set();
  const season = episodes.flatMap(e => {
    const bvid = e.bvid || e.arc?.bvid;
    const cid = Number(e.cid || e.page?.cid || e.pages?.[0]?.cid);
    if (!bvid || !cid || seen.has(`${bvid}:${cid}`)) return [];
    seen.add(`${bvid}:${cid}`);
    return [{bvid,cid,title:e.title || e.arc?.title || bvid,cover:e.arc?.pic || '',duration:Number(e.page?.duration || e.arc?.duration || e.duration)||0,page:Number(e.page?.page)||1}];
  });
  return {...current,groups:{pages,season},seasonTitle:data.ugc_season?.title || '',seasonTotal:Number(data.ugc_season?.ep_count)||season.length};
}

export async function getVideoContext(url, signal) {
  const {page,...params} = parseVideoUrl(url);
  return contextFromView(await api('/x/web-interface/view',params,signal),page);
}

export function allowedMediaUrl(value) {
  let url;
  try { url = new URL(value.startsWith('//') ? `https:${value}` : value); } catch { return null; }
  if (url.protocol === 'http:') url.protocol='https:';
  const domains = ['bilivideo.com','bilivideo.cn','bilivideo.net','acgvideo.com','hdslb.com','bilibili.com'];
  if (url.protocol!=='https:' || url.username || url.password || !domains.some(d=>url.hostname===d || url.hostname.endsWith('.'+d))) return null;
  return url.href;
}

export async function getAudioSources(item, signal) {
  const params = {bvid:item.bvid,cid:item.cid,fnval:16,fnver:0,fourk:0,qn:16};
  let data;
  try {data = await signedApi('/x/player/wbi/playurl',params,signal);}
  catch(error) {checkAbort(signal);data = await api('/x/player/playurl',params,signal);}
  const streams = [...(data.dash?.audio || [])].sort((a,b)=>Number(a.bandwidth)-Number(b.bandwidth));
  if (!streams.length) throw new Error('B 站没有提供可读取的独立音轨。请登录并确认该视频可正常播放；当前不支持仅提供 FLV 或受保护的媒体。');
  const sources=rankAudioSources(streams);
  const urls = sources.map(source=>source.url);
  if (!urls.length) throw new Error('音频 CDN 地址不在插件支持范围内。');
  return {urls,sources,duration:Number(data.dash.duration || data.timelength/1000 || item.duration)};
}

export function rankAudioSources(streams) {
  const seen=new Set();
  return streams.flatMap(audio=>[audio.baseUrl || audio.base_url,...(audio.backupUrl || audio.backup_url || [])].filter(Boolean).flatMap(value=>{
    const url=allowedMediaUrl(value);
    if(!url || seen.has(url)) return [];
    seen.add(url);
    const parsed=new URL(url);
    return [{url,bandwidth:Number(audio.bandwidth)||Infinity,codec:audio.codecs || '',peer:Boolean(parsed.port) || /(^|\.)(mcdn|szbdyd)\./.test(parsed.hostname),aac:!audio.codecs || audio.codecs.startsWith('mp4a')}];
  })).sort((a,b)=>Number(b.aac)-Number(a.aac) || Number(a.peer)-Number(b.peer) || a.bandwidth-b.bandwidth);
}

export function selectNativeSubtitle(subtitles, sourceLanguage) {
  const normalize = language => String(language || '').toLowerCase().replace(/^ai-/,'').replace(/_/g,'-');
  const requested=normalize(sourceLanguage);
  if(requested==='auto') return subtitles.find(s=>!s.lan?.startsWith('ai-')) || subtitles[0] || null;
  const exact=subtitles.filter(s=>normalize(s.lan)===requested);
  const candidates=exact.length ? exact : subtitles.filter(s=>normalize(s.lan).split('-')[0]===requested.split('-')[0]);
  return candidates.find(s=>!s.lan?.startsWith('ai-')) || candidates[0] || null;
}

export async function getNativeSubtitles(item, settings, signal) {
  let player;
  try {player = await signedApi('/x/player/wbi/v2',{bvid:item.bvid,cid:item.cid},signal);}
  catch(error) {
    checkAbort(signal);
    try {player = await api('/x/player/v2',{bvid:item.bvid,cid:item.cid},signal);} catch {checkAbort(signal);return null;}
  }
  const subtitles = player.subtitle?.subtitles || [];
  if (!subtitles.length) return null;
  const selected = selectNativeSubtitle(subtitles,settings.sourceLanguage);
  if(!selected) return null;
  const url = allowedMediaUrl(selected.subtitle_url);
  if (!url) return null;
  try {
    const result = await requestJSON(url,{credentials:'omit'},{signal,timeout:12000,label:'B 站原生字幕'});
    const cues = normalizeCues(result.body || []);
    return cues.length ? {cues,timing:'native',sourceLanguage:selected.lan_doc || selected.lan} : null;
  } catch {checkAbort(signal);return null;}
}
