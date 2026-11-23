/**
 * The record of renders and reviews (render/record.ts) through the CLI: render, compare (round 1), a scene changed,
 * render, compare (round 2, the shot left as it was named still worst, the fixed one not), renders without a compare
 * (a warning, unless nothing that changes the picture changed), a render again without a change (still the same
 * round), two projects in one work directory, and a record that cannot be read. The reference is three shots made with
 * ffmpeg; the project draws the first as the reference does, the second wrongly, the third with a scene that a later
 * step corrects. Also: references/video.md says what the tools now count, and its directed recording passes the band.
 */
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeCommands } from '../../src/video/commands/make';
import { createDiskRuntime, hasChrome, type DiskRuntime } from '../../src/testing/disk';
import { PACKAGE_ROOT, runCli } from '../../src/testing/memory';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import type { Project } from '../../src/video/types';

let rt: DiskRuntime;
beforeAll(async () => { rt = await createDiskRuntime(); });
afterAll(async () => { await rt.cleanup(); });
const probe = await createDiskRuntime();
const ready = (await hasFfmpeg(probe)) && hasChrome();
await probe.cleanup();

const W = 180, H = 320;
const S = 's=' + W + 'x' + H + ':r=30';

/** Three one-second shots: red with a white bar at the top, blue with one at the bottom, green with a box in the middle. */
const makeReference = async (): Promise<void> => {
  const shots = ['color=c=0xd02020:' + S + ',drawbox=x=20:y=40:w=140:h=60:color=white:t=fill', 'color=c=0x2040c0:' + S + ',drawbox=x=20:y=220:w=140:h=60:color=white:t=fill', 'color=c=0x20a040:' + S + ',drawbox=x=40:y=120:w=100:h=80:color=white:t=fill'];
  const inputs = shots.flatMap((src) => ['-f', 'lavfi', '-t', '1', '-i', src]);
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]', '-map', '[v]', '-c:v', 'libx264', '-crf', '18', path.join(rt.dir, 'reference.mp4')]);
};

/** The first shot as in the reference, the second yellow with no bar (wrong), the third drawn by a scene. */
const PROJECT: Project = {
  version: 1,
  canvas: { width: W, height: H, fps: 30 },
  materials: [],
  segments: [
    { id: 'one', frames: 30, base: { color: '#d02020' } },
    { id: 'two', frames: 30, base: { color: '#e0c020' } },
    { id: 'three', frames: 30, base: { scene: 'scenes/three.html' } },
  ],
  tracks: [{ id: 'bar', type: 'shape', shape: 'rect', color: '#ffffff', box: [20 / W, 40 / H, 140 / W, 60 / H], during: { segment: 'one' } }],
};

/** The third shot's scene: a ground, and a white box where given. */
const scene = (ground: string, box?: { left: number }): string =>
  '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:' + W + 'px;height:' + H + 'px;overflow:hidden;background:' + ground + '}'
  + 'div{position:absolute;left:' + (box?.left ?? 0) + 'px;top:120px;width:100px;height:80px;background:#ffffff}</style></head><body>' + (box ? '<div></div>' : '') + '</body></html>';

const writeScene = (html: string): Promise<void> => rt.fs.writeFile(path.join(rt.dir, 'a', 'scenes', 'three.html'), html);

const json = (): Record<string, unknown> => rt.json();
const render = async (dir: string, out: string, extra: string[] = []): Promise<Record<string, unknown>> => {
  expect((await runCli(rt, ['video', 'render', dir, '--out', out, '--pages', '1', ...extra])).code).toBe(0);
  return json();
};
const compare = async (extra: string[] = []): Promise<Record<string, unknown>> => {
  expect((await runCli(rt, ['video', 'compare', 'reference.mp4', 'final.mp4', ...extra])).code).toBe(0);
  return json();
};
interface Still { shot: number; since: number; then: number; now: number; by: string }
const worstShots = (r: Record<string, unknown>): number[] => (r.worst as { shot: number }[]).map((w) => w.shot);
const reviews = (): string => path.join(rt.dir, '.popost', 'video', 'reviews');
const WARNING = /^the last render \(final\.mp4 at \d\d:\d\d\) was not compared with the reference: run compare before changing more$/;

describe.skipIf(!ready)('the record of renders and reviews', () => {
  beforeAll(async () => {
    await makeReference();
    for (const [dir, p] of [['a', PROJECT], ['b', { ...PROJECT, segments: [{ id: 'only', frames: 10, base: { color: '#203040' } }], tracks: [] }]] as const) {
      await rm(path.join(rt.dir, dir), { recursive: true, force: true });
      await rt.fs.writeFile(path.join(rt.dir, dir, 'video.json'), JSON.stringify(p, null, 2));
    }
    await writeScene(scene('#c020c0'));
  });

  it('a render names the compare to run; its compare is round 1 and says what the round asks', async () => {
    const r = await render('a', 'final.mp4');
    expect(r).toMatchObject({ ok: true, out: 'final.mp4', next: 'Compare it with the reference: popost video compare reference.mp4 final.mp4' });
    expect(r.warning).toBeUndefined();
    const c = await compare();
    expect(c.round).toBe(1);
    expect(c.next).toBe('Round 1 of at least 2: look at each worst shot at full size (its look command: popost video look … --at …), fix it or write it down with its reason in the delivery notes, render again and compare again.');
    expect(c.stillWorst).toBeUndefined();
    expect(worstShots(c)).toEqual(expect.arrayContaining([2, 3]));
    // Small: one file for the project, a few hundred bytes a render.
    const files = await readdir(reviews());
    expect(files).toHaveLength(1);
    expect((await readFile(path.join(reviews(), files[0] as string))).length).toBeLessThan(2000);
  });

  it('round 2 names the shot that stayed worst with a similar score, not the one that was fixed; another project is apart', async () => {
    // Another project in the same work directory, rendered and never compared: nothing to do with the first one's rounds.
    expect((await render('b', 'b.mp4')).warning).toBeUndefined();
    await writeScene(scene('#20a040', { left: 40 }));
    const r = await render('a', 'final.mp4');
    expect(r.warning).toBeUndefined();
    expect(r.next).toBe('Compare it with the reference: popost video compare reference.mp4 final.mp4');
    const c = await compare();
    expect(c.round).toBe(2);
    const still = c.stillWorst as Still[];
    expect(still.find((s) => s.shot === 2)).toMatchObject({ since: 1 });
    expect(still.find((s) => s.shot === 3)).toBeUndefined();
    // The first shot is drawn as in the reference: among the worst only because worst names three, so not named.
    expect(still.find((s) => s.shot === 1)).toBeUndefined();
    const two = still.find((s) => s.shot === 2) as Still;
    expect(Math.abs(two.then - two.now)).toBeLessThanOrEqual(0.05);
    expect(String(c.next)).toMatch(/^Round 2 \(at least 2, at most 4\): look at each worst shot/);
    expect(String(c.next)).toContain('Still worst since round 1: shot 2 (' + two.then + ' then, ' + two.now + ' now). Fix it or write down why it stays.');
    expect(String(c.next)).toContain('after a fix, render again and compare again (round 3)');
  });

  it('the same render compared again stays in its round; the next render names the text files that compare was given', async () => {
    const track = JSON.stringify({ step: 6, sampled: 0, cues: [] });
    await writeFile(path.join(rt.dir, 'ref.text.json'), track);
    await writeFile(path.join(rt.dir, 'final.text.json'), track);
    expect((await compare(['--reference-text', 'ref.text.json', '--other-text', 'final.text.json'])).round).toBe(2);
    await writeScene(scene('#20a040', { left: 44 }));
    const r = await render('a', 'final.mp4');
    expect(r.warning).toBeUndefined();
    expect(r.next).toBe('Read its text, then compare it with the reference: popost video text final.mp4 --out final.text.json, then popost video compare reference.mp4 final.mp4 --reference-text ref.text.json --other-text final.text.json');
  });

  it('a render after a render that was never compared warns, unless nothing that changes the picture changed', async () => {
    await writeScene(scene('#20a040', { left: 48 }));
    expect(String((await render('a', 'final.mp4')).warning)).toMatch(WARNING);
    // The same project again (another scale): the render before shows the same picture, so it is no reason to warn.
    expect((await render('a', 'final.mp4', ['--scale', '0.5'])).warning).toBeUndefined();
    expect((await compare()).round).toBe(3);
    // And comparing it again at full size is still round 3: a round needs a change.
    expect((await render('a', 'final.mp4')).warning).toBeUndefined();
    const c = await compare();
    expect(c.round).toBe(3);
    expect(String(c.next)).toMatch(/^Still round 3: this render shows the project as it was when it was compared in round 3/);
  });

  it('a record that cannot be read starts again; a video that no render wrote has no round', async () => {
    const [file] = (await readdir(reviews())).filter((f) => f.startsWith('b-'));
    await writeFile(path.join(reviews(), file as string), 'not a record');
    expect((await render('b', 'b.mp4')).warning).toBeUndefined();
    expect(JSON.parse(await readFile(path.join(reviews(), file as string), 'utf8'))).toMatchObject({ renders: [expect.objectContaining({ out: path.join(rt.dir, 'b.mp4') })] });
    expect((await runCli(rt, ['video', 'compare', 'reference.mp4', 'reference.mp4'])).code).toBe(0);
    expect(json().round).toBeUndefined();
    expect(String(json().next)).toContain('Rounds are counted only for a video popost video render wrote');
  });
});

describe('references/video.md', () => {
  const doc = readFile(path.join(PACKAGE_ROOT, 'references', 'video.md'), 'utf8');

  it('step 7 says that compare counts the rounds, and what "at least two" means in that count', async () => {
    const step7 = (await doc).split('## 7.')[1] ?? '';
    for (const word of ['`round`', '"round": 2', '`stillWorst`', '`warning`']) expect(step7, word).toContain(word);
  });

  it('every directed recording passes the top of the caption band from the template, and the page says when not to', async () => {
    const text = await doc;
    const commands = [...text.matchAll(/`(popost video capture [^`]*)`/g)].map((m) => m[1] as string);
    const flags = new Set((makeCommands.capture?.spec.options ?? []).map((o) => o.flag));
    for (const c of commands) for (const f of c.match(/--[a-z-]+/g) ?? []) expect(flags.has(f), f + ' in ' + c).toBe(true);
    const recordings = commands.filter((c) => c.includes('--plan '));
    expect(recordings.length).toBeGreaterThan(0);
    for (const c of recordings) expect(c).toContain('--caption-band <y of slots.captions.box>');
    expect(text).toMatch(/Leave it out only for a video without\s+captions/);
  });
});
