// A conservative, energy-based fallback for ASR services without timestamps.
// These are audio windows, not forced alignment or individual word timings.
const FRAME_SECONDS = 0.02;
const CLEAR_GAP_SECONDS = 0.32;
const PRE_ROLL_SECONDS = 0.12;
const POST_ROLL_SECONDS = 0.15;
const MIN_SPLIT_SECONDS = 3;
const TARGET_SECONDS = 5;
const MAX_SECONDS = 6;
const QUIET_RUN_SECONDS = 0.2;
const SEARCH_RADIUS_SECONDS = 0.75;

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] || 0;
}

function boundaryFor(start, maximum, sampleRate, frameSize, energies) {
  const minimum = Math.min(maximum, start + Math.round(MIN_SPLIT_SECONDS * sampleRate));
  const target = Math.min(maximum, start + Math.round(TARGET_SECONDS * sampleRate));
  const first = Math.max(0, Math.floor(start / frameSize));
  const last = Math.min(energies.length, Math.ceil(maximum / frameSize));
  const sorted = Array.from(energies.subarray(first, last)).sort((a, b) => a - b);
  const high = percentile(sorted, 0.9);
  const low = percentile(sorted, 0.2);
  // Relative thresholds preserve the same decisions when volume changes. They
  // choose boundaries only: quiet/nonzero audio is never discarded as silence.
  const threshold = Math.min(high * 0.25, Math.max(low * 2, high * 0.02));
  const minimumQuietFrames = Math.max(1, Math.ceil(QUIET_RUN_SECONDS * sampleRate / frameSize));
  let chosen = null;
  let distance = Infinity;
  for (let i = first; i < last;) {
    if (energies[i] > threshold) { i++; continue; }
    const begin = i;
    while (i < last && energies[i] <= threshold) i++;
    if (i - begin < minimumQuietFrames) continue;
    const at = Math.floor((begin + i) * frameSize / 2);
    if (at < minimum || at > maximum) continue;
    const nextDistance = Math.abs(at - target);
    if (nextDistance < distance) { chosen = at; distance = nextDistance; }
  }
  if (chosen !== null) return chosen;

  // Continuous speech and music may have no identifiable pause. Prefer the
  // lowest energy near five seconds, with a small distance penalty to avoid
  // arbitrarily early cuts in a constant signal. Six seconds is a hard limit.
  const lower = Math.max(minimum, target - Math.round(SEARCH_RADIUS_SECONDS * sampleRate));
  const upper = Math.min(maximum, target + Math.round(SEARCH_RADIUS_SECONDS * sampleRate));
  let best = Infinity;
  chosen = target;
  for (let i = Math.ceil(lower / frameSize); i < energies.length && i * frameSize <= upper; i++) {
    const at = i * frameSize;
    const score = (high ? energies[i] / high : 0) + 0.05 * Math.abs(at - target) / sampleRate;
    if (score < best) { best = score; chosen = at; }
  }
  return Math.max(start + 1, Math.min(maximum, chosen));
}

export function splitSpeechAudio(samples, sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate < 1) throw new RangeError('音频采样率无效。');
  if (!samples || !Number.isSafeInteger(samples.length) || samples.length < 0) throw new TypeError('音频采样数据无效。');
  if (!samples.length) return [];
  const frameSize = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  const frameCount = Math.ceil(samples.length / frameSize);
  const raw = new Float64Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * frameSize;
    const end = Math.min(samples.length, start + frameSize);
    let energy = 0;
    for (let i = start; i < end; i++) {
      const sample = samples[i];
      if (!Number.isFinite(sample)) throw new TypeError('音频包含无效采样数据。');
      energy += sample * sample;
    }
    raw[frame] = Math.sqrt(energy / (end - start));
  }
  const energies = new Float64Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    let energy = 0;
    const begin = Math.max(0, i - 1);
    const end = Math.min(frameCount - 1, i + 1);
    for (let frame = begin; frame <= end; frame++) energy += raw[frame] * raw[frame];
    energies[i] = Math.sqrt(energy / (end - begin + 1));
  }

  // Only actual digital silence can create omitted gaps. Relative loudness is
  // insufficient evidence to remove audio: whispers, steady noise and music
  // remain available to the recognizer, even when they never cross a VAD gate.
  const gapFrames = Math.max(1, Math.ceil(CLEAR_GAP_SECONDS * sampleRate / frameSize));
  const preRoll = Math.round(PRE_ROLL_SECONDS * sampleRate);
  const postRoll = Math.round(POST_ROLL_SECONDS * sampleRate);
  const spans = [];
  let firstActive = -1;
  let lastActive = -1;
  const addSpan = () => spans.push({
    start: Math.max(0, firstActive * frameSize - preRoll),
    end: Math.min(samples.length, (lastActive + 1) * frameSize + postRoll),
  });
  for (let frame = 0; frame < frameCount; frame++) {
    if (raw[frame] === 0) continue;
    if (firstActive < 0) firstActive = frame;
    else if (frame - lastActive - 1 >= gapFrames) { addSpan(); firstActive = frame; }
    lastActive = frame;
  }
  if (firstActive < 0) return [];
  addSpan();

  const maximumSamples = Math.max(1, Math.floor(MAX_SECONDS * sampleRate));
  const units = [];
  for (const span of spans) {
    // Clamp padding to the previous span if unusual sample rates introduce
    // rounding at a gap boundary. No audio is duplicated between requests.
    let start = Math.max(span.start, units.at(-1)?.end || 0);
    while (start < span.end) {
      const maximum = Math.min(span.end, start + maximumSamples);
      const end = maximum < span.end ? boundaryFor(start, maximum, sampleRate, frameSize, energies) : span.end;
      units.push({start, end, offset: start / sampleRate, duration: (end - start) / sampleRate, timing: 'speech'});
      start = end;
    }
  }
  return units;
}
