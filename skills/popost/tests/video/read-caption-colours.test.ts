/**
 * The colours of caption letters (text/letters.ts, text/highlight.ts), read from clips the engine renders over a
 * moving picture made with ffmpeg: white letters with a black outline, yellow letters with a dark blue outline (whose
 * outline the darkest pixels of the box would give as the letters' colour), black letters with no outline on a light
 * ground (whose ground encloses them as an outline would), plain white letters on a flat black bar and on flat black
 * (where the black encloses them the same way), white letters on a dark plate, and white outlined letters
 * with one word in yellow on three lines of four. Each comes back as what it was: the fill within a small colour
 * distance, the outline found or not, the highlight's colour and its words; a template keeps the highlight colour and
 * a fill's marked words are drawn in it. The reader is a stand-in that gives each line the box a reader would.
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
import { templateCard } from '../../src/video/template/card';
import { slotsOf } from '../../src/video/template/slots';
import { retargetInputs, templateFrom } from '../../src/video/template/structure';
import { cuesOf, readSamples, withCaptionLook } from '../../src/video/text/index';
import type { CaptionLook, TextReader, TextTrack } from '../../src/video/text/index';
import type { CaptionTrack, Measure, Project, TextSpanStyle, TextStyle } from '../../src/video/types';

const rt = await createDiskRuntime();
const ready = (await hasFfmpeg(rt)) && hasChrome();
afterAll(async () => { await rt.cleanup(); });

const W = 960, H = 540, FRAMES = 72;
const LINES = ['The first caption line', 'A second one follows', 'Then comes the third', 'And the last of four'];
/** The word of each line drawn in the highlight colour, in the clip that has one. */
const LIT: (string | undefined)[] = ['first', 'second', undefined, 'last'];
const YELLOW = '#ffd400', BLUE = '#1a2a8c';
/** Colours that keep changing everywhere, a light ground that does too, the colours with a flat black bar across the caption band, and flat black. */
const GROUNDS = {
  colour: "geq=r='128+120*sin(X/23+T*7)':g='128+120*sin(Y/17-T*5)':b='128+120*cos((X+Y)/31+T*9)'",
  light: "geq=r='225+25*sin(X/23+T*7)':g='225+25*sin(Y/17-T*5)':b='225+25*cos((X+Y)/31+T*9)'",
  bar: "geq=r='128+120*sin(X/23+T*7)':g='128+120*sin(Y/17-T*5)':b='128+120*cos((X+Y)/31+T*9)',drawbox=x=0:y=ih*0.66:w=iw:h=ih*0.32:color=black:t=fill",
  black: "geq=r='0':g='0':b='0'",
};
const base: TextStyle = { size: 0.07, weight: 800, align: 'center' };
const CLIPS: Record<string, { ground: keyof typeof GROUNDS; style: TextStyle; lit?: string }> = {
  'white-black': { ground: 'colour', style: { ...base, color: '#ffffff', stroke: { color: '#000000', width: 0.2 } } },
  'yellow-blue': { ground: 'colour', style: { ...base, color: YELLOW, stroke: { color: BLUE, width: 0.2 } } },
  'black-light': { ground: 'light', style: { ...base, color: '#111111' } },
  'white-bar': { ground: 'bar', style: { ...base, color: '#ffffff' } },
  'white-black-ground': { ground: 'black', style: { ...base, color: '#ffffff' } },
  'white-plate': { ground: 'colour', style: { ...base, color: '#ffffff', background: { color: '#1c1c1c', padding: 0.3, radius: 0.2 } } },
  'one-word': { ground: 'colour', style: { ...base, color: '#ffffff', stroke: { color: '#000000', width: 0.2 } }, lit: YELLOW },
};
type Name = keyof typeof CLIPS;

const spansOf = (i: number, colour: string | undefined): TextSpanStyle[] | undefined => {
  const word = LIT[i], line = LINES[i] ?? '';
  if (!colour || !word) return undefined;
  const from = Array.from(line.slice(0, line.indexOf(word))).length;
  return [{ from, to: from + Array.from(word).length, color: colour }];
};

const project = (c: { style: TextStyle; lit?: string }): Project => ({
  version: 1, canvas: { width: W, height: H, fps: 30 },
  materials: [{ id: 'video-1', kind: 'video', file: 'assets/moving.mp4' }],
  segments: [{ id: 'shot-01', frames: FRAMES, base: { material: 'video-1', fit: 'cover' } }],
  tracks: [{
    id: 'captions', type: 'caption', box: [0.08, 0.72, 0.84, 0.2], style: c.style,
    cues: LINES.map((text, i) => {
      const spans = spansOf(i, c.lit);
      return { text, during: { segment: 'shot-01', from: i * 18, to: (i + 1) * 18 }, ...(spans ? { spans } : {}) };
    }),
  } as CaptionTrack],
});

const looks = new Map<Name, CaptionLook | undefined>();
const tracks = new Map<Name, TextTrack>();
beforeAll(async () => {
  if (!ready) return;
  const moving = new Map<string, string>();
  for (const [ground, filter] of Object.entries(GROUNDS)) {
    const file = path.join(rt.dir, ground + '.mp4');
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=' + W + 'x' + H + ':r=30:d=' + (FRAMES / 30 + 0.5) + ',format=rgb24,' + filter, '-pix_fmt', 'yuv420p', file]);
    moving.set(ground, file);
  }
  for (const [name, clip] of Object.entries(CLIPS) as [Name, (typeof CLIPS)[Name]][]) {
    const dir = path.join(rt.dir, name);
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    await writeFile(path.join(dir, 'assets', 'moving.mp4'), await rt.fs.readFile(moving.get(clip.ground) as string));
    await writeFile(path.join(dir, 'video.json'), JSON.stringify(project(clip)));
    const session = await openSession(rt, dir, { scale: 1 });
    const ink = await session.layout().finally(() => session.close());
    const video = path.join(rt.dir, name + '.mp4');
    await renderVideo(rt, { projectDir: dir, out: video });
    // A reader's box: the line's ink with a little room around it.
    const boxes = LINES.map((_l, i) => {
      const [x, y, w, h] = ink.find((f) => f.id === 'captions#' + i)?.ink ?? [0, 0, 0, 0];
      return [x - 0.1 * h * (H / W), y - 0.15 * h, w + 0.2 * h * (H / W), 1.3 * h] as [number, number, number, number];
    });
    const reader: TextReader = { read: async (frames) => frames.map((f) => {
      const i = Math.floor(f.frame / 18);
      return { frame: f.frame, lines: i < LINES.length ? [{ text: LINES[i] as string, confidence: 0.95, box: boxes[i] ?? [0, 0, 0, 0] }] : [] };
    }) };
    const track = await withCaptionLook(rt, video, cuesOf(await readSamples(rt, video, reader)));
    tracks.set(name, track);
    looks.set(name, track.captionLook);
  }
}, 300_000);

const dE = (a: string | undefined, b: string): number => (a ? deltaE(toLab(hexToRgb(a)), toLab(hexToRgb(b))) : Infinity);
const show = (l: CaptionLook | undefined): string => JSON.stringify(l);

describe.skipIf(!ready)('the colours of caption letters', () => {
  it('reads white letters with a black outline', () => {
    const l = looks.get('white-black');
    expect(l?.kind, show(l)).toBe('outline');
    expect(dE(l?.color, '#ffffff'), show(l)).toBeLessThan(10);
    expect(dE(l?.outline?.color, '#000000'), show(l)).toBeLessThan(15);
    expect(l?.confidence).toBeGreaterThanOrEqual(0.6);
    expect(l?.outline?.confidence).toBeGreaterThanOrEqual(0.6);
    expect(l?.highlight, show(l)).toBeUndefined();
  });

  it('gives yellow letters with a dark blue outline as yellow, and the outline apart', () => {
    const l = looks.get('yellow-blue');
    expect(l?.kind, show(l)).toBe('outline');
    expect(dE(l?.color, YELLOW), show(l)).toBeLessThan(12);
    expect(l?.outline, show(l)).toBeDefined();
    // A colour is given only when it is sure; when it is, it is the outline's: dark, and blue rather than black.
    const o = l?.outline?.color;
    if (o) {
      const [L, , b] = toLab(hexToRgb(o));
      expect(L, show(l)).toBeLessThan(35);
      expect(b, show(l)).toBeLessThan(-10);
    } else expect(l?.outline?.confidence).toBeLessThan(0.6);
  });

  it('reads black letters on a light ground as plain black letters, not as the ground with a black outline', () => {
    const l = looks.get('black-light');
    expect(l?.kind, show(l)).toBe('plain');
    expect(dE(l?.color, '#111111'), show(l)).toBeLessThan(12);
    expect(l?.outline, show(l)).toBeUndefined();
  });

  it('reads plain white letters on a flat black bar, or on flat black, as plain white letters, not as black ones with a white outline', () => {
    for (const name of ['white-bar', 'white-black-ground'] as const) {
      const l = looks.get(name);
      expect(l?.kind, name + ' ' + show(l)).toBe('plain');
      expect(dE(l?.color, '#ffffff'), name + ' ' + show(l)).toBeLessThan(10);
      expect(l?.outline, name + ' ' + show(l)).toBeUndefined();
    }
  });

  it('reads white letters on a dark plate', () => {
    const l = looks.get('white-plate');
    expect(l?.kind, show(l)).toBe('plate');
    expect(dE(l?.color, '#ffffff'), show(l)).toBeLessThan(10);
    expect(dE(l?.plate?.color, '#1c1c1c'), show(l)).toBeLessThan(12);
    expect(l?.outline, show(l)).toBeUndefined();
  });

  it('finds the word of each line drawn in yellow, and which word it was', () => {
    const l = looks.get('one-word');
    expect(l?.kind, show(l)).toBe('outline');
    expect(dE(l?.color, '#ffffff'), show(l)).toBeLessThan(10);
    expect(dE(l?.highlight?.color, YELLOW), show(l)).toBeLessThan(12);
    expect(l?.highlight?.lines).toBe(3);
    expect(l?.highlight?.examples).toEqual(['The *first* caption line', 'A *second* one follows', 'And the *last* of four']);
  });

  it('keeps the highlight colour in a template, and draws the words a fill marks in it', () => {
    const measure: Measure = {
      version: 1, source: { width: W, height: H, fps: 30, frames: FRAMES, duration: FRAMES / 30, hasAudio: false }, boundaries: [],
      shots: [{ index: 0, start: 0, end: FRAMES, camera: { kind: 'static', zoomPerS: 0, panPerS: [0, 0], confidence: 1 }, background: '#808080', palette: [], events: [] }],
      rhythm: { step: 3, change: [] }, signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
    };
    const t = templateFrom({ measure, text: tracks.get('one-word') as TextTrack, name: 'one-word', label: 'synthetic', hash: 'sha256:0' });
    const lit = looks.get('one-word')?.highlight?.color as string;
    expect(t.captions?.look?.highlight?.color).toBe(lit);
    // The source's own words stay out of the template's structure.
    expect(t.captions?.look?.highlight?.examples).toBeUndefined();
    const card = templateCard(t, slotsOf(t, { cjk: 12, latin: 24, lines: 1, measured: false, method: 'test' }, { text: tracks.get('one-word') as TextTrack })).text;
    expect(card).toContain('in ' + lit + ': wrap such words in asterisks');
    const plan = { shots: [{ color: '#202020' }], captions: ['A *new* line', 'Two', 'Three', '**Four** more'] };
    const filled = retarget({ ...retargetInputs(t), plan }).project?.tracks.find((x): x is CaptionTrack => x.type === 'caption');
    expect(filled?.cues.map((c) => c.text)).toEqual(['A new line', 'Two', 'Three', 'Four more']);
    expect(filled?.cues.map((c) => c.spans)).toEqual([[{ from: 2, to: 5, color: lit }], undefined, undefined, [{ from: 0, to: 4, color: lit }]]);
  });
});
