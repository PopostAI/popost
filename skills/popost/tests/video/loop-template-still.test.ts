/**
 * template check with the files at hand: one picture that fills more than two shots, or more than a third of the
 * video, is a slide show, and the check says so, naming the shots and the capture director's camera. Pictures are made
 * with ffmpeg; the same bytes under two names count as one picture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import type { RetargetPlan } from '../../src/video/retarget/index';
import { checkFill } from '../../src/video/template/check';
import { jsonText } from '../../src/video/template/save';
import { slotsOf } from '../../src/video/template/slots';
import { templateFrom } from '../../src/video/template/structure';
import type { TemplatePackage } from '../../src/video/template/types';
import type { Measure, Problem } from '../../src/video/types';

let rt: DiskRuntime;
const probeRt = await createDiskRuntime();
const ok = await hasFfmpeg(probeRt);
await probeRt.cleanup();

/** Six still shots at 30 fps, 12 s in all: the first is 5 s long. */
const LENGTHS = [150, 30, 30, 30, 60, 60];
const starts = LENGTHS.map((_n, k) => LENGTHS.slice(0, k).reduce((a, b) => a + b, 0));
const measure: Measure = {
  version: 1,
  source: { width: 640, height: 360, fps: 30, frames: 360, duration: 12, hasAudio: false },
  boundaries: starts.slice(1).map((s) => ({ frame: s, kind: 'cut' as const, start: s - 1, end: s, confidence: 1 })),
  shots: LENGTHS.map((n, k) => ({ index: k, start: starts[k] ?? 0, end: (starts[k] ?? 0) + n, camera: { kind: 'static' as const, zoomPerS: 0, panPerS: [0, 0] as [number, number], confidence: 0.9 }, background: '#202020', palette: [{ hex: '#202020', share: 0.5 }], events: [] })),
  rhythm: { step: 3, change: [] },
  signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
};
const template = templateFrom({ measure, name: 'stills', label: 'stills', hash: 'x' });
const pkg: TemplatePackage = { template, slots: slotsOf(template, undefined) };

const fillOf = (pictures: Record<number, string>): RetargetPlan => ({ shots: LENGTHS.map((_n, k) => (pictures[k] ? { picture: pictures[k] as string } : { color: k % 2 ? '#101010' : '#f0f0f0' })) });
const stills = (p: Problem[]): Problem[] => p.filter((x) => x.message.includes('slide show'));

describe.skipIf(!ok)('template check: one still for many shots', () => {
  beforeAll(async () => {
    rt = await createDiskRuntime();
    await rt.fs.mkdir(rt.path.join(rt.dir, 'assets'));
    const picture = (file: string, colour: string): Promise<unknown> => runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=' + colour + ':s=640x360', '-frames:v', '1', rt.path.join(rt.dir, 'assets', file)]);
    await picture('page.png', '0x3060a0');
    await picture('other.png', '0xa06030');
    await rt.fs.writeFile(rt.path.join(rt.dir, 'assets', 'copy.png'), await rt.fs.readFile(rt.path.join(rt.dir, 'assets', 'page.png')));
    await rt.fs.writeFile(rt.path.join(rt.dir, 'template', 'template.json'), jsonText(pkg.template));
    await rt.fs.writeFile(rt.path.join(rt.dir, 'template', 'slots.json'), jsonText(pkg.slots));
  });
  afterAll(() => rt.cleanup());

  it('warns when one picture fills more than two shots, naming them, and names the capture director', async () => {
    const p = stills(await checkFill(rt, pkg, fillOf({ 1: 'assets/page.png', 2: 'assets/page.png', 3: 'assets/page.png', 4: 'assets/other.png' }), { dir: rt.dir }));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ level: 'warning', at: 'shots[1].picture' });
    expect(p[0]?.message).toBe('"assets/page.png" fills shots[1], shots[2] and shots[3]: 3.0 s of the video\'s 12.0 s (25%). One still over several shots plays as a slide show.');
    expect(p[0]?.fix).toContain('popost video capture file://<its absolute path> --size <its width>x<its height> --plan plan.json');
    expect(p[0]?.fix).toContain('each shot with that footage from its own "in"');
  });

  it('counts the same picture under two names as one', async () => {
    const p = stills(await checkFill(rt, pkg, fillOf({ 1: 'assets/page.png', 2: 'assets/copy.png', 5: 'assets/page.png' }), { dir: rt.dir }));
    expect(p.map((x) => x.message.split(':')[0])).toEqual(['"assets/page.png" fills shots[1], shots[2] and shots[5]']);
  });

  it('warns when one picture fills more than a third of the video, even in one shot', async () => {
    const p = stills(await checkFill(rt, pkg, fillOf({ 0: 'assets/other.png' }), { dir: rt.dir }));
    expect(p.map((x) => x.message)).toEqual(['"assets/other.png" fills shots[0]: 5.0 s of the video\'s 12.0 s (42%). One still over so long a shot plays as a slide show.']);
  });

  it('leaves two shots of a third of the video alone, and says nothing without the files', async () => {
    expect(stills(await checkFill(rt, pkg, fillOf({ 4: 'assets/page.png', 5: 'assets/page.png' }), { dir: rt.dir }))).toEqual([]);
    expect(stills(await checkFill(rt, pkg, fillOf({ 1: 'assets/page.png', 2: 'assets/page.png', 3: 'assets/page.png' })))).toEqual([]);
  });

  it('is printed by popost video template check --assets', async () => {
    await rt.fs.writeFile(rt.path.join(rt.dir, 'fill.json'), JSON.stringify(fillOf({ 1: 'assets/page.png', 2: 'assets/page.png', 3: 'assets/page.png' })));
    expect((await runCli(rt, ['video', 'template', 'check', 'template', '--fill', 'fill.json', '--assets', '.'])).code).toBe(0);
    const out = rt.json() as { ok: boolean; problems: Problem[] };
    expect(out.ok).toBe(true);
    expect(stills(out.problems).map((x) => x.at)).toEqual(['shots[1].picture']);
  });
});
