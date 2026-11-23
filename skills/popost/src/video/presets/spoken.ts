/**
 * Captions that follow the words: the phase of a token at frame n, how it looks in that phase (style.spoken), and how
 * many characters a cue shows when its tokens appear as they are spoken. Pure functions of the frame, shared by the
 * page runtime and the tests (types.ts SpokenStyle, ResolvedWord).
 */
import type { ResolvedItem, ResolvedWord, SpokenStyle } from '../types';
import type { ElementState } from './motion';

export type TokenPhase = 'before' | 'spoken' | 'past';

/** Before its first frame, on its frames start .. end-1, or after them. */
export const tokenPhase = (w: ResolvedWord, n: number): TokenPhase => (n < w.start ? 'before' : n < w.end ? 'spoken' : 'past');

/** The box behind a spoken token when its background gives no padding or radius: fractions of the font size. */
export const SPOKEN_BACKGROUND = { padding: 0.1, radius: 0.2 } as const;

/** What a token looks like in one phase, on top of its base style. background: the spoken box is shown. */
export interface TokenLook { color?: string; weight?: number; opacity?: number; scale: number; background: boolean }

export const BASE_LOOK: TokenLook = { scale: 1, background: false };

export const tokenLook = (s: SpokenStyle | undefined, phase: TokenPhase): TokenLook => {
  if (!s || phase === 'before') return BASE_LOOK;
  if (phase === 'past')
    return s.past ? { ...BASE_LOOK, ...(s.past.color ? { color: s.past.color } : {}), ...(s.past.opacity !== undefined ? { opacity: s.past.opacity } : {}) } : BASE_LOOK;
  return { scale: s.scale ?? 1, background: s.background !== undefined, ...(s.color ? { color: s.color } : {}), ...(s.weight ? { weight: s.weight } : {}) };
};

/**
 * Characters shown at frame n when tokens appear as they are spoken: none before the first token starts, then every
 * character before the first token that has not started (so punctuation after a token shows with it).
 */
export const revealedChars = (words: readonly ResolvedWord[], length: number, n: number): number => {
  let next = 0;
  while (next < words.length && (words[next]?.start ?? Infinity) <= n) next++;
  return next === 0 ? 0 : (words[next]?.from ?? length);
};

/**
 * Characters of an item shown at frame n: as far as the typing of its entrance or exit has come, and for a cue whose
 * tokens appear as they are spoken (reveal), no further than the words have come.
 */
export const charsShown = (item: Pick<ResolvedItem, 'words' | 'reveal'>, s: ElementState, length: number, n: number): number => {
  const typed = Math.round(s.chars * length);
  return item.reveal === 'words' && item.words ? Math.min(typed, revealedChars(item.words, length, n)) : typed;
};
