/**
 * The words of a spoken track, token by token, in project frames: what a caption needs to light up the word being
 * spoken, and what a phrase anchor needs to find its phrase. Tokens are those of the lines AS WRITTEN (what a caption
 * shows); a name that is spoken differently ("say") is one written token whose time is that of its spoken form.
 */
import { alignScript, tokenize, type AlignedToken } from '../align/index';
import type { SpokenWord, Transcript } from '../speech/types';
import type { RetargetPlan } from './index';

export interface VoiceWords {
  fps: number;
  tokens: AlignedToken[];
  /** True when no transcript was available and every time was spread evenly over its line. */
  estimated: boolean;
}

interface Chunk { written: string; spoken: string }

/** A line cut where a "say" entry applies: plain stretches are spoken as written, the others in their spoken form. */
export const chunksOf = (line: string, say: RetargetPlan['say']): Chunk[] => {
  const entries = (say ?? []).filter((s) => s.text);
  const out: Chunk[] = [];
  let rest = line;
  while (rest) {
    const hits = entries.map((s) => ({ s, at: rest.indexOf(s.text) })).filter((h) => h.at >= 0).sort((a, b) => a.at - b.at || b.s.text.length - a.s.text.length);
    const hit = hits[0];
    if (!hit) { out.push({ written: rest, spoken: rest }); break; }
    if (hit.at > 0) out.push({ written: rest.slice(0, hit.at), spoken: rest.slice(0, hit.at) });
    out.push({ written: hit.s.text, spoken: hit.s.as });
    rest = rest.slice(hit.at + hit.s.text.length);
  }
  return out;
};

/**
 * The written tokens of one line with times. heard: the recognised words inside the line's stretch, or undefined to
 * spread the stretch [start, end) evenly.
 */
export const lineTokens = (line: string, say: RetargetPlan['say'], start: number, end: number, heard?: SpokenWord[]): AlignedToken[] => {
  const chunks = chunksOf(line, say);
  const spokenLine = chunks.map((c) => c.spoken).join(' ');
  const spokenCount = tokenize(spokenLine).length;
  if (!spokenCount) return [];
  let spoken: AlignedToken[];
  if (heard && heard.length) spoken = alignScript(spokenLine, heard).tokens;
  else {
    const span = Math.max(1, end - start) / spokenCount;
    spoken = tokenize(spokenLine).map((text, k) => ({ text, start: Math.round(start + k * span), end: Math.max(Math.round(start + k * span) + 1, Math.round(start + (k + 1) * span)), confidence: 0.3, matched: false }));
  }
  const out: AlignedToken[] = [];
  let k = 0;
  for (const c of chunks) {
    const s = tokenize(c.spoken).length;
    const part = spoken.slice(k, k + s);
    k += s;
    const written = tokenize(c.written);
    if (!written.length || !part.length) continue;
    if (c.written === c.spoken) { out.push(...part); continue; }
    // A written token that is spoken differently takes the time of its spoken form, shared evenly when there are several.
    const from = (part[0] as AlignedToken).start, to = (part[part.length - 1] as AlignedToken).end;
    const span = Math.max(1, to - from) / written.length;
    const confidence = Math.min(...part.map((t) => t.confidence));
    written.forEach((text, i) => out.push({ text, start: Math.round(from + i * span), end: Math.max(Math.round(from + i * span) + 1, Math.round(from + (i + 1) * span)), confidence, matched: part.every((t) => t.matched) }));
  }
  return out;
};

/**
 * lines: the caption lines as written. starts[i], frames[i]: where line i starts on the project's clock and how long
 * it is spoken (0 for a line that is not spoken). transcript: what a transcriber heard in the mixed voice track, on
 * the same clock.
 */
export const voiceWords = (o: { lines: string[]; say?: RetargetPlan['say']; starts: number[]; frames: number[]; fps: number; transcript?: Transcript }): VoiceWords => {
  const words = o.transcript?.words;
  const tokens = o.lines.flatMap((line, i) => {
    const length = o.frames[i] ?? 0;
    if (!line.trim() || !length) return [];
    const start = o.starts[i] ?? 0, end = start + length;
    // Words belong to the line whose stretch holds their middle: lines follow one another without overlap.
    const heard = words?.filter((w) => { const mid = (w.start + w.end) / 2; return mid >= start - 2 && mid < end + 2; });
    return lineTokens(line, o.say, start, end, heard);
  });
  // One clock for the whole track: a token never starts before the one before it ends.
  let clock = 0;
  for (const t of tokens) {
    t.start = Math.max(t.start, clock);
    t.end = Math.max(t.end, t.start + 1);
    clock = t.end;
  }
  return { fps: o.fps, tokens, estimated: !words };
};
