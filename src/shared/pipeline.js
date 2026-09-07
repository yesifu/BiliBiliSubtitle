import { getAudioSources, getNativeSubtitles } from './bilibili.js';
import { downloadAudio, decodeAudio, splitAudio } from './audio.js';
import { splitCompressedAudio } from './compressed-audio.js';
import { splitSpeechAudio } from './speech-audio.js';
import { transcribeChunk, transcribeBlob, translateCues, mapConcurrent } from './providers.js';
import { getTrack, putTrack, getCheckpoint, putCheckpoint } from './cache.js';
import { normalizeCues } from './subtitles.js';
import { checkAbort } from './network.js';
import { md5 } from './md5.js';
import { trackVariant, translationCredentials } from './settings.js';
import { withRecognitionFallback, MODE_LABELS } from './recognition-policy.js';

export function audioFileType(bytes) {
  const head=new Uint8Array(bytes,0,Math.min(16,bytes.byteLength));
  const tag=(start,end)=>String.fromCharCode(...head.slice(start,end));
  if(tag(4,8)==='ftyp') return {filename:'audio.m4a',type:'audio/mp4'};
  if(tag(0,4)==='RIFF' && tag(8,12)==='WAVE') return {filename:'audio.wav',type:'audio/wav'};
  if(tag(0,3)==='ID3' || head[0]===255 && (head[1]&0xe0)===0xe0) return {filename:'audio.mp3',type:'audio/mpeg'};
  throw new Error('音轨格式无法识别，可能下载到了错误页面，请重新获取视频音轨。');
}

export function uploadByteLimit(settings) {
  // Compatible gateways differ; use a conservative 24 MB in verbose_json mode.
  return settings?.asrProvider==='openai'?24_000_000:49_000_000;
}

export function canUploadWhole(byteLength,duration,settings) {
  // Conservative decimal MB limit; avoids different MB/MiB interpretations.
  return byteLength>0 && byteLength<=uploadByteLimit(settings) && duration>0 && duration<=3600;
}

async function recognize(item,settings,force,signal,progress) {
  let transcript=!force ? await getCheckpoint(item.bvid,item.cid,settings) : null;
  if(transcript) {progress('transcribing',0.70,'已复用完整识别原文，无需重新下载或上传音轨');return transcript;}
  progress('metadata',0.01,'读取视频字幕与音轨');
  transcript=settings.preferNativeSubtitles ? await getNativeSubtitles(item,settings,signal) : null;
  if(transcript) return transcript;
  if(!settings.asrApiKey) throw new Error('该视频没有可用字幕，请先在设置中填写语音识别 API Key。');
  if(item.duration>settings.maxDurationMinutes*60) throw new Error(`暂不支持超过 ${settings.maxDurationMinutes} 分钟的单个视频。`);
  const audio=await getAudioSources(item,signal);
  const duration=Math.max(audio.duration || 0,item.duration || 0);
  if(duration>settings.maxDurationMinutes*60+2) throw new Error('音轨时长超过设置中的处理上限。');
  progress('downloading',0.03,'下载最低码率独立音轨');
  let bytes=await downloadAudio(audio.urls,settings.maxAudioMB*1024*1024,signal,(received,total,source)=>{
    progress('downloading',0.03+(total?received/total:0)*0.1,`音轨 ${(received/1048576).toFixed(2)}${total?' / '+(total/1048576).toFixed(2):''} MB · ${source?.host || ''} · 线路 ${source?.index || 1}`);
  });
  const audioBytes=bytes.byteLength;
  const format=audioFileType(bytes);
  return withRecognitionFallback(settings.asrMode,signal,async mode=>{
  if(mode==='whole') {
    if(!canUploadWhole(audioBytes,duration,settings)) throw new Error('音轨超过单次上传限制。');
    const blob=new Blob([bytes],{type:format.type});
    progress('uploading',0.17,`整段直传 ${(blob.size/1048576).toFixed(2)} MB 原始音轨，共 1 次识别请求，无需解码转码`);
    const started=Date.now();
    const result=await transcribeBlob(blob,format.filename,0,duration,settings,signal,event=>{
      if(event.done) progress('transcribing',0.30,`完整音轨已上传，等待平台识别；最长等待 ${settings.asrTimeoutSeconds} 秒`);
      else progress('uploading',0.17+(event.total?event.loaded/event.total:0)*0.12,`整段音轨上传 ${event.total?Math.round(event.loaded/event.total*100)+'%':(event.loaded/1048576).toFixed(2)+' MB'}`);
    }).catch(error=>{error.phase=error.phase || 'transcribing';throw error;});
    if(!result.cues.length) throw new Error('整段识别未返回字幕，尝试分段识别。');
    return {...result,timing:result.timing==='approximate'?'whole-approximate':result.timing,sourceLanguage:settings.sourceLanguage,mode:'whole',audioBytes,requestCount:1,recognitionSeconds:(Date.now()-started)/1000};
  }
  let units,pcm;
  if(mode==='speech') {
    progress('decoding',0.14,'分析原始音轨中的说话与停顿位置，生成短句字幕');
    pcm=await decodeAudio(bytes.slice(0),settings.maxDurationMinutes,signal);
    units=splitSpeechAudio(pcm.samples,pcm.sampleRate);
    if(!units.length) throw new Error('音轨中未检测到可识别的语音，请确认视频中有人声。');
  }
  if(mode==='compressed') {
    if(format.type!=='audio/mp4') throw new Error('此音轨需要兼容识别。');
    progress('preparing_audio',0.14,`整理压缩音轨，每段约 ${settings.compressedChunkSeconds} 秒；保留原始音质，无需解码转码`);
    units=await splitCompressedAudio(bytes,{seconds:settings.compressedChunkSeconds,maxBytes:Math.min(45_000_000,uploadByteLimit(settings))});
  }
  if(!units) {
    mode='timed';
    progress('decoding',0.14,'兼容模式：解码音轨并按静音边界切成小段');
    pcm=await decodeAudio(bytes.slice(0),settings.maxDurationMinutes,signal);
    units=splitAudio(pcm.samples,pcm.sampleRate,settings.chunkSeconds);
  }
  checkAbort(signal);
  let completed=0,resumed=0,requests=0;
  progress('transcribing',0.18,`共 ${units.length} 段，优先复用已识别片段`);
  const parts=await mapConcurrent(units,settings.asrConcurrency,async(unit,i)=>{
    const key=`part:${mode}:${i}:${Math.round(unit.offset*1000)}:${Math.round(unit.duration*1000)}:${unit.blob?.size || audioBytes}`;
    let result=!force ? await getCheckpoint(item.bvid,item.cid,settings,key) : null;
    if(result) resumed++;
    else {
      requests++;
      try {
        result=mode==='timed' || mode==='speech' ? await transcribeChunk(pcm.samples,pcm.sampleRate,unit,settings,signal,mode==='speech'?{textTiming:'speech'}:{})
          : await transcribeBlob(unit.blob,unit.filename,unit.offset,unit.duration,settings,signal);
      } catch(error) {error.phase=error.phase || 'transcribing';error.message=`第 ${i+1} / ${units.length} 段 · ${error.message}`;throw error;}
      await putCheckpoint(item.bvid,item.cid,settings,key,result);
    }
    completed++;
    progress('transcribing',0.18+completed/units.length*0.52,`已识别 ${completed} / ${units.length} 段${resumed?`，复用 ${resumed} 段`:''}；已完成片段已保存，失败可续传`);
    return result;
  },signal);
  pcm=null;
  if(!parts.some(part=>part.cues.length)) throw new Error('未识别出语音或可用字幕。');
  const timing=parts.some(part=>part.timing==='approximate')?'approximate':parts.some(part=>part.timing==='speech')?'speech':'precise';
  return {cues:normalizeCues(parts.flatMap(part=>part.cues)),timing,sourceLanguage:settings.sourceLanguage,mode,audioBytes,requestCount:requests,partCount:units.length};
  },(previous,next)=>progress('preparing_audio',0.14,`${MODE_LABELS[previous]}未完成，自动切换${MODE_LABELS[next]}`));
}

export async function processItem(item,settings,force,signal,progress,control={}) {
  if(control.skipNative) {
    const native=await getNativeSubtitles(item,{...settings,sourceLanguage:'auto'},signal);
    checkAbort(signal);
    if(native) {progress('completed',1,'已有原生字幕，跳过自动处理');return {track:null,status:'skipped'};}
  }
  if(!force) {
    const cached=await getTrack(item.bvid,item.cid,settings);
    if(cached) {progress('completed',1,'已读取本地字幕缓存');return {track:cached,status:'cached'};}
  }
  checkAbort(signal);
  const transcript=await recognize(item,settings,force,signal,progress);
  checkAbort(signal);
  if(!transcript.cues.length) throw new Error('未识别出语音或可用字幕；该音轨可能只有音乐、静音或语言不受支持。');
  await putCheckpoint(item.bvid,item.cid,settings,'transcript',{...transcript,title:item.title,duration:item.duration});
  const {mode,audioBytes,requestCount,partCount,recognitionSeconds}=transcript;
  const original={bvid:item.bvid,cid:item.cid,title:item.title,cues:transcript.cues.map(c=>({...c,text:c.source || c.text})),timing:transcript.timing,sourceLanguage:transcript.sourceLanguage,targetLanguage:'',duration:item.duration,mode,audioBytes,requestCount,partCount,recognitionSeconds};
  await putTrack(original,{...settings,translateEnabled:false});
  await control.onOriginalReady?.();
  let cues=transcript.cues;
  if(settings.translateEnabled) {
    if(!translationCredentials(settings).apiKey) throw new Error('请在设置中填写翻译 API Key。原文字幕已保存。');
    progress('translating',0.71,`完整识别原文已保存，共 ${cues.length} 条，开始统一翻译`);
    const prefix=`translation:${md5(trackVariant(settings))}:`;
    const translation=new AbortController();
    control.translationController=translation;
    const abort=()=>translation.abort();
    signal?.addEventListener('abort',abort,{once:true});
    try {
      checkAbort(signal);
      cues=await translateCues(cues,settings,translation.signal,(p,detail)=>progress('translating',0.71+p*0.27,detail),{
      get:force?async()=>null:key=>getCheckpoint(item.bvid,item.cid,settings,prefix+key),
      put:(key,value)=>putCheckpoint(item.bvid,item.cid,settings,prefix+key,value),
      });
    } catch(error) {
      checkAbort(signal);
      if(settings.translateEnabled || !translation.signal.aborted) throw error;
      cues=original.cues;
      progress('saving',0.99,'翻译已关闭，直接使用已识别的原文字幕');
    } finally {signal?.removeEventListener('abort',abort);control.translationController=null;}
  }
  checkAbort(signal);
  progress('saving',0.99,'保存完整字幕');
  if(!settings.translateEnabled) return {track:original,status:'completed'};
  const track=await putTrack({bvid:item.bvid,cid:item.cid,title:item.title,cues,timing:transcript.timing,sourceLanguage:transcript.sourceLanguage,targetLanguage:settings.translateEnabled?settings.targetLanguage:'',duration:item.duration,mode,audioBytes,requestCount,partCount,recognitionSeconds},settings);
  return {track,status:'completed'};
}
