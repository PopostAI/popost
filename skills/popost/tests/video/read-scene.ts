/**
 * A small deterministic renderer for test clips that xfade cannot make: transitions that move, turn, blur or glitch
 * the picture, camera moves, light ramps and elements that enter and leave. It follows the semantics the make side's
 * presets describe (src/presets/transition.ts, motion.ts) but shares no code with them or with the measurement, so a
 * test checks the measurement against an independent picture. Frames are rgb24, w x h.
 */
import type { Boundary, Box, Direction, Ease, MotionEvent, TransitionKind, WipeDirection } from '../../src/video/types';
import { truthOf } from './read-clips';

export type Rgb = [number, number, number];
/** A picture to show: a flat colour, or rgb frames (one = still) of size w x h, at least as large as the canvas. */
export type Base = { colour: Rgb } | { w: number; h: number; frames: readonly Uint8Array[] };

export interface SceneShot {
  frames: number;
  base: Base;
  /** CameraSpec units: scale = 1 + zoom x seconds (a pull-out starts large and ends at 1 on the shot's last frame);
   *  the picture travels pan x canvas per second. */
  camera?: { zoom?: number; pan?: [number, number] };
  /** Brightness gain over the shot's own seconds (a light ramp inside one take). */
  light?: (seconds: number) => number;
  /**
   * A keyframed move (CameraMove semantics, own code): before frame "from" (of the shot) the picture holds scale[0],
   * then the scale is lerped to scale[1] with the eased progress (n - from) / (to - from), then holds. The focus point
   * (fractions of the canvas) stays in place on screen. Replaces "camera".
   */
  move?: { from: number; to: number; scale: [number, number]; focus: [number, number]; ease: Ease };
}

export interface SceneJoin { kind: Exclude<TransitionKind, 'cut'>; frames: number; direction?: WipeDirection; mode?: 'push' | 'cover' | 'reveal'; via?: 'black' | 'white'; ease?: Ease }

export interface SceneAnim { how: 'instant' | 'fade' | 'slide' | 'scale' | 'pop' | 'wipe'; frames: number; ease?: Ease; direction?: Direction; overshoot?: number }

export interface SceneItem {
  /** On screen on frames from .. to-1 (absolute). */
  from: number;
  to: number;
  box: Box;
  colour: Rgb;
  enter?: SceneAnim;
  exit?: SceneAnim;
  /** Moves linearly from box to box + travel (fractions of the canvas) over its life: an object crossing the frame. */
  travel?: [number, number];
}

export interface Scene { width: number; height: number; fps: number; shots: SceneShot[]; joins: Array<SceneJoin | undefined>; items: SceneItem[] }

export const ease = (kind: Ease, t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  if (kind === 'in') return x * x * x;
  if (kind === 'out') return 1 - (1 - x) ** 3;
  if (kind === 'in-out') return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
  return x;
};

/** A fixed pseudo-random value in 0..1 for an integer (no randomness at run time). */
const hash = (i: number): number => {
  let h = Math.imul((i | 0) + 0x632be5ab, 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

type Img = Float32Array; // w x h x 3
const VEC: Record<Direction, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

/** The shot's own picture at its local time (seconds; may be outside the shot during transitions). */
const baseImage = (sc: Scene, shot: SceneShot, local: number, n: number): Img => {
  const { width: W, height: H } = sc;
  const out = new Float32Array(W * H * 3);
  const gain = shot.light ? shot.light(local / sc.fps) : 1;
  const b = shot.base;
  if ('colour' in b) {
    for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = (b.colour[c] as number) * gain;
    return out;
  }
  if (shot.move) return movedImage(sc, shot, b, local, n, gain);
  const t = local / sc.fps;
  const zoom = shot.camera?.zoom ?? 0;
  const S = 1 + zoom * (zoom < 0 ? t - (shot.frames - 1) / sc.fps : t);
  const [px, py] = shot.camera?.pan ?? [0, 0];
  const pic = b.frames[Math.min(b.frames.length - 1, Math.max(0, n))] as Uint8Array;
  const k = b.w / W; // picture pixels per canvas pixel
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = (b.w - 1) / 2 + ((x - (W - 1) / 2 - px * W * t) / S) * k;
      const sy = (b.h - 1) / 2 + ((y - (H - 1) / 2 - py * H * t) / S) * k;
      sample(pic, b.w, b.h, sx, sy, out, (y * W + x) * 3, gain);
    }
  }
  return out;
};

/** A picture under a keyframed move: canvas fraction u shows picture fraction f + (u - f) / s. */
const movedImage = (sc: Scene, shot: SceneShot, b: { w: number; h: number; frames: readonly Uint8Array[] }, local: number, n: number, gain: number): Img => {
  const { width: W, height: H } = sc;
  const mv = shot.move as NonNullable<SceneShot['move']>;
  const q = ease(mv.ease, (local - mv.from) / Math.max(1, mv.to - mv.from));
  const s = mv.scale[0] + (mv.scale[1] - mv.scale[0]) * q;
  const [fx, fy] = mv.focus;
  const pic = b.frames[Math.min(b.frames.length - 1, Math.max(0, n))] as Uint8Array;
  const out = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = fx + ((x + 0.5) / W - fx) / s, py = fy + ((y + 0.5) / H - fy) / s;
      sample(pic, b.w, b.h, px * b.w - 0.5, py * b.h - 0.5, out, (y * W + x) * 3, gain);
    }
  }
  return out;
};

const sample = (pic: ArrayLike<number>, w: number, h: number, x: number, y: number, out: Float32Array, at: number, gain = 1): void => {
  const cx = Math.min(w - 1.001, Math.max(0, x)), cy = Math.min(h - 1.001, Math.max(0, y));
  const x0 = Math.floor(cx), y0 = Math.floor(cy), fx = cx - x0, fy = cy - y0;
  for (let c = 0; c < 3; c++) {
    const i = (y0 * w + x0) * 3 + c;
    const top = (pic[i] as number) * (1 - fx) + (pic[i + 3] as number) * fx;
    const bot = (pic[i + w * 3] as number) * (1 - fx) + (pic[i + w * 3 + 3] as number) * fx;
    out[at + c] = (top * (1 - fy) + bot * fy) * gain;
  }
};

/** A layer moved, scaled and turned about the canvas centre (translate in fractions of the canvas, deg clockwise). */
const transform = (img: Img, W: number, H: number, tx: number, ty: number, scale: number, deg: number): Img => {
  if (tx === 0 && ty === 0 && scale === 1 && deg === 0) return img;
  const out = new Float32Array(W * H * 3);
  const r = (-deg * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const X = (x - (W - 1) / 2 - tx * W) / scale, Y = (y - (H - 1) / 2 - ty * H) / scale;
      const sx = (W - 1) / 2 + cos * X - sin * Y, sy = (H - 1) / 2 + sin * X + cos * Y;
      if (sx < -0.5 || sy < -0.5 || sx > W - 0.5 || sy > H - 0.5) continue; // outside: black
      sample(img, W, H, sx, sy, out, (y * W + x) * 3);
    }
  }
  return out;
};

/** Three box passes along x and/or y, about a Gaussian of standard deviation sigma (pixels). */
const blur = (img: Img, W: number, H: number, sx: number, sy: number): Img => {
  let cur = img;
  const pass = (src: Img, r: number, horizontal: boolean): Img => {
    const out = new Float32Array(src.length);
    const len = horizontal ? W : H, lines = horizontal ? H : W;
    for (let l = 0; l < lines; l++) {
      for (let i = 0; i < len; i++) {
        for (let c = 0; c < 3; c++) {
          let s = 0, n = 0;
          for (let k = Math.max(0, i - r); k <= Math.min(len - 1, i + r); k++) { s += src[((horizontal ? l * W + k : k * W + l) * 3) + c] as number; n++; }
          out[((horizontal ? l * W + i : i * W + l) * 3) + c] = s / n;
        }
      }
    }
    return out;
  };
  const radius = (sigma: number): number => Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2);
  for (let p = 0; p < 3; p++) {
    if (radius(sx) > 0) cur = pass(cur, radius(sx), true);
    if (radius(sy) > 0) cur = pass(cur, radius(sy), false);
  }
  return cur;
};

const mix = (a: Img, b: Img, wb: number): Img => a.map((v, i) => v * (1 - wb) + (b[i] as number) * wb);
const veil = (a: Img, colour: number, o: number): Img => a.map((v) => v * (1 - o) + colour * o);
const tri = (e: number): number => 1 - Math.abs(2 * e - 1);
const coverScale = (deg: number, W: number, H: number): number => {
  const r = (deg * Math.PI) / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  return Math.max((W * c + H * s) / W, (W * s + H * c) / H);
};

/** Pixels where the new picture shows during a wipe at eased progress e. */
const wipeMask = (dir: WipeDirection, e: number, x: number, y: number, W: number, H: number): boolean => {
  const half = Math.hypot(W / 2, H / 2), r = Math.hypot(x + 0.5 - W / 2, y + 0.5 - H / 2);
  switch (dir) {
    case 'left': return x + 0.5 >= (1 - e) * W;
    case 'right': return x + 0.5 < e * W;
    case 'up': return y + 0.5 >= (1 - e) * H;
    case 'down': return y + 0.5 < e * H;
    case 'center-out': return r < e * half;
    case 'edges-in': return r >= (1 - e) * half;
  }
};

const composeTransition = (sc: Scene, j: SceneJoin, i: number, oldI: Img, newI: Img): Img => {
  const { width: W, height: H } = sc;
  const p = (i + 1) / (j.frames + 1), e = ease(j.ease ?? 'linear', p);
  const dir = j.direction ?? 'left';
  const [vx, vy] = VEC[(dir in VEC ? dir : 'left') as Direction];
  const side = Math.min(W, H);
  switch (j.kind) {
    case 'dissolve': return mix(oldI, newI, e);
    case 'fade': return veil(e < 0.5 ? oldI : newI, j.via === 'white' ? 255 : 0, tri(e));
    case 'flash': return veil(e < 0.5 ? oldI : newI, 255, Math.min(1, 1.5 * tri(e)));
    case 'wipe': {
      const out = new Float32Array(oldI.length);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const src = wipeMask(dir, e, x, y, W, H) ? newI : oldI; for (let c = 0; c < 3; c++) out[(y * W + x) * 3 + c] = src[(y * W + x) * 3 + c] as number; }
      return out;
    }
    case 'slide': {
      const mode = j.mode ?? 'push';
      const o = mode === 'cover' ? oldI : transform(oldI, W, H, vx * e, vy * e, 1, 0);
      const nw = mode === 'reveal' ? newI : transform(newI, W, H, vx * (e - 1), vy * (e - 1), 1, 0);
      return mode === 'reveal' ? over(nw, o, W, H, vx * e, vy * e) : over(o, nw, W, H, vx * (e - 1), vy * (e - 1));
    }
    case 'zoom': return mix(transform(newI, W, H, 0, 0, 1 + 0.25 * (1 - e), 0), transform(oldI, W, H, 0, 0, 1 + 0.5 * e, 0), 1 - e);
    case 'spin': {
      const q = ease('in-out', e < 0.5 ? e / 0.5 : (e - 0.5) / 0.5);
      const deg = e < 0.5 ? 90 * q : -90 * (1 - q);
      return transform(e < 0.5 ? oldI : newI, W, H, 0, 0, coverScale(deg, W, H), deg);
    }
    case 'blur': {
      const s = 0.06 * side * (e < 0.5 ? e / 0.5 : 1 - (e - 0.5) / 0.5);
      return blur(e < 0.5 ? oldI : newI, W, H, s, s);
    }
    case 'glitch': {
      const useNew = (i + 0.5) / j.frames > 0.3 + 0.4 * hash(i);
      const dx = (hash(i + 101) - 0.5) * 2 * 0.08 * tri(p);
      return transform(useNew ? newI : oldI, W, H, dx, 0, 1 + 2 * Math.abs(dx), 0);
    }
    case 'shake': {
      const amp = 0.05 * (e < 0.5 ? e / 0.5 : ((1 - e) / 0.5) ** 2);
      const dx = amp * (i % 2 === 0 ? 1 : -1) * (0.6 + 0.4 * hash(i)), dy = amp * (hash(i + 7) - 0.5);
      return transform(e < 0.5 ? oldI : newI, W, H, dx, dy, 1 + 2 * amp, 0);
    }
    case 'whip': {
      const s = 0.08 * side * tri(e);
      const o = blur(transform(oldI, W, H, vx * e, vy * e, 1, 0), W, H, Math.abs(vx) * s, Math.abs(vy) * s);
      const nw = blur(transform(newI, W, H, vx * (e - 1), vy * (e - 1), 1, 0), W, H, Math.abs(vx) * s, Math.abs(vy) * s);
      return over(o, nw, W, H, vx * (e - 1), vy * (e - 1));
    }
  }
};

/** The top layer (moved by tx, ty fractions of the canvas) over the bottom one, where the top layer covers. */
const over = (bottom: Img, top: Img, W: number, H: number, tx: number, ty: number): Img => {
  const out = Float32Array.from(bottom);
  const x0 = Math.round(tx * W), y0 = Math.round(ty * H);
  for (let y = Math.max(0, y0); y < Math.min(H, H + y0); y++) for (let x = Math.max(0, x0); x < Math.min(W, W + x0); x++) for (let c = 0; c < 3; c++) out[(y * W + x) * 3 + c] = top[(y * W + x) * 3 + c] as number;
  return out;
};

export { composeTransition, baseImage, blur, transform, hash, tri };

export interface Timeline { starts: number[]; total: number; a: number[] }

export const timeline = (sc: Scene): Timeline => {
  const starts = sc.shots.map((_, k) => sc.shots.slice(0, k).reduce((s, x) => s + x.frames, 0));
  const total = sc.shots.reduce((s, x) => s + x.frames, 0);
  const a = sc.joins.map((j, k) => (starts[k + 1] as number) - Math.floor((j?.frames ?? 0) / 2));
  return { starts, total, a };
};

/** The true boundaries of a scene (types.ts conventions). */
export const sceneBoundaries = (sc: Scene): Boundary[] =>
  truthOf(sc.shots.map((s) => s.frames), sc.joins.map((j) => (j ? { frames: j.frames, kind: j.kind, ...(j.kind === 'wipe' || j.kind === 'slide' || j.kind === 'whip' ? { direction: j.direction ?? 'left' } : {}), ...(j.kind === 'slide' ? { mode: j.mode ?? 'push' } : {}), ...(j.kind === 'fade' ? { via: j.via ?? 'black' } : {}) } : { frames: 0, kind: 'cut' as const })));

export type { MotionEvent };

// ---------------------------------------------------------------------------------------------------------------------
// Items and the whole picture

interface ItemState { opacity: number; dx: number; dy: number; scale: number; clip: [number, number, number, number] }
const FULL: ItemState = { opacity: 1, dx: 0, dy: 0, scale: 1, clip: [0, 0, 0, 0] };
const SIDE: Record<Direction, number> = { up: 0, right: 1, down: 2, left: 3 };

/** State at eased entrance progress e (0 = not there, 1 = in place). */
const animState = (a: SceneAnim, e: number): ItemState => {
  const dir = a.direction ?? 'up';
  switch (a.how) {
    case 'instant': return FULL;
    case 'fade': return { ...FULL, opacity: e };
    case 'slide': { const [vx, vy] = VEC[dir]; return { ...FULL, dx: -vx * 0.25 * (1 - e), dy: -vy * 0.25 * (1 - e), opacity: Math.min(1, 2 * e) }; }
    case 'scale': return { ...FULL, scale: e };
    case 'pop': {
      const o = a.overshoot ?? 0.12;
      const s = e < 0.6 ? 0.6 + (1 + o - 0.6) * ease('out', e / 0.6) : 1 + o - o * ease('in-out', (e - 0.6) / 0.4);
      return { ...FULL, scale: s, opacity: Math.min(1, e / 0.25) };
    }
    case 'wipe': { const clip: [number, number, number, number] = [0, 0, 0, 0]; clip[SIDE[dir]] = 1 - e; return { ...FULL, clip }; }
  }
};

/** State of an item on frame n, or undefined when it is not on screen. */
const itemState = (it: SceneItem, n: number): ItemState | undefined => {
  if (n < it.from || n >= it.to) return undefined;
  // an entrance shows progress 1/F on its first frame and 1 on its last; an exit runs the entrance backwards with its
  // own easing applied to its own progress (ease 'in' leaves slowly, then accelerates away), gone on the item's last frame
  if (it.enter && it.enter.how !== 'instant' && n < it.from + it.enter.frames) return animState(it.enter, ease(it.enter.ease ?? 'linear', (n - it.from + 1) / it.enter.frames));
  if (it.exit && it.exit.how !== 'instant' && n >= it.to - it.exit.frames) return animState(it.exit, 1 - ease(it.exit.ease ?? 'linear', (n - (it.to - it.exit.frames) + 1) / it.exit.frames));
  return FULL;
};

const drawItem = (img: Float32Array, sc: Scene, it: SceneItem, n: number): void => {
  const st = itemState(it, n);
  if (!st || st.opacity <= 0 || st.scale <= 0) return;
  const { width: W, height: H } = sc;
  const side = Math.min(W, H);
  const life = Math.max(1, it.to - it.from - 1);
  const [tx, ty] = it.travel ? [it.travel[0] * ((n - it.from) / life), it.travel[1] * ((n - it.from) / life)] : [0, 0];
  const [bx, by, bw, bh] = it.box;
  const cx = (bx + bw / 2 + tx) * W + st.dx * side, cy = (by + bh / 2 + ty) * H + st.dy * side;
  const hw = (bw * W * st.scale) / 2, hh = (bh * H * st.scale) / 2;
  // the clip hides fractions of the element's own (scaled) box: top, right, bottom, left
  const x0 = cx - hw + st.clip[3] * 2 * hw, x1 = cx + hw - st.clip[1] * 2 * hw;
  const y0 = cy - hh + st.clip[0] * 2 * hh, y1 = cy + hh - st.clip[2] * 2 * hh;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++) {
    const cy1 = Math.min(1, Math.max(0, Math.min(y + 1, y1) - Math.max(y, y0)));
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
      const cov = cy1 * Math.min(1, Math.max(0, Math.min(x + 1, x1) - Math.max(x, x0))) * st.opacity;
      for (let c = 0; c < 3; c++) { const i = (y * W + x) * 3 + c; img[i] = (img[i] as number) * (1 - cov) + (it.colour[c] as number) * cov; }
    }
  }
};

/** Frame n of the scene: the shot (or the two shots of a transition), then the items on top. */
export const renderFrame = (sc: Scene, tl: Timeline, n: number): Uint8Array => {
  let img: Float32Array | undefined;
  sc.joins.forEach((j, k) => {
    const a = tl.a[k] as number;
    if (!img && j && n >= a && n < a + j.frames) {
      const oldI = baseImage(sc, sc.shots[k] as SceneShot, n - (tl.starts[k] as number), n - (tl.starts[k] as number));
      const newI = baseImage(sc, sc.shots[k + 1] as SceneShot, n - (tl.starts[k + 1] as number), n - (tl.starts[k + 1] as number));
      img = composeTransition(sc, j, n - a, oldI, newI);
    }
  });
  if (!img) {
    let k = 0;
    while (k + 1 < sc.shots.length && n >= (tl.starts[k + 1] as number)) k++;
    img = baseImage(sc, sc.shots[k] as SceneShot, n - (tl.starts[k] as number), n - (tl.starts[k] as number));
  }
  for (const it of sc.items) drawItem(img, sc, it, n);
  const out = new Uint8Array(img.length);
  for (let i = 0; i < img.length; i++) out[i] = Math.min(255, Math.max(0, Math.round(img[i] as number)));
  return out;
};

export const renderScene = (sc: Scene): Uint8Array[] => {
  const tl = timeline(sc);
  return Array.from({ length: tl.total }, (_, n) => renderFrame(sc, tl, n));
};

const OPPOSITE: Record<Direction, Direction> = { left: 'right', right: 'left', up: 'down', down: 'up' };
const HOW: Record<SceneAnim['how'], MotionEvent['how']> = { instant: 'instant', fade: 'fade', slide: 'slide', scale: 'scale', pop: 'scale', wipe: 'wipe' };

/** The true motion events of the scene's items (an item without an entrance appears instantly). */
export const sceneEvents = (sc: Scene): MotionEvent[] => {
  const total = timeline(sc).total;
  return sc.items.flatMap((it): MotionEvent[] => {
    const ev = (a: SceneAnim | undefined, kind: 'appear' | 'disappear'): MotionEvent => {
      const how = HOW[a?.how ?? 'instant'];
      const frames = !a || a.how === 'instant' ? 1 : a.frames;
      // an instant exit is seen on the first frame without the item (types.ts / truth.ts put it one frame earlier)
      const start = kind === 'appear' ? it.from : !a || a.how === 'instant' ? it.to : it.to - frames;
      const dir = a?.direction ?? 'up';
      return {
        start, end: start + frames, box: it.box, kind, how,
        ...(how === 'slide' || how === 'wipe' ? { direction: kind === 'appear' ? dir : OPPOSITE[dir] } : {}),
        ease: how === 'instant' ? 'instant' : a?.ease ?? 'linear',
        ...(a?.how === 'pop' ? { overshoot: a.overshoot ?? 0.12 } : {}),
        colour: '#' + it.colour.map((c) => c.toString(16).padStart(2, '0')).join(''), confidence: 1,
      };
    };
    return [ev(it.enter, 'appear'), ...(it.to < total ? [ev(it.exit, 'disappear')] : [])];
  });
};
