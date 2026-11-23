import { describe, expect, it } from 'vitest';
import { MOTION_PRESETS, TRANSITION_KINDS } from '../../src/video/types';
import type { Direction, Ease, MotionPreset, ResolvedMotion, ResolvedTransition, WipeDirection } from '../../src/video/types';
import { ease } from '../../src/video/presets/easing';
import { IDENTITY_ELEMENT, MOTION_DEFAULTS, motionFrames, motionState, type ElementState } from '../../src/video/presets/motion';
import { TRANSITION_DEFAULTS, transitionFrames, transitionState, type LayerState, type TransitionName } from '../../src/video/presets/transition';
import { TEXT_STYLES, TEXT_STYLE_NAMES } from '../../src/video/presets/text-styles';

const EASES: Ease[] = ['linear', 'in', 'out', 'in-out'];
const CANVAS = { width: 1080, height: 1920 };

const motion = (preset: MotionPreset, over: Partial<ResolvedMotion> = {}): ResolvedMotion => {
  const d = MOTION_DEFAULTS[preset];
  return { preset, frames: d.frames, ease: d.ease.enter, overshoot: d.overshoot, direction: d.direction, distance: d.distance, ...over };
};

const close = (a: ElementState, b: ElementState): void => {
  expect(a.opacity).toBeCloseTo(b.opacity, 6);
  expect(a.scale).toBeCloseTo(b.scale, 6);
  expect(a.blur).toBeCloseTo(b.blur, 6);
  expect(a.chars).toBeCloseTo(b.chars, 6);
  a.translate.forEach((v, i) => expect(v).toBeCloseTo(b.translate[i] ?? 0, 6));
  a.clip.forEach((v, i) => expect(v).toBeCloseTo(b.clip[i] ?? 0, 6));
};

/** How the picture at t = 0 of an entrance looks: nothing of the element is visible yet (or, for none, all of it). */
const START: Record<MotionPreset, (s: ElementState) => boolean> = {
  none: (s) => s.opacity === 1 && s.scale === 1,
  fade: (s) => s.opacity === 0,
  pop: (s) => s.opacity === 0 && Math.abs(s.scale - 0.6) < 1e-9,
  'scale-in': (s) => s.scale === 0,
  slide: (s) => s.opacity === 0 && Math.abs(Math.hypot(...s.translate) - 0.25) < 1e-9,
  wipe: (s) => s.clip.some((c) => c === 1),
  type: (s) => s.chars === 0,
  blur: (s) => s.opacity === 0 && s.blur > 0,
};

describe('easing', () => {
  it.each(EASES)('%s runs from 0 to 1, is clamped and never decreases', (kind) => {
    expect(ease(kind, 0)).toBe(0);
    expect(ease(kind, 1)).toBe(1);
    expect(ease(kind, -3)).toBe(0);
    expect(ease(kind, 7)).toBe(1);
    expect(ease(kind, Number.NaN)).toBe(0);
    const values = Array.from({ length: 101 }, (_, i) => ease(kind, i / 100));
    values.slice(1).forEach((v, i) => expect(v).toBeGreaterThanOrEqual(values[i] ?? 0));
  });
});

describe('motion presets', () => {
  it('has a default for every preset, scaled with the frame rate', () => {
    expect(Object.keys(MOTION_DEFAULTS).sort()).toEqual([...MOTION_PRESETS].sort());
    expect(motionFrames('pop', 30)).toBe(8);
    expect(motionFrames('pop', 60)).toBe(16);
    expect(motionFrames('fade', 30)).toBe(6);
    expect(motionFrames('slide', 30)).toBe(10);
    expect(motionFrames('none', 60)).toBe(0);
  });

  it.each([...MOTION_PRESETS])('%s: entrance at t = 0, 0.5, 1 and the exit as its mirror', (preset) => {
    const m = motion(preset);
    const start = motionState(m, 'enter', 0);
    expect(START[preset](start), JSON.stringify(start)).toBe(true);
    close(motionState(m, 'enter', 1), IDENTITY_ELEMENT);
    const mid = motionState(m, 'enter', 0.5);
    if (preset !== 'none') expect(mid).not.toEqual(IDENTITY_ELEMENT);
    close(motionState(m, 'exit', 0), IDENTITY_ELEMENT);
    expect(START[preset](motionState({ ...m, direction: opposite(m.direction) }, 'exit', 1))).toBe(true);
  });

  it('pop peaks at 1 + overshoot', () => {
    for (const overshoot of [0.08, 0.12, 0.2]) {
      const peak = Math.max(...Array.from({ length: 1001 }, (_, i) => motionState(motion('pop', { overshoot }), 'enter', i / 1000).scale));
      expect(peak).toBeCloseTo(1 + overshoot, 4);
    }
  });

  it('slide travels in its direction on entrance and on exit, and type is linear whatever the easing', () => {
    const enter = motionState(motion('slide', { direction: 'left' }), 'enter', 0.5);
    expect(enter.translate[0]).toBeGreaterThan(0);
    const exit = motionState(motion('slide', { direction: 'left' }), 'exit', 0.5);
    expect(exit.translate[0]).toBeLessThan(0);
    expect(motionState(motion('type', { ease: 'in' }), 'enter', 0.25).chars).toBeCloseTo(0.25, 9);
    expect(motionState(motion('wipe', { direction: 'right' }), 'enter', 0.5).clip[1]).toBeCloseTo(0.5, 9);
  });
});

const opposite = (d: Direction): Direction => ({ left: 'right', right: 'left', up: 'down', down: 'up' } as const)[d];

const transition = (kind: TransitionName, over: Partial<ResolvedTransition> = {}): ResolvedTransition => {
  const d = TRANSITION_DEFAULTS[kind];
  return { kind, a: 100, frames: d.frames, boundary: 100 + Math.floor(d.frames / 2), direction: d.direction, mode: d.mode, via: d.via, ease: d.ease, ...over };
};

const TOL = 0.03;
const isIdentity = (s: LayerState): boolean =>
  s.opacity > 1 - TOL && Math.abs(s.translate[0]) < TOL && Math.abs(s.translate[1]) < TOL && Math.abs(s.scale - 1) < TOL &&
  Math.abs(s.rotate) < 3 && s.blur < 0.002 && s.smear.every((v) => v < 0.002) &&
  (Array.isArray(s.clip) ? s.clip.every((c) => c < TOL) : s.clip.radius > 1 - TOL);
/** Fraction of the canvas a layer still covers, ignoring rotation and blur (small when it is invisible). */
const coverage = (s: LayerState): number => {
  const visible = Array.isArray(s.clip) ? Math.max(0, 1 - s.clip[0] - s.clip[2]) * Math.max(0, 1 - s.clip[1] - s.clip[3]) : Math.min(1, s.clip.radius ** 2);
  const overlap = Math.max(0, 1 - Math.abs(s.translate[0])) * Math.max(0, 1 - Math.abs(s.translate[1]));
  return s.opacity * visible * overlap;
};
/** Only 'shown' is visible: it is unchanged, and the other layer is invisible or hidden under it. */
const pure = (shown: LayerState, other: LayerState, overlay?: { opacity: number }): boolean =>
  isIdentity(shown) && (overlay?.opacity ?? 0) < TOL && (coverage(other) < TOL || shown.z > other.z);

const VARIANTS: ResolvedTransition[] = [
  ...(TRANSITION_KINDS.filter((k) => k !== 'cut') as TransitionName[]).map((k) => transition(k)),
  ...(['left', 'right', 'up', 'down', 'center-out', 'edges-in'] as WipeDirection[]).map((direction) => transition('wipe', { direction })),
  ...(['push', 'cover', 'reveal'] as const).flatMap((mode) => (['left', 'up'] as const).map((direction) => transition('slide', { mode, direction }))),
  transition('fade', { via: 'white' }),
  ...EASES.map((e) => transition('dissolve', { ease: e })),
];

describe('transitions', () => {
  it('has a default for every kind, scaled with the frame rate', () => {
    expect(Object.keys(TRANSITION_DEFAULTS).sort()).toEqual(TRANSITION_KINDS.filter((k) => k !== 'cut').sort());
    expect(transitionFrames('fade', 60)).toBe(24);
  });

  it.each(VARIANTS.map((t) => [t.kind + ' ' + t.direction + ' ' + t.mode + ' ' + t.via + ' ' + t.ease, t] as const))('%s is purely old near p = 0 and purely new near p = 1', (_name, tr) => {
    const first = transitionState(tr, 0.001, CANVAS);
    expect(pure(first.old, first.next, first.overlay), JSON.stringify(first)).toBe(true);
    const last = transitionState(tr, 0.999, CANVAS);
    expect(pure(last.next, last.old, last.overlay), JSON.stringify(last)).toBe(true);
    const mid = transitionState(tr, 0.5, CANVAS);
    expect(pure(mid.old, mid.next, mid.overlay) || pure(mid.next, mid.old, mid.overlay), JSON.stringify(mid)).toBe(false);
  });

  it.each(['glitch', 'shake'] as const)('%s is deterministic and varies from frame to frame', (kind) => {
    const tr = transition(kind, { frames: 10 });
    const ps = Array.from({ length: 10 }, (_, i) => (i + 1) / 11);
    const a = ps.map((p) => transitionState(tr, p, CANVAS));
    const b = ps.map((p) => transitionState(tr, p, CANVAS));
    expect(a).toEqual(b);
    expect(new Set(a.map((s) => JSON.stringify(s))).size).toBeGreaterThan(5);
  });

  it('wipe left shows the new picture on the right first; fade passes through its colour at the middle', () => {
    const wipe = transitionState(transition('wipe', { direction: 'left', ease: 'linear' }), 0.3, CANVAS);
    expect(wipe.next.clip).toEqual([0, 0, 0, expect.closeTo(0.7, 9)]);
    const fade = transitionState(transition('fade', { via: 'white' }), 0.5, CANVAS);
    expect(fade.overlay).toEqual({ color: '#ffffff', opacity: 1 });
  });
});

describe('text styles', () => {
  it('every named style is readable (at least 2.2% of the canvas height)', () => {
    TEXT_STYLE_NAMES.forEach((name) => expect(TEXT_STYLES[name].size).toBeGreaterThanOrEqual(0.022));
  });
});
