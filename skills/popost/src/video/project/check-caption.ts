/**
 * Checks of caption tracks: every cue's span and text, its length against the track's entrance and exit, the spans
 * of its text, and the cues' order (in time, not overlapping: one box shows one caption at a time). A track that
 * follows the words: the sound it follows, and each cue's text against the words spoken during it.
 */
import type { CaptionCue, CaptionTrack, Problem } from '../types';
import type { SpanFrames } from '../timeline/spans';
import type { TrackWords } from '../timeline/words';
import { cueWords } from '../timeline/cue-words';
import { checkBox, error, motionLength, warning, type CheckContext } from './check-common';
import { checkSpan } from './check-span';
import { checkSpans, checkTextStyle } from './check-look';
import { captionWords } from './check-words';

interface Placed { n: number; cue: CaptionCue; frames: SpanFrames }

/** Below this share of its words heard during it, a cue's word times are mostly guesses. */
const MATCHED = 0.5;

const matchProblems = (ctx: CaptionCtx, cue: CaptionCue, n: number, frames: SpanFrames): Problem[] => {
  const tokens = ctx.words?.tokens;
  if (!tokens || frames.end <= frames.start) return [];
  const at = ctx.at + '.cues[' + n + ']';
  const range = 'frames ' + frames.start + '..' + (frames.end - 1);
  const m = cueWords(cue.text, frames.start, frames.end, tokens);
  const anchor = 'anchor the cue on its own words with "during": { "phrase": "' + cue.text.trim() + '" }';
  if (!m.heard)
    return [warning(at + '.during', 'No words of audio track "' + (ctx.words?.track ?? '') + '" are spoken during cue ' + n + ' (' + range + '), so its tokens share its frames evenly.', 'Place the cue where its words are spoken: ' + anchor + '.')];
  if (m.matchedShare < MATCHED)
    return [warning(at + '.text', 'Cue ' + n + ' ("' + cue.text + '") matches only ' + Math.round(m.matchedShare * 100) + '% of the words spoken during it (' + range + ': "' + m.heard + '"), so the times of its other tokens are guesses.',
      'Check that the cue covers where its words are spoken: ' + anchor + ', or correct "from" and "to". A misheard name alone is fine.')];
  return [];
};

const cueProblems = (ctx: CaptionCtx, cue: CaptionCue, n: number): { problems: Problem[]; placed?: Placed } => {
  const at = ctx.at + '.cues[' + n + ']';
  const what = 'Cue ' + n + ' of caption track "' + ctx.t.id + '"';
  const span = checkSpan(ctx.check, cue.during, at + '.during', what);
  const out = [...span.problems];
  if (cue.text.trim() === '') out.push(error(at + '.text', what + ' has no text.', 'Write the words of the caption, or remove the cue.'));
  const spans = cue.spans ?? (typeof ctx.t.style === 'object' ? ctx.t.style.spans : undefined);
  out.push(...checkSpans(spans, cue.text, cue.spans ? at + '.spans' : ctx.at + '.style.spans', what));
  const ok = !span.problems.some((p) => p.level === 'error');
  const frames = ok ? span.frames : undefined;
  const len = frames ? frames.end - frames.start : 0;
  if (frames && len > 0 && len < ctx.motion)
    out.push(error(at + '.during', what + ' is on screen for ' + len + ' frames, shorter than the track\'s entrance and exit together (' + ctx.motion + ' frames).',
      'Make the cue at least ' + ctx.motion + ' frames long, or set shorter "frames" on the track\'s enter or exit.'));
  if (frames && cue.text.trim() !== '') out.push(...matchProblems(ctx, cue, n, frames));
  return { problems: out, ...(frames && len > 0 ? { placed: { n, cue, frames } } : {}) };
};

interface CaptionCtx { check: CheckContext; t: CaptionTrack; at: string; motion: number; words?: TrackWords }

/** "to" that would end a cue at absolute frame end, counted from the start of the cue's own segment. */
const toFor = (ctx: CheckContext, cue: CaptionCue, end: number): number => end - (ctx.tl.starts[ctx.tl.index.get(cue.during.segment ?? '') ?? 0] ?? 0);

const orderProblems = (ctx: CaptionCtx, placed: readonly Placed[]): Problem[] =>
  placed.flatMap((p, j) => {
    const prev = placed[j - 1];
    if (!prev) return [];
    const at = ctx.at + '.cues[' + p.n + '].during';
    const range = (x: Placed): string => 'frames ' + x.frames.start + '..' + (x.frames.end - 1);
    if (p.frames.start < prev.frames.start)
      return [error(at, 'Cue ' + p.n + ' (' + range(p) + ') starts before cue ' + prev.n + ' (' + range(prev) + ') of "' + ctx.t.id + '"; cues must be in time order.',
        'Move cue ' + p.n + ' before cue ' + prev.n + ' in the list, or correct its ' + (p.cue.during.phrase === undefined ? '"from"' : '"phrase" or "occurrence"') + '.')];
    if (p.frames.start < prev.frames.end)
      return [error(at, 'Cue ' + p.n + ' (' + range(p) + ') overlaps cue ' + prev.n + ' (' + range(prev) + ') of "' + ctx.t.id + '"; one box shows one caption at a time.',
        prev.cue.during.phrase === undefined
          ? 'End cue ' + prev.n + ' earlier ("to": ' + toFor(ctx.check, prev.cue, p.frames.start) + ' in segment "' + prev.cue.during.segment + '"), or start cue ' + p.n + ' later.'
          : 'Shorten the "hold" of cue ' + prev.n + ' or the "lead" of cue ' + p.n + ' by ' + (prev.frames.end - p.frames.start) + ' frames together.')];
    return [];
  });

/** A 'type' entrance whose characters follow the words (reveal) takes none of the cue's frames. */
const enterLength = (t: CaptionTrack, fps: number): number => (t.reveal === 'words' && t.enter?.preset === 'type' ? 0 : motionLength(t.enter, fps));

export const checkCaption = (check: CheckContext, t: CaptionTrack, i: number): Problem[] => {
  const at = 'tracks[' + i + ']';
  const source = captionWords(check, t, at);
  const ctx: CaptionCtx = { check, t, at, motion: enterLength(t, check.fps) + motionLength(t.exit, check.fps), ...(source.words ? { words: source.words } : {}) };
  const cues = t.cues.map((cue, n) => cueProblems(ctx, cue, n));
  return [
    ...checkBox(t.box, t.id, at),
    ...checkTextStyle(check, t.style, undefined, at + '.style', 'Caption track "' + t.id + '"'),
    ...source.problems,
    ...cues.flatMap((c) => c.problems),
    ...orderProblems(ctx, cues.flatMap((c) => (c.placed ? [c.placed] : []))),
  ];
};
