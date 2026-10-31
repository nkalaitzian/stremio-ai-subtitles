'use strict';

// ---------------------------------------------------------------------------
// Subtitle file handling: parse SRT / WebVTT and emit WebVTT.
// Stremio's subtitle URLs must serve WebVTT (.vtt), so OpenSubtitles SRT files
// are converted on the fly.
// ---------------------------------------------------------------------------

const TIMING_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/;

function parseSubtitle(text) {
  if (!text) return { format: 'unknown', cues: [] };
  if (/^\uFEFF?\s*WEBVTT/i.test(text)) return parseVtt(text);
  return parseSrt(text);
}

function parseSrt(text) {
  const cues = [];
  const blocks = text.replace(/^\uFEFF/, '').split(/\r?\n\s*\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let timingIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (TIMING_RE.test(lines[i])) { timingIdx = i; break; }
    }
    if (timingIdx === -1) continue;
    const m = TIMING_RE.exec(lines[timingIdx]);
    const textLines = lines.slice(timingIdx + 1).map((l) => l.trim()).filter((l) => l.length > 0);
    if (!textLines.length) continue;
    cues.push({
      start: srtTimeToVtt(m[1], m[2], m[3], m[4]),
      end: srtTimeToVtt(m[5], m[6], m[7], m[8]),
      text: textLines.join('\n'),
    });
  }
  return { format: 'srt', cues };
}

function parseVtt(text) {
  const cues = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let current = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (TIMING_RE.test(line)) {
      if (current) cues.push(current);
      const m = TIMING_RE.exec(line);
      current = {
        start: srtTimeToVtt(m[1], m[2], m[3], m[4]),
        end: srtTimeToVtt(m[5], m[6], m[7], m[8]),
        text: '',
      };
    } else if (!current) {
      continue; // WEBVTT header / NOTE blocks / STYLE before first cue
    } else if (line === '') {
      if (current.text) { cues.push(current); current = null; }
    } else if (/^(NOTE|STYLE|REGION)\b/i.test(line)) {
      continue;
    } else {
      current.text = current.text ? current.text + '\n' + line : line;
    }
  }
  if (current && current.text) cues.push(current);
  return { format: 'vtt', cues };
}

function srtTimeToVtt(h, m, s, ms) {
  return `${String(h).padStart(2, '0')}:${m}:${s}.${ms}`;
}

function toVtt(cues) {
  const blocks = cues.map((c) => `${c.start} --> ${c.end}\n${escapeVtt(c.text)}`);
  return 'WEBVTT\n\n' + blocks.join('\n\n') + '\n';
}

function errorVtt(message) {
  const text = `⚠ ${String(message).replace(/[\r\n]+/g, ' ')}`;
  return toVtt([{ start: '00:00:01.000', end: '00:00:15.000', text }]);
}

// Strip formatting markup before handing text to translation providers.
function sanitize(text) {
  return String(text)
    .replace(/\{\\[^{}]*\}/g, '')  // ASS override tags {\an8}
    .replace(/<[^>]*>/g, '')        // HTML tags <i>, <font ...>
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

function escapeVtt(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { parseSubtitle, toVtt, errorVtt, sanitize };
