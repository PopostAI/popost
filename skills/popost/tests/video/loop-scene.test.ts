import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import type { Message, Model } from '../../src/video/plan/model';
import { extractHtml, writeScene } from '../../src/video/scene/author';

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ready = (await hasFfmpeg(rt)) && hasChrome();

const page = (body: string): string =>
  '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:320px;height:180px;overflow:hidden;background:#102040}#t{position:absolute;left:20px;top:60px;font:700 24px sans-serif;color:#fff;animation:in 0.5s both}@keyframes in{from{opacity:0}to{opacity:1}}</style></head><body>' + body + '</body></html>';
const fence = (html: string): string => 'Here is the scene.\n```html\n' + html + '\n```';
const GOOD = page('<div id="t" data-slot="title">新的标题</div>');
const TIMER = page('<div id="t" data-slot="title">新的标题</div><script>setTimeout(function () {}, 10);</script>');
const BETTER = page('<div id="t" data-slot="title">更好的标题</div>');

const scripted = (answers: string[]): Model & { asked: Message[][] } => {
  const asked: Message[][] = [];
  return { name: 'scripted', asked, ask: async (messages) => { asked.push(messages.map((m) => ({ ...m }))); return { text: answers[asked.length - 1] ?? '', usage: { input: 10, output: 5 } }; } };
};

describe('scene: reading an answer', () => {
  it('takes the page out of a fence, or as it stands, and refuses half a page', () => {
    expect(extractHtml(fence(GOOD))).toBe(GOOD + '\n');
    expect(extractHtml('<think>plan</think>' + GOOD)).toBe(GOOD + '\n');
    expect(extractHtml('```html\n<!doctype html><html><head></head>\n')).toBeUndefined();
    expect(extractHtml('I cannot.')).toBeUndefined();
  });
});

describe.skipIf(!ready)('scene: a model writes one (Chrome + ffmpeg)', () => {
  let root = '';
  let video = '';
  const base = (dir: string, model: Model, rounds: number) => ({
    projectDir: dir, segment: 0, file: 'scenes/shot-01.html', start: 0, frames: 30, canvas: { width: 320, height: 180, fps: 30 },
    reference: { video, start: 0, end: 1 }, brief: '介绍我们的新功能', model, rounds, pictures: 2,
    texts: [{ text: '旧的标题', from: 0, to: 1, box: [0.1, 0.3, 0.5, 0.2], role: 'title' }],
  });
  const project = async (name: string): Promise<string> => {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'video.json'), JSON.stringify({ version: 1, canvas: { width: 320, height: 180, fps: 30 }, materials: [], tracks: [], segments: [{ id: 'a', frames: 30, base: { scene: 'scenes/shot-01.html' } }] }));
    return dir;
  };
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'loop-scene-'));
    video = path.join(root, 'ref.mp4');
    await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=1', '-pix_fmt', 'yuv420p', video]);
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it('sends the check\'s problems back until the scene passes, then shows the model its own frames', async () => {
    const dir = await project('repair');
    const model = scripted([fence(TIMER), fence(GOOD), fence(BETTER)]);
    const r = await writeScene(rt, base(dir, model, 1));
    expect(r.passed).toBe(true);
    expect(r.steps.map((s) => [s.kind, s.errors])).toEqual([['write', 1], ['repair', 0], ['review', 0]]);
    expect(await readFile(path.join(dir, 'scenes', 'shot-01.html'), 'utf8')).toBe(BETTER + '\n');
    // The first request: the rules, the brief, the reference's text, and two frames of the reference.
    const first = model.asked[0] ?? [];
    expect(String(first[0]?.content)).toContain('NOT allowed: setTimeout');
    const parts = Array.isArray(first[1]?.content) ? first[1].content : [];
    expect(parts.map((p) => p.type)).toEqual(['text', 'text', 'image_url', 'text', 'image_url']);
    expect((parts[0] as { text: string }).text).toContain('介绍我们的新功能');
    expect((parts[0] as { text: string }).text).toContain('title: "旧的标题"');
    // The repair names the timer; the review carries the scene as it stood and two frames of it.
    expect(String(model.asked[1]?.[3]?.content)).toContain('It drives something with a timer');
    const review = model.asked[2] ?? [];
    expect(String(review[2]?.content)).toContain('新的标题');
    const own = Array.isArray(review[3]?.content) ? review[3].content : [];
    expect(own.filter((p) => p.type === 'image_url')).toHaveLength(2);
    expect((own[1] as { text: string }).text).toMatch(/^Yours, /);
    expect(JSON.parse(await readFile(path.join(dir, 'scenes', 'shot-01.html.steps.json'), 'utf8'))).toMatchObject({ model: 'scripted', passed: true });
  });

  it('does not call a scene passed when the project could not be opened for another reason', async () => {
    const dir = await project('elsewhere');
    await writeFile(path.join(dir, 'video.json'), JSON.stringify({ version: 1, canvas: { width: 320, height: 180, fps: 30 }, materials: [], tracks: [], segments: [{ id: 'a', frames: 30, base: { scene: 'scenes/shot-01.html' } }, { id: 'b', frames: 30, base: { scene: 'scenes/not-written.html' } }] }));
    await expect(writeScene(rt, base(dir, scripted([fence(GOOD)]), 0))).rejects.toThrow(/could not be opened because the project has another error \(segments\[1\]\.base\.scene/);
  });

  it('keeps the version that passed when a review breaks the scene, and says so when nothing ever passes', async () => {
    const kept = await project('kept');
    const r = await writeScene(rt, { ...base(kept, scripted([fence(GOOD), 'no page', 'no page', 'no page']), 1), attempts: 3 });
    expect(r.passed).toBe(true);
    expect(await readFile(path.join(kept, 'scenes', 'shot-01.html'), 'utf8')).toBe(GOOD + '\n');
    const never = await project('never');
    const n = await writeScene(rt, { ...base(never, scripted([fence(TIMER), fence(TIMER)]), 1), attempts: 2 });
    expect(n.passed).toBe(false);
    expect(n.steps).toHaveLength(2);
    expect(n.problems[0]?.message).toContain('timer');
  });
});
