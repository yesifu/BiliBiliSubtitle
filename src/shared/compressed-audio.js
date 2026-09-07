import { BoxParser, DataStream, createFile } from '../vendor/mp4box.all.mjs';

// Intentionally isolated: callers choose this path and catch errors to use the
// existing WAV fallback. Nothing here decodes PCM, uses WASM, or accesses Node.
const TYPE = 'audio/mp4';
const MAX_SAMPLES = 2_000_000;
const MAX_BOXES = 250_000;
const MAX_METADATA = 64 * 1024 * 1024;
const FREQUENCIES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function fail(message) {
  throw new Error(`Compressed audio: ${message}. Use the WAV fallback for this input.`);
}

function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`invalid ${name}`);
  return value;
}

function inputView(bytes) {
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes) && bytes.buffer instanceof ArrayBuffer) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  fail('expected an ArrayBuffer or an ArrayBuffer view');
}

// Unknown metadata is opaque and never passed to the vendor's generic parser.
// Only this fixed-depth box tree and preflighted leaf parsers handle input.
function reader(bytes) {
  const data = inputView(bytes);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let boxCount = 0;
  let metadata = 0;
  const u32 = p => view.getUint32(p);
  const u64 = p => integer(u32(p) * 0x100000000 + u32(p + 4), '64-bit box value');
  const fourcc = p => String.fromCharCode(...data.subarray(p, p + 4));
  function boxes(start, end) {
    const result = [];
    while (start < end) {
      if (++boxCount > MAX_BOXES) fail('too many MP4 boxes');
      if (end - start < 8) fail('truncated MP4 box header');
      let size = u32(start);
      const type = fourcc(start + 4);
      let header = 8;
      if (size === 1) {
        if (end - start < 16) fail('truncated extended MP4 box');
        size = u64(start + 8);
        header = 16;
      } else if (size === 0) {
        if (type !== 'mdat') fail('unsupported zero-size MP4 box');
        size = end - start;
      }
      if (size < header || size > end - start) fail(`invalid or truncated ${type} box`);
      result.push({ type, start, p: start + header, end: start + size, size });
      start += size;
    }
    return result;
  }
  function children(box) { return boxes(box.p, box.end); }
  function one(list, type, optional = false) {
    const found = list.filter(b => b.type === type);
    if (found.length > 1 || (!optional && !found.length)) fail(`missing or duplicate ${type} box`);
    return found[0];
  }
  function length(box, minimum) {
    if (box.end - box.p < minimum) fail(`truncated ${box.type} fields`);
  }
  function full(box, minimum, versions = [0]) {
    length(box, minimum);
    if (!versions.includes(data[box.p])) fail(`unsupported ${box.type} version`);
    return u32(box.p) & 0xffffff;
  }
  function table(box, stride, prefix = 8, countAt = 4) {
    full(box, prefix, box.type === 'ctts' || box.type === 'elst' ? [0, 1] : [0]);
    const count = u32(box.p + countAt);
    if (count > MAX_SAMPLES || count * stride !== box.end - box.p - prefix) {
      fail(`invalid ${box.type} count or truncated table`);
    }
    return count;
  }
  function parse(box) {
    metadata += box.size;
    if (metadata > MAX_METADATA) fail('MP4 metadata exceeds 64 MiB limit');
    const Constructor = BoxParser.box[box.type];
    if (!Constructor) fail(`unsupported ${box.type} box`);
    const parsed = new Constructor(box.size);
    parsed.hdr_size = box.p - box.start;
    const stream = new DataStream(data.slice(box.p, box.end).buffer, 0, DataStream.BIG_ENDIAN);
    parsed.parse(stream);
    if (stream.position !== box.end - box.p) fail(`invalid ${box.type} payload`);
    // esds has no custom writer: MP4Box's inherited FullBox writer needs data.
    if (box.type === 'esds') parsed.data = data.slice(box.p + 4, box.end);
    return parsed;
  }
  return { data, view, u32, u64, fourcc, boxes, children, one, length, full, table, parse };
}

function audioConfig(r, box) {
  r.full(box, 6);
  if (box.size > 4096) fail('oversized AAC decoder configuration');
  let asc;
  let objectType;
  // Bound descriptor nesting, lengths, optional ES fields, and variable-length
  // size encodings before invoking MP4Box's descriptor parser.
  function descriptors(start, end, parent = 0, depth = 0) {
    if (depth > 3) fail('invalid esds descriptor nesting');
    const seen = new Set();
    while (start < end) {
      const tag = r.data[start++];
      if (seen.has(tag)) fail('duplicate esds descriptor');
      seen.add(tag);
      let size = 0;
      let more = true;
      for (let i = 0; i < 4 && more; i++) {
        if (start >= end) fail('truncated esds descriptor size');
        const value = r.data[start++];
        size = size * 128 + (value & 127);
        more = !!(value & 128);
      }
      if (more || size > end - start) fail('invalid esds descriptor length');
      const next = start + size;
      if (tag === 3 && parent === 0) {
        if (size < 3) fail('truncated ES descriptor');
        const flags = r.data[start + 2];
        start += 3;
        if (flags & 128) start += 2;
        if (flags & 64) {
          if (start >= next) fail('truncated ES URL');
          start += 1 + r.data[start];
        }
        if (flags & 32) start += 2;
        if (start > next) fail('truncated ES descriptor flags');
        descriptors(start, next, tag, depth + 1);
      } else if (tag === 4 && parent === 3) {
        if (size < 13) fail('truncated decoder descriptor');
        objectType = r.data[start];
        if ((r.data[start + 1] >> 2) !== 5) fail('unsupported non-audio decoder');
        descriptors(start + 13, next, tag, depth + 1);
      } else if (tag === 5 && parent === 4) {
        asc = r.data.subarray(start, next);
      } else if (tag !== 6 || parent !== 3 || !size) {
        fail('unsupported esds descriptor');
      }
      start = next;
    }
  }
  descriptors(box.p + 4, box.end);
  if (objectType !== 0x40 || !asc) fail('unsupported codec (expected MPEG-4 AAC)');
  if (asc.length > 64) fail('oversized AAC AudioSpecificConfig');
  let bit = 0;
  function bits(count) {
    if (bit + count > asc.length * 8) fail('truncated AAC AudioSpecificConfig');
    let value = 0;
    while (count--) { value = value * 2 + ((asc[bit >> 3] >> (7 - (bit & 7))) & 1); bit++; }
    return value;
  }
  const profile = bits(5);
  if (profile !== 2) fail(`unsupported AAC profile ${profile} (only AAC-LC is supported)`);
  const frequencyIndex = bits(4);
  const sampleRate = frequencyIndex === 15 ? bits(24) : FREQUENCIES[frequencyIndex];
  if (!sampleRate || sampleRate > 192000) fail('unsupported AAC sampling frequency');
  const channelConfig = bits(4);
  if (channelConfig < 1 || channelConfig > 7) fail('unsupported AAC channel configuration (PCE is not supported)');
  bits(1); // frameLengthFlag: M4A preserves both 960- and 1024-sample AAC frames.
  if (bits(1) || bits(1)) fail('unsupported AAC core dependency or extension');
  // Common FFmpeg ASC has an explicit, disabled SBR sync extension.
  if (asc.length * 8 - bit >= 16) {
    if (bits(11) !== 0x2b7 || bits(5) !== 5 || bits(1)) fail('unsupported AAC SBR extension');
  }
  while (bit < asc.length * 8) if (bits(1)) fail('unsupported AAC config extension');
  return { sampleRate, channels: channelConfig === 7 ? 8 : channelConfig, codec: 'mp4a.40.2', esds: r.parse(box) };
}

function parseAudio(bytes) {
  const r = reader(bytes);
  const top = r.boxes(0, r.data.length);
  const ftyp = r.one(top, 'ftyp');
  r.length(ftyp, 8);
  if ((ftyp.end - ftyp.p) % 4) fail('invalid ftyp brands');
  const moov = r.one(top, 'moov');
  if (moov.size > MAX_METADATA) fail('MP4 metadata exceeds 64 MiB limit');
  const movie = r.children(moov);
  const mvhd = r.one(movie, 'mvhd');
  r.full(mvhd, r.data[mvhd.p] === 1 ? 112 : 100, [0, 1]);
  const movieScale = integer(r.u32(mvhd.p + (r.data[mvhd.p] === 1 ? 20 : 12)), 'movie timescale', 1);
  const traks = movie.filter(b => b.type === 'trak');
  if (traks.length !== 1) fail('expected exactly one audio track');
  const track = r.children(traks[0]);
  const tkhd = r.one(track, 'tkhd');
  r.full(tkhd, r.data[tkhd.p] === 1 ? 96 : 84, [0, 1]);
  const id = integer(r.u32(tkhd.p + (r.data[tkhd.p] === 1 ? 20 : 12)), 'track ID', 1);
  const mdia = r.children(r.one(track, 'mdia'));
  const hdlr = r.one(mdia, 'hdlr');
  r.full(hdlr, 24);
  if (r.fourcc(hdlr.p + 8) !== 'soun') fail('unsupported codec or non-audio track');
  const mdhd = r.one(mdia, 'mdhd');
  r.full(mdhd, r.data[mdhd.p] === 1 ? 36 : 24, [0, 1]);
  const scale = integer(r.u32(mdhd.p + (r.data[mdhd.p] === 1 ? 20 : 12)), 'audio timescale', 1);
  const minf = r.children(r.one(mdia, 'minf'));
  const stbl = r.children(r.one(minf, 'stbl'));
  const stsd = r.one(stbl, 'stsd');
  r.full(stsd, 8);
  const entries = r.boxes(stsd.p + 8, stsd.end);
  if (r.u32(stsd.p + 4) !== 1 || entries.length !== 1) fail('unsupported multiple sample descriptions');
  const entry = entries[0];
  if (entry.type !== 'mp4a') fail(`unsupported codec ${entry.type}`);
  r.length(entry, 28);
  if (r.view.getUint16(entry.p + 8) !== 0) fail('unsupported QuickTime audio sample entry');
  if (r.view.getUint16(entry.p + 6) !== 1) fail('unsupported external audio data reference');
  const entryBoxes = r.boxes(entry.p + 28, entry.end);
  if (entryBoxes.some(b => b.type === 'sinf')) fail('encrypted audio is not supported');
  const config = audioConfig(r, r.one(entryBoxes, 'esds'));
  const dataRefs = r.children(r.one(minf, 'dinf'));
  const dref = r.one(dataRefs, 'dref');
  r.full(dref, 8);
  const refs = r.boxes(dref.p + 8, dref.end);
  if (r.u32(dref.p + 4) !== 1 || refs.length !== 1 || refs[0].type !== 'url ' || r.full(refs[0], 4) !== 1) {
    fail('unsupported external audio data reference');
  }
  const mdats = top.filter(b => b.type === 'mdat');
  if (!mdats.length) fail('missing audio media data');
  const samples = [];
  let mediaBytes = 0;
  let lastByteEnd = 0;
  let lastTimeEnd = 0;
  function add(offset, size, dts, duration, cts = dts, description = 1) {
    if (samples.length >= MAX_SAMPLES) fail('audio exceeds two million compressed samples');
    integer(offset, 'sample offset'); integer(size, 'sample size', 1);
    integer(dts, 'decode timestamp'); integer(duration, 'sample duration', 1);
    integer(dts + duration, 'sample end timestamp');
    if (duration > 0x7fffffff || cts !== dts || description !== 1) fail('unsupported audio timing or sample description');
    if (samples.length && (dts < lastTimeEnd || offset < lastByteEnd)) fail('overlapping or out-of-order audio samples');
    let lo = 0, hi = mdats.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (mdats[mid].end <= offset) lo = mid + 1; else hi = mid; }
    const mdat = mdats[lo];
    if (!mdat || offset < mdat.p || size > mdat.end - offset) fail('truncated sample or sample outside mdat');
    samples.push({ offset, size, dts, duration });
    lastByteEnd = offset + size;
    lastTimeEnd = dts + duration;
    mediaBytes += size;
  }
  // Progressive M4A: expand each timing run exactly, including the last frame.
  const stszBox = r.one(stbl, 'stsz');
  r.full(stszBox, 12);
  const constantSize = r.u32(stszBox.p + 4);
  const count = r.table(stszBox, constantSize ? 0 : 4, 12, 8);
  if (count > mdats.reduce((sum, b) => sum + b.end - b.p, 0)) fail('sample count exceeds available media bytes');
  const stsz = r.parse(stszBox);
  const sttsBox = r.one(stbl, 'stts'); r.table(sttsBox, 8);
  const stts = r.parse(sttsBox);
  const stscBox = r.one(stbl, 'stsc'); r.table(stscBox, 12);
  const stsc = r.parse(stscBox);
  const stcoBox = r.one(stbl, 'stco', true) || r.one(stbl, 'co64');
  if (stcoBox.type === 'stco' && stbl.some(b => b.type === 'co64')) fail('duplicate chunk offset tables');
  r.table(stcoBox, stcoBox.type === 'co64' ? 8 : 4);
  const offsets = r.parse(stcoBox).chunk_offsets;
  const cttsBox = r.one(stbl, 'ctts', true);
  if (cttsBox) {
    r.table(cttsBox, 8);
    const ctts = r.parse(cttsBox);
    if (ctts.sample_offsets.some(n => n !== 0) || ctts.sample_counts.reduce((a, b) => a + b, 0) !== count) fail('unsupported AAC composition offsets');
  }
  if (stts.sample_counts.reduce((a, b) => a + b, 0) !== count || stts.sample_counts.some(n => !n)) fail('invalid stts sample count');
  if (stts.sample_deltas.some(n => n <= 0)) fail('invalid stts duration');
  // MP4Box reads stts deltas as signed and silently fixes negatives. Reject first.
  for (let p = sttsBox.p + 12; p < sttsBox.end; p += 8) if (r.u32(p) > 0x7fffffff) fail('invalid stts duration');
  let chunkSamples = 0;
  for (let i = 0; i < stsc.first_chunk.length; i++) {
    const first = stsc.first_chunk[i];
    const next = stsc.first_chunk[i + 1] ?? offsets.length + 1;
    if ((i === 0 && first !== 1) || next <= first || next > offsets.length + 1 || !stsc.samples_per_chunk[i] || stsc.sample_description_index[i] !== 1) fail('invalid stsc chunk table');
    chunkSamples += (next - first) * stsc.samples_per_chunk[i];
  }
  if (chunkSamples !== count || (!!offsets.length !== !!count)) fail('inconsistent MP4 sample tables');
  let sampleIndex = 0, run = 0, runLeft = stts.sample_counts[0], chunkRun = 0, dts = 0;
  for (let chunk = 1; chunk <= offsets.length; chunk++) {
    if (chunk === stsc.first_chunk[chunkRun + 1]) chunkRun++;
    let offset = offsets[chunk - 1];
    for (let j = 0; j < stsc.samples_per_chunk[chunkRun]; j++) {
      if (!runLeft) runLeft = stts.sample_counts[++run];
      const duration = stts.sample_deltas[run];
      const size = stsz.sample_sizes[sampleIndex++];
      add(offset, size, dts, duration);
      offset += size; dts += duration; runLeft--;
    }
  }
  // fMP4: defaults, every tfdt (including 64-bit), and every trun data offset.
  const mvex = r.one(movie, 'mvex', true);
  let defaults;
  if (mvex) {
    const trex = r.one(r.children(mvex), 'trex');
    r.full(trex, 24); defaults = r.parse(trex);
    if (defaults.track_id !== id) fail('invalid fragment track ID');
  }
  for (const moof of top.filter(b => b.type === 'moof')) {
    if (!defaults) fail('missing fragment defaults');
    const fragment = r.children(moof);
    const traf = r.children(r.one(fragment, 'traf'));
    if (traf.some(b => ['senc', 'saiz', 'saio'].includes(b.type))) fail('encrypted audio is not supported');
    const tfhdBox = r.one(traf, 'tfhd');
    const flags = r.full(tfhdBox, 8);
    if (flags & ~0x03003b) fail('unsupported fragment header flags');
    r.length(tfhdBox, 8 + ((flags & 1) ? 8 : 0) + [2, 8, 16, 32].filter(f => flags & f).length * 4);
    const tfhd = r.parse(tfhdBox);
    if (tfhd.track_id !== id) fail('invalid fragment track ID');
    const tfdtBox = r.one(traf, 'tfdt', true);
    let time = lastTimeEnd;
    if (tfdtBox) {
      r.full(tfdtBox, r.data[tfdtBox.p] === 1 ? 12 : 8, [0, 1]);
      time = r.parse(tfdtBox).baseMediaDecodeTime;
    }
    const base = (flags & 1) ? tfhd.base_data_offset : moof.start;
    let position = base;
    const truns = traf.filter(b => b.type === 'trun');
    if (!truns.length) fail('empty audio fragment');
    for (const trunBox of truns) {
      const f = r.full(trunBox, 8, [0, 1]);
      if (f & ~0xf05 || ((f & 4) && (f & 0x400))) fail('unsupported trun flags');
      const prefix = 8 + ((f & 1) ? 4 : 0) + ((f & 4) ? 4 : 0);
      const stride = [0x100, 0x200, 0x400, 0x800].filter(v => f & v).length * 4;
      r.length(trunBox, prefix);
      const n = r.u32(trunBox.p + 4);
      if (n > MAX_SAMPLES - samples.length || n > r.data.length || n * stride !== trunBox.end - trunBox.p - prefix) fail('invalid trun sample count or truncated table');
      const trun = r.parse(trunBox);
      if (f & 1) position = base + trun.data_offset;
      for (let i = 0; i < n; i++) {
        const size = (f & 0x200) ? trun.sample_size[i] : (flags & 16) ? tfhd.default_sample_size : defaults.default_sample_size;
        const duration = (f & 0x100) ? trun.sample_duration[i] : (flags & 8) ? tfhd.default_sample_duration : defaults.default_sample_duration;
        const description = (flags & 2) ? tfhd.default_sample_description_index : defaults.default_sample_description_index;
        add(position, size, time, duration, time + ((f & 0x800) ? trun.sample_composition_time_offset[i] : 0), description);
        position += size; time += duration;
      }
    }
  }
  if (!samples.length || !mediaBytes) fail('no complete AAC samples');
  // One normal-rate media edit, optionally preceded by an empty edit. Preserve
  // encoder priming/end trimming using an output edit list, without dropping AAC.
  let mediaStart = samples[0].dts, mediaEnd = lastTimeEnd, shift = 0;
  const edts = r.one(track, 'edts', true);
  if (edts) {
    const elstBox = r.one(r.children(edts), 'elst');
    r.table(elstBox, r.data[elstBox.p] === 1 ? 20 : 12);
    const edits = r.parse(elstBox).entries;
    if (edits.some(e => e.media_rate_integer !== 1 || e.media_rate_fraction !== 0)) fail('unsupported edit-list playback rate');
    for (const e of edits) { integer(e.segment_duration, 'edit duration'); integer(e.media_time, 'edit media time', -1); }
    const leading = edits.length === 2 && edits[0].media_time === -1 ? edits.shift().segment_duration / movieScale : 0;
    if (edits.length !== 1 || edits[0].media_time < 0) fail('unsupported audio edit list');
    const edit = edits[0];
    integer(edit.media_time, 'edit media time'); integer(edit.segment_duration, 'edit duration');
    // A zero-duration identity edit is common in Bilibili fMP4 initialization.
    if (edit.segment_duration || edit.media_time || leading) {
      mediaStart = Math.max(mediaStart, edit.media_time);
      mediaEnd = edit.segment_duration ? Math.min(lastTimeEnd, edit.media_time + edit.segment_duration * scale / movieScale) : lastTimeEnd;
      shift = leading * scale - edit.media_time;
      if (mediaStart > samples[0].dts + samples[0].duration || mediaEnd < samples.at(-1).dts || mediaEnd <= mediaStart) fail('unsupported edit trimming more than a boundary AAC packet');
    }
  }
  return { ...config, r, samples, scale, mediaStart, mediaEnd, shift,
    duration: (mediaEnd + shift) / scale };
}

function guardedParse(bytes) {
  try { return parseAudio(bytes); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('Compressed audio:')) throw error;
    fail(`invalid or truncated MP4 (${error instanceof Error ? error.message : String(error)})`);
  }
}

/**
 * Synchronous. Accepts ArrayBuffer or a typed-array/DataView (its exact range).
 * Returns {duration, codec, sampleRate, channels, type:'audio/mp4'}.
 * Duration is the source presentation end in seconds, including any initial
 * timestamp/gaps, derived from complete packets rather than fMP4's often-zero
 * movie duration. Supports one unencrypted AAC-LC track in MP4/fMP4.
 * Throws a readable error for unsupported codecs/layouts or malformed input.
 */
export function inspectAudio(bytes) {
  const { duration, codec, sampleRate, channels } = guardedParse(bytes);
  return { duration, codec, sampleRate, channels, type: TYPE };
}

function makeHeader(audio, start, end) {
  const { samples, scale, sampleRate, channels, esds } = audio;
  const first = samples[start];
  const last = samples[end - 1];
  const codedDuration = last.dts + last.duration - first.dts;
  const visibleStart = Math.max(first.dts, audio.mediaStart);
  const visibleEnd = Math.min(last.dts + last.duration, audio.mediaEnd);
  const duration = visibleEnd - visibleStart;
  const output = createFile();
  output.init({ brands: ['M4A ', 'isom', 'iso2', 'mp41'], timescale: scale, duration: Math.round(duration) });
  const id = output.addTrack({ type: 'mp4a', hdlr: 'soun', timescale: scale,
    duration: Math.round(duration), media_duration: codedDuration,
    // ISO audio sample-entry field is 16.16; ASC carries higher frequencies.
    samplerate: sampleRate > 65535 ? 0xffff : sampleRate, channel_count: channels,
    description: esds, language: 'und', name: 'AAC audio' });
  const trak = output.getTrackById(id);
  trak.tkhd.width = 0; trak.tkhd.height = 0;
  trak.mdia.mdhd.language = 0x55c4; // Packed ISO-639-2 "und".
  output.moov.mvhd.volume = 1;
  const stbl = trak.mdia.minf.stbl;
  stbl.stsz.sample_size = 0;
  for (let i = start; i < end; i++) {
    const sample = samples[i];
    stbl.stsz.sample_sizes.push(sample.size);
    const deltas = stbl.stts.sample_deltas;
    if (deltas.at(-1) === sample.duration) stbl.stts.sample_counts[deltas.length - 1]++;
    else { deltas.push(sample.duration); stbl.stts.sample_counts.push(1); }
  }
  stbl.stsc.first_chunk = [1];
  stbl.stsc.samples_per_chunk = [end - start];
  stbl.stsc.sample_description_index = [1];
  stbl.stco.chunk_offsets = [0];
  output.moov.boxes = output.moov.boxes.filter(b => b.type !== 'mvex');
  delete output.moov.mvex;
  if (visibleStart !== first.dts || visibleEnd !== last.dts + last.duration) {
    const edts = trak.addBox(new BoxParser.box.edts());
    const elst = edts.addBox(new BoxParser.box.elst());
    elst.entries = [{ segment_duration: Math.round(duration), media_time: visibleStart - first.dts,
      media_rate_integer: 1, media_rate_fraction: 0 }];
  }
  let header = output.getBuffer().buffer;
  stbl.stco.chunk_offsets[0] = header.byteLength + 8;
  header = output.getBuffer().buffer;
  return { header, duration: duration / scale, offset: (visibleStart + audio.shift) / scale };
}

/**
 * Async -> Array<{blob:Blob,filename,offset,duration,startSample,endSample}>.
 * Outputs standalone, seekable M4A (ftyp+moov+mdat), with identical AAC packets.
 * offsets/durations are source presentation seconds. Sample indices are zero-
 * based [startSample,endSample), complete, consecutive, with no duplication.
 * Each blob is <= maxBytes INCLUDING headers; seconds is a maximum except that
 * one indivisible AAC packet may exceed it. Gaps force a new chunk, retaining
 * their original offset. Simple priming/end edits are retained losslessly.
 *
 * Memory: input + returned Blobs + O(packet count) bounded metadata; no complete
 * input copy and no PCM. Only a chunk's table/header and zero-copy packet views
 * are live during writing. MP4Box never extracts/retains sample.data buffers;
 * views are released immediately after Blob construction. Input must not be
 * mutated until this Promise settles. Limits: 2M samples, 250k boxes, 64MiB
 * parsed metadata. Unsupported features throw so callers can choose WAV.
 */
export async function splitCompressedAudio(bytes, { seconds = 120, maxBytes = 45_000_000 } = {}) {
  if (!Number.isFinite(seconds) || seconds <= 0) fail('seconds must be a positive finite number');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 0xffffffff) fail('maxBytes must be an integer between 1 and 4294967295');
  const audio = guardedParse(bytes);
  const { samples, scale, r } = audio;
  const result = [];
  for (let start = 0; start < samples.length;) {
    let end = start;
    let size = 0;
    // Conservative header reservation bounds metadata work even at small caps.
    while (end < samples.length) {
      const sample = samples[end];
      const visibleStart = Math.max(samples[start].dts, audio.mediaStart);
      const previousEnd = end > start ? samples[end - 1].dts + samples[end - 1].duration : visibleStart;
      if (end > start && previousEnd > visibleStart && (
        sample.dts !== previousEnd ||
        (Math.min(sample.dts + sample.duration, audio.mediaEnd) - visibleStart) / scale > seconds ||
        size + sample.size + 12 * (end - start + 1) + audio.esds.data.length + 1024 > maxBytes)) break;
      size += sample.size;
      end++;
      if (size > maxBytes) break;
    }
    let built = makeHeader(audio, start, end);
    while (built.header.byteLength + 8 + size > maxBytes && end > start + 1) {
      size -= samples[--end].size;
      built = makeHeader(audio, start, end);
    }
    if (built.header.byteLength + 8 + size > maxBytes) fail('maxBytes is too small for one complete AAC packet and M4A headers');
    if (built.duration <= 0) fail('segment limit cannot accommodate the AAC priming/end edit');
    const mdat = new ArrayBuffer(8);
    const header = new DataView(mdat);
    header.setUint32(0, size + 8); header.setUint32(4, 0x6d646174);
    const parts = [built.header, mdat];
    // Coalesce adjacent packet views, including across chunks in progressive MP4.
    let begin = samples[start].offset;
    let finish = begin;
    for (let i = start; i < end; i++) {
      const sample = samples[i];
      if (sample.offset !== finish) {
        if (finish > begin) parts.push(r.data.subarray(begin, finish));
        begin = sample.offset;
      }
      finish = sample.offset + sample.size;
    }
    parts.push(r.data.subarray(begin, finish));
    const blob = new Blob(parts, { type: TYPE });
    parts.length = 0;
    result.push({ blob, filename: `audio-${String(result.length + 1).padStart(4, '0')}.m4a`,
      offset: built.offset, duration: built.duration, startSample: start, endSample: end });
    start = end;
    // Yield between bounded writes so the browser can process cancellation/UI.
    if (start < samples.length) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return result;
}
