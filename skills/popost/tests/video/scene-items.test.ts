/**
 * The scene check and the clips and pictures laid over a scene ("Footage inside a scene", video-scenes.md): the page
 * draws them over the scene, but footage shades into the frame it sits in, and the measure of what stands out from the
 * ground grew into it, so a phone holding a clip was called nearly empty. Their boxes count whole now, and scenes[]
 * says how many lie over each scene and how much of the canvas they cover. Synthetic scenes and media only.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { coverOf, itemRegion, itemsOver } from '../../src/video/scene/items';
import { FACTS_FILE, FACTS_FORMAT, FACTS_VERSION, type ReferenceFacts } from '../../src/video/template/facts';
import { resolve } from '../../src/video/timeline/resolve';
import type { Project } from '../../src/video/types';
import { projectDir } from './make-fixtures';

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ready = (await hasFfmpeg(rt)) && hasChrome();

const W = 640, H = 360, FPS = 30;
type Track = Project['tracks'][number];

describe('scene check: where the clips and pictures over a scene are', () => {
  const picture = (id: string, box: [number, number, number, number], more: Record<string, unknown> = {}): Track =>
    ({ id, type: 'image', material: 'pic', box, during: { segment: 's' }, ...more }) as Track;
  const near = (box: readonly number[] | undefined, expected: readonly number[]): void => {
    expect(box).toHaveLength(expected.length);
    expected.forEach((v, i) => expect(box?.[i]).toBeCloseTo(v, 9));
  };
  const timeline = (tracks: Track[]) => resolve({ version: 1, canvas: { width: W, height: H, fps: FPS }, materials: [{ id: 'pic', kind: 'image', file: 'assets/pic.png' }],
    segments: [{ id: 's', frames: 30, base: { color: '#000000' } }], tracks });

  it('takes an item\'s box on the frames it is on screen, with its corners or its ellipse, and the share of the canvas they cover', () => {
    const r = timeline([picture('plain', [0.1, 0.1, 0.4, 0.5]), picture('round', [0.6, 0.1, 0.3, 0.5], { radius: 0.5 }), picture('oval', [0.1, 0.65, 0.3, 0.3], { mask: 'ellipse' })]);
    const [plain, round, oval] = r.items.map((item) => itemRegion(r, item, 15));
    near(plain?.box, [0.1, 0.1, 0.4, 0.5]);
    expect(plain && 'radius' in plain).toBe(false);
    // Half the box's smaller side (180 px tall, 192 px wide): its ends are half discs.
    expect(round?.radius).toBeCloseTo(0.5 * Math.min(0.3 * W, 0.5 * H), 6);
    expect(oval?.ellipse).toBe(true);
    expect(coverOf(plain ? [plain] : [], W, H)).toBeCloseTo(0.2, 2);
    // A disc of the box's smaller side at each end, and an ellipse: less than their boxes.
    expect(coverOf(round ? [round] : [], W, H)).toBeCloseTo((192 * 180 - (4 - Math.PI) * 90 * 90) / (W * H), 2);
    expect(coverOf(oval ? [oval] : [], W, H)).toBeCloseTo(0.09 * Math.PI / 4, 2);
    expect(itemsOver(r, 15)).toMatchObject({ count: 3 });
    expect(itemsOver(r, 30).count).toBe(0);
  });

  it('follows the item\'s motion and leaves out what lies outside the canvas or is too faint to see', () => {
    const r = timeline([picture('growing', [0.2, 0.2, 0.4, 0.4], { enter: { preset: 'scale-in', frames: 10 } }), picture('faint', [0.1, 0.1, 0.2, 0.2], { opacity: 0.3 }), picture('edge', [0.8, 0, 0.4, 0.5])]);
    const growing = r.items[0];
    const early = growing ? itemRegion(r, growing, 2)?.box : undefined;
    expect(early?.[2]).toBeLessThan(0.4);
    expect((early?.[0] ?? 0) + (early?.[2] ?? 0) / 2).toBeCloseTo(0.4, 6);
    near(growing ? itemRegion(r, growing, 15)?.box : undefined, [0.2, 0.2, 0.4, 0.4]);
    const over = itemsOver(r, 15);
    expect(over.count).toBe(2);
    expect(over.cover).toBeCloseTo(0.16 + 0.1, 2);
  });
});

/** A dark phone on a dark ground, nothing in its opening: its body hardly differs from the ground, its shadow is soft. */
const PHONE = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:' + W + 'px;height:' + H + 'px;overflow:hidden;background:#1b2436}'
  + '.phone{position:absolute;left:376px;top:28px;width:178px;height:304px;border-radius:22px;background:#161e2e;box-shadow:0 10px 40px rgba(0,0,0,.35)}</style></head>'
  + '<body><div class="phone"></div></body></html>';
/** The phone's opening, [384, 36, 162, 288] px, where a clip or a picture is laid. */
const OPENING: [number, number, number, number] = [384 / W, 36 / H, 162 / W, 288 / H];
/** Footage that shades smoothly from the phone's body into lighter tones, as a photograph or a screen recording does. */
const SHADING = "nullsrc=s=180x320:r=30:d=2,format=gbrp,geq=r='22+84*Y/H':g='30+92*Y/H':b='46+104*Y/H'";

const scene = (id: string): Project['segments'][number] => ({ id, frames: 30, base: { scene: 'scenes/phone.html' } });
const laid = (id: string, type: 'video' | 'image', material: string, box = OPENING): Track =>
  ({ id: id + '-' + type, type, material, box, fit: 'cover', radius: 0.06, during: { segment: id } }) as Track;
const PROJECT: Project = {
  version: 1, canvas: { width: W, height: H, fps: FPS },
  materials: [{ id: 'clip', kind: 'video', file: 'assets/clip.mp4' }, { id: 'still', kind: 'image', file: 'assets/still.png' }],
  segments: [scene('video'), scene('empty'), scene('image'), scene('small'), scene('ref-empty'), scene('ref-video')],
  tracks: [laid('video', 'video', 'clip'), laid('image', 'image', 'still'), laid('small', 'image', 'still', [0.05, 0.05, 0.04, 0.07]), laid('ref-video', 'video', 'clip')],
};
/** The record of a reference whose shots 5 and 6 were 30% full in the middle. */
const FACTS: ReferenceFacts = {
  format: FACTS_FORMAT, version: FACTS_VERSION, template: { name: 'phone', label: 'synthetic', measure: '0' }, canvas: PROJECT.canvas,
  shots: [{ index: 4, segment: 'ref-empty', frames: 30, source: 'footage', fill: 0.3 }, { index: 5, segment: 'ref-video', frames: 30, source: 'footage', fill: 0.3 }],
};

interface Summary { id: string; fill?: number; items?: { count: number; cover: number } }

describe.skipIf(!ready)('scene check: footage inside a scene', () => {
  let dir = '';
  let out: { problems: { at: string; message: string }[]; scenes: Summary[] };
  const said = (k: number): string => out.problems.filter((p) => p.at === 'segments[' + k + '].base.scene').map((p) => p.message).join('\n');
  const summary = (id: string): Summary | undefined => out.scenes.find((s) => s.id === id);
  beforeAll(async () => {
    dir = await projectDir('scene-items-', PROJECT);
    await mkdir(path.join(dir, 'scenes'));
    await writeFile(path.join(dir, 'scenes', 'phone.html'), PHONE);
    await writeFile(path.join(dir, FACTS_FILE), JSON.stringify(FACTS));
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', SHADING, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', path.join(dir, 'assets', 'clip.mp4')]);
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', SHADING, '-frames:v', '1', path.join(dir, 'assets', 'still.png')]);
    const run = await runCli(rt, ['video', 'scene', 'check', dir]);
    expect(run.code).toBe(0);
    out = rt.json() as typeof out;
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('counts a clip in the phone\'s opening as what the shot shows, and says so in scenes[]', () => {
    expect(said(0)).toBe('');
    expect(summary('video')?.fill).toBeGreaterThan(0.18);
    expect(summary('video')?.items?.count).toBe(1);
    expect(summary('video')?.items?.cover).toBeCloseTo(0.2, 1);
  });

  it('still calls the phone with nothing in it nearly empty', () => {
    expect(said(1)).toMatch(/^Half-way through segment "empty" \("scenes\/phone.html"\) the picture is nearly empty: [\d.]+% of it stands out from its ground, and it shows no text/);
    expect(summary('empty')?.fill).toBeLessThan(0.02);
    expect(summary('empty')?.items).toBeUndefined();
  });

  it('counts a picture in the opening likewise', () => {
    expect(said(2)).toBe('');
    expect(summary('image')?.fill).toBeGreaterThan(0.18);
    expect(summary('image')?.items?.count).toBe(1);
  });

  it('counts a small picture only as large as it is, and says that it was counted', () => {
    expect(said(3)).toMatch(/the picture is nearly empty: [\d.]+% of it stands out from its ground \(the video or image item over the scene counted whole\), and it shows no text/);
    expect(summary('small')?.items?.cover).toBeLessThan(0.01);
  });

  it('holds the scene to its reference shot with the clip counted', () => {
    expect(said(4)).toMatch(/far emptier than its shot/);
    expect(said(5)).toBe('');
    expect(summary('ref-video')?.fill).toBeGreaterThan(0.15);
  });
});
