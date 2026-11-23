/**
 * Shot boundaries: hard cuts and gradual transitions found on the thumbnails, each with its span (start = last purely
 * old frame, end = first purely new frame, frame = where the new shot takes over) and its kind.
 */
import type { Boundary } from '../types';
import type { Thumbs } from './pixels';
import { round } from './pixels';
import type { Signals } from './signals';
import { computeSignals, dist, viaOf } from './signals';
import type { CutCandidate } from './cuts';
import { findCuts } from './cuts';
import { changedShare, findRamps } from './gradual';
import { activeSpan, refineSpan } from './span';
import type { Classified } from './kinds';
import { classifySpan, midFrame } from './kinds';

export interface Candidate { s: number; e: number; cuts: CutCandidate[]; ramp: boolean }

/** Two cuts this close (frames, at least 3) may be beats of one effect (a glitch, a fast slide). */
const chainGap = (fps: number): number => Math.max(3, Math.round(0.15 * fps));

/**
 * Cuts b1 < b2 belong to one effect when the picture swings back after b1, or never holds still between them
 * (every frame between changes by more than max(2, 10% of the whole change)); a short insert between two real cuts
 * holds still.
 */
const linked = (sg: Signals, a: CutCandidate, b: CutCandidate): boolean => {
  if (b.frame - a.frame > chainGap(sg.fps)) return false;
  if (a.returns || b.frame - a.frame === 1) return true;
  const whole = dist(sg, a.frame - 1, b.frame) + 1e-6;
  let quiet = Infinity;
  for (let m = a.frame + 1; m < b.frame; m++) quiet = Math.min(quiet, dist(sg, m, m - 1));
  return quiet > Math.max(2, 0.1 * whole);
};

/**
 * Two candidates with nothing but flat black or white between them (at most 0.6 s) are the two halves of a fade, and
 * so are two that meet within 3 frames next to black or white (the fade in starts before the picture is fully black); a
 * longer black card is a shot. Between them means strictly: the last frame of the first and the first of the second
 * are still a little lit (a fade of 27 frames over dark scenes: black on 5 frames, its edges a step from it, and the
 * fade was read as two dissolves).
 */
const throughVia = (sg: Signals, a: Candidate, b: Candidate): boolean => {
  if (b.s - a.e > 0.6 * sg.fps) return false;
  let all = b.s - a.e >= 2, near = false;
  for (let m = a.e + 1; m < b.s; m++) all &&= viaOf(sg, m) !== undefined;
  for (let m = Math.max(0, a.e - 2); m <= Math.min(sg.n - 1, b.s + 2); m++) near ||= viaOf(sg, m) !== undefined;
  return all || (near && b.s - a.e <= 3);
};

const cutChains = (sg: Signals, cuts: CutCandidate[]): CutCandidate[][] => {
  const chains: CutCandidate[][] = [];
  for (const c of cuts) {
    const last = chains[chains.length - 1];
    const prev = last?.[last.length - 1];
    if (last && prev && linked(sg, prev, c)) last.push(c);
    else chains.push([c]);
  }
  return chains;
};

/**
 * Widens each chain of cuts over the unusual frames around it, never past the neighbouring chains or a ramp that
 * ends before (or starts after) it, so the pace of a shot is read from that shot alone.
 */
const widen = (sg: Signals, chains: CutCandidate[][], ramps: Candidate[]): Candidate[] =>
  chains.map((chain, i) => {
    const first = (chain[0] as CutCandidate).frame, last = (chain[chain.length - 1] as CutCandidate).frame;
    const lo = Math.max(i > 0 ? ((chains[i - 1] as CutCandidate[]).at(-1) as CutCandidate).frame : 0, ...ramps.filter((r) => r.e < first - 1).map((r) => r.e));
    const hi = Math.min(i + 1 < chains.length ? ((chains[i + 1] as CutCandidate[])[0] as CutCandidate).frame - 1 : sg.n - 1, ...ramps.filter((r) => r.s > last).map((r) => r.s));
    return { s: activeSpan(sg, first, lo, hi).start, e: activeSpan(sg, last, lo, hi).end, cuts: chain, ramp: false };
  });

const mergeAll = (sg: Signals, cands: Candidate[]): Candidate[] => {
  const sorted = [...cands].sort((a, b) => a.s - b.s || a.e - b.e);
  const out: Candidate[] = [];
  for (const c of sorted) {
    const cur = out[out.length - 1];
    if (cur && (c.s <= cur.e || throughVia(sg, cur, c))) out[out.length - 1] = { s: cur.s, e: Math.max(cur.e, c.e), cuts: [...cur.cuts, ...c.cuts], ramp: cur.ramp || c.ramp };
    else out.push(c);
  }
  return out;
};

/** Kinds whose switch is a hard cut in the middle of moving or blurred frames: the boundary is that cut. */
const SWITCHED = new Set(['spin', 'blur', 'shake', 'glitch']);

/**
 * A span no transition model explains, with a hard cut inside that carries nearly all of the change across it (85%),
 * is that cut: the rest is the shots' own movement (a push-in that starts on the cut, a picture settling after it). A
 * dissolve whose elements switch at the takeover has a large step too, but the mix carries a good part of the change.
 */
const CUT_CARRIES = 0.85;
const cutInsideGuess = (sg: Signals, k: Classified, D: number, biggest: CutCandidate | undefined): Classified =>
  k.guessed && biggest && dist(sg, biggest.frame - 1, biggest.frame) >= CUT_CARRIES * D ? { kind: 'cut', confidence: 0.5 } : k;

const toBoundary = (t: Thumbs, sg: Signals, c: Candidate, lo: number, hi: number): Boundary | undefined => {
  const r = refineSpan(sg, c.s, c.e, lo, hi);
  const D = dist(sg, r.start, r.end);
  // a lasting change of most of the picture; a flash or flicker comes back, a pop-in changes a part; a cut between
  // two stills of one layout changes little of the picture but all over it (cuts.ts)
  const still = c.cuts.length === 1 && c.cuts[0]?.still === true && r.end - r.start <= 1;
  if (!still && (D < 5 || changedShare(sg, r.start, r.end) < 0.3)) return undefined;
  const inside = c.cuts.filter((x) => x.frame > r.start && x.frame <= r.end);
  const biggest = inside.reduce<CutCandidate | undefined>((a, b) => (!a || b.strength > a.strength ? b : a), undefined);
  const k = cutInsideGuess(sg, classifySpan(t, sg, r.start, r.end, lo, hi), D, biggest);
  let frame = k.takeover ?? (SWITCHED.has(k.kind) && biggest ? biggest.frame : r.takeover);
  if (k.kind === 'cut') frame = biggest?.frame ?? r.end;
  if (!(frame > r.start && frame <= r.end)) frame = midFrame(r.start, r.end);
  const confidence = k.kind === 'cut' ? Math.min(1, 0.5 + (biggest?.strength ?? 0.3)) : k.confidence;
  return {
    frame, kind: k.kind, start: k.kind === 'cut' ? frame - 1 : r.start, end: k.kind === 'cut' ? frame : r.end,
    ...(k.direction ? { direction: k.direction } : {}), ...(k.mode ? { mode: k.mode } : {}), ...(k.via ? { via: k.via } : {}),
    confidence: round(confidence, 3),
    ...(k.kind !== 'cut' && k.residual !== undefined ? { residual: round(k.residual, 3) } : {}),
    ...(k.kind !== 'cut' && k.bend !== undefined ? { bend: round(k.bend, 3) } : {}),
  };
};

/** The merged candidate spans before they are described (for inspection and tests). */
export const candidates = (t: Thumbs, sg: Signals): Candidate[] => {
  const chains = cutChains(sg, findCuts(sg));
  const ramps: Candidate[] = findRamps(t, sg).map((r) => ({ s: r.s, e: r.e, cuts: [], ramp: true }));
  return mergeAll(sg, [...widen(sg, chains, ramps), ...ramps]);
};

/** Finds and describes every boundary of a video from its thumbnails (every frame, in order). */
export const detectBoundaries = (t: Thumbs, sg: Signals = computeSignals(t)): Boundary[] => {
  if (sg.n < 3) return [];
  const groups = candidates(t, sg);
  const out: Boundary[] = [];
  groups.forEach((g, i) => {
    const lo = i > 0 ? (groups[i - 1] as Candidate).e : 0;
    const hi = i + 1 < groups.length ? (groups[i + 1] as Candidate).s : sg.n - 1;
    const b = toBoundary(t, sg, g, lo, hi);
    const prev = out[out.length - 1];
    if (b && (!prev || b.frame > prev.frame + 1)) out.push(prev && b.start < prev.end ? { ...b, start: Math.max(b.start, prev.frame) } : b);
  });
  return out;
};
