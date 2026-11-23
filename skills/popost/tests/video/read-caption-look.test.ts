/**
 * What is behind a caption's letters (text/look.ts), read from clips the engine renders: the same four caption lines
 * over a moving picture made with ffmpeg, on a see-through dark plate, on an opaque light plate with dark letters,
 * with an outline, and plain. Each must come out as what it was and none as another; the fill a template makes then
 * draws its captions the same way. The reader is a stand-in that gives each line the box a reader would (the ink the
 * page lays out, with a little room around it).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { deltaE, hexToRgb, toLab } from '../../src/video/measure/colour';
import { renderVideo } from '../../src/video/render/index';
import { openSession } from '../../src/video/render/session';
import { retarget } from '../../src/video/retarget/index';
import { retargetInputs, templateFrom } from '../../src/video/template/structure';
import { cuesOf, readSamples, withCaptionLook } from '../../src/video/text/index';
import type { CaptionLook, TextReader, TextTrack } from '../../src/video/text/index';
import type { CaptionTrack, Measure, Project, TextStyle } from '../../src/video/types';

const rt = await createDiskRuntime();
const ready = (await hasFfmpeg(rt)) && hasChrome();
afterAll(async () => { await rt.cleanup(); });

const W = 960, H = 540, FRAMES = 72;
const LINES = ['The first caption line', 'A second one follows', 'Then comes the third', 'And the last of four'];
const STYLES: Record<string, TextStyle> = {
  plate: { size: 0.06, weight: 800, color: '#ffffff', align: 'center', background: { color: 'rgba(0, 0, 0, 0.6)', padding: 0.3, radius: 0.2 } },
  light: { size: 0.06, weight: 800, color: '#1a1a1a', align: 'center', background: { color: '#f5f5f5', padding: 0.3, radius: 0.2 } },
  outline: { size: 0.06, weight: 800, color: '#ffffff', align: 'center', stroke: { color: '#111111', width: 0.16 }, shadow: { color: '#111111', blur: 0.3, x: 0, y: 0.05 } },
  plain: { size: 0.06, weight: 800, color: '#ffffff', align: 'center' },
};
type Name = keyof typeof STYLES;

const project = (style: TextStyle): Project => ({
  version: 1, canvas: { width: W, height: H, fps: 30 },
  materials: [{ id: 'video-1', kind: 'video', file: 'assets/moving.mp4' }],
  segments: [{ id: 'shot-01', frames: FRAMES, base: { material: 'video-1', fit: 'cover' } }],
  tracks: [{ id: 'captions', type: 'caption', box: [0.08, 0.72, 0.84, 0.2], style, cues: LINES.map((text, i) => ({ text, during: { segment: 'shot-01', from: i * 18, to: (i + 1) * 18 } })) } as CaptionTrack],
});

const looks = new Map<Name, CaptionLook | undefined>();
const tracks = new Map<Name, TextTrack>();
/** The light plate read through boxes so loose that they hold the whole plate. */
let loose: CaptionLook | undefined;
beforeAll(async () => {
  if (!ready) return;
  // A field of colours that moves all the time, so that what is behind the captions changes from line to line.
  const moving = path.join(rt.dir, 'moving.mp4');
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=' + W + 'x' + H + ':r=30:d=' + (FRAMES / 30 + 0.5) + ",format=rgb24,geq=r='128+120*sin(X/23+T*7)':g='128+120*sin(Y/17-T*5)':b='128+120*cos((X+Y)/31+T*9)'", '-pix_fmt', 'yuv420p', moving]);
  for (const name of Object.keys(STYLES) as Name[]) {
    const dir = path.join(rt.dir, name);
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    await writeFile(path.join(dir, 'assets', 'moving.mp4'), await rt.fs.readFile(moving));
    await writeFile(path.join(dir, 'video.json'), JSON.stringify(project(STYLES[name] as TextStyle)));
    const session = await openSession(rt, dir, { scale: 1 });
    const ink = await session.layout().finally(() => session.close());
    const video = path.join(rt.dir, name + '.mp4');
    await renderVideo(rt, { projectDir: dir, out: video });
    // A reader's box: the line's ink with a little room around it.
    const boxes = LINES.map((_l, i) => {
      const [x, y, w, h] = ink.find((f) => f.id === 'captions#' + i)?.ink ?? [0, 0, 0, 0];
      return [x - 0.1 * h * (H / W), y - 0.15 * h, w + 0.2 * h * (H / W), 1.3 * h] as [number, number, number, number];
    });
    const reader = (grow: number): TextReader => ({ read: async (frames) => frames.map((f) => {
      const i = Math.floor(f.frame / 18);
      const [x, y, w, h] = boxes[i] ?? [0, 0, 0, 0];
      const box: [number, number, number, number] = [x - grow * h * (H / W), y - grow * h, w + 2 * grow * h * (H / W), h * (1 + 2 * grow)];
      return { frame: f.frame, lines: i < LINES.length ? [{ text: LINES[i] as string, confidence: 0.95, box }] : [] };
    }) });
    const track = await withCaptionLook(rt, video, cuesOf(await readSamples(rt, video, reader(0))));
    tracks.set(name, track);
    looks.set(name, track.captionLook);
    if (name === 'light') loose = (await withCaptionLook(rt, video, cuesOf(await readSamples(rt, video, reader(0.5))))).captionLook;
  }
}, 300_000);

const dE = (a: string, b: string): number => deltaE(toLab(hexToRgb(a)), toLab(hexToRgb(b)));

describe.skipIf(!ready)('what is behind the caption letters', () => {
  it('reads the four lines as captions', () => {
    for (const t of tracks.values()) expect(t.cues.filter((c) => c.role === 'caption')).toHaveLength(4);
  });

  it('finds a see-through dark plate: its colour, about how see-through, its padding and its corners', () => {
    const l = looks.get('plate');
    expect(l?.kind, JSON.stringify(l)).toBe('plate');
    expect(dE(l?.color ?? '#000000', '#ffffff')).toBeLessThan(10);
    expect(dE(l?.plate?.color ?? '#ffffff', '#000000'), JSON.stringify(l)).toBeLessThan(15);
    expect(l?.plate?.opacity).toBeGreaterThanOrEqual(0.4);
    expect(l?.plate?.opacity).toBeLessThanOrEqual(0.85);
    expect(l?.plate?.padding).toBeGreaterThanOrEqual(0.1);
    expect(l?.plate?.padding).toBeLessThanOrEqual(0.5);
    expect(l?.plate?.radius).toBeLessThanOrEqual(0.5);
  });

  it('finds an opaque light plate with dark letters', () => {
    const l = looks.get('light');
    expect(l?.kind, JSON.stringify(l)).toBe('plate');
    expect(dE(l?.plate?.color ?? '#000000', '#f5f5f5')).toBeLessThan(8);
    expect(l?.plate?.opacity).toBeGreaterThanOrEqual(0.9);
    expect(dE(l?.color ?? '#ffffff', '#1a1a1a')).toBeLessThan(15);
    // Boxes that hold the whole plate hide its sides: still a plate, never an outline, its padding and corners unsure.
    expect(loose?.kind, JSON.stringify(loose)).toBe('plate');
    expect(dE(loose?.plate?.color ?? '#000000', '#f5f5f5')).toBeLessThan(8);
    expect(loose?.unsure?.[0]).toContain('padding, corners and opacity were not measured');
  });

  it('finds an outline, and plain letters, and takes neither for a plate', () => {
    const o = looks.get('outline'), p = looks.get('plain');
    expect(o?.kind, JSON.stringify(o)).toBe('outline');
    expect(dE(o?.outline?.color ?? '#ffffff', '#111111')).toBeLessThan(20);
    expect(dE(o?.color ?? '#000000', '#ffffff')).toBeLessThan(10);
    expect(p?.kind, JSON.stringify(p)).toBe('plain');
    expect(dE(p?.color ?? '#000000', '#ffffff')).toBeLessThan(10);
  });

  it('gives a template and the project its fill makes the reference\'s plate, outline or plain letters', () => {
    const measure: Measure = {
      version: 1, source: { width: W, height: H, fps: 30, frames: FRAMES, duration: FRAMES / 30, hasAudio: false }, boundaries: [],
      shots: [{ index: 0, start: 0, end: FRAMES, camera: { kind: 'static', zoomPerS: 0, panPerS: [0, 0], confidence: 1 }, background: '#808080', palette: [], events: [] }],
      rhythm: { step: 3, change: [] }, signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
    };
    const styleOf = (name: Name): TextStyle | undefined => {
      const t = templateFrom({ measure, text: tracks.get(name) as TextTrack, name, label: 'synthetic', hash: 'sha256:0' });
      const plan = { shots: [{ color: '#202020' }], captions: ['new one', 'new two', 'new three', 'new four'] };
      const filled = retarget({ ...retargetInputs(t), plan }).project?.tracks.find((x): x is CaptionTrack => x.type === 'caption');
      expect(filled?.style).toEqual(t.captions?.style);
      return typeof filled?.style === 'object' ? filled.style : undefined;
    };
    const plate = styleOf('plate');
    expect(plate?.background?.color).toMatch(/^rgba\(\d+, \d+, \d+, 0\.\d+\)$/);
    expect(plate?.stroke).toBeUndefined();
    expect(styleOf('light')?.background?.color).toMatch(/^#f/);
    expect(styleOf('outline')?.stroke?.width).toBe(0.16);
    const plain = styleOf('plain');
    expect([plain?.background, plain?.stroke, plain?.shadow]).toEqual([undefined, undefined, undefined]);
    // A fill's own captionOutline still wins.
    const t = templateFrom({ measure, text: tracks.get('plain') as TextTrack, name: 'x', label: 'synthetic', hash: 'sha256:0' });
    const outlined = retarget({ ...retargetInputs(t), plan: { shots: [{ color: '#202020' }], captions: ['a', 'b', 'c', 'd'], captionOutline: '#000000' } }).project?.tracks.find((x): x is CaptionTrack => x.type === 'caption');
    expect(typeof outlined?.style === 'object' ? outlined.style.stroke : undefined).toEqual({ color: '#000000', width: 0.16 });
  });
});
