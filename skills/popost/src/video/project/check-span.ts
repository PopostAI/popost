/**
 * Checks of a span (the "during" of an item, a cue or an audio track): placed by a segment and frames, or by a phrase
 * of the words (check-words.ts); either way not empty and not wholly outside the video.
 */
import type { Problem, Span } from '../types';
import { spanFrames, type SpanFrames } from '../timeline/spans';
import { error, type CheckContext } from './check-common';
import { checkPhraseSpan, phraseKeysUnused } from './check-words';

const outside = (ctx: CheckContext, frames: SpanFrames, at: string, what: string, span: Span): Problem[] =>
  frames.rawStart >= ctx.tl.total || frames.rawEnd <= 0
    ? [error(at, what + ' lies wholly outside the video: frames ' + frames.rawStart + '..' + (frames.rawEnd - 1) + ', but the video has frames 0..' + (ctx.tl.total - 1) + '.',
        span.phrase === undefined ? 'Move it into the video, for example with "from": 0.' : 'The words of the phrase are spoken after the video ends: move the audio track earlier, or make the segments longer.')]
    : [];

export const checkSpan = (ctx: CheckContext, span: Span, at: string, what: string): { problems: Problem[]; frames?: SpanFrames } => {
  if (span.phrase !== undefined) {
    const p = checkPhraseSpan(ctx, span, at, what);
    if (!p.frames || p.problems.some((x) => x.level === 'error')) return p;
    return { problems: [...p.problems, ...outside(ctx, p.frames, at, what, span)], frames: p.frames };
  }
  const frames = spanFrames(ctx.tl, span);
  if (!frames)
    return { problems: [span.segment === undefined
      ? error(at, what + ' has neither "segment" nor "phrase", so it has no place on the timeline.', 'Add "segment": "<segment id>" (and "from" / "to"), or "phrase": "<words of the script>".', ['segment', 'phrase'])
      : error(at + '.segment', what + ' is placed in segment "' + span.segment + '", which does not exist.', 'Use the id of one of the segments.', ctx.project.segments.map((s) => s.id))] };
  const problems: Problem[] = [...phraseKeysUnused(span, at, what)];
  if (frames.rawEnd <= frames.rawStart)
    problems.push(error(at, what + ' has an empty span: it ends (to ' + (span.to ?? 'the segment end') + ') where or before it starts (from ' + (span.from ?? 0) + ').', 'Make "to" larger than "from", or remove "to" to run to the end of the segment.'));
  else problems.push(...outside(ctx, frames, at, what, span));
  return { problems, frames };
};
