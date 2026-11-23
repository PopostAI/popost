import { existsSync } from 'node:fs';
import { copyFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import type { Problem, Project, TextStyle, TextTrack, Track } from '../../src/video/types';
import { checkProject } from '../../src/video/project/check';
import { parseProject } from '../../src/video/project/schema';
import { resolve } from '../../src/video/timeline/resolve';
import { quoteFamilies, textParts } from '../../src/video/presets/text-styles';
import { hasFfmpeg } from '../../src/video/media/ffmpeg';
import { checkLayout, openRenderer, type Renderer } from '../../src/video/render/index';
import { openSession } from '../../src/video/render/session';
import { decodePng, pixelsWhere, playedAndJumped, projectDir, type Rgb } from './make-fixtures';

const W = 180;
const H = 320;
/** A monospaced font of the system, copied into the test project as a font material (skipped when absent). */
const MONO = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
/** DejaVu Sans Mono advances every glyph by 1233 of 2048 units. */
const MONO_ADVANCE = 1233 / 2048;

const text = (id: string, words: string, box: TextTrack['box'], style: TextStyle, during: TextTrack['during'], more: Partial<TextTrack> = {}): TextTrack =>
  ({ id, type: 'text', text: words, box, style, during, ...more });

/**
 * Two-frame segments: 0 and 1 the same black word on white, without and with a soft shadow; 2 a line with a green
 * span; 3 the same line typed over 14 frames, with a blue background on the span; 4 ten "i" in the monospaced font.
 */
const project = (font: boolean): Project => {
  const word = (shadow?: TextStyle['shadow']): TextStyle => ({ size: 0.12, color: '#000000', weight: 900, ...(shadow ? { shadow } : {}) });
  const line: TextStyle = { size: 0.08, color: '#ffffff', align: 'left', spans: [{ from: 4, to: 7, color: '#00ff00' }] };
  const tracks: Track[] = [
    text('plain', 'HH', [0.1, 0.3, 0.8, 0.2], word(), { segment: 'plain' }),
    text('shadowed', 'HH', [0.1, 0.3, 0.8, 0.2], word({ color: '#000000', blur: 0.25, x: 0.12, y: 0.12 }), { segment: 'shadow' }),
    text('span', 'AAA BBB', [0, 0.4, 1, 0.1], line, { segment: 'span' }),
    text('typed', 'AAA BBB', [0, 0.4, 1, 0.1], { ...line, spans: [{ from: 4, to: 7, color: '#00ff00', background: { color: '#0000ff', padding: 0.1 } }] }, { segment: 'typed' }, { enter: { preset: 'type', frames: 14 } }),
    ...(font ? [text('mono', 'iiiiiiiiii', [0, 0.45, 1, 0.1], { size: 0.05, font: 'mono', weight: 400, align: 'left' }, { segment: 'font' })] : []),
  ];
  return {
    version: 1,
    canvas: { width: W, height: H, fps: 30 },
    materials: font ? [{ id: 'mono', kind: 'font', file: 'assets/mono.ttf' }] : [],
    segments: [
      { id: 'plain', frames: 2, base: { color: '#ffffff' } },
      { id: 'shadow', frames: 2, base: { color: '#ffffff' } },
      { id: 'span', frames: 2, base: { color: '#000000' } },
      { id: 'typed', frames: 20, base: { color: '#000000' } },
      { id: 'font', frames: 2, base: { color: '#000000' } },
    ],
    tracks,
  };
};

const at = (problems: Problem[], where: string, level: Problem['level'] = 'error'): Problem => {
  const p = problems.find((x) => x.at === where && x.level === level);
  if (!p) throw new Error('No ' + level + ' at ' + where + ' among: ' + JSON.stringify(problems, null, 1));
  return p;
};

describe('text: format, check and resolve', () => {
  it('accepts shadow, spacing, line height, opacity and spans, and fills in the shadow', () => {
    const p = project(true);
    (p.tracks[0] as TextTrack).style = { letterSpacing: 0.05, lineHeight: 1.1, opacity: 0.8, shadow: { color: '#000000' } };
    expect(parseProject(p).problems).toEqual([]);
    expect(checkProject(p)).toEqual([]);
    const r = resolve(p);
    expect(r.items[0]?.style).toMatchObject({ letterSpacing: 0.05, lineHeight: 1.1, opacity: 0.8, shadow: { color: '#000000', blur: 0.12, x: 0.04, y: 0.06 } });
    expect(r.items.find((i) => i.id === 'mono')?.style?.font).toBe('"mono"');
    expect(r.fonts).toEqual([{ family: 'mono', src: 'assets/mono.ttf' }]);
  });

  it('cuts text into parts by code point at the spans\' edges, and quotes font material names', () => {
    expect(textParts('只要19.9元', [{ from: 2, to: 6, color: 'red' }]).map((x) => [x.text, x.span ? 1 : 0])).toEqual([['只要', 0], ['19.9', 1], ['元', 0]]);
    expect(textParts('a😀b', [{ from: 1, to: 2 }]).map((x) => x.text)).toEqual(['a', '😀', 'b']);
    expect(textParts('abc', undefined).map((x) => x.text)).toEqual(['abc']);
    expect(quoteFamilies('1brand, "Noto Sans", sans-serif', new Set(['1brand']))).toBe('"1brand", "Noto Sans", sans-serif');
  });

  it('refuses spans that run past the text or overlap, naming both, and fonts without a font file', () => {
    const p = project(true);
    (p.tracks[2] as TextTrack).style = { spans: [{ from: 0, to: 3, color: '#ff0000' }, { from: 2, to: 9, weight: 900 }] };
    const problems = checkProject(p);
    expect(at(problems, 'tracks[2].style.spans[1].to').message).toContain('has 7 characters');
    expect(at(problems, 'tracks[2].style.spans[1]').message).toContain('overlaps span 0');
    const q = project(true);
    q.materials.push({ id: 'logo', kind: 'font', file: 'assets/logo.png' }, { id: 'none', kind: 'font' });
    expect(at(checkProject(q), 'materials[1].file').allowed).toEqual(['.woff2', '.woff', '.ttf', '.otf']);
    at(checkProject(q), 'materials[2].file');
    const raw = { ...project(false), tracks: [{ ...project(false).tracks[0], style: { shadow: { color: '#000', spread: 2 }, spans: [{ from: 0, to: 1, colour: 'red' }] } }] };
    expect(parseProject(raw).problems.map((x) => x.at)).toEqual(['tracks[0].style.shadow.spread', 'tracks[0].style.spans[0].colour']);
  });
});

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ready = (await hasFfmpeg(rt)) && hasChrome();
const hasMono = existsSync(MONO);

describe.skipIf(!ready)('text: render (Chrome + ffmpeg)', () => {
  let dir = '';
  let renderer: Renderer | undefined;
  const frame = async (n: number): Promise<Buffer> => {
    if (!renderer) throw new Error('renderer not open');
    return renderer.frame(n);
  };
  const rgb = async (n: number): Promise<Rgb> => decodePng(await frame(n));
  const green = (c: number[]): boolean => (c[1] ?? 0) > 180 && (c[0] ?? 0) < 90 && (c[2] ?? 0) < 90;
  const white = (c: number[]): boolean => c.every((v) => v > 200);
  const blue = (c: number[]): boolean => (c[2] ?? 0) > 180 && (c[0] ?? 0) < 60 && (c[1] ?? 0) < 60;

  beforeAll(async () => {
    dir = await projectDir('make-text-', project(hasMono));
    if (hasMono) await copyFile(MONO, path.join(dir, 'assets', 'mono.ttf'));
    renderer = await openRenderer(rt, dir);
  });
  afterAll(async () => {
    await renderer?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('casts a soft shadow: pixels beside the glyphs darken, through many grey levels', async () => {
    const plain = await rgb(1);
    const shadowed = await rgb(3);
    const box = [0, Math.round(0.25 * H), W, Math.round(0.6 * H)];
    const darkened = pixelsWhere(shadowed, box, (c) => (c[0] ?? 0) < 235).filter(([x, y]) => (pixelsWhere(plain, [x, y, x + 1, y + 1], (c) => (c[0] ?? 0) > 245).length > 0));
    const levels = new Set(darkened.map(([x, y]) => Math.round((shadowed.data[(y * W + x) * 3] ?? 0) / 16)));
    console.log('shadow: ' + darkened.length + ' pixels darkened beside the glyphs, ' + levels.size + ' grey levels of 16');
    expect(darkened.length).toBeGreaterThan(300);
    expect(levels.size).toBeGreaterThanOrEqual(8);
  });

  it('gives a span its colour inside one line', async () => {
    const img = await rgb(5);
    const band = (x0: number, x1: number): number[] => [x0, Math.round(0.4 * H), x1, Math.round(0.5 * H)];
    // "AAA " is left of x 55 at this size; "BBB" right of x 60.
    expect(pixelsWhere(img, band(0, 50), white).length).toBeGreaterThan(40);
    expect(pixelsWhere(img, band(0, 50), green)).toHaveLength(0);
    expect(pixelsWhere(img, band(62, W), green).length).toBeGreaterThan(40);
    expect(pixelsWhere(img, band(62, W), white)).toHaveLength(0);
  });

  it('types a line with a coloured span: the span and its background appear only with its characters', async () => {
    const band = [0, Math.round(0.38 * H), W, Math.round(0.52 * H)];
    const early = await rgb(6 + 5);
    expect(pixelsWhere(early, band, white).length).toBeGreaterThan(20);
    expect(pixelsWhere(early, band, green)).toHaveLength(0);
    expect(pixelsWhere(early, band, blue)).toHaveLength(0);
    const done = await rgb(6 + 15);
    expect(pixelsWhere(done, band, green).length).toBeGreaterThan(40);
    expect(pixelsWhere(done, band, blue).length).toBeGreaterThan(100);
    for (const n of [9, 13, 16]) {
      const [played, jumped] = await playedAndJumped(frame, n);
      expect(played.equals(jumped), 'frame ' + n).toBe(true);
    }
  });

  it.skipIf(!hasMono)('declares a font material and loads it before the first frame: ten "i" are ten monospaced advances wide', async () => {
    const session = await openSession(rt, dir, { scale: 1 });
    try {
      const fact = (await session.layout()).find((f) => f.id === 'mono');
      const want = (10 * MONO_ADVANCE * 0.05 * H) / W;
      console.log('monospaced line: ' + ((fact?.block[2] ?? 0) * W).toFixed(1) + ' px, expected ' + (want * W).toFixed(1));
      expect(fact?.block[2]).toBeCloseTo(want, 2);
    } finally {
      await session.close();
    }
    const broken = await projectDir('make-text-font-', { ...project(true), tracks: project(true).tracks.slice(4) });
    try {
      await writeFile(path.join(broken, 'assets', 'mono.ttf'), 'not a font');
      await expect(openRenderer(rt, broken)).rejects.toThrow(/Font "mono" \(assets\/mono.ttf\) could not be loaded/);
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });

  it('reports the layout of every text: lines, ink inside the line boxes, and text that does not fit with a fix', async () => {
    const tight: Project = {
      ...project(false),
      segments: [{ id: 's', frames: 10, base: { color: '#000000' } }],
      tracks: [
        text('fits', 'One line', [0.05, 0.1, 0.9, 0.08], { size: 0.04 }, { segment: 's' }),
        text('long', 'This sentence is far too long for the small box it was given here', [0.1, 0.5, 0.8, 0.06], { size: 0.04 }, { segment: 's' }),
      ],
    };
    const tdir = await projectDir('make-text-layout-', tight);
    try {
      const session = await openSession(rt, tdir, { scale: 0.5 });
      const facts = await session.layout();
      await session.close();
      const fits = facts.find((f) => f.id === 'fits');
      const long = facts.find((f) => f.id === 'long');
      expect(fits).toMatchObject({ fits: true, lines: 1 });
      const [ix, iy, iw, ih] = fits?.ink ?? [0, 0, 0, 0];
      const [bx, by, bw, bh] = fits?.block ?? [0, 0, 0, 0];
      expect(ih).toBeGreaterThan(0.4 * 0.04);
      expect(ih).toBeLessThan(bh);
      expect(iy).toBeGreaterThanOrEqual(by);
      expect(ix).toBeCloseTo(bx, 2);
      expect(iw).toBeCloseTo(bw, 2);
      expect(long?.fits).toBe(false);
      expect(long?.lines).toBeGreaterThanOrEqual(3);
      const problems = await checkLayout(rt, tdir);
      expect(problems).toHaveLength(1);
      const p = problems[0];
      console.log(JSON.stringify(p));
      expect(p?.at).toBe('tracks[1].text');
      expect(p?.message).toContain('"long"');
      expect(p?.message).toContain('too tall');
      expect(p?.fix).toMatch(/Shorten the text \(tracks\[1\]\.text\) to about \d+ characters \(it has 65\), or enlarge the box \(tracks\[1\]\.box\) to 0\.8\d* x 0\.\d+/);
    } finally {
      await rm(tdir, { recursive: true, force: true });
    }
  });
});
