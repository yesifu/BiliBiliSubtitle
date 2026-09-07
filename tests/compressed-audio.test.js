import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BoxParser, createFile } from '../src/vendor/mp4box.all.mjs';
import { inspectAudio, splitCompressedAudio } from '../src/shared/compressed-audio.js';

// Self-generated FFmpeg AAC-LC stereo silence, one raw access unit, not video
// content. Containers/metadata are generated afresh with pinned MP4Box 2.4.1.
const SILENCE = Uint8Array.of(0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const concat = parts => new Uint8Array(Buffer.concat(parts.map(p => Buffer.from(p))));
function box(type, data) {
  const bytes = new Uint8Array(8 + data.length);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(Buffer.from(type), 4); bytes.set(data, 8);
  return bytes;
}
function descriptor(tag, data) {
  assert.ok(data.length < 128);
  return Uint8Array.of(tag, data.length, ...data);
}
function esds(asc = Uint8Array.of(0x11, 0x90)) {
  const config = descriptor(4, Uint8Array.of(0x40, 0x15, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, ...descriptor(5, asc)));
  const result = new BoxParser.box.esds();
  result.data = descriptor(3, Uint8Array.of(0, 1, 0, ...config, ...descriptor(6, Uint8Array.of(2))));
  return result;
}
function fixture({ count = 12, rate = 48000, asc, start = 0, gapAt = -1, gap = 0,
  durations = Array(count).fill(1024), edits, progressive = false, defaults = false,
  payloads = Array.from({ length: count }, () => SILENCE) } = {}) {
  const file = createFile();
  file.init({ brands: ['iso5', 'dash'], timescale: rate });
  const id = file.addTrack({ type: 'mp4a', hdlr: 'soun', timescale: rate,
    samplerate: rate, channel_count: 2, description: esds(asc),
    default_sample_duration: defaults ? 1024 : 0, default_sample_size: defaults ? SILENCE.length : 0 });
  const trak = file.getTrackById(id);
  trak.first_dts = 0; // Keep nonzero tfdt rather than addSample's auto-rebasing.
  trak.mdia.mdhd.language = 0x55c4;
  if (edits) {
    const elst = trak.addBox(new BoxParser.box.edts()).addBox(new BoxParser.box.elst());
    elst.entries = edits.map(e => ({ media_rate_integer: 1, media_rate_fraction: 0, ...e }));
  }
  let dts = start;
  for (let i = 0; i < count; i++) {
    if (i === gapAt) dts += gap;
    file.addSample(id, payloads[i], { duration: durations[i], dts, cts: dts, is_sync: true });
    dts += durations[i];
  }
  if (defaults) {
    for (const moof of file.boxes.filter(b => b.type === 'moof')) {
      const trun = moof.trafs[0].truns[0];
      trun.flags = 1;
      moof.computeSize();
      trun.data_offset = moof.size + 8;
    }
  }
  if (!progressive) return new Uint8Array(file.getBuffer().buffer);
  const stbl = trak.mdia.minf.stbl;
  stbl.stsz.sample_size = 0;
  stbl.stsz.sample_sizes = payloads.map(b => b.length);
  for (const duration of durations) {
    if (stbl.stts.sample_deltas.at(-1) === duration) stbl.stts.sample_counts[stbl.stts.sample_counts.length - 1]++;
    else { stbl.stts.sample_deltas.push(duration); stbl.stts.sample_counts.push(1); }
  }
  stbl.stsc.first_chunk = [1]; stbl.stsc.samples_per_chunk = [count]; stbl.stsc.sample_description_index = [1];
  stbl.stco.chunk_offsets = [0];
  trak.mdia.mdhd.duration = dts; trak.tkhd.duration = dts; file.moov.mvhd.duration = dts;
  file.moov.boxes = file.moov.boxes.filter(b => b.type !== 'mvex'); delete file.moov.mvex;
  file.boxes = file.boxes.filter(b => ['ftyp', 'moov'].includes(b.type));
  stbl.stco.chunk_offsets[0] = file.getBuffer().buffer.byteLength + 8;
  return concat([file.getBuffer().buffer, box('mdat', concat(payloads))]);
}
function vendorRead(bytes) {
  const array = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  array.fileStart = 0;
  const file = createFile(true);
  file.appendBuffer(array); file.flush();
  return file;
}
function extracted(bytes) {
  const file = vendorRead(bytes);
  const track = file.moov.traks[0];
  const result = [];
  for (let i = 0; i < track.samples.length; i++) {
    const sample = file.getTrackSample(track.tkhd.track_id, i);
    assert.ok(sample && sample.data.length === sample.size);
    result.push(new Uint8Array(sample.data));
    file.releaseUsedSamples(track.tkhd.track_id, i + 1);
  }
  assert.equal(file.samplesDataSize, 0);
  return result;
}
function topBoxes(bytes, start = 0, end = bytes.length) {
  const result = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (start < end) {
    const size = view.getUint32(start);
    result.push({ type: Buffer.from(bytes.subarray(start + 4, start + 8)).toString(), start, size, end: start + size });
    start += size;
  }
  return result;
}
function at(bytes, names) {
  let list = topBoxes(bytes);
  let found;
  for (const name of names) {
    found = list.find(b => b.type === name);
    assert.ok(found, name);
    if (name !== names.at(-1)) list = topBoxes(bytes, found.start + 8 + (name === 'stsd' ? 8 : name === 'mp4a' ? 28 : 0), found.end);
  }
  return found.start;
}
function patch32(bytes, names, relative, value) {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(at(copy, names) + relative, value);
  return copy;
}
const stblPath = ['moov', 'trak', 'mdia', 'minf', 'stbl'];
const esdsPath = [...stblPath, 'stsd', 'mp4a', 'esds'];

test('inspection is synchronous; bounded views and immutable input; fMP4 zero movie duration', async () => {
  const source = fixture();
  const padded = new Uint8Array(source.length + 31); padded.set(source, 13);
  const originalHash = hash(padded);
  const view = new DataView(padded.buffer, 13, source.length);
  assert.deepEqual(inspectAudio(view), { duration: 12 * 1024 / 48000, codec: 'mp4a.40.2', sampleRate: 48000, channels: 2, type: 'audio/mp4' });
  const promise = splitCompressedAudio(view, { seconds: 0.1 });
  assert.ok(promise instanceof Promise);
  const parts = await promise;
  assert.equal(parts.length, 3);
  assert.equal(hash(padded), originalHash);
  assert.ok(!Object.hasOwn(padded.buffer, 'fileStart'));
});

test('standalone M4A chunks retain every distinct AAC packet once with exact sample boundaries', async () => {
  // Unique test payloads check lossless container copying independently of decode.
  const payloads = Array.from({ length: 21 }, (_, i) => Uint8Array.of(...SILENCE, i));
  const source = fixture({ count: 21, payloads });
  const parts = await splitCompressedAudio(source, { seconds: 0.09 });
  const recovered = [];
  for (const [i, part] of parts.entries()) {
    assert.equal(part.blob.type, 'audio/mp4');
    assert.match(part.filename, /^audio-\d{4}\.m4a$/);
    assert.ok(part.duration > 0 && part.duration <= 0.09);
    assert.equal(part.startSample, i ? parts[i - 1].endSample : 0);
    assert.equal(part.offset, part.startSample * 1024 / 48000);
    const bytes = new Uint8Array(await part.blob.arrayBuffer());
    assert.deepEqual(topBoxes(bytes).map(b => b.type), ['ftyp', 'moov', 'mdat']);
    const file = vendorRead(bytes);
    assert.equal(file.moov.traks[0].samples[0].dts, 0);
    assert.equal(file.moov.mvex, undefined);
    assert.equal(inspectAudio(bytes).duration, part.duration);
    recovered.push(...extracted(bytes));
  }
  assert.equal(parts.at(-1).endSample, payloads.length);
  assert.deepEqual(recovered, payloads);
});

test('each chunk respects maxBytes including M4A overhead; indivisible packets and invalid options reject', async () => {
  const source = fixture({ count: 30, payloads: Array.from({ length: 30 }, () => new Uint8Array(300)) });
  const parts = await splitCompressedAudio(source, { seconds: 120, maxBytes: 2600 });
  assert.ok(parts.length > 1);
  assert.ok(parts.every(p => p.blob.size <= 2600));
  assert.equal(parts.reduce((n, p) => n + p.endSample - p.startSample, 0), 30);
  const exact = (await splitCompressedAudio(fixture({ count: 1 })))[0].blob.size;
  assert.equal((await splitCompressedAudio(fixture({ count: 1 }), { maxBytes: exact }))[0].blob.size, exact);
  await assert.rejects(splitCompressedAudio(fixture({ count: 1 }), { maxBytes: exact - 1 }), /too small/);
  for (const seconds of [0, -1, NaN, Infinity, '120']) await assert.rejects(splitCompressedAudio(source, { seconds }), /seconds/);
  for (const maxBytes of [0, -1, NaN, Infinity, 1.1, 2 ** 32]) await assert.rejects(splitCompressedAudio(source, { maxBytes }), /maxBytes/);
  assert.equal((await splitCompressedAudio(fixture({ count: 2 }), { seconds: 0.001 })).length, 2);
});

test('nonzero 64-bit tfdt and later fragment gaps preserve source offsets without inserting or losing packets', async () => {
  const start = 2 ** 32 + 8192;
  const source = fixture({ count: 8, start, gapAt: 4, gap: 48000 });
  assert.equal(inspectAudio(source).duration, (start + 8 * 1024 + 48000) / 48000);
  const parts = await splitCompressedAudio(source);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map(p => [p.startSample, p.endSample]), [[0, 4], [4, 8]]);
  assert.equal(parts[0].offset, start / 48000);
  assert.equal(parts[1].offset, (start + 4096 + 48000) / 48000);
  assert.equal(parts[1].duration, 4096 / 48000);
  assert.throws(() => inspectAudio(fixture({ count: 8, gapAt: 4, gap: -1024 })), /overlapping/);
});

test('trex defaults, ordinary progressive MP4, changing stts runs and short final sample', async () => {
  const fragmented = fixture({ count: 18, defaults: true });
  assert.equal(inspectAudio(fragmented).duration, 18 * 1024 / 48000);
  assert.equal((await splitCompressedAudio(fragmented, { seconds: 0.1 })).length, 5);
  const durations = [1024, 1024, 960, 960, 1024, 1008];
  const source = fixture({ count: durations.length, durations, progressive: true });
  assert.equal(inspectAudio(source).duration, durations.reduce((a, b) => a + b) / 48000);
  const parts = await splitCompressedAudio(source, { seconds: 0.041 });
  let next = 0;
  for (const part of parts) {
    assert.equal(part.startSample, next);
    assert.equal(part.offset, durations.slice(0, next).reduce((a, b) => a + b, 0) / 48000);
    assert.equal(part.duration, durations.slice(next, part.endSample).reduce((a, b) => a + b, 0) / 48000);
    next = part.endSample;
  }
  assert.equal(next, durations.length);
});

test('AAC configuration comes from ASC: indexed/explicit frequency and channels; unsupported profiles reject', async () => {
  assert.equal(inspectAudio(fixture({ asc: Uint8Array.of(0x12, 0x08) })).sampleRate, 44100);
  assert.equal(inspectAudio(fixture({ asc: Uint8Array.of(0x12, 0x08) })).channels, 1);
  const bits = '00010' + '1111' + (48000).toString(2).padStart(24, '0') + '0010' + '000';
  const asc = Uint8Array.from(bits.match(/.{8}/g).map(b => parseInt(b, 2)));
  assert.equal(inspectAudio(fixture({ asc })).sampleRate, 48000);
  assert.equal(inspectAudio(fixture({ asc: Uint8Array.of(0x11, 0xb8) })).channels, 8);
  assert.equal(inspectAudio(fixture({ asc: Uint8Array.of(0x10, 0x10), rate: 96000 })).sampleRate, 96000);
  for (const invalid of [Uint8Array.of(0x29, 0x90), Uint8Array.of(0x11, 0x80), Uint8Array.of(0x16, 0x90), Uint8Array.of(0x11)]) {
    assert.throws(() => inspectAudio(fixture({ asc: invalid })), /unsupported|truncated/);
  }
  const opus = fixture();
  opus.set(Buffer.from('Opus'), at(opus, [...stblPath, 'stsd', 'mp4a']) + 4);
  await assert.rejects(splitCompressedAudio(opus), /unsupported codec Opus/);
});

test('identity edits and AAC priming/end edits preserve all packets and presentation duration', async () => {
  const identity = fixture({ edits: [{ segment_duration: 0, media_time: 0 }] });
  assert.equal(inspectAudio(identity).duration, 12 * 1024 / 48000);
  const source = fixture({ edits: [{ segment_duration: 11 * 1024 - 17, media_time: 1024 }] });
  const parts = await splitCompressedAudio(source, { seconds: 0.08 });
  assert.equal(parts[0].offset, 0);
  const packets = [];
  for (const part of parts) {
    const b = new Uint8Array(await part.blob.arrayBuffer());
    assert.ok(Math.abs(inspectAudio(b).duration - part.duration) < 1e-9);
    packets.push(...extracted(b));
  }
  assert.equal(packets.length, 12);
  assert.ok(Math.abs(parts.at(-1).offset + parts.at(-1).duration - inspectAudio(source).duration) < 1e-9);
});

test('malformed/truncated boxes, malicious counts, forged offsets and descriptor lengths fail readably', async () => {
  const source = fixture({ count: 2 });
  const cases = [new Uint8Array(), source.subarray(0, 7), source.subarray(0, source.length - 1),
    patch32(source, ['ftyp'], 0, 7),
    patch32(source, ['ftyp'], 0, 0xffffffff),
    patch32(source, ['moof', 'traf', 'trun'], 12, 0xffffffff),
    patch32(source, ['moof', 'traf', 'trun'], 16, 0x7fffffff),
    patch32(source, ['moof', 'traf', 'trun'], 20, 0),
    patch32(source, ['moof', 'traf', 'trun'], 24, 0xffffffff),
    patch32(patch32(source, [...stblPath, 'stsz'], 12, 1), [...stblPath, 'stsz'], 16, 0xffffffff),
    patch32(source, [...stblPath, 'stts'], 12, 0xffffffff),
    patch32(source, ['moov', 'trak', 'mdia', 'mdhd'], 20, 0),
  ];
  const badEsds = source.slice(); badEsds.fill(0xff, at(badEsds, esdsPath) + 13, at(badEsds, esdsPath) + 17); cases.push(badEsds);
  const badChild = source.slice(); new DataView(badChild.buffer).setUint32(at(badChild, ['moov', 'trak']), 0xffffffff); cases.push(badChild);
  for (const bytes of cases) {
    assert.throws(() => inspectAudio(bytes), /^Error: Compressed audio:/);
    await assert.rejects(splitCompressedAudio(bytes), /^Error: Compressed audio:/);
  }
  for (const value of [null, undefined, [], 'mp4', new Blob()]) assert.throws(() => inspectAudio(value), /ArrayBuffer/);
});

test('real Bilibili fixture when available: 704 seconds, six 120s chunks, all 33000 packets byte-identical', async t => {
  let source;
  try { source = await readFile(new URL('../.research/sample-original.m4a', import.meta.url)); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('optional local research fixture is absent'); return; } throw error; }
  const info = inspectAudio(source);
  assert.ok(Math.abs(info.duration - 704) < 0.001);
  assert.deepEqual([info.codec, info.sampleRate, info.channels], ['mp4a.40.2', 48000, 2]);
  const sourceHash = hash(source);
  const parts = await splitCompressedAudio(source, { seconds: 120, maxBytes: 45_000_000 });
  assert.equal(parts.length, 6);
  assert.deepEqual(parts.map(p => p.offset), [0, 120, 240, 360, 480, 600]);
  assert.deepEqual(parts.slice(0, 5).map(p => p.duration), [120, 120, 120, 120, 120]);
  assert.equal(parts.at(-1).endSample, 33000);
  const originalPackets = extracted(source);
  const recovered = [];
  for (const part of parts) recovered.push(...extracted(new Uint8Array(await part.blob.arrayBuffer())));
  assert.equal(recovered.length, originalPackets.length);
  assert.deepEqual(recovered.map(hash), originalPackets.map(hash));
  assert.equal(hash(source), sourceHash);
});

// Optional independent decoder smoke: FFMPEG_PATH=/path/to/ffmpeg node --test ...
// Always runs when ffmpeg is on PATH; no .research, download or npm dependency.
test('independent FFmpeg decodes every generated M4A chunk', async t => {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  if (spawnSync(ffmpeg, ['-version'], { windowsHide: true }).error) { t.skip('set FFMPEG_PATH or install ffmpeg for decoder smoke'); return; }
  const directory = await mkdtemp(path.join(tmpdir(), 'compressed-audio-test-'));
  try {
    const parts = await splitCompressedAudio(fixture({ count: 120 }), { seconds: 0.5 });
    for (const part of parts) {
      const target = path.join(directory, part.filename);
      await writeFile(target, new Uint8Array(await part.blob.arrayBuffer()));
      const decoded = spawnSync(ffmpeg, ['-v', 'error', '-xerror', '-i', target, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      assert.equal(decoded.status, 0, decoded.stderr || decoded.error?.message);
      assert.equal(decoded.stderr, '');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
