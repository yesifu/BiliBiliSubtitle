import { itemKey, nextItem } from './selection.js';
import { trackVariant } from './settings.js';

// The coordinator lives in the service worker; its small queue survives worker suspension.
// Only a page visit adds work. Completion never recursively schedules the whole collection.
export function createAutoQueue({storage, getSettings, getContext, getStatus, start, cancel, tabExists}) {
  let lock=Promise.resolve();
  const serial=fn=>{
    const pending=lock.then(fn);
    lock=pending.catch(()=>{});
    return pending;
  };
  const read=async()=> (await storage().get('autoQueue')).autoQueue || {pending:[],seen:[]};
  const write=state=>storage().set({autoQueue:state});
  const enabled=(entry,settings)=>entry.kind==='current'?settings.autoEnabled:settings.followNext;

  async function drain(state,settings) {
    state.enabled={autoEnabled:settings.autoEnabled,followNext:settings.followNext};
    state.pending=state.pending.filter(entry=>enabled(entry,settings));
    await write(state);
    if((await getStatus())?.state==='running') return;
    while(state.pending.length) {
      const entry=state.pending.shift();
      await write(state);
      if(!await tabExists(entry.tabId,entry.visitUrl)) continue;
      // Save the attempt before dispatch so repeated SPA notifications cannot duplicate requests.
      state.seen=[...state.seen.filter(key=>key!==entry.key),entry.key].slice(-1000);
      await write(state);
      try {await start(entry);state.error='';await write(state);return;}
      catch(error) {
        // Keep a visible error; the next navigation or explicit retry can proceed.
        state.error=error.message;await write(state);return;
      }
    }
  }

  return {
    visit:(url,tabId,playing)=>serial(async()=>{
      const settings=await getSettings();
      if(!settings.autoEnabled && !settings.followNext) return;
      const info=await getContext(url);
      const state=await read();
      state.pending=state.pending.filter(entry=>entry.tabId!==tabId);
      const candidates=[];
      if(settings.autoEnabled) candidates.push({item:info,kind:'current'});
      if(settings.followNext && playing) {
        const next=nextItem(info);
        if(next) candidates.push({item:next,kind:'next'});
      }
      for(const candidate of candidates) {
        const key=`${itemKey(candidate.item)}:${trackVariant(settings)}`;
        if(state.seen.includes(key) || state.pending.some(entry=>entry.key===key)) continue;
        const {bvid,cid,title,duration,page,cover}=candidate.item;
        const entry={item:{bvid,cid,title,duration,page,cover},kind:candidate.kind,key,tabId,visitUrl:url};
        if(candidate.kind==='current') state.pending.unshift(entry);else state.pending.push(entry);
      }
      state.pending=state.pending.slice(0,40);
      await drain(state,settings);
    }),
    resume:()=>serial(async()=>drain(await read(),await getSettings())),
    settingsChanged:()=>serial(async()=>{
      const settings=await getSettings(),state=await read();
      if((settings.autoEnabled && !state.enabled?.autoEnabled) || (settings.followNext && !state.enabled?.followNext)) state.seen=[];
      state.pending=state.pending.filter(entry=>enabled(entry,settings));
      const job=await getStatus();
      if(job?.state==='running' && job.automatic && !(job.autoKind==='next'?settings.followNext:settings.autoEnabled)) await cancel(job.id);
      await drain(state,settings);
    }),
    stop:()=>serial(async()=>{const state=await read();state.seen=[...state.seen,...state.pending.map(entry=>entry.key)].slice(-1000);state.pending=[];await write(state);}),
    status:()=>serial(async()=>{const state=await read();return {queued:state.pending.length,error:state.error || ''};}),
  };
}
