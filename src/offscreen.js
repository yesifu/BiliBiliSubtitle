import { processItem } from './shared/pipeline.js';
import { checkAbort } from './shared/network.js';

let active=null;
const cancelledJobs=new Set();
const send = message => chrome.runtime.sendMessage({target:'background',...message}).catch(()=>{});

function publish(activeJob,changes={},force=false) {
  Object.assign(activeJob.status,changes,{updatedAt:Date.now()});
  if(force || !activeJob.lastSent || Date.now()-activeJob.lastSent>350) {
    activeJob.lastSent=Date.now();
    void send({type:'JOB_PROGRESS',job:structuredClone(activeJob.status)});
  }
}

async function run(job,settings,items,force) {
  const controller=new AbortController();
  const current={status:structuredClone(job),controller,settings,control:{skipNative:Boolean(job.automatic)},lastSent:0};
  active=current;
  const heartbeat=setInterval(()=>publish(current,{},true),15000);
  try {
    for(let i=0;i<items.length;i++) {
      checkAbort(controller.signal);
      const item=items[i];
      const itemStarted=Date.now();
      let latestPhase='queued',latestDetail='准备处理';
      publish(current,{currentIndex:i+1,currentTitle:item.title,phase:'queued',detail:'准备处理',progress:i/items.length},true);
      try {
        current.control.onOriginalReady=()=>send({type:'TRACK_READY',bvid:item.bvid,cid:item.cid});
        const result=await processItem(item,settings,force,controller.signal,(phase,p,detail)=>{
          latestPhase=phase;latestDetail=detail;
          publish(current,{phase,detail,phaseStartedAt:current.status.phase===phase?current.status.phaseStartedAt:Date.now(),progress:(i+p)/items.length});
        },current.control);
        current.status.results.push({bvid:item.bvid,cid:item.cid,title:item.title,status:result.status,phase:'completed',elapsedSeconds:Math.round((Date.now()-itemStarted)/1000)});
        await send({type:'TRACK_READY',bvid:item.bvid,cid:item.cid});
      } catch(error) {
        checkAbort(controller.signal);
        const names={metadata:'视频信息',downloading:'音轨下载',preparing_audio:'压缩音轨整理',decoding:'音轨解码',uploading:'音轨上传',transcribing:'语音识别',translating:'字幕翻译',saving:'保存字幕'};
        const phase=error.phase || latestPhase;
        current.status.results.push({bvid:item.bvid,cid:item.cid,title:item.title,status:'failed',phase,detail:latestDetail,elapsedSeconds:Math.round((Date.now()-itemStarted)/1000),error:`${names[phase] || '处理'}阶段失败：${error.message || '未知错误'}`});
      }
      publish(current,{progress:(i+1)/items.length},true);
    }
    const failures=current.status.results.filter(r=>r.status==='failed');
    const skipped=current.status.results.filter(r=>r.status==='skipped').length;
    const allFailed=failures.length===items.length;
    publish(current,{state:allFailed?'failed':'completed',phase:allFailed?'failed':'completed',progress:1,detail:skipped===items.length?'已有原生字幕，已跳过自动识别与翻译':failures.length ? `${items.length-failures.length} 个成功，${failures.length} 个失败，可重试并复用已完成缓存` : '字幕已准备好，播放时自动显示',error:allFailed ? failures[0].error : undefined},true);
  } catch(error) {
    const cancelled=controller.signal.aborted;
    publish(current,{state:cancelled?'cancelled':'failed',phase:cancelled?'cancelled':'failed',detail:cancelled?'已取消，已完成的视频字幕仍保留在本地':error.message,error:cancelled?undefined:error.message},true);
  } finally {clearInterval(heartbeat);}
}

chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id || message.target!=='offscreen') return;
  if(message.type==='OFFSCREEN_STATUS') {respond({ok:true,data:active?.status || null});return;}
  if(message.type==='OFFSCREEN_DISABLE_TRANSLATION') {
    if(active?.status.state==='running') {
      active.settings.translateEnabled=false;
      active.control.translationController?.abort();
    }
    respond({ok:true});return;
  }
  if(message.type==='OFFSCREEN_CANCEL') {
    if(message.jobId) {
      cancelledJobs.add(message.jobId);
      if(cancelledJobs.size>30) cancelledJobs.delete(cancelledJobs.values().next().value);
    }
    if(!message.jobId || active?.status.id===message.jobId) active?.controller.abort();
    respond({ok:true});return;
  }
  if(message.type==='OFFSCREEN_START') {
    if(cancelledJobs.has(message.job.id)) {respond({ok:false,error:'任务准备已取消。'});return;}
    if(active?.status.state==='running') {respond({ok:false,error:'已有字幕任务正在运行。'});return;}
    void run(message.job,message.settings,message.items,Boolean(message.force));
    respond({ok:true});
  }
});
