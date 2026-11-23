/**
 * Hard cut candidates: frames that differ from the one before far more than the shot around them usually changes,
 * over most of the picture. Thresholds follow the local activity, so fast motion and flicker do not fire; an element
 * popping in changes too few cells of the grid to count.
 */
import type { Signals } from './signals';
import { dist } from './signals';
import { median } from './pixels';

export interface CutCandidate {
  /** First frame of the new picture. */
  frame: number;
  /** 0..1: how far the jump stands out. */
  strength: number;
  /** The picture comes back to what it was within three frames (a flash, a flicker, one beat of a glitch). */
  returns: boolean;
  /** A cut between two still pictures of one layout, found by how widely the change spreads (see stillJump). */
  still?: boolean;
}

/** Score above which a jump can be a cut (it must also stand above the medians on both sides of it, see findCuts). */
const CUT_SCORE = 0.2;
/** Share of the 6 x 8 grid's cells that must change: a pop-in covering a third of the frame stays below. */
const CUT_CELLS = 0.55;

/** Least share of changed pixels, of touched cells and smaller side of the changed area for a cut between stills. */
const STILL_CHANGE = 0.1;
const STILL_SPREAD = 0.45;
const STILL_EXTENT = 0.7;

/**
 * A cut between two still pictures of one layout (pages of one website in a screen recording, slides of one
 * template): a tenth to a fifth of the pixels change, at low contrast, but the change is spread over most of the
 * frame at once while the frames around it hold still. A pop-in or a new caption fills one area or one strip.
 */
const stillJump = (s: Signals, i: number): boolean => {
  if ((s.chg[i] as number) < STILL_CHANGE || (s.spread[i] as number) < STILL_SPREAD || (s.extent[i] as number) < STILL_EXTENT) return false;
  const calm = Math.max(0.5, 0.15 * dist(s, i, i - 1));
  for (let k = 1; k <= 3; k++) {
    if (i - k >= 1 && dist(s, i - k, i - k - 1) > calm) return false;
    if (i + k < s.n && dist(s, i + k, i + k - 1) > calm) return false;
  }
  return !comesBack(s, i);
};

/** Medians of xs over the r frames before i and the r frames after it. */
const sideMedians = (xs: Float32Array, i: number, r: number): [number, number] => {
  const before: number[] = [], after: number[] = [];
  for (let j = Math.max(1, i - r); j < i; j++) before.push(xs[j] as number);
  for (let j = i + 1; j <= Math.min(xs.length - 1, i + r); j++) after.push(xs[j] as number);
  return [before.length ? median(before) : 0, after.length ? median(after) : 0];
};

/** True when frame i is followed within three frames by a frame that looks like the one before it again. */
const comesBack = (s: Signals, i: number): boolean => {
  const jump = dist(s, i, i - 1);
  for (let k = i + 1; k <= Math.min(s.n - 1, i + 3); k++) if (dist(s, k, i - 1) < 0.3 * jump) return true;
  return false;
};

export const findCuts = (s: Signals): CutCandidate[] => {
  const out: CutCandidate[] = [];
  const r = Math.max(4, Math.round(0.5 * s.fps));
  for (let i = 1; i < s.n; i++) {
    const score = s.score[i] as number, chg = s.chg[i] as number, blk = s.blk[i] as number;
    if (blk < CUT_CELLS) {
      if (stillJump(s, i)) out.push({ frame: i, strength: Math.min(1, Math.max(score, chg)), returns: false, still: true });
      continue;
    }
    // The jump must stand well above the calmer side and clearly above the busier one: a cut from a churning shot to
    // a still one stands above both, the frames at the start of a churning shot only above the still side before it.
    const [bl, br] = sideMedians(s.score, i, r);
    const [cl, cr] = sideMedians(s.chg, i, r);
    const strong = score > CUT_SCORE && score > 2.5 * Math.min(bl, br) + 0.06 && score > Math.max(bl, br) + 0.12;
    // Two pictures with the same colours (a re-framed shot, a page of the same layout): the histogram barely moves,
    // but nearly every pixel changes at once while the frames around change little.
    const relative = chg > 0.5 && chg > 3 * Math.max(cl, cr) + 0.2 && score > 4 * Math.max(bl, br) + 0.03;
    const base = Math.max(bl, br), chgBase = Math.max(cl, cr);
    if (!strong && !relative) continue;
    const strength = Math.min(1, Math.max(score - base, chg - chgBase));
    out.push({ frame: i, strength, returns: comesBack(s, i) });
  }
  return out;
};
