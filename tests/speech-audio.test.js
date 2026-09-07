import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSpeechAudio } from '../src/shared/speech-audio.js';

const RATE = 16000;
function audio(duration, regions, sampleRate = RATE) {
  const samples = new Float32Array(Math.round(duration * sampleRate));
  for (const [from, to, amplitude] of regions) {
    for (let i = Math.round(from * sampleRate); i < Math.min(samples.length, Math.round(to * sampleRate)); i++) {
      samples[i] = amplitude * Math.sin(2 * Math.PI * 200 * i / sampleRate);
    }
  }
  return samples;
}

function validWindows(units, sampleLength, sampleRate = RATE) {
  let lastEnd = 0;
  for (const unit of units) {
    assert.equal(unit.timing, 'speech');
    assert.ok(Number.isInteger(unit.start) && Number.isInteger(unit.end));
    assert.ok(unit.start >= lastEnd, 'windows must never overlap');
    assert.ok(unit.end > unit.start && unit.end <= sampleLength);
    assert.equal(unit.offset, unit.start / sampleRate);
    assert.equal(unit.duration, (unit.end - unit.start) / sampleRate);
    assert.ok(Number.isFinite(unit.offset) && unit.duration > 0 && unit.duration <= 6);
    lastEnd = unit.end;
  }
}

test('long silent gaps retain the absolute onset of each separate utterance', () => {
  const samples = audio(18, [[4, 5.4, 0.2], [15, 16.3, 0.15]]);
  const units = splitSpeechAudio(samples, RATE);
  assert.equal(units.length, 2);
  assert.ok(units[0].offset >= 3.86 && units[0].offset <= 4);
  assert.ok(units[1].offset >= 14.86 && units[1].offset <= 15);
  assert.ok(units[0].end / RATE < 5.6);
  assert.ok(units[1].end / RATE < 16.5);
  assert.ok(units[1].offset - units[0].offset >= 10.9, 'silence must not be removed from the timeline');
  validWindows(units, samples.length);
});

test('volume scaling preserves speech windows and relative pause boundaries', () => {
  const original = audio(13, [[0, 13, 0.16], [4.4, 4.8, 0.0001], [9.2, 9.6, 0.0001]]);
  const quiet = Float32Array.from(original, sample => sample * 0.0001);
  const loudUnits = splitSpeechAudio(original, RATE);
  const quietUnits = splitSpeechAudio(quiet, RATE);
  assert.equal(quietUnits.length, loudUnits.length);
  for (let i = 0; i < loudUnits.length; i++) {
    assert.ok(Math.abs(quietUnits[i].start - loudUnits[i].start) <= RATE * 0.02);
    assert.ok(Math.abs(quietUnits[i].end - loudUnits[i].end) <= RATE * 0.02);
  }
  assert.ok(loudUnits[0].end / RATE >= 4.4 && loudUnits[0].end / RATE <= 4.8, 'a natural quiet pause wins over the five-second target');
  validWindows(quietUnits, quiet.length);
});

test('empty and wholly silent audio produces no ASR requests', () => {
  assert.deepEqual(splitSpeechAudio(new Float32Array(), RATE), []);
  assert.deepEqual(splitSpeechAudio(new Float32Array(RATE * 15), RATE), []);
});

test('continuous speech or background sound obeys the hard limit without dropping samples', () => {
  const samples = new Float32Array(RATE * 41 + 137).fill(0.07);
  const units = splitSpeechAudio(samples, RATE);
  assert.ok(units.length > 1);
  assert.equal(units[0].start, 0);
  assert.equal(units.at(-1).end, samples.length);
  for (let i = 1; i < units.length; i++) assert.equal(units[i].start, units[i - 1].end);
  validWindows(units, samples.length);
});

test('short utterances at both audio edges and a one-sample recording are retained', () => {
  const samples = audio(7, [[0, 0.4, 0.1], [6.7, 7, 0.1]]);
  const units = splitSpeechAudio(samples, RATE);
  assert.equal(units.length, 2);
  assert.equal(units[0].start, 0);
  assert.equal(units.at(-1).end, samples.length);
  validWindows(units, samples.length);
  assert.deepEqual(splitSpeechAudio(new Float32Array([0.00000001]), RATE), [
    {start: 0, end: 1, offset: 0, duration: 1 / RATE, timing: 'speech'},
  ]);
});

test('continuous very quiet speech never has to cross an absolute VAD threshold', () => {
  const samples = new Float32Array(RATE * 13).fill(1e-9);
  const units = splitSpeechAudio(samples, RATE);
  assert.equal(units[0].start, 0);
  assert.equal(units.at(-1).end, samples.length);
  assert.equal(units.reduce((sum, unit) => sum + unit.end - unit.start, 0), samples.length);
  validWindows(units, samples.length);
});

test('maximum duration includes pre-roll and post-roll padding', () => {
  const samples = audio(15, [[1, 6.9, 0.1], [8, 13.9, 0.1]]);
  const units = splitSpeechAudio(samples, RATE);
  assert.ok(units.length >= 4, 'padding cannot silently push a six-second request over its limit');
  validWindows(units, samples.length);
});

test('fractional frame endings and multiple sample rates retain finite nonoverlapping windows', () => {
  for (const sampleRate of [8000, 16000, 22050, 44100, 48000]) {
    const samples = audio(17.013, [[0.013, 5.731, 0.08], [6.091, 16.999, 0.00001]], sampleRate);
    const units = splitSpeechAudio(samples, sampleRate);
    assert.ok(units.length >= 3);
    validWindows(units, samples.length, sampleRate);
    for (let i = 0; i < samples.length; i++) {
      if (samples[i] !== 0) assert.ok(units.some(unit => unit.start <= i && unit.end > i), `sample ${i} must remain in a window`);
    }
  }
});

test('invalid sampling inputs fail explicitly', () => {
  for (const rate of [0, -1, NaN, Infinity]) assert.throws(() => splitSpeechAudio(new Float32Array(1), rate), /采样率/);
  assert.throws(() => splitSpeechAudio(null, RATE), /采样数据/);
  assert.throws(() => splitSpeechAudio(new Float32Array([NaN]), RATE), /无效采样/);
});
