/**
 * Readback: checks a rendered video against its own project with the same readers that read a reference. What the
 * project says should be on screen and be heard is looked for in the picture and in the sound:
 * - every caption cue and every text item should be legible (the text reader finds its words in its time);
 * - every spoken line should be heard (the transcriber hears something like it while its caption is up);
 * - captions and speech should line up (how many frames a caption appears before or after its first word);
 * - text that stays on screen should be large enough to read on a phone (legibility.ts), per shot;
 * - every caption should stand out from what is behind it (contrast.ts), per shot.
 * A model looking at frames does not find a white caption on a white page; a text reader that cannot read it does.
 */
import { editDistance } from '../text/cues';
import type { TextTrack } from '../text/types';
import { phrasesOf } from '../speech/index';
import type { Transcript } from '../speech/types';
import type { Problem, Resolved } from '../types';
import { spokenForm, type RetargetPlan } from '../retarget/index';
import { shotTextSizes, type ShotText } from './legibility';
import { contrastProblems, type CaptionContrast } from './contrast';

export interface ReadbackLine {
  id: string;
  text: string;
  start: number;
  end: number;
  /** What the text reader found in that place and time, and how close it is (1 = the same words). */
  read?: string;
  legible: number;
  /** What was heard while the line was up, and how close it is to the line; undefined when speech was not checked. */
  heard?: string;
  heardScore?: number;
  /** Frames from the first word heard to the line's appearance (positive: the caption comes after the word). */
  lag?: number;
}

export interface Readback {
  lines: ReadbackLine[];
  /** Share of the text items that were read back (legible >= 0.7). */
  legibleShare: number;
  /** Share of the spoken lines that were heard (heardScore >= 0.5); undefined when speech was not checked. */
  heardShare?: number;
  meanLag?: number;
  /** Per shot, how large the text the reader read is (legibility.ts). */
  shots: ShotText[];
  /** Per caption and shot, how far it stands out from what is behind it (contrast.ts); empty when not measured. */
  contrast: CaptionContrast[];
  problems: Problem[];
}

const norm = (s: string): string => s.replace(/[\s·・,.!?;:，。！？；：、"'“”‘’()（）+-]/g, '').toLowerCase();

/** 1 when b contains a (as a whole or nearly), falling towards 0 with the edits needed. */
export const closeness = (expected: string, found: string): number => {
  const a = norm(expected), b = norm(found);
  if (!a) return 1;
  if (!b) return 0;
  if (b.includes(a)) return 1;
  // The best window of b against a: a reader may have joined neighbouring text to the line.
  let best = editDistance(a, b);
  for (let i = 0; i + a.length <= b.length; i++) best = Math.min(best, editDistance(a, b.slice(i, i + a.length)));
  return Math.max(0, 1 - best / a.length);
};

/** Spoken units: one per CJK character, one per run of Latin letters or digits (a word, a number). */
const units = (s: string): number =>
  (s.match(/[\u{3040}-\u{30ff}\u{3400}-\u{9fff}\u{ac00}-\u{d7af}]/gu) ?? []).length + (s.match(/[A-Za-z0-9]+/g) ?? []).length;

const overlap = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
  Math.min(a[0] + a[2], b[0] + b[2]) > Math.max(a[0], b[0]) && Math.min(a[1] + a[3], b[1] + b[3]) > Math.max(a[1], b[1]);

/**
 * spoken: which item ids are spoken lines (the cues of the caption track when the project has a voice).
 * text: what the text reader found in the render. transcript: what the transcriber heard in it.
 * spokenForms: how each cue of the spoken track is said, by cue index; say: the plan's spoken forms, applied to a cue's
 * own text (a plan whose beats are not all drawn has fewer cues than lines, so an index into its lines would slip).
 */
export const readback = (resolved: Resolved, text: TextTrack, o: { transcript?: Transcript; spokenTrack?: string; spokenForms?: string[]; say?: RetargetPlan['say']; contrast?: CaptionContrast[] } = {}): Readback => {
  const items = resolved.items.filter((i) => i.type === 'text' && (i.text ?? '').trim());
  const phrases = o.transcript ? phrasesOf(o.transcript) : [];
  const words = o.transcript?.words ?? [];
  const lines = items.map((item): ReadbackLine => {
    const expected = item.text ?? '';
    // Cues of the reader that are on screen during the item and touch its box; the closest reading wins.
    const seen = text.cues.filter((c) => c.start < item.end && c.end > item.start && overlap(c.box, item.box));
    const joined = seen.map((c) => c.text).join('');
    const best = [...seen.map((c) => c.text), joined].map((t) => ({ t, score: closeness(expected, t) })).sort((a, b) => b.score - a.score)[0];
    const line: ReadbackLine = { id: item.id, text: expected, start: item.start, end: item.end, legible: best ? Math.round(best.score * 100) / 100 : 0, ...(best ? { read: best.t } : {}) };
    const cue = item.cue;
    if (o.transcript && cue && cue.track === o.spokenTrack) {
      const during = phrases.filter((p) => p.start < item.end + 6 && p.end > item.start - 6);
      const heard = during.map((p) => p.text).join('');
      const form = o.spokenForms?.[cue.index] ?? spokenForm(expected, o.say);
      // Recognisers mishear names: a line counts as heard when about as many units were heard as were written.
      const unitsExpected = units(form), unitsHeard = units(heard);
      line.heard = heard;
      line.heardScore = Math.round(Math.max(closeness(form, heard), unitsExpected ? Math.min(1, unitsHeard / unitsExpected) * 0.6 : 0) * 100) / 100;
      const first = words.find((w) => w.start < item.end + 6 && w.end > item.start - 6);
      if (first) line.lag = item.start - first.start;
    }
    return line;
  });
  const problems: Problem[] = [];
  for (const l of lines) {
    if (l.legible < 0.7) problems.push({ level: l.legible < 0.4 ? 'error' : 'warning', at: 'items.' + l.id, message: 'The text "' + l.text + '" (frames ' + l.start + '-' + l.end + ') could not be read back from the render' + (l.read ? ': the reader saw "' + l.read + '".' : ': the reader saw nothing there.'), fix: 'Give it more contrast with what is behind it (an outline, a shadow, a box), make it larger, or move it off busy footage.' });
    if (l.heardScore !== undefined && l.heardScore < 0.5) problems.push({ level: 'warning', at: 'items.' + l.id, message: 'The line "' + l.text + '" was not heard in the render' + (l.heard ? ': the transcriber heard "' + l.heard + '".' : '.'), fix: 'Check that the voice clip of this line exists and is not empty; a name may need a spoken form ("say").' });
    if (l.lag !== undefined && Math.abs(l.lag) > 15) problems.push({ level: 'warning', at: 'items.' + l.id, message: 'The caption "' + l.text + '" appears ' + Math.abs(l.lag) + ' frames ' + (l.lag > 0 ? 'after' : 'before') + ' its first word.', fix: 'Move the cue to the word, or re-flow the timing to the spoken lines.' });
  }
  const spoken = lines.filter((l) => l.heardScore !== undefined);
  const lags = lines.flatMap((l) => (l.lag === undefined ? [] : [l.lag]));
  const sizes = shotTextSizes(resolved, text);
  problems.push(...sizes.problems, ...contrastProblems(resolved, o.contrast ?? []));
  return {
    lines,
    legibleShare: lines.length ? Math.round((lines.filter((l) => l.legible >= 0.7).length / lines.length) * 100) / 100 : 1,
    ...(spoken.length ? { heardShare: Math.round((spoken.filter((l) => (l.heardScore ?? 0) >= 0.5).length / spoken.length) * 100) / 100 } : {}),
    ...(lags.length ? { meanLag: Math.round((lags.reduce((a, b) => a + b, 0) / lags.length) * 10) / 10 } : {}),
    shots: sizes.shots,
    contrast: o.contrast ?? [],
    problems,
  };
};
