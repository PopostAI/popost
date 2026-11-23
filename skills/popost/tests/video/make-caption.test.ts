import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import type { CaptionCue, CaptionTrack, Problem, Project } from '../../src/video/types';
import { checkProject } from '../../src/video/project/check';
import { parseProject } from '../../src/video/project/schema';
import { resolve } from '../../src/video/timeline/resolve';
import { itemStateAt } from '../../src/video/timeline/frame';
import { TEXT_STYLES } from '../../src/video/presets/text-styles';
import { hasFfmpeg } from '../../src/video/media/ffmpeg';
import { openRenderer, type Renderer } from '../../src/video/render/index';
import { decodePng, pixelsWhere, playedAndJumped, projectDir } from './make-fixtures';

const W = 180;
const H = 320;

/**
 * Two 30-frame shots (a hard cut at 30). Captions follow speech: cue 0 on 2..19, cue 1 on 24..43 (it runs past the
 * cut), cue 2 on 50..59, each fading in and out over 4 frames.
 */
const cues = (): CaptionCue[] => [
  { text: '第一句话', during: { segment: 'a', from: 2, to: 20 } },
  { text: 'Second line', during: { segment: 'a', from: 24, to: 44 }, spans: [{ from: 0, to: 6, color: '#ffd000' }] },
  { text: 'Third', during: { segment: 'b', from: 20 } },
];
const track = (list: CaptionCue[] = cues()): CaptionTrack => ({
  id: 'subs', type: 'caption', box: [0.05, 0.75, 0.9, 0.1], style: 'caption', enter: { preset: 'fade', frames: 4 }, exit: { preset: 'fade', frames: 4 }, cues: list,
});
const project = (t: CaptionTrack = track()): Project => ({
  version: 1,
  canvas: { width: W, height: H, fps: 30 },
  materials: [],
  segments: [{ id: 'a', frames: 30, base: { color: '#203040' } }, { id: 'b', frames: 30, base: { color: '#402030' } }],
  tracks: [{ id: 'title', type: 'text', text: 'Title', box: [0.1, 0.1, 0.8, 0.1], during: { segment: 'a' } }, t],
});

const at = (problems: Problem[], where: string): Problem => {
  const p = problems.find((x) => x.at === where && x.level === 'error');
  if (!p) throw new Error('No error at ' + where + ' among: ' + JSON.stringify(problems, null, 1));
  return p;
};

describe('caption track: format, check and resolve', () => {
  it('expands the cues into text items "<track>#<n>" with the track\'s box, style, entrance and exit', () => {
    expect(parseProject(project()).problems).toEqual([]);
    expect(checkProject(project())).toEqual([]);
    const r = resolve(project());
    const subs = r.items.filter((i) => i.cue);
    expect(subs.map((i) => [i.id, i.start, i.end, i.text])).toEqual([['subs#0', 2, 20, '第一句话'], ['subs#1', 24, 44, 'Second line'], ['subs#2', 50, 60, 'Third']]);
    expect(subs[0]).toMatchObject({ type: 'text', box: [0.05, 0.75, 0.9, 0.1], style: TEXT_STYLES.caption, enter: { preset: 'fade', frames: 4 }, cue: { track: 'subs', index: 0 } });
    expect(subs[1]?.style?.spans).toEqual([{ from: 0, to: 6, color: '#ffd000' }]);
    expect(r.items.map((i) => i.id)).toEqual(['title', 'subs#0', 'subs#1', 'subs#2']);
    // Frame 25 is the second of cue 1's four entrance frames: progress 0.5, eased 'out' (the fade's default).
    const second = subs[1];
    if (!second) throw new Error('no cue 1');
    expect(itemStateAt(second, 25)?.opacity).toBeCloseTo(1 - 0.5 ** 3, 12);
    expect(itemStateAt(second, 44)).toBeUndefined();
  });

  it('refuses cues out of order or overlapping (naming both), empty text, and a cue shorter than its entrance and exit', () => {
    const swapped = cues();
    [swapped[0], swapped[1]] = [swapped[1] as CaptionCue, swapped[0] as CaptionCue];
    const order = at(checkProject(project(track(swapped))), 'tracks[1].cues[1].during');
    expect(order.message).toContain('Cue 1 (frames 2..19) starts before cue 0 (frames 24..43)');
    const overlap = cues();
    overlap[1] = { ...(overlap[1] as CaptionCue), during: { segment: 'a', from: 15, to: 40 } };
    const o = at(checkProject(project(track(overlap))), 'tracks[1].cues[1].during');
    expect(o.message).toContain('overlaps cue 0');
    expect(o.fix).toContain('"to": 15 in segment "a"');
    const empty = cues();
    empty[2] = { ...(empty[2] as CaptionCue), text: '  ' };
    expect(at(checkProject(project(track(empty))), 'tracks[1].cues[2].text').fix).toContain('Write the words');
    const short = cues();
    short[2] = { ...(short[2] as CaptionCue), during: { segment: 'b', from: 20, to: 26 } };
    expect(at(checkProject(project(track(short))), 'tracks[1].cues[2].during').message).toContain('shorter than the track\'s entrance and exit together (8 frames)');
    const spans = cues();
    spans[0] = { ...(spans[0] as CaptionCue), spans: [{ from: 2, to: 5, color: '#fff' }] };
    expect(at(checkProject(project(track(spans))), 'tracks[1].cues[0].spans[0].to').message).toContain('has 4 characters');
    expect(at(checkProject(project(track([{ text: 'x', during: { segment: 'c' } }]))), 'tracks[1].cues[0].during.segment').allowed).toEqual(['a', 'b']);
    expect(parseProject({ ...project(), tracks: [{ ...track(), cues: [] }] }).problems.map((p) => p.at)).toEqual(['tracks[0].cues']);
  });
});

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ready = (await hasFfmpeg(rt)) && hasChrome();

describe.skipIf(!ready)('caption track: render (Chrome + ffmpeg)', () => {
  let dir = '';
  let renderer: Renderer | undefined;
  const frame = async (n: number): Promise<Buffer> => {
    if (!renderer) throw new Error('renderer not open');
    return renderer.frame(n);
  };
  /** Light pixels in the caption box: the text (the caption style is white on a dark band). */
  const lit = async (n: number): Promise<number> =>
    pixelsWhere(await decodePng(await frame(n)), [0, Math.round(0.75 * H), W, Math.round(0.85 * H)], (c) => c.every((v) => v > 180)).length;

  beforeAll(async () => {
    dir = await projectDir('make-caption-', project());
    renderer = await openRenderer(rt, dir);
  });
  afterAll(async () => {
    await renderer?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('shows each cue on its own frames, across the cut, and nothing in the gaps', async () => {
    const counts = await Promise.all([1, 10, 22, 30, 35, 46, 55].map(async (n) => [n, await lit(n)] as const));
    console.log('lit caption pixels by frame: ' + counts.map(([n, c]) => n + ':' + c).join(' '));
    const by = new Map(counts);
    for (const n of [1, 22, 46]) expect(by.get(n), 'frame ' + n).toBe(0);
    for (const n of [10, 30, 35, 55]) expect(by.get(n), 'frame ' + n).toBeGreaterThan(30);
    const yellow = pixelsWhere(await decodePng(await frame(35)), [0, Math.round(0.75 * H), W, Math.round(0.85 * H)], (c) => (c[0] ?? 0) > 200 && (c[1] ?? 0) > 170 && (c[2] ?? 0) < 80);
    expect(yellow.length).toBeGreaterThan(20);
  });

  it('draws frames inside a cue\'s entrance and exit the same when played and when jumped to', async () => {
    for (const n of [3, 18, 25, 42]) {
      const [played, jumped] = await playedAndJumped(frame, n);
      expect(played.equals(jumped), 'frame ' + n).toBe(true);
    }
  });
});
