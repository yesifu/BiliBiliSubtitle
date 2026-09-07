import { checkAbort } from './network.js';

export async function downloadAudio(urls, maxBytes, signal, onProgress=()=>{}, {connectTimeout=10000,stallTimeout=15000,totalTimeout=300000}={}) {
  let lastError;
  const started=Date.now();
  for (const [index,url] of urls.entries()) {
    checkAbort(signal);
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener('abort',stop,{once:true});
    let timeoutPhase='连接';
    let timer=setTimeout(stop,Math.min(connectTimeout,Math.max(1,totalTimeout-(Date.now()-started))));
    const resetStall=()=>{
      clearTimeout(timer);timeoutPhase='接收数据';
      timer=setTimeout(stop,Math.min(stallTimeout,Math.max(1,totalTimeout-(Date.now()-started))));
    };
    try {
      if(Date.now()-started>=totalTimeout) throw new Error('音轨下载总耗时超过上限，请检查网络后重试。');
      onProgress(0,0,{host:new URL(url).hostname,index:index+1,totalSources:urls.length});
      const response = await fetch(url,{credentials:'omit',cache:'default',signal:controller.signal});
      resetStall();
      if (!response.ok) throw new Error(`音频下载失败（HTTP ${response.status}）。`);
      const length = Number(response.headers.get('content-length')) || 0;
      if (length>maxBytes) throw new Error('音轨超过设置中的大小上限，请提高上限或选择较短的视频。');
      const reader = response.body.getReader();
      const chunks = [];
      let received=0;
      while (true) {
        checkAbort(signal);
        const {value,done} = await reader.read();
        if (done) break;
        resetStall();
        received+=value.byteLength;
        if (received>maxBytes) {await reader.cancel();throw new Error('音轨超过设置中的大小上限，请提高上限或选择较短的视频。');}
        chunks.push(value);
        onProgress(received,length,{host:new URL(url).hostname,index:index+1,totalSources:urls.length});
      }
      if (received<44) throw new Error('下载的音频为空。');
      const result = new Uint8Array(received);
      let offset=0;
      for(const chunk of chunks) {result.set(chunk,offset);offset+=chunk.length;}
      return result.buffer;
    } catch(error) {
      checkAbort(signal);
      lastError = error.name==='AbortError' ? new Error(`音轨下载${timeoutPhase}超时：${new URL(url).hostname}，已尝试备用线路。`) : error;
      if (/上限/.test(lastError.message)) throw lastError;
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',stop);controller.abort();}
  }
  throw lastError || new Error('没有可下载的音频地址。');
}

export function encodeWav(samples,sampleRate=16000) {
  const buffer = new ArrayBuffer(44+samples.length*2);
  const view = new DataView(buffer);
  const text = (offset,value) => {for(let i=0;i<value.length;i++) view.setUint8(offset+i,value.charCodeAt(i));};
  text(0,'RIFF');view.setUint32(4,36+samples.length*2,true);text(8,'WAVE');text(12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
  text(36,'data');view.setUint32(40,samples.length*2,true);
  for(let i=0;i<samples.length;i++) {const x=Math.max(-1,Math.min(1,samples[i]));view.setInt16(44+i*2,x<0 ? x*32768 : x*32767,true);}
  return new Blob([buffer],{type:'audio/wav'});
}

export async function decodeAudio(bytes,maxDurationMinutes,signal) {
  checkAbort(signal);
  // decodeAudioData resamples into this context: 16 kHz dramatically reduces
  // retained PCM memory compared to a 48 kHz player AudioContext.
  const context = new AudioContext({sampleRate:16000});
  try {
    const audio = await context.decodeAudioData(bytes);
    checkAbort(signal);
    if (audio.duration > maxDurationMinutes*60+2) throw new Error('实际音频时长超过设置上限。');
    const mono = new Float32Array(audio.length);
    for(let channel=0;channel<audio.numberOfChannels;channel++) {
      const pcm=audio.getChannelData(channel);
      for(let i=0;i<pcm.length;i++) mono[i]+=pcm[i]/audio.numberOfChannels;
    }
    return {samples:mono,sampleRate:audio.sampleRate,duration:audio.duration};
  } catch(error) {
    if(error.name==='EncodingError' || error.name==='NotSupportedError') throw new Error('Chrome 无法解码此音轨；当前支持 B 站常见 AAC / M4A 音频。');
    throw error;
  } finally {await context.close();}
}

// Prefer a low-energy boundary near each slice end to avoid cutting words.
export function splitAudio(samples,sampleRate,chunkSeconds) {
  const chunks=[];
  const desired=Math.floor(chunkSeconds*sampleRate);
  const window=Math.floor(sampleRate*0.02);
  let start=0;
  while(start<samples.length) {
    let end=Math.min(samples.length,start+desired);
    if(end<samples.length) {
      const lower=Math.max(start+sampleRate*5,end-Math.floor(sampleRate*1.5));
      const upper=end;
      let quiet=Infinity;
      for(let at=lower;at+window<upper;at+=window) {
        let energy=0;
        for(let i=at;i<at+window;i++) energy+=samples[i]*samples[i];
        if(energy<quiet) {quiet=energy;end=at+Math.floor(window/2);}
      }
    }
    chunks.push({start,end,offset:start/sampleRate,duration:(end-start)/sampleRate});
    start=end;
  }
  return chunks;
}
