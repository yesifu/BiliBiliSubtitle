// Per-video calibration is independent of recognition settings and cached transcript text.
const delayKey = (bvid, cid) => {
  if (!/^BV[0-9a-zA-Z]{10}$/.test(bvid) || !Number.isSafeInteger(Number(cid)) || Number(cid) <= 0) throw new Error('无效的视频。');
  return `subtitle-delay:${bvid}:${Number(cid)}`;
};

export async function getSubtitleDelay(bvid, cid) {
  const key = delayKey(bvid, cid);
  const value = (await chrome.storage.local.get(key))[key];
  return Number.isFinite(value) && Math.abs(value) <= 30 ? value : 0;
}

export async function setSubtitleDelay(bvid, cid, value) {
  const key = delayKey(bvid, cid);
  if (!Number.isFinite(value) || Math.abs(value) > 30 || !Number.isInteger(value * 2)) throw new Error('字幕延迟须在 -30 至 30 秒之间。');
  if (value === 0) await chrome.storage.local.remove(key);
  else await chrome.storage.local.set({[key]:value});
  return value;
}
