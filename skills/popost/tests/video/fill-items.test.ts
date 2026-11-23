/**
 * Items over a shot in the fill (retarget/items.ts): a clip or a picture in a box over a scene lives in fill.json, so
 * that template fill writes it into video.json every time, during its shot, moved with the shot by a re-flow.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { itemFitProblems } from '../../src/video/template/fit';
import { itemLength } from '../../src/video/template/check';
import type { TemplatePackage } from '../../src/video/template/types';
import { retarget, type RetargetPlan } from '../../src/video/retarget/index';
import { itemTracks, shotItemProblems } from '../../src/video/retarget/items';
import { resolve } from '../../src/video/timeline/resolve';
import type { Measure } from '../../src/video/types';
import type { TextTrack } from '../../src/video/text/types';

const still = { kind: 'static' as const, zoomPerS: 0, panPerS: [0, 0] as [number, number], confidence: 1 };
const measure: Measure = {
  version: 1,
  source: { width: 1280, height: 720, fps: 30, frames: 300, duration: 10, hasAudio: true },
  boundaries: [{ frame: 90, kind: 'cut', start: 89, end: 90, confidence: 1 }, { frame: 200, kind: 'cut', start: 199, end: 200, confidence: 1 }],
  shots: [
    { index: 0, start: 0, end: 90, camera: still, background: '', palette: [], events: [] },
    { index: 1, start: 90, end: 200, camera: still, background: '', palette: [], events: [] },
    { index: 2, start: 200, end: 300, camera: still, background: '', palette: [], events: [] },
  ],
  rhythm: { step: 3, change: [] },
  signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
};
const cue = (text: string, start: number, end: number) => ({ text, start, end, box: [0.3, 0.86, 0.4, 0.08] as [number, number, number, number], role: 'caption' as const, size: 0.08, samples: 5, confidence: 0.95 });
const text: TextTrack = { step: 6, sampled: 50, cues: [cue('第一句', 0, 85), cue('第二句', 95, 195), cue('第三句', 205, 290)] };
const phone = { video: 'assets/app.mp4', box: [0.6, 0.1, 0.2531, 0.8] as [number, number, number, number], fit: 'cover' as const, radius: 0.07, in: 0 };
const plan: RetargetPlan = {
  captions: ['新的第一句', '新的第二句', '新的第三句'],
  shots: [{ color: '#101010' }, { scene: 'scenes/phone.html', items: [phone, { image: 'assets/badge.webp', box: [0.1, 0.1, 0.2, 0.2] }] }, { footage: 'assets/app.mp4', in: 90 }],
};
const facts = { 'video-1': { width: 360, height: 640, fps: 30, frames: 600, hasAudio: false } };

describe('items over a shot', () => {
  it('become tracks during their shot, over the base and under the captions, with materials shared by file', () => {
    const r = retarget({ measure, text, plan });
    expect(r.problems).toEqual([]);
    const p = r.project;
    expect(p?.materials.map((m) => [m.id, m.kind, m.file])).toEqual([['video-1', 'video', 'assets/app.mp4'], ['image-1', 'image', 'assets/badge.webp']]);
    expect(p?.tracks.map((t) => t.id)).toEqual(['shot-02-video-1', 'shot-02-image-2', 'captions']);
    expect(p?.tracks[0]).toEqual({ id: 'shot-02-video-1', type: 'video', material: 'video-1', box: [0.6, 0.1, 0.2531, 0.8], fit: 'cover', radius: 0.07, in: 0, during: { segment: 'shot-02' } });
    expect(p?.tracks[1]).toEqual({ id: 'shot-02-image-2', type: 'image', material: 'image-1', box: [0.1, 0.1, 0.2, 0.2], fit: 'cover', during: { segment: 'shot-02' } });
    // The third shot's footage is the same file: one material.
    expect(p?.segments[2]?.base).toMatchObject({ material: 'video-1', in: 90 });
  });

  it('move and stretch with their shot when time is re-flowed to speech', () => {
    const plain = retarget({ measure, text, plan }).project;
    const spoken = retarget({ measure, text, plan, spoken: { frames: [40, 160, 60] } }).project;
    if (!plain || !spoken) throw new Error('no project');
    const span = (project: typeof plain) => {
      const r = resolve(project, facts);
      const item = r.items.find((i) => i.id === 'shot-02-video-1');
      const seg = r.segments.find((s) => s.id === 'shot-02');
      return { item: [item?.start, item?.end], segment: [seg?.start, seg?.end] };
    };
    const before = span(plain), after = span(spoken);
    expect(before.item).toEqual(before.segment);
    expect(after.item).toEqual(after.segment);
    expect(after.segment).not.toEqual(before.segment);
  });

  it('are checked: a file, a box inside the canvas, values the engine takes', () => {
    const at = (items: unknown) => shotItemProblems({ scene: 'scenes/a.html', items }, 'shots[1]').map((p) => [p.level, p.at]);
    expect(at([phone])).toEqual([]);
    expect(at('assets/app.mp4')).toEqual([['error', 'shots[1].items']]);
    expect(at([{ box: [0, 0, 1, 1] }])).toEqual([['error', 'shots[1].items[0]']]);
    expect(at([{ ...phone, box: [0.6, 0.1, 0.5, 0.8] }])).toEqual([['error', 'shots[1].items[0].box']]);
    expect(at([{ ...phone, fit: 'fill', radius: 2, in: -1 }])).toEqual([['error', 'shots[1].items[0].fit'], ['error', 'shots[1].items[0].radius'], ['error', 'shots[1].items[0].in']]);
    expect(at([{ image: 'assets/a.webp', box: [0, 0, 0.5, 0.5], in: 3 }])).toEqual([['error', 'shots[1].items[0]']]);
    expect(at([{ ...phone, z: 3 }])).toEqual([['warning', 'shots[1].items[0].z']]);
    const bad = retarget({ measure, text, plan: { ...plan, shots: [plan.shots[0]!, { scene: 'scenes/phone.html', items: [{ ...phone, box: [0.9, 0.1, 0.3, 0.8] }] }, plan.shots[2]!] } });
    expect(bad.project).toBeUndefined();
    expect(bad.problems.map((p) => p.at)).toEqual(['shots[1].items[0].box']);
  });

  it('take their ids from the shot and their order, as the page that shows them says', () => {
    const ids: string[] = [];
    const tracks = itemTracks('shot-05', [phone, phone], (file, kind) => { ids.push(kind + ':' + file); return 'm'; });
    expect(tracks.map((t) => t.id)).toEqual(['shot-05-video-1', 'shot-05-video-2']);
    expect(ids).toEqual(['video:assets/app.mp4', 'video:assets/app.mp4']);
  });
});

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });

describe.skipIf(!(await hasFfmpeg(rt)))('an item\'s file in its box', () => {
  it('warns when cover would crop it, with a box of its proportions, and says nothing when it fits', async () => {
    const clip = rt.path.join(rt.dir, 'portrait.mp4');
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=360x640:r=30:d=1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', clip]);
    const canvas = { width: 1280, height: 720 };
    const check = (box: number[], fit?: string) => itemFitProblems(rt, canvas, { at: 'shots[1].items[0]', key: 'video', name: 'assets/portrait.mp4', file: clip, box, ...(fit ? { fit } : {}) });
    expect(await check([0.6, 0.1, 0.2531, 0.8])).toEqual([]);
    const wide = await check([0.1, 0.1, 0.8, 0.8]);
    expect(wide.map((p) => [p.level, p.at])).toEqual([['warning', 'shots[1].items[0].fit'], ['warning', 'shots[1].items[0].video']]);
    expect(wide[0]?.message).toContain('"assets/portrait.mp4" is 360x640 in a 1024x576 box: "cover" fills the box and cuts');
    expect(wide[0]?.fix).toContain('"box": [0.1, 0.1, 0.2531, 0.8]');
    // Shown whole, the scene shows round it: no warning about a ground.
    expect((await check([0.1, 0.1, 0.8, 0.8], 'contain')).map((p) => p.at)).toEqual([]);
  });

  it('warns, with the seconds, when a clip runs out before its shot ends, and measures again on re-flowed lengths', async () => {
    const clip = rt.path.join(rt.dir, 'two-seconds.mp4');
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=360x640:r=30:d=2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', clip]);
    const pkg = { template: { canvas: { width: 1280, height: 720, fps: 30 }, shots: [{ frames: 90 }, { frames: 45 }] } } as unknown as TemplatePackage;
    const at = (k: number, from = 0, lengths?: number[]) => itemLength(rt, pkg, { at: 'shots[' + k + '].items[0]', name: 'assets/two-seconds.mp4', file: clip, k, from, speed: 1, ...(lengths ? { lengths } : {}) });
    expect(await at(1)).toEqual([]);
    const short = await at(0);
    expect(short.map((p) => [p.level, p.at])).toEqual([['warning', 'shots[0].items[0].video']]);
    expect(short[0]?.message).toBe('Shot 1 is 3.00 s, but its clip "assets/two-seconds.mp4" has 2.00 s of frames of clip from "in": 0, so its last frame holds for the last 1.00 s.');
    expect((await at(1, 30))[0]?.message).toContain('has 1.00 s of frames of clip from "in": 30');
    expect(await at(1, 0, [90, 90])).toHaveLength(1);
  });
});
