import test from 'node:test';
import assert from 'node:assert/strict';
import {transcriptionCues} from '../src/shared/subtitles.js';

test('missing and nonnumeric provider timestamps cannot become precise zero times',()=>{
  for(const value of [null,undefined,'','  ',false,true,NaN,Infinity,{},[]]) {
    for(const field of ['start','end']) {
      const result=transcriptionCues({text:'完整识别文字',segments:[{start:0,end:2,text:'片段',[field]:value}]},100,5,{textTiming:'speech'});
      assert.equal(result.timing,'speech');
      assert.deepEqual(result.cues.map(c=>[c.start,c.end,c.text]),[[100,105,'完整识别文字']]);
    }
  }
});

test('numeric timestamp strings remain supported and relative to source audio',()=>{
  const result=transcriptionCues({segments:[{start:'0',end:'2.5',text:'带时间的文字'}]},100,5,{textTiming:'speech'});
  assert.equal(result.timing,'precise');
  assert.deepEqual(result.cues.map(c=>[c.start,c.end]),[[100,102.5]]);
});

test('a malformed segment preserves all transcript text instead of silently deleting a phrase',()=>{
  const payload={segments:[null,{start:0,end:1,text:'第一句。'},{start:null,end:3,text:'第二句。'}]};
  const result=transcriptionCues(payload,20,4,{textTiming:'speech'});
  assert.equal(result.timing,'speech');
  assert.deepEqual(result.cues.map(c=>[c.start,c.end,c.text]),[[20,24,'第一句。 第二句。']]);
  const legacy=transcriptionCues(payload,20,4);
  assert.equal(legacy.timing,'approximate');
  assert.ok(legacy.cues.some(c=>c.text.includes('第二句')));
});
