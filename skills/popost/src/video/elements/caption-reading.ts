/**
 * The captions of a shot as the reading saw them, held against a fill or a project. A reading that says some caption
 * words are drawn differently (a highlight) wants the fill to mark its own stressed words, *like this* (the engine draws
 * marked words in the highlight colour: retarget/marks.ts); a reading that says words or letters appear one by one wants
 * captionReveal: "words" (each word shows when it is spoken). Pure.
 */
import { warning } from '../project/check-common';
import { unmark } from '../retarget/marks';
import type { Problem, Project } from '../types';
import type { ReadingFacts } from './findings';
import { ONE_BY_ONE_WORDS } from './main';

const quote = (t: string, n = 60): string => '"' + (t.length > n ? t.slice(0, n - 1) + '…' : t).replace(/"/g, "'") + '"';
const list = (xs: readonly number[]): string => xs.join(', ');

const MARK_FIX = 'Mark the words the new line stresses, *like this*, as the reference marks its own: the engine draws them in the highlight colour.';
const REVEAL_FIX = 'Add "captionReveal": "words" to the fill (it needs the voice\'s words: build with --speak): each word shows when it is spoken.';

const markWhat = (shots: readonly number[], words: readonly string[], where: string): string =>
  'The reading says shot' + (shots.length > 1 ? 's ' : ' ') + list(shots) + ' draw' + (shots.length > 1 ? '' : 's') + ' some caption words differently (' + words.map((w) => quote(w)).join('; ') + '), and ' + where + ' marks no word with asterisks.';

const revealWhat = (shots: readonly number[], words: readonly string[]): string =>
  'The reading says the caption words appear one by one in shot' + (shots.length > 1 ? 's ' : ' ') + list(shots) + ' (' + words.map((w) => quote(w)).join('; ') + '), and the fill sets no captionReveal.';

const unique = (xs: readonly string[]): string[] => [...new Set(xs)];

const reveals = (rf: ReadingFacts): { shots: number[]; words: string[] } => {
  const hits = rf.shots.flatMap((s, k) => (s.reveal && ONE_BY_ONE_WORDS.test(s.reveal) ? [{ n: k + 1, w: s.reveal }] : []));
  return { shots: hits.map((h) => h.n), words: unique(hits.map((h) => h.w)) };
};

/** What the reading's captions say of a fill: marked words in the shots with a highlight, and captionReveal. */
export const captionFillProblems = (rf: ReadingFacts, fill: { captions?: unknown; captionReveal?: unknown }): Problem[] => {
  const out: Problem[] = [];
  const lines = Array.isArray(fill.captions) ? fill.captions : [];
  const lit = rf.shots.flatMap((s, k) => (s.highlight ? [{ n: k + 1, words: s.highlight, beats: s.beats ?? [] }] : []));
  const covered = lit.flatMap((s) => s.beats).map((i) => lines[i]).filter((l): l is string => typeof l === 'string' && l.trim() !== '');
  if (lit.length && covered.length && !covered.some((l) => unmark(l).marks.length))
    out.push(warning('captions', markWhat(lit.map((s) => s.n), unique(lit.map((s) => s.words)), 'the fill\'s lines for their beats'), MARK_FIX));
  const r = reveals(rf);
  if (r.shots.length && !fill.captionReveal) out.push(warning('captionReveal', revealWhat(r.shots, r.words), REVEAL_FIX));
  return out;
};

/** The same for a project (video check), from its caption tracks, when the record says the shots' segments. */
export const captionProjectProblems = (rf: ReadingFacts, project: Project): Problem[] => {
  const tracks = project.tracks.flatMap((t, i) => (t.type === 'caption' ? [{ t, i }] : []));
  if (!tracks.length) return [];
  const out: Problem[] = [];
  const lit = rf.shots.flatMap((s, k) => (s.highlight && project.segments[k] ? [{ n: k + 1, id: project.segments[k]?.id, words: s.highlight }] : []));
  const cues = tracks.flatMap(({ t }) => t.cues).filter((c) => lit.some((s) => s.id === c.during.segment) && c.text.trim() !== '');
  if (lit.length && cues.length && !cues.some((c) => c.spans?.length || unmark(c.text).marks.length))
    out.push(warning('tracks[' + (tracks[0]?.i ?? 0) + '].cues', markWhat(lit.map((s) => s.n), unique(lit.map((s) => s.words)), 'the caption track'), MARK_FIX.replace('the engine draws them in the highlight colour', 'give the cue "spans" with the highlight colour')));
  const r = reveals(rf);
  if (r.shots.length && !tracks.some(({ t }) => t.reveal)) out.push(warning('tracks[' + (tracks[0]?.i ?? 0) + '].reveal', revealWhat(r.shots, r.words).replace('the fill sets no captionReveal', 'the caption track has no "reveal"'), REVEAL_FIX.replace('Add "captionReveal": "words" to the fill', 'Set "reveal": "words" on the caption track (or "captionReveal": "words" in the fill, then template fill again)')));
  return out;
};
