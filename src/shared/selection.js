export const itemKey = item => `${item.bvid}:${item.cid}`;

export function selectableItems(info) {
  const seen=new Set();
  return [...(info.groups?.pages || []),...(info.groups?.season || [])].filter(item=>{
    const key=itemKey(item);
    if(seen.has(key)) return false;
    seen.add(key);return true;
  });
}

export function selectItems(info,scope,selection=[]) {
  if(scope==='current') return [info];
  if(scope==='pages') return info.groups.pages;
  if(scope==='season') {
    if(info.seasonTotal>info.groups.season.length) throw new Error('合集目录不完整，请使用自由选择。');
    return info.groups.season;
  }
  if(scope!=='selected' || !Array.isArray(selection) || !selection.length || selection.length>500) throw new Error('请选择 1–500 个视频。');
  const wanted=new Set(selection);
  const items=selectableItems(info).filter(item=>wanted.has(itemKey(item)));
  if(items.length!==wanted.size) throw new Error('选择中包含目录外的视频，请刷新后重新选择。');
  return items;
}

export function nextItem(info) {
  for(const items of [info.groups?.pages || [],info.groups?.season || []]) {
    const index=items.findIndex(item=>itemKey(item)===itemKey(info));
    if(index>=0 && items[index+1]) return items[index+1];
  }
  return null;
}
