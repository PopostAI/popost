/**
 * Random projects inside the preset vocabulary, for the synthetic round trip: the project is the truth, its render is
 * what the measurement has to read back. Everything is driven by one seed, so a case can be rebuilt from its number.
 */
import type { Box, CameraSpec, Direction, Ease, Material, MotionPreset, MotionSpec, Project, Segment, Track, TransitionKind, TransitionSpec, WipeDirection } from '../types';

/** mulberry32: a small seeded generator. The same seed gives the same sequence on every machine. */
export const rng = (seed: number) => {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
  const chance = (p: number): boolean => next() < p;
  return { next, int, pick, chance };
};

export type Rng = ReturnType<typeof rng>;

export interface SynthOptions {
  seed: number;
  width?: number;
  height?: number;
  fps?: number;
  /** Number of segments. Default 3 to 5. */
  segments?: number;
  /** Which transition kinds may be drawn. Default: every kind. */
  transitions?: readonly TransitionKind[];
  /** Which entrance presets may be drawn. Default: every preset. */
  motions?: readonly MotionPreset[];
  /** Share of segments whose base is a picture (the rest are flat colours). Default 0.6. */
  pictureShare?: number;
  /** Items per segment, at most. Default 2. */
  maxItems?: number;
  /** Share of picture segments that get a camera move. Default 0.4. */
  cameraShare?: number;
  /**
   * Features that later versions of the format added. They are opt-in, so that a seed keeps giving the project it
   * always gave: 'sides' draws one-sided transitions with a strength, 'moves' draws camera moves with keyframes.
   */
  features?: readonly ('sides' | 'moves')[];
}

export interface SynthCase {
  seed: number;
  project: Project;
  /** Pictures the project refers to, to be generated before rendering: file (relative to the project) and a recipe. */
  pictures: { file: string; recipe: PictureRecipe }[];
}

/** A picture made by ffmpeg from a lavfi source, so no binary is ever stored. */
export interface PictureRecipe { source: 'mandelbrot' | 'testsrc2' | 'cellauto' | 'gradients' | 'smptebars' | 'life'; seed: number; hue: number }

const DIRECTIONS: readonly Direction[] = ['left', 'right', 'up', 'down'];
const WIPE_DIRECTIONS: readonly WipeDirection[] = [...DIRECTIONS, 'center-out', 'edges-in'];
const EASES: readonly Ease[] = ['linear', 'in', 'out', 'in-out'];
const ALL_TRANSITIONS: readonly TransitionKind[] = ['cut', 'fade', 'flash', 'dissolve', 'wipe', 'slide', 'zoom', 'spin', 'blur', 'glitch', 'shake', 'whip'];
const ALL_MOTIONS: readonly MotionPreset[] = ['none', 'fade', 'pop', 'scale-in', 'slide', 'wipe', 'type', 'blur'];
const SOURCES: readonly PictureRecipe['source'][] = ['mandelbrot', 'testsrc2', 'cellauto', 'gradients', 'smptebars', 'life'];
const WORDS = ['只要 19.9', '限时三天', 'NEW', '两周见效', 'Stop scrolling', '第 1 名', '免费试用', 'Before / After', '立即领取', '2x faster'];

const hex = (r: Rng, lo = 20, hi = 235): string => '#' + [0, 0, 0].map(() => r.int(lo, hi).toString(16).padStart(2, '0')).join('');

/** Two colours far enough apart that a cut between them is a real change of picture. */
const farFrom = (r: Rng, other: string | undefined): string => {
  for (let i = 0; i < 20; i++) {
    const c = hex(r);
    if (!other) return c;
    const d = [1, 3, 5].reduce((s, k) => s + Math.abs(parseInt(c.slice(k, k + 2), 16) - parseInt(other.slice(k, k + 2), 16)), 0);
    if (d > 180) return c;
  }
  return other === '#101010' ? '#e0e0e0' : '#101010';
};

/** Kinds that may be one-sided (a cut, then the new shot settles; or the old shot goes into the effect, then a cut). */
const SIDED: readonly TransitionKind[] = ['blur', 'zoom', 'shake', 'flash', 'whip', 'glitch', 'fade', 'spin'];

const transition = (r: Rng, kinds: readonly TransitionKind[], fps: number, sides = false): TransitionSpec | undefined => {
  const kind = r.pick(kinds);
  if (kind === 'cut') return undefined;
  const frames = r.int(Math.round(fps * 0.2), Math.round(fps * 0.6));
  const spec: TransitionSpec = { transition: kind, frames };
  if (kind === 'wipe') spec.direction = r.pick(WIPE_DIRECTIONS);
  if (kind === 'slide') { spec.direction = r.pick(DIRECTIONS); spec.mode = r.pick(['push', 'cover', 'reveal'] as const); }
  if (kind === 'whip') spec.direction = r.pick(DIRECTIONS);
  if (kind === 'fade') spec.via = r.pick(['black', 'white'] as const);
  if (sides && SIDED.includes(kind) && r.chance(0.5)) {
    spec.side = r.pick(['after', 'before'] as const);
    spec.strength = r.pick([0.6, 1, 1.5]);
  }
  return spec;
};

/** One camera move inside a segment: it starts after the transition in has ended and stops well before the end. */
const cameraMove = (r: Rng, frames: number, fps: number): CameraSpec => {
  const from = r.int(Math.round(fps * 0.5), Math.round(frames * 0.3));
  const to = Math.min(frames - Math.round(fps * 0.5), from + r.int(Math.round(fps * 0.5), Math.round(fps * 1.2)));
  const out = r.chance(0.3);
  const s = r.pick([1.3, 1.6, 2.2]);
  return { moves: [{ from, to, scale: out ? [s, 1] : [1, s], focus: [r.pick([0.2, 0.5, 0.8]), r.pick([0.25, 0.5, 0.75])], ease: r.pick(['linear', 'out', 'in-out'] as const) }] };
};

/** maxFrames keeps an entrance and an exit from meeting: the item must hold still in between. */
const motion = (r: Rng, presets: readonly MotionPreset[], fps: number, maxFrames: number): MotionSpec => {
  const preset = r.pick(presets);
  const spec: MotionSpec = { preset };
  if (preset === 'none') return spec;
  spec.frames = Math.max(3, Math.min(maxFrames, r.int(Math.round(fps * 0.2), Math.round(fps * 0.5))));
  if (preset !== 'type') spec.ease = r.pick(EASES);
  if (preset === 'pop') spec.overshoot = r.pick([0.08, 0.12, 0.2]);
  if (preset === 'slide' || preset === 'wipe') spec.direction = r.pick(DIRECTIONS);
  if (preset === 'slide') spec.distance = r.pick([0.2, 0.3, 0.45]);
  return spec;
};

/** Boxes on a coarse grid, so two items of one segment never overlap and each stays clear of the frame's edge. */
const boxes = (r: Rng, n: number): Box[] => {
  const rows = [0.1, 0.4, 0.7];
  const order = [...rows].sort(() => r.next() - 0.5).slice(0, n);
  return order.map((y) => {
    const w = r.pick([0.4, 0.55, 0.7]);
    const x = r.pick([0.08, (1 - w) / 2, 1 - w - 0.08]);
    return [Number(x.toFixed(3)), y, w, r.pick([0.12, 0.16, 0.2])];
  });
};

const item = (r: Rng, id: string, segment: Segment, box: Box, o: Required<Pick<SynthOptions, 'fps'>> & { motions: readonly MotionPreset[] }, background: string): Track => {
  const frames = segment.frames ?? 0;
  // The item starts after the transition into the segment has ended and ends before the next one begins, so its
  // entrance and exit are events inside one shot.
  const from = r.int(Math.round(o.fps * 0.5), Math.round(frames * 0.35));
  const leaves = r.chance(0.5);
  const to = leaves ? r.int(Math.round(frames * 0.7), frames - Math.round(o.fps * 0.5)) : undefined;
  // At least 0.4 s of standing still between the entrance and the exit.
  const room = Math.floor(((to ?? frames) - from - Math.round(o.fps * 0.4)) / 2);
  // "type" reveals characters, so only a text item may use it, and only to enter.
  const isText = r.chance(0.6);
  const untyped = o.motions.filter((m) => m !== 'type');
  const enterPresets = isText ? o.motions : untyped;
  const enter = enterPresets.length ? motion(r, enterPresets, o.fps, room) : { preset: 'none' as const };
  const exit = leaves && untyped.length ? motion(r, untyped, o.fps, room) : undefined;
  const during = { segment: segment.id, from, ...(to === undefined ? {} : { to }) };
  const common = { id, during, box, enter, ...(exit ? { exit } : {}) };
  if (isText) {
    const color = farFrom(r, background);
    return { ...common, type: 'text', text: r.pick(WORDS), style: { size: Number((box[3] * 0.55).toFixed(3)), weight: 800, color, align: 'center' } };
  }
  return { ...common, type: 'shape', shape: r.pick(['rect', 'ellipse'] as const), color: farFrom(r, background), radius: 0.02 };
};

/**
 * Textures whose cells are a pixel or two (cellauto, life) alias under a transform: a renderer that moves, scales or
 * turns them resamples a different pattern on every frame, so a camera move, a jolt or a turn on them cannot be read
 * as one picture moved. Under a camera or a transition that transforms the picture they are replaced by a steady
 * source picked from the same seed, which draws nothing more from the generator, so the project stays the same.
 */
const ALIASING: ReadonlySet<PictureRecipe['source']> = new Set(['cellauto', 'life']);
const STEADY: readonly PictureRecipe['source'][] = ['mandelbrot', 'testsrc2', 'gradients', 'smptebars'];
const TRANSFORMING: ReadonlySet<TransitionKind> = new Set(['slide', 'whip', 'zoom', 'spin', 'shake', 'glitch']);

const steadyUnderTransforms = (segments: readonly Segment[], pictures: SynthCase['pictures']): SynthCase['pictures'] =>
  pictures.map((p) => {
    const k = segments.findIndex((s) => 'assets/' + s.id + '.png' === p.file);
    const s = segments[k], next = segments[k + 1];
    if (!s || !ALIASING.has(p.recipe.source)) return p;
    const moved = 'material' in s.base && s.base.camera !== undefined;
    const transformed = [s.in, next?.in].some((t) => t !== undefined && TRANSFORMING.has(t.transition));
    return moved || transformed ? { ...p, recipe: { ...p.recipe, source: STEADY[p.recipe.seed % STEADY.length] as PictureRecipe['source'] } } : p;
  });

/** One random project. Segments are long enough (2.5 to 4 seconds) that entrances, exits and transitions do not touch. */
export const synthCase = (options: SynthOptions): SynthCase => {
  const o = { width: 1080, height: 1920, fps: 30, transitions: ALL_TRANSITIONS, motions: ALL_MOTIONS, pictureShare: 0.6, maxItems: 2, cameraShare: 0.4, ...options };
  const r = rng(o.seed);
  const sides = o.features?.includes('sides') ?? false;
  const moves = o.features?.includes('moves') ?? false;
  const count = o.segments ?? r.int(3, 5);
  const materials: Material[] = [];
  const pictures: SynthCase['pictures'] = [];
  const segments: Segment[] = [];
  const tracks: Track[] = [];
  let previous: string | undefined;
  for (let k = 0; k < count; k++) {
    const id = 's' + (k + 1);
    const frames = r.int(Math.round(o.fps * 2.5), Math.round(o.fps * 4));
    let background: string;
    let segment: Segment;
    if (r.chance(o.pictureShare)) {
      const file = 'assets/' + id + '.png';
      materials.push({ id: 'pic-' + id, kind: 'image', file });
      pictures.push({ file, recipe: { source: r.pick(SOURCES), seed: r.int(1, 9999), hue: r.int(0, 359) } });
      const rate: CameraSpec | undefined = r.chance(o.cameraShare)
        ? (r.chance(0.5) ? { zoom: r.pick([0.03, 0.05, 0.08, -0.04]) } : { pan: r.pick([[0.03, 0], [-0.03, 0], [0, 0.03], [0, -0.03]] as [number, number][]) })
        : undefined;
      // Drawn only when asked for, after everything a seed drew before, so older cases stay as they were.
      const camera = moves && r.chance(0.4) ? cameraMove(r, frames, o.fps) : rate;
      segment = { id, frames, base: { material: 'pic-' + id, ...(camera ? { camera } : {}) } };
      background = '#808080';
      previous = undefined;
    } else {
      background = farFrom(r, previous);
      previous = background;
      segment = { id, frames, base: { color: background } };
    }
    if (k > 0) {
      const tr = transition(r, o.transitions, o.fps, sides);
      if (tr) segment.in = tr;
    }
    segments.push(segment);
    const n = r.int(0, o.maxItems);
    boxes(r, n).forEach((box, i) => tracks.push(item(r, id + '-i' + (i + 1), segment, box, o, background)));
  }
  return { seed: o.seed, project: { version: 1, canvas: { width: o.width, height: o.height, fps: o.fps }, materials, segments, tracks, note: 'synthetic case ' + o.seed }, pictures: steadyUnderTransforms(segments, pictures) };
};
