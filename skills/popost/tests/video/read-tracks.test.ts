/**
 * Trajectories (measure/tracks.ts): thumbnails drawn here, frame by frame, of changes whose geometry is known (an object
 * that leads a wedge at an angle, a straight edge, a circle from a corner, a dissolve, an element that slides in), read
 * back as paths; then the lines describe writes for them and what compare says of two that differ.
 */
import { describe, expect, it } from 'vitest';
import type { Boundary, Measure, MotionEvent, ShotMeasure, Trajectory } from '../../src/video/types';
import { describeReference } from '../../src/video/describe/index';
import { tracksFile } from '../../src/video/describe/paths';
import { grayOf, type Thumbs } from '../../src/video/measure/pixels';
import { measureTracks } from '../../src/video/measure/tracks';
import { compareTracks } from '../../src/video/score/tracks';
import { pathsNote } from '../../src/video/commands/read';

const W = 128, H = 72, FPS = 30, N = 60, FROM = 20, TO = 40;

/** A frame whose pixel (x, y) shows the new picture where 'shows' says so; the old one is dark, the new one light with stripes. */
const frame = (shows: (x: number, y: number) => number): Uint8Array => {
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const a = [12, 14, 20], b = (x >> 3) % 2 ? [236, 232, 220] : [200, 214, 236], m = shows(x, y);
    for (let c = 0; c < 3; c++) out[(y * W + x) * 3 + c] = Math.round((a[c] as number) * (1 - m) + (b[c] as number) * m);
  }
  return out;
};

/** N frames: the old picture, the change on FROM + 1 .. TO - 1 at progress 0..1, the new picture. */
const thumbs = (shows: (p: number, x: number, y: number) => number): Thumbs => {
  const rgb = Array.from({ length: N }, (_v, f) => (f <= FROM ? frame(() => 0) : f >= TO ? frame(() => 1) : frame((x, y) => shows((f - FROM) / (TO - FROM), x, y))));
  return { width: W, height: H, fps: FPS, rgb, gray: rgb.map(grayOf) };
};

const still = (index: number, start: number, end: number, events: MotionEvent[] = []): ShotMeasure =>
  ({ index, start, end, camera: { kind: 'static', zoomPerS: 0, panPerS: [0, 0], confidence: 1 }, background: '#0c0e14', palette: [], events });
const WIPE: Boundary = { frame: 30, kind: 'wipe', start: FROM, end: TO, confidence: 0.8, residual: 0.1 };
const read = (t: Thumbs): Trajectory[] => measureTracks(t, [WIPE], [still(0, 0, 30), still(1, 30, N)]);

/** A disc of radius 9 that travels at 'angle' through the middle, a wedge of 30 degrees opening behind it. */
const led = (angle: number) => (p: number, x: number, y: number): number => {
  const r = (angle * Math.PI) / 180, ux = Math.cos(r), uy = Math.sin(r);
  const cx = W / 2 + (p - 0.5) * 100 * ux, cy = H / 2 + (p - 0.5) * 100 * uy;
  const dx = x - cx, dy = y - cy, along = dx * ux + dy * uy, across = Math.abs(-dx * uy + dy * ux);
  return Math.hypot(dx, dy) <= 9 || (along < 0 && across <= -along * Math.tan((15 * Math.PI) / 180)) ? 1 : 0;
};

const measureOf = (tracks: Trajectory[]): Measure => ({
  version: 1, source: { width: 1280, height: 720, fps: FPS, frames: N, duration: N / FPS, hasAudio: false },
  boundaries: [WIPE], shots: [still(0, 0, 30), still(1, 30, N)], tracks,
  rhythm: { step: 3, change: [] }, signature: { every: 6, width: 8, height: 8, count: 0, data: '' },
});

describe('trajectories of a transition', () => {
  it.each([0, 30, -20])('follow the object that leads a wedge at %d degrees: path angle, size, edge', (angle) => {
    const [t] = read(thumbs(led(angle)));
    expect(t).toMatchObject({ id: 'transition-02', of: 'transition', shot: 2, what: 'object', method: 'reveal-front' });
    expect(Math.abs((t?.path.angle ?? 99) - angle)).toBeLessThan(6);
    expect(t?.path.straightness).toBeGreaterThan(0.9);
    // The disc is 19 pixels across: 0.15 of the width and 0.26 of the height.
    expect(Math.abs((t?.size[0] ?? 0) - 19 / W)).toBeLessThan(0.04);
    expect(Math.abs((t?.size[1] ?? 0) - 19 / H)).toBeLessThan(0.06);
    expect(t?.reveal?.edge.shape).toBe('wedge');
    expect(Math.abs((t?.reveal?.edge.angle ?? 99) - angle)).toBeLessThan(8);
    expect(Math.abs((t?.reveal?.edge.spread ?? 0) - 30)).toBeLessThan(12);
    expect(t?.samples.length).toBeLessThanOrEqual(24);
    expect(t?.samples.every((s) => s.centre.every((v) => v >= 0 && v <= 1))).toBe(true);
  });

  it('read a straight edge with where it travels, and a circle with its centre, as regions without an object', () => {
    const [wipe] = read(thumbs((p, x) => (x < p * W ? 1 : 0)));
    expect(wipe).toMatchObject({ what: 'region', method: 'reveal-region', reveal: { edge: { shape: 'straight' } } });
    expect(Math.abs(wipe?.reveal?.edge.angle ?? 99)).toBeLessThan(3);
    const [down] = read(thumbs((p, _x, y) => (y < p * H ? 1 : 0)));
    expect(Math.abs((down?.reveal?.edge.angle ?? 0) - 90)).toBeLessThan(3);
    const [iris] = read(thumbs((p, x, y) => (Math.hypot(x - 0.1 * W, y - 0.9 * H) < p * 150 ? 1 : 0)));
    expect(iris).toMatchObject({ what: 'region', reveal: { edge: { shape: 'circle', grows: true } } });
    expect(Math.hypot((iris?.reveal?.edge.centre?.[0] ?? 0) - 0.1, (iris?.reveal?.edge.centre?.[1] ?? 0) - 0.9)).toBeLessThan(0.06);
    expect(iris?.reveal?.start).toBe(FROM + 1);
    expect(iris?.reveal?.end).toBeGreaterThan(TO - 6);
  });

  it('give nothing for a dissolve, whose pixels are neither picture, and nothing for a cut', () => {
    expect(read(thumbs((p) => p))).toEqual([]);
    const t = thumbs((p, x) => (x < p * W ? 1 : 0));
    expect(measureTracks(t, [{ frame: 30, kind: 'cut', start: 29, end: 30, confidence: 1 }], [still(0, 0, 30), still(1, 30, N)])).toEqual([]);
  });

  it('are the same on every run', () => {
    expect(JSON.stringify(read(thumbs(led(30))))).toBe(JSON.stringify(read(thumbs(led(30)))));
  });
});

describe('the trajectory of an element', () => {
  /** A light block of 24 x 12 pixels that slides in from the left to x 60 on frames 20 .. 34, on the dark picture. */
  const slide = (f: number): Uint8Array => {
    const x0 = f < 20 ? -40 : Math.min(60, -24 + (f - 20) * 6);
    return frame((x, y) => (x >= x0 && x < x0 + 24 && y >= 30 && y < 42 ? 1 : 0));
  };
  const rgb = Array.from({ length: N }, (_v, f) => slide(f));
  const t: Thumbs = { width: W, height: H, fps: FPS, rgb, gray: rgb.map(grayOf) };
  const event = (kind: MotionEvent['kind']): MotionEvent => ({ start: 21, end: 34, box: [0, 0.4, 0.66, 0.2], kind, how: 'slide', direction: 'right', confidence: 0.9 });

  it('is read while it slides in: from the left edge to its place, to the right', () => {
    const [e] = measureTracks(t, [], [still(0, 0, N, [event('appear')])]);
    expect(e).toMatchObject({ id: 'shot-01-event-1', of: 'event', shot: 1, event: 0, what: 'element', method: 'changed-region' });
    expect(Math.abs(e?.path.angle ?? 99)).toBeLessThan(3);
    expect(e?.path.to[0]).toBeCloseTo((60 + 12) / W, 1);
    expect(e?.size[1]).toBeCloseTo(12 / H, 1);
  });

  it('is left out when the element does not travel, or the event is a change', () => {
    const fixed: MotionEvent = { start: 40, end: 50, box: [0.4, 0.35, 0.3, 0.3], kind: 'appear', how: 'fade', confidence: 0.9 };
    expect(measureTracks(t, [], [still(0, 0, N, [fixed, event('change')])])).toEqual([]);
  });
});

describe('paths in the description and in compare', () => {
  const object = measureOf(read(thumbs(led(0))));
  const circle = measureOf(read(thumbs((p, x, y) => (Math.hypot(x - 0.1 * W, y - 0.9 * H) < p * 150 ? 1 : 0))));

  it('describe writes the path where the shot is read, names the change as an effect of its own, and lists tracks.json', () => {
    const d = describeReference(object, undefined, 'reference');
    expect(d.files['shots/02.md']).toMatch(/## Paths .*\n\n- The change into shot 02, frames 21-40 \(0\.63 s\): the new picture opens as a wedge of \d+ degrees whose tip points at -?\d+ degrees .* An object leads it: its centre goes from \[0\.\d+, 0\.5\d\] to \[0\.\d+, 0\.5\d\] on frames \d+-\d+ .*path angle 0 degrees, straight, .* size 1\d% x 2\d% of the canvas\. By reveal-front\. \[measured 0\.\d+\]/);
    expect(d.files['timeline.md']).toContain('; path: an object at 0 degrees leads a wedge edge, 0.63 s');
    expect(d.files['REFERENCE.md']).toContain('1 change is not a standard transition by its measured path: the change into shot 02');
    expect(d.files['REFERENCE.md']).toContain('| tracks.json | The sampled positions of 1 path');
    expect(tracksFile(object)).toMatchObject({ version: 1, tracks: [{ id: 'transition-02' }] });
    // A measurement from before trajectories existed reads as before.
    const old = describeReference({ ...object, tracks: undefined }, undefined, 'reference');
    expect(old.files['shots/02.md']).not.toContain('## Paths');
    expect(old.files['REFERENCE.md']).not.toContain('tracks.json');
  });

  it('compare names what differs: the object, the duration, the shape of the edge', () => {
    const same = compareTracks(object, object, (s) => s);
    expect(same.map((p) => p.differs)).toEqual([[]]);
    expect(pathsNote(same)).toContain('None differs');
    const fast: Measure = { ...circle, tracks: circle.tracks?.map((t) => ({ ...t, reveal: t.reveal ? { ...t.reveal, end: t.reveal.start + 6 } : undefined })) as Trajectory[] };
    const [d] = compareTracks(object, fast, (s) => s);
    expect(d?.reference).toMatchObject({ what: 'object', edge: 'wedge', pathAngle: expect.any(Number), size: expect.any(Array) });
    expect(d?.other).toMatchObject({ what: 'region', edge: 'circle' });
    expect(d?.differs.join(' | ')).toMatch(/led by an object of 1\d% x 2\d% of the canvas that travels at 0 degrees; the other's has no object large enough to follow \| it lasts 0\.63 s against 0\.20 s \| the new picture opens with a wedge edge against a circle one \(a circle about \[0\.\d+, 0\.\d+\]\)/);
    expect(pathsNote([d as NonNullable<typeof d>])).toContain('1 of 1 differs');
    // No path in the other video at that moment: said, not passed over.
    expect(compareTracks(object, { ...object, tracks: [] }, (s) => s)[0]?.differs[0]).toContain('no path that could be measured');
  });
});
