export function normalizeCues(cues) {
  return cues.map(c => ({
    start: Math.max(0, Number(c.start ?? c.from)),
    end: Number(c.end ?? c.to),
    source: String(c.source ?? c.content ?? c.text ?? '').trim(),
    text: String(c.text ?? c.source ?? c.content ?? '').trim(),
  })).filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && (c.source || c.text))
    .sort((a,b) => a.start - b.start || a.end - b.end);
}

export function cleanTranscript(text) {
  return String(text || '').replace(/<\|[^|]*\|>/g, '').trim();
}

export function approximateCues(text, start, end) {
  text = cleanTranscript(text);
  if (!text || end <= start) return [];
  const pieces = text.match(/[^。！？.!?\n]+[。！？.!?]?/gu) || [text];
  const lines = pieces.flatMap(piece => {
    const parts = [];
    let rest = piece.trim();
    while (rest.length > 80) {
      const space = rest.lastIndexOf(' ', 80);
      const cut = space > 30 ? space : 60;
      parts.push(rest.slice(0,cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) parts.push(rest);
    return parts;
  }).filter(Boolean);
  const weight = lines.reduce((n,s) => n + s.length, 0);
  let cursor = start;
  return lines.map((line,i) => {
    const next = i === lines.length - 1 ? end : cursor + (end-start) * line.length / weight;
    const cue = {start:cursor,end:next,source:line,text:line};
    cursor = next;
    return cue;
  });
}

export function transcriptionCues(result, offset, duration, {textTiming}={}) {
  const hasTimestamp = value => (typeof value==='number' || (typeof value==='string' && value.trim()!=='')) && Number.isFinite(Number(value));
  if (Array.isArray(result.segments) && result.segments.length) {
    const segments=result.segments.filter(segment=>segment && cleanTranscript(segment.text));
    // Empty/null/boolean values must not become a fabricated zero timestamp.
    // If any spoken segment lacks usable bounds, retain the complete text via
    // the fallback instead of silently dropping that segment from the track.
    const valid=segments.every(segment=>hasTimestamp(segment.start) && hasTimestamp(segment.end) &&
      Math.min(duration,Number(segment.end))>Math.max(0,Number(segment.start)));
    const cues = valid ? normalizeCues(segments.map(segment => ({
      start: offset + Math.max(0, Number(segment.start)),
      end: offset + Math.min(duration, Number(segment.end)),
      source:cleanTranscript(segment.text),text:cleanTranscript(segment.text),
    }))) : [];
    if (cues.length) return {cues,timing:'precise'};
  }
  const transcript=cleanTranscript(result.text) || (Array.isArray(result.segments)
    ? result.segments.map(segment=>cleanTranscript(segment?.text)).filter(Boolean).join(' ') : '');
  if (textTiming==='speech') {
    // This short region already has boundaries measured on the original audio.
    // Splitting its text by character count would invent a second, drifting clock.
    const text=transcript;
    return {cues:normalizeCues([{start:offset,end:offset+duration,source:text,text}]),timing:'speech'};
  }
  return {cues:approximateCues(transcript,offset,offset+duration),timing:'approximate'};
}

export function parseTranslations(content, count) {
  const raw = String(content).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('翻译模型未返回有效 JSON，请换用支持 JSON 输出的模型。'); }
  const rows = Array.isArray(parsed) ? parsed : parsed.translations;
  if (!Array.isArray(rows) || rows.length !== count) throw new Error('翻译结果条数与字幕不匹配。');
  const byId = new Map();
  for (const row of rows) {
    if (!Number.isInteger(row.id) || row.id < 0 || row.id >= count || byId.has(row.id) || typeof row.text !== 'string' || !row.text.trim()) {
      throw new Error('翻译结果包含无效、重复或缺失的字幕编号。');
    }
    byId.set(row.id,row.text.trim());
  }
  return Array.from({length:count},(_,i) => byId.get(i));
}

function timestamp(seconds, vtt) {
  const ms = Math.max(0,Math.round(seconds*1000));
  const h = Math.floor(ms/3600000), m = Math.floor(ms/60000)%60, s = Math.floor(ms/1000)%60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}${vtt?'.':','}${String(ms%1000).padStart(3,'0')}`;
}

export function exportSubtitles(track, format = 'srt', bilingual = true) {
  const vtt = format === 'vtt';
  const clean = text => String(text).replace(/\r/g,'').replace(/\n\s*\n/g,'\n').replace(/-->/g,'→');
  const body = normalizeCues(track.cues).map((c,i) => {
    let line = clean(c.text || c.source);
    if (bilingual && c.source && c.source !== c.text) line += '\n' + clean(c.source);
    if (vtt) line = line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `${i+1}\n${timestamp(c.start,vtt)} --> ${timestamp(c.end,vtt)}\n${line}`;
  }).join('\n\n');
  return (vtt ? 'WEBVTT\n\n' : '') + body + '\n';
}
