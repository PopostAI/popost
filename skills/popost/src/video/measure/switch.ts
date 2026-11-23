/**
 * Switched transitions: one picture is replaced by the other in one step (no frame is a mix of the two), while each
 * picture is turned, jolted or blurred around the switch (spin, shake, glitch, blur in our presets). Every frame of the
 * span is read against both clean ends: as that end unchanged, moved (a jolt), turned, or blurred. The better reading
 * says which picture the frame shows. A side that shows nothing (a flat colour shaken, or turned under a cover scale,
 * is the same flat colour) adds nothing; when neither side shows anything, the switch is what the eye sees: a cut.
 */
import type { Thumbs } from './pixels';
import type { Signals } from './signals';
import { detail, dist } from './signals';
import { align } from './align';
import { coverScale, diffs, gaussBlur, ratio, warpDiffs } from './robust';

export type Reading = { kind: 'same' } | { kind: 'turned'; deg: number } | { kind: 'moved'; dx: number; dy: number; scale: number } | { kind: 'blurred' } | { kind: 'veiled'; via: 'black' | 'white'; opacity: number } | { kind: 'other' };

export interface SwitchReading {
  /** First frame of the new picture. */
  at: number;
  /** Largest turn of a frame against its end, degrees. */
  turn: number;
  /** Frames read as a moved end: shift in fractions of the frame, scale. */
  moved: Array<{ side: -1 | 1; frame: number; dx: number; dy: number; scale: number }>;
  blurred: number;
  /** Frames that no reading explains. */
  other: number;
  /** Times the picture went back to the old one after showing the new one. */
  backs: number;
  /** The clean ends the frames were read against, and each frame's reading (for inspection and tests). */
  refs: [number, number];
  frames: Array<{ frame: number; side: -1 | 1; reading: string; read: Reading; old: Reading; next: Reading }>;
  /** The largest step of the span: where a one-sided transition cuts. */
  cut: number;
}

/** Blurs tried, standard deviations in pixels of the thumbnail (72 px across a portrait frame). The blur preset peaks at
 *  0.06 x strength (up to 2) of the smaller side: up to 8.6 px. */
const SIGMAS = [0.6, 0.9, 1.3, 1.8, 2.5, 3.5, 5, 7, 9];
/** A frame within max(SAME, 2.5 x the shot's frame-to-frame noise) of its end shows nothing (levels). */
const SAME = 1.2;
/** A reading must explain at least half of the frame's difference to its end. */
const EXPLAINS = 0.5;
/** A jolt moves the picture by at most this share of the frame and keeps it covering the frame; more is a slide. */
const MAX_JOLT = 0.12;
/** Mixed: A + alpha (B - A) with alpha well inside 0..1, a small residual, and the detail a mix keeps. */
export const isMix = (sg: Signals, a: number, b: number, m: number): boolean => {
  const A = sg.small[a] as Float32Array, B = sg.small[b] as Float32Array, M = sg.small[m] as Float32Array;
  let num = 0, den = 0, scale = 0;
  for (let i = 0; i < A.length; i++) { const d = (B[i] as number) - (A[i] as number); num += ((M[i] as number) - (A[i] as number)) * d; den += d * d; scale += Math.abs(d); }
  if (den < 1e-6) return false;
  const alpha = num / den;
  if (alpha < 0.15 || alpha > 0.85) return false;
  let r = 0;
  for (let i = 0; i < A.length; i++) r += Math.abs((M[i] as number) - ((A[i] as number) + alpha * ((B[i] as number) - (A[i] as number))));
  // a blurred picture over a flat one looks like a mix in block means, but has far less detail than a mix keeps
  // (a mix of two sharp pictures keeps about 0.7 of the weighted detail of its ends)
  const expected = (1 - alpha) * detail(sg, a) + alpha * detail(sg, b);
  return r / (scale + 1e-6) < 0.35 && !(expected > 2 && detail(sg, m) < 0.45 * expected);
};

/**
 * Blurred frames of one span's reading, made once: every frame is read against both ends, and each end against every
 * blur in SIGMAS, so the same blurs would otherwise be made again for every frame.
 */
type Blurs = (frame: number, sigma: number, black: boolean) => Float32Array;
const blursOf = (t: Thumbs): Blurs => {
  const made = new Map<string, Float32Array>();
  return (frame, sigma, black) => {
    const key = frame + ':' + sigma + ':' + (black ? 1 : 0);
    const hit = made.get(key);
    if (hit) return hit;
    const out = gaussBlur(t.gray[frame] as Uint8Array, t.width, t.height, sigma, black);
    made.set(key, out);
    return out;
  };
};

/** The end blurred as well as any blur in SIGMAS can: [plain, trimmed] differences, each the smallest found. */
const blurDiffs = (blurs: Blurs, ref: number, m: ArrayLike<number>): [number, number] => {
  let p = Infinity, q = Infinity;
  for (const s of SIGMAS) for (const black of [false, true]) { const [x, y] = diffs(blurs(ref, s, black), m); p = Math.min(p, x); q = Math.min(q, y); }
  return [p, q];
};

/** Frame m as its end under a veil of black or white, (1 - o) ref + o C: the opacity and the mean difference left. */
const veilFit = (ref: ArrayLike<number>, m: ArrayLike<number>): { via: 'black' | 'white'; opacity: number; d: number } => {
  const fits = ([['black', 0], ['white', 255]] as const).map(([via, c]) => {
    let num = 0, den = 0;
    for (let i = 0; i < ref.length; i++) { const x = (ref[i] as number) - c; num += x * ((ref[i] as number) - (m[i] as number)); den += x * x; }
    const o = den > 1e-6 ? Math.min(1, Math.max(0, num / den)) : 1;
    let d = 0;
    for (let i = 0; i < ref.length; i++) d += Math.abs((m[i] as number) - ((1 - o) * (ref[i] as number) + o * c));
    return { via, opacity: o, d: d / Math.max(1, ref.length) };
  });
  return (fits[0] as (typeof fits)[number]).d <= (fits[1] as (typeof fits)[number]).d ? (fits[0] as (typeof fits)[number]) : (fits[1] as (typeof fits)[number]);
};

/** A veil this faint is no veil (a light change of the shot). A veil is one number per frame, and darkening or lightening
 *  any picture halves its difference to an unrelated one, so it must explain three quarters of the difference. */
const MIN_VEIL = 0.05;
const VEIL_EXPLAINS = 0.25;
/** A flat colour under a veil is a flat colour: what the veil leaves of a frame read against a flat end must be noise
 *  (at most this mean difference, levels). A darker picture comes close to a light flat colour veiled toward black in
 *  proportion, but its own detail stays. */
const VEIL_LEFT = 4;

/** The turn (degrees) whose warp, scaled to cover or not, best explains frame m, with its differences. */
const turnFit = (ref: ArrayLike<number>, m: ArrayLike<number>, w: number, h: number): { deg: number; d: [number, number] } => {
  let deg = 0, scale = 1, d: [number, number] = [Infinity, Infinity];
  const consider = (g: number, s: number): void => { const e = warpDiffs(ref, m, w, h, g, s); if (e[1] < d[1]) { d = e; deg = g; scale = s; } };
  for (let g = -90; g <= 90; g += 3) if (Math.abs(g) >= 3) for (const s of [coverScale(g, w, h), 1]) consider(g, s);
  const [g0, s0] = [deg, scale];
  for (const dg of [-1.5, -0.75, 0.75, 1.5]) for (const k of [0.95, 1, 1.05]) consider(g0 + dg, s0 * k);
  return { deg, d };
};

/**
 * Moves and turns are compared at a common softness (Gaussian, in thumbnail pixels): a renderer resamples a layer it
 * moves, scales or turns with another filter than the same layer at rest (Chrome's transformed layers come out sharper
 * or more aliased; a camera adds motion blur), and that difference of fine texture is not a difference of picture.
 */
const SOFT = 1;

/** A move this small is a picture at rest (the last beats of a decaying shake, compression wobble). */
const isTiny = (dx: number, dy: number, scale: number): boolean => Math.abs(dx) < 0.008 && Math.abs(dy) < 0.008 && Math.abs(scale - 1) < 0.03;

/** The best reading of frame m against end ref. A turn must clearly beat the best move: a smooth picture fits many warps. */
const readFrame = (t: Thumbs, sg: Signals, ref: number, m: number, same: number, blurs: Blurs): Reading => {
  if (dist(sg, m, ref) <= same) return { kind: 'same' };
  const a = t.gray[ref] as Uint8Array, b = t.gray[m] as Uint8Array, w = t.width, h = t.height;
  const before = diffs(a, b);
  if (before[0] <= SAME) return { kind: 'same' };
  // a veil of black or white (a fade or flash on one side) shows on any end, a flat one too
  const veil = veilFit(a, b);
  const veilR = veil.opacity >= MIN_VEIL && veil.d <= VEIL_EXPLAINS * before[0] ? (veil.d / (before[0] + 1e-6)) * (EXPLAINS / VEIL_EXPLAINS) : Infinity;
  const veiled: Reading = { kind: 'veiled', via: veil.via, opacity: veil.opacity };
  // a flat end can otherwise only show a blur (its edges fading to black); its change sits at the borders, so no trimming
  if (detail(sg, ref) < 2) {
    const blurFlat = blurDiffs(blurs, ref, b)[0] / (before[0] + 1e-6), flatVeilR = veil.d <= VEIL_LEFT ? veilR : Infinity;
    return Math.min(flatVeilR, blurFlat) > EXPLAINS ? { kind: 'other' } : flatVeilR < blurFlat ? veiled : { kind: 'blurred' };
  }
  // a small jolt is found from rest; the coarse search is for larger ones and can lock onto a repeating texture
  const sa = blurs(ref, SOFT, false), sb = blurs(m, SOFT, false), softBefore = diffs(sa, sb);
  const fits = [align(sa, sb, w, h), align(sa, sb, w, h, { search: true })].filter((f) => f.coverage > 0.85);
  const fit = fits.reduce<(typeof fits)[number] | undefined>((x, y) => (!x || y.residual < x.residual ? y : x), undefined);
  const dx = fit ? fit.tx / w : 0, dy = fit ? fit.ty / h : 0, scale = fit?.scale ?? 1;
  const jolt = fit !== undefined && Math.max(Math.abs(dx), Math.abs(dy)) <= MAX_JOLT && scale > 0.85 && scale < 1.3;
  const moveR = fit ? Math.min(fit.residual / (fit.before + 1e-6), ratio(warpDiffs(sa, sb, w, h, 0, scale, fit.tx, fit.ty), softBefore)) : Infinity;
  const turn = turnFit(sa, sb, w, h);
  const turnR = Math.abs(turn.deg) >= 3 ? ratio(turn.d, softBefore) : Infinity;
  const blurR = ratio(blurDiffs(blurs, ref, b), before);
  const options: Array<[number, Reading]> = [
    [jolt ? moveR : Infinity, isTiny(dx, dy, scale) ? { kind: 'same' } : { kind: 'moved', dx, dy, scale }],
    [turnR < 0.7 * moveR ? turnR : Infinity, { kind: 'turned', deg: Math.abs(turn.deg) }],
    [blurR, { kind: 'blurred' }],
    [veilR, veiled],
  ];
  const [r, reading] = options.reduce((x, y) => (y[0] < x[0] ? y : x));
  if (r <= EXPLAINS) return reading;
  // at rest but for an interpolation floor (fine texture): the motion-compensated difference is clearly smaller
  return fit && isTiny(dx, dy, scale) && fit.residual < 0.7 * fit.before ? { kind: 'same' } : { kind: 'other' };
};

/** Which reading is the better one: unchanged, then explained by a model, then not explained. */
const RANK: Readonly<Record<Reading['kind'], number>> = { same: 0, turned: 1, moved: 1, blurred: 1, veiled: 1, other: 2 };

/** Median frame-to-frame change of up to 6 frames from 'from' going 'dir' (inside lo..hi). */
const noiseFrom = (sg: Signals, from: number, dir: -1 | 1, lo: number, hi: number): number => {
  const ds: number[] = [];
  for (let k = 0; k < 6; k++) {
    const m = from + dir * k, n = m + dir;
    if (m < lo || n < lo || m > hi || n > hi) break;
    ds.push(dist(sg, m, n));
  }
  ds.sort((x, y) => x - y);
  return ds.length ? (ds[ds.length >> 1] as number) : 0;
};

/**
 * The clean end of one side: from the span's end, outwards while the picture still changes faster than the shot
 * does further out (the last frames of a decaying shake differ little from each other, but are not yet at rest).
 */
const settledEnd = (sg: Signals, from: number, dir: -1 | 1, lo: number, hi: number): number => {
  const reach = Math.max(4, Math.round(0.4 * sg.fps));
  const quiet = Math.max(0.6, 2.5 * noiseFrom(sg, from + dir * reach, dir, lo, hi));
  let m = from;
  while (m + dir > lo && m + dir < hi && Math.abs(m - from) < reach && dist(sg, m, m + dir) > quiet) m += dir;
  return m;
};

const label = (r: Reading): string =>
  r.kind === 'moved' ? 'moved ' + r.dx.toFixed(3) + ',' + r.dy.toFixed(3) + ' x' + r.scale.toFixed(3) : r.kind === 'turned' ? 'turned ' + r.deg.toFixed(1) : r.kind === 'veiled' ? 'veiled ' + r.via + ' ' + r.opacity.toFixed(2) : r.kind;

/**
 * Reads a span as a switch: the largest step carries at least half of the change and no frame is a mix. Undefined
 * when the span is not one. lo and hi bound how far the sides may be followed (the neighbouring boundaries).
 */
export const readSwitch = (t: Thumbs, sg: Signals, start: number, end: number, lo = 0, hi = sg.n - 1): SwitchReading | undefined => {
  if (end - start < 2) return undefined;
  const D = dist(sg, start, end);
  let at = start + 1;
  for (let m = start + 2; m <= end; m++) if (dist(sg, m, m - 1) > dist(sg, at, at - 1)) at = m;
  if (dist(sg, at, at - 1) < 0.5 * D) return undefined;
  const a = settledEnd(sg, start, -1, lo, hi), b = settledEnd(sg, end, 1, lo, hi);
  const sameA = Math.max(SAME, 2.5 * noiseFrom(sg, a, -1, lo, hi)), sameB = Math.max(SAME, 2.5 * noiseFrom(sg, b, 1, lo, hi));
  // each frame is read once against each end (the mix test below and the reading after it ask for the same readings)
  const blurs = blursOf(t), readings = new Map<number, Reading>();
  const readAt = (ref: number, m: number, same: number): Reading => {
    const key = ref === a ? -1 - m : m;
    const hit = readings.get(key);
    if (hit) return hit;
    const r = readFrame(t, sg, ref, m, same, blurs);
    readings.set(key, r);
    return r;
  };
  // a frame that mixes the two pictures rules a switch out, unless it is one picture blurred (in block means a blurred
  // picture over a flat one can pass for a mix)
  for (let m = start + 1; m < end; m++) {
    if (isMix(sg, start, end, m) && readAt(a, m, sameA).kind !== 'blurred' && readAt(b, m, sameB).kind !== 'blurred') return undefined;
  }
  const out: SwitchReading = { at, turn: 0, moved: [], blurred: 0, other: 0, backs: 0, refs: [a, b], frames: [], cut: at };
  let lastOld = a, prev: -1 | 1 = -1;
  for (let m = a + 1; m < b; m++) {
    const ro = readAt(a, m, sameA), rn = readAt(b, m, sameB);
    const side: -1 | 1 = RANK[rn.kind] < RANK[ro.kind] || (RANK[rn.kind] === RANK[ro.kind] && m >= at) ? 1 : -1;
    const r = side < 0 ? ro : rn;
    if (side < 0) lastOld = m;
    if (side < 0 && prev > 0) out.backs++;
    prev = side;
    out.frames.push({ frame: m, side, reading: label(r), read: r, old: ro, next: rn });
    if (r.kind === 'turned') out.turn = Math.max(out.turn, r.deg);
    else if (r.kind === 'moved') out.moved.push({ side, frame: m, dx: r.dx, dy: r.dy, scale: r.scale });
    else if (r.kind === 'blurred') out.blurred++;
    else if (r.kind === 'other') out.other++;
  }
  return { ...out, at: Math.min(end, Math.max(start + 1, lastOld + 1)) };
};

/**
 * Vertical travel against horizontal under which jolts are a glitch. The presets (presets/transition.ts) define the
 * difference: a glitch offsets the picture sideways only (its vertical offset is 0 on every frame), a shake also moves
 * it up or down by (hash - 0.5) of its amplitude, 0.33 of its sideways offset on average (0.07 to 0.70 by frame). Each
 * frame adds 0.002 of the frame to the vertical allowance: the fit's noise on a small thumbnail.
 */
export const GLITCH_VERTICAL = 0.12;
const NOISE = 0.002;

/**
 * Shake or glitch, from both things the presets fix: a shake moves the picture up and down too (GLITCH_VERTICAL) and
 * flips its sideways direction on every frame (the sign is the frame's parity); a glitch moves it sideways only, with
 * signs that keep as often as they flip. Little vertical travel is a glitch unless every pair of neighbouring frames
 * (two or more) flips.
 */
export const joltKind = (moved: ReadonlyArray<{ dx: number; dy: number; frame?: number; side?: number }>): 'shake' | 'glitch' => {
  const sx = moved.reduce((s, x) => s + Math.abs(x.dx), 0), sy = moved.reduce((s, x) => s + Math.abs(x.dy), 0);
  if (sy > GLITCH_VERTICAL * sx + NOISE * moved.length) return 'shake';
  let flips = 0, keeps = 0;
  for (let i = 1; i < moved.length; i++) {
    const p = moved[i - 1] as (typeof moved)[number], q = moved[i] as (typeof moved)[number];
    if (p.side !== q.side || p.frame === undefined || q.frame !== p.frame + 1 || Math.abs(p.dx) < 0.004 || Math.abs(q.dx) < 0.004) continue;
    if (Math.sign(p.dx) !== Math.sign(q.dx)) flips++;
    else keeps++;
  }
  return flips >= 2 && keeps === 0 ? 'shake' : 'glitch';
};

/**
 * A few frames that no reading explains are tolerated (a mis-fit on a repeating texture). So is a side none of whose
 * frames can be read (a fine noise texture turned or shaken), when at least two frames of the other side are explained
 * and none is left unexplained.
 */
const convincing = (r: SwitchReading): boolean => {
  const sides = ([-1, 1] as const).map((side) => {
    const fs = r.frames.filter((f) => f.side === side);
    const other = fs.filter((f) => f.reading === 'other').length, same = fs.filter((f) => f.reading === 'same').length;
    return { other, explained: fs.length - other - same };
  });
  const explained = sides.reduce((s, x) => s + x.explained, 0);
  if (r.other <= 0.25 * (explained + r.other)) return true;
  return sides.some((x) => x.explained >= 2 && x.other === 0);
};

export interface SwitchKind {
  kind: 'spin' | 'shake' | 'glitch' | 'blur' | 'cut' | 'zoom' | 'whip' | 'fade' | 'flash';
  confidence: number;
  takeover: number;
  via?: 'black' | 'white';
  direction?: 'left' | 'right' | 'up' | 'down';
}

type Frame = SwitchReading['frames'][number];

/** A veil at full white (a flash holds it on two frames or more; a fade through white touches it once at most). */
const FULL = 0.97;
/** Moves that only scale (shift under 1% of the frame, scale off by 3% or more) are a zoom; moves that shift without
 *  scaling (under 3%) are a whip, whose picture travels at its own size, while a jolt of a shake or a glitch scales the
 *  picture by 1 + 2 x its offset to keep the frame covered (presets/transition.ts). */
const PURE_SHIFT = 0.01;
const SCALED = 0.03;

/** Whip: every moved frame is offset the same way along one axis (a shake or a glitch swings both ways). */
const whipDirection = (moved: ReadonlyArray<{ dx: number; dy: number }>, side: -1 | 1): SwitchKind['direction'] => {
  const sx = moved.reduce((s, x) => s + x.dx, 0), sy = moved.reduce((s, x) => s + x.dy, 0);
  const ax = moved.reduce((s, x) => s + Math.abs(x.dx), 0), ay = moved.reduce((s, x) => s + Math.abs(x.dy), 0);
  const horizontal = ax >= ay;
  const net = horizontal ? sx : sy, path = horizontal ? ax : ay;
  if (moved.length < 2 || Math.abs(net) < 0.9 * path || path < 0.04) return undefined;
  // 'before': the old picture leaves the way the pictures travel; 'after': the new one arrives from the other side
  const way = side < 0 ? Math.sign(net) : -Math.sign(net);
  return horizontal ? (way > 0 ? 'right' : 'left') : way > 0 ? 'down' : 'up';
};

/**
 * The kind of a one-sided effect from the readings of the frames that show it (presets/transition.ts EFFECTS): a veil
 * is a fade (black, or white that reaches full white at most once) or a flash, a turn a spin, a blur a blur, a move
 * that only scales a zoom, moves one way a whip, jolts a shake or a glitch.
 */
const effectKind = (fx: readonly Frame[], side: -1 | 1): Omit<SwitchKind, 'confidence' | 'takeover'> => {
  const reads = fx.map((f) => f.read);
  const count = (k: Reading['kind']): number => reads.filter((r) => r.kind === k).length;
  const veils = reads.flatMap((r) => (r.kind === 'veiled' ? [r] : []));
  const moved = reads.flatMap((r) => (r.kind === 'moved' ? [r] : []));
  const turned = reads.flatMap((r) => (r.kind === 'turned' ? [r] : []));
  if (veils.length * 2 >= reads.length) {
    const white = veils.filter((v) => v.via === 'white').length * 2 >= veils.length;
    if (white && veils.filter((v) => v.via === 'white' && v.opacity >= FULL).length >= 2) return { kind: 'flash' };
    return { kind: 'fade', via: white ? 'white' : 'black' };
  }
  if (turned.some((r) => r.deg >= 20)) return { kind: 'spin' };
  if (count('blurred') >= Math.max(moved.length, turned.length, 1)) return { kind: 'blur' };
  if (moved.length && moved.every((r) => Math.abs(r.dx) < PURE_SHIFT && Math.abs(r.dy) < PURE_SHIFT) && moved.some((r) => Math.abs(r.scale - 1) >= SCALED)) return { kind: 'zoom' };
  const way = moved.every((r) => Math.abs(r.scale - 1) < SCALED) ? whipDirection(moved, side) : undefined;
  if (way) return { kind: 'whip', direction: way };
  // jolts keep their frames, so a shake's flip from side to side on every frame is seen (joltKind)
  if (moved.length) return { kind: joltKind(fx.flatMap((f) => (f.read.kind === 'moved' ? [{ ...f.read, frame: f.frame, side: f.side }] : []))) };
  return { kind: turned.length ? 'spin' : 'blur' };
};

/**
 * One-sided: the frames on one side of the switch are their end at rest, the other side's show it under an effect
 * (types.ts header: 'after' settles the new shot out of the effect, 'before' takes the old one into it). The effect
 * fades in or out, so its weakest frames, farthest from the switch, may be unexplained; between the first explained
 * frame and the switch at most a quarter may be.
 */
export const oneSidedKind = (r: SwitchReading): SwitchKind | undefined => {
  // one picture before the cut and the other after it: each frame is read against the end of its own side
  const byPlace = r.frames.map((f): Frame => (f.frame < r.cut ? { ...f, side: -1, read: f.old } : { ...f, side: 1, read: f.next }));
  for (const side of [-1, 1] as const) {
    const fx = byPlace.filter((f) => f.side === side), rest = byPlace.filter((f) => f.side !== side);
    if (rest.some((f) => f.read.kind !== 'same')) continue;
    const explained = fx.filter((f) => f.read.kind !== 'same' && f.read.kind !== 'other');
    if (explained.length < 2) continue;
    // a frame on the effect's side that shows the other side's picture (unexplained by its own end, explained by the
    // other) means the pictures switch inside the span: a transition of two pictures
    if (fx.some((f) => f.read.kind === 'other' && (side < 0 ? f.next : f.old).kind !== 'other')) continue;
    // frames from the strongest end of the effect (next to the switch) to the last explained one
    const near = side < 0 ? fx.filter((f) => f.frame >= (explained[0] as Frame).frame) : fx.filter((f) => f.frame <= (explained[explained.length - 1] as Frame).frame);
    if (near.filter((f) => f.read.kind === 'other').length > 0.25 * near.length) continue;
    return { ...effectKind(explained, side), confidence: 0.6, takeover: r.cut };
  }
  return undefined;
};

/** The kind of a switched span, or undefined when it is not one or too many frames show something else. */
export const switchKind = (t: Thumbs, sg: Signals, start: number, end: number, lo = 0, hi = sg.n - 1, read?: SwitchReading | null): SwitchKind | undefined => {
  const r = read === undefined ? readSwitch(t, sg, start, end, lo, hi) : read ?? undefined;
  if (!r) return undefined;
  const one = oneSidedKind(r);
  if (one) return one;
  if (!convincing(r)) return undefined;
  if (r.backs > 0 && r.turn < 20) return { kind: 'glitch', confidence: 0.6, takeover: r.at };
  if (r.turn >= 20) return { kind: 'spin', confidence: 0.7, takeover: r.at };
  if (r.moved.length) return { kind: joltKind(r.moved), confidence: 0.6, takeover: r.at };
  if (r.blurred) return { kind: 'blur', confidence: 0.6, takeover: r.at };
  return { kind: 'cut', confidence: 0.6, takeover: r.at };
};