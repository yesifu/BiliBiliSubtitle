import { trackVariant, recognitionVariant } from './settings.js';

let dbPromise;
function database() {
  if (!dbPromise) dbPromise = new Promise((resolve,reject) => {
    const req = indexedDB.open('bili-whole-subtitles',2);
    req.onupgradeneeded = () => {
      for(const name of ['tracks','checkpoints']) if(!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name,{keyPath:'id'});
    };
    req.onsuccess = () => {
      req.result.onversionchange=()=>{req.result.close();dbPromise=null;};
      resolve(req.result);
    };
    req.onerror = () => {dbPromise=null;reject(new Error('无法打开字幕缓存。'));};
  });
  return dbPromise;
}

export const cacheId = (bvid,cid,settings) => `${bvid}:${cid}:${trackVariant(settings)}`;

async function transaction(mode, action, store='tracks') {
  const db = await database();
  return new Promise((resolve,reject) => {
    const tx = db.transaction(store,mode);
    const req = action(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(new Error('字幕缓存读写失败，可能是本地空间不足。'));
    tx.onabort = () => reject(new Error('字幕缓存操作已中止。'));
  });
}

export const getTrack = (bvid,cid,settings) => transaction('readonly',s=>s.get(cacheId(bvid,cid,settings)));
export async function putTrack(track,settings) {
  // Never persist API credentials in tracks or task status.
  const stored = {...track,id:cacheId(track.bvid,track.cid,settings),createdAt:Date.now()};
  stored.bytes = new Blob([JSON.stringify(stored)]).size;
  await transaction('readwrite',s=>s.put(stored));
  return stored;
}
const checkpointId=(bvid,cid,settings,part)=>`${bvid}:${cid}:${recognitionVariant(settings)}:${part}`;
export const getCheckpoint=async(bvid,cid,settings,part='transcript')=>(await transaction('readonly',s=>s.get(checkpointId(bvid,cid,settings,part)),'checkpoints'))?.value || null;
export async function putCheckpoint(bvid,cid,settings,part,value) {
  const stored={id:checkpointId(bvid,cid,settings,part),bvid,cid,value,createdAt:Date.now()};
  stored.bytes=new Blob([JSON.stringify(stored)]).size;
  await transaction('readwrite',s=>s.put(stored),'checkpoints');
}
export async function clearCache() {
  const db=await database();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(['tracks','checkpoints'],'readwrite');
    tx.objectStore('tracks').clear();tx.objectStore('checkpoints').clear();
    tx.oncomplete=resolve;tx.onerror=()=>reject(new Error('清理缓存失败。'));
  });
}
export async function cacheStats() {
  const [all,checkpoints]=await Promise.all([transaction('readonly',s=>s.getAll()),transaction('readonly',s=>s.getAll(),'checkpoints')]);
  return {count:all.length,checkpoints:checkpoints.length,bytes:[...all,...checkpoints].reduce((n,t)=>n+(t.bytes || 0),0)};
}
