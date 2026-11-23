/**
 * Checks of words: words files on audio materials, phrase spans (which sound, whether and how often the phrase is
 * spoken, how sure its time is) and caption tracks that follow the words. Positions in messages are seconds.
 */
import type { CaptionTrack, Problem, Span } from '../types';
import { tokenize } from '../align/index';
import type { SpanFrames } from '../timeline/spans';
import { findPhrase, nearestPhrases, phraseFrames, phraseIndexes, placeAt, pickWords, type PlacedToken, type TrackWords } from '../timeline/words';
import { error, warning, type CheckContext } from './check-common';

/** Below this confidence the time of a phrase is a guess (src/align: about 0.5 misheard, about 0.2 interpolated). */
export const SURE = 0.4;

const secs = (ctx: CheckContext, frame: number): string => (frame / ctx.fps).toFixed(2) + ' s';

const ADD_WORDS = 'Add "words": "assets/<name>.words.json" to the audio material that is spoken (one token per unit, as src/align writes them) and play it on an audio track';

/** The track whose words a phrase span ("of") or a caption track ("words") means, or the Problem why it is not clear. */
export const wordsSource = (ctx: CheckContext, of: string | boolean | undefined, at: { none: string; key: string }, lead: string, need: string): { words?: TrackWords; problem?: Problem } => {
  const ids = ctx.words.map((w) => w.track);
  if (!ids.length)
    return { problem: error(at.none, lead + ', but ' + need + ' need a sound with a words file: no audio track plays a material with "words".', ADD_WORDS + ', or ' + (at.key.endsWith('.words') ? 'remove "words" from the track' : 'place it with "segment", "from" and "to"') + '.') };
  const found = pickWords(ctx.words, of);
  if (found) return { words: found };
  if (typeof of === 'string') {
    const audio = ctx.project.tracks.find((t) => t.type === 'audio' && t.id === of);
    const why = audio && audio.type === 'audio' ? 'audio track "' + of + '" plays material "' + audio.material + '", which has no words file' : 'there is no audio track "' + of + '"';
    return { problem: error(at.key, lead + ', but ' + why + '.', 'Use the id of an audio track whose material has "words".', ids) };
  }
  const key = at.key.slice(at.key.lastIndexOf('.') + 1);
  return { problem: error(at.key, lead + ', but ' + ids.length + ' audio tracks have words (' + ids.join(', ') + '), so it is not clear whose words are meant.', 'Set "' + key + '": "' + (ids[0] ?? '') + '" (the id of the audio track).', ids) };
};

/** Problems of a span with a frame anchor that also carries fields of a phrase span. */
export const phraseKeysUnused = (span: Span, at: string, what: string): Problem[] =>
  (['occurrence', 'of', 'lead', 'hold'] as const).filter((k) => span[k] !== undefined).map((k) =>
    warning(at + '.' + k, '"' + k + '" applies to a phrase span only; ' + what + ' is placed by "segment", so it has no effect.', 'Remove "' + k + '", or anchor it with "phrase" instead of "segment", "from" and "to".'));

interface PhraseCtx { ctx: CheckContext; span: Span; at: string; what: string; tokens: readonly PlacedToken[]; track: string }

const notFound = (p: PhraseCtx, phrase: string): Problem => {
  const near = nearestPhrases(p.tokens, phrase);
  return error(p.at + '.phrase', p.what + ' is anchored to the phrase "' + phrase + '", which is not in the words of audio track "' + p.track + '".' +
    (near.length ? ' The nearest phrases that are: ' + near.map((n) => '"' + n.text + '" (at ' + secs(p.ctx, n.start) + ')').join(', ') + '.' : ''),
    near[0] ? 'Use the words as they are spoken, for example "phrase": "' + near[0].text + '"; case and punctuation do not matter.' : 'Use words that are spoken in the sound, or place it with "segment", "from" and "to".',
    near.map((n) => n.text));
};

const occurrenceProblem = (p: PhraseCtx, phrase: string, starts: number[]): Problem | undefined => {
  const n = starts.length;
  const list = starts.map((s) => secs(p.ctx, s)).join(', ');
  const allowed = starts.map((_s, i) => String(i + 1));
  if (p.span.occurrence === undefined && n > 1)
    return error(p.at + '.occurrence', 'The phrase "' + phrase + '" is spoken ' + n + ' times in the words of "' + p.track + '": at ' + list + '. Say which one ' + p.what + ' belongs to.',
      'Add "occurrence": 1 to ' + n + ' (1 is the one at ' + secs(p.ctx, starts[0] ?? 0) + ').', allowed);
  if (p.span.occurrence !== undefined && p.span.occurrence > n)
    return error(p.at + '.occurrence', '"occurrence" is ' + p.span.occurrence + ', but the phrase "' + phrase + '" is spoken only ' + n + ' time' + (n === 1 ? '' : 's') + ' in the words of "' + p.track + '" (at ' + list + ').',
      n === 1 ? 'Remove "occurrence" (or write 1).' : 'Use an occurrence from 1 to ' + n + '.', allowed);
  return undefined;
};

/** The phrase found: its frames, and warnings about a guessed time or a sound that has ended. */
const placed = (p: PhraseCtx, phrase: string, words: TrackWords): { problems: Problem[]; frames?: SpanFrames } => {
  const place = findPhrase(p.tokens, p.span);
  if (!place) return { problems: [] };
  const frames = phraseFrames(p.ctx.tl, place, p.span);
  const out: Problem[] = [];
  if (place.confidence < SURE)
    out.push(warning(p.at + '.phrase', 'The time of the phrase "' + phrase + '" is a guess: its words were not heard as written (confidence ' + place.confidence + '), so ' + p.what + ' will be on frames ' + frames.rawStart + '..' + (frames.rawEnd - 1) + '.',
      'Check those frames in the preview. If they are wrong, correct the words file, or place it with "segment", "from" and "to".'));
  if (words.end !== undefined && place.start >= words.end)
    out.push(warning(p.at + '.phrase', 'The phrase "' + phrase + '" is spoken at frame ' + place.start + ', after audio track "' + words.track + '" ends (frame ' + words.end + '), so it is not heard.', 'Let audio track "' + words.track + '" run longer, or anchor to an earlier phrase.'));
  if (frames.rawEnd <= frames.rawStart)
    out.push(error(p.at, p.what + ' has an empty span: the phrase "' + phrase + '" is spoken on frames ' + place.start + '..' + (place.end - 1) + ', and "lead" ' + (p.span.lead ?? 0) + ' with "hold" ' + (p.span.hold ?? 0) + ' leave no frame.', 'Use a smaller negative "lead" or "hold", or remove them.'));
  return { problems: out, frames };
};

/** A phrase span: which sound, whether and how often the phrase is spoken there, and its frames. */
export const checkPhraseSpan = (ctx: CheckContext, span: Span, at: string, what: string): { problems: Problem[]; frames?: SpanFrames } => {
  const phrase = span.phrase ?? '';
  const out: Problem[] = [];
  const key = span.from !== undefined ? 'from' : span.to !== undefined ? 'to' : undefined;
  if (key)
    out.push(error(at + '.' + key, '"from" and "to" cannot be combined with "phrase": ' + what + ' is placed on the words, which give its frames.',
      'Remove "from" and "to". To show it before or after the words, use "lead" (frames before the first word) and "hold" (frames after the last), for example "lead": 6, "hold": 12.'));
  if (span.segment !== undefined) out.push(warning(at + '.segment', '"segment" has no effect on ' + what + ': it is placed on the words of the phrase "' + phrase + '".', 'Remove "segment".'));
  const src = wordsSource(ctx, span.of, { none: at + '.phrase', key: at + '.of' }, what + ' is anchored to the phrase "' + phrase + '"', 'phrase anchors');
  if (src.problem) return { problems: [...out, src.problem] };
  const words = src.words;
  // Words that were not read (no table) or cannot be used (reported at the material) are not checked further.
  if (!words?.tokens) return { problems: out };
  const units = tokenize(phrase);
  if (!units.length) return { problems: [...out, error(at + '.phrase', 'The phrase "' + phrase + '" of ' + what + ' has no words, only punctuation or spaces.', 'Write the words it is anchored to, for example "phrase": "' + (words.tokens.slice(0, 4).map((t) => t.text).join('') || '...') + '".')] };
  const tokens = words.tokens;
  const p: PhraseCtx = { ctx, span, at, what, tokens, track: words.track };
  const starts = phraseIndexes(tokens, units).map((k) => placeAt(tokens, k, units.length).start);
  if (!starts.length) return { problems: [...out, notFound(p, phrase)] };
  const occurrence = occurrenceProblem(p, phrase, starts);
  if (occurrence) return { problems: [...out, occurrence] };
  const found = placed(p, phrase, words);
  return { problems: [...out, ...found.problems], ...(found.frames ? { frames: found.frames } : {}) };
};

/** Words files on materials: only on audio, and readable (what the build step found). Files on disk: check.ts. */
export const checkWordsMaterials = (ctx: CheckContext): Problem[] =>
  ctx.project.materials.flatMap((m, i) => {
    const at = 'materials[' + i + '].words';
    if (m.words === undefined) return [];
    if (m.kind !== 'audio')
      return [error(at, '"words" belongs to an audio material (the words of a sound), but "' + m.id + '" is ' + (m.kind === 'image' ? 'an' : 'a') + ' ' + m.kind + ' material.', 'Move "words" to the audio material that is spoken, or remove it.')];
    const read = ctx.wordsRead[m.id];
    return read && 'error' in read ? [error(at, read.error, read.fix)] : [];
  });

/** A caption track's "words", "reveal" and "spoken": the sound it follows, or why it cannot follow one. */
export const captionWords = (ctx: CheckContext, t: CaptionTrack, at: string): { problems: Problem[]; words?: TrackWords } => {
  const follows = t.words !== undefined && t.words !== false;
  const out: Problem[] = [];
  if (t.reveal === 'words' && !follows)
    out.push(error(at + '.reveal', 'Caption track "' + t.id + '" reveals its tokens as they are spoken ("reveal": "words"), but it does not follow the words.', 'Add "words": true (or the id of the audio track with the words), or remove "reveal".'));
  if (!follows) {
    if (typeof t.style === 'object' && t.style.spoken)
      out.push(warning(at + '.style.spoken', '"spoken" has no effect: caption track "' + t.id + '" does not follow the words, so no token is ever being spoken.', 'Add "words": true to the track, or remove "spoken".'));
    return { problems: out };
  }
  const src = wordsSource(ctx, t.words, { none: at + '.words', key: at + '.words' }, 'Caption track "' + t.id + '" follows the words', 'captions that follow the words');
  return { problems: src.problem ? [...out, src.problem] : out, ...(src.words ? { words: src.words } : {}) };
};
