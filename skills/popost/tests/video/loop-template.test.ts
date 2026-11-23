import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { roughTokens } from '../../src/video/describe/index';
import { planMessages } from '../../src/video/plan/prompt';
import { retarget, type RetargetPlan } from '../../src/video/retarget/index';
import type { Measure, Problem } from '../../src/video/types';
import type { TextTrack } from '../../src/video/text/types';
import type { Transcript } from '../../src/video/speech/types';
import type { Speaker } from '../../src/video/voice/index';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { checkFill, fillTemplate, generatedFills, loadTemplate, saveTemplate, swapTest, type TemplatePackage } from '../../src/video/template/index';
import { splitLongShots } from '../../src/video/template/split';

const rt = await createDiskRuntime();
const ffmpeg = await hasFfmpeg(rt);
const chrome = hasChrome();

const still = { kind: 'static' as const, zoomPerS: 0, panPerS: [0, 0] as [number, number], confidence: 1 };
const shot = (index: number, start: number, end: number, share: number) => ({ index, start, end, camera: still, background: '#203040', palette: [{ hex: '#203040', share }], events: [] });
/** Change between samples three frames apart: shot 1 keeps changing (footage), the others hardly (a picture, a colour, a picture). */
const change = Array.from({ length: 99 }, (_x, k) => (k * 3 < 90 ? 0.12 : 0.004));

/**
 * The reference, written by hand: 720x1280 at 30 fps, four shots (90, 110, 20 and 80 frames) joined by a cut, a
 * 9-frame push to the left and a 13-frame dissolve, and five caption lines in a band around 85% of the height.
 */
const measure: Measure = {
  version: 1,
  source: { width: 720, height: 1280, fps: 30, frames: 300, duration: 10, hasAudio: true },
  boundaries: [
    { frame: 90, kind: 'cut', start: 89, end: 90, confidence: 1 },
    { frame: 200, kind: 'slide', start: 195, end: 205, direction: 'left', mode: 'push', confidence: 0.9 },
    { frame: 220, kind: 'dissolve', start: 213, end: 227, confidence: 0.8 },
  ],
  shots: [shot(0, 0, 90, 0.4), shot(1, 90, 200, 0.5), shot(2, 200, 220, 0.96), shot(3, 220, 300, 0.6)],
  rhythm: { step: 3, change },
  signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
};
const cue = (text: string, start: number, end: number) =>
  ({ text, start, end, box: [0.25, 0.825, 0.5, 0.05] as [number, number, number, number], role: 'caption' as const, size: 0.05, samples: 5, confidence: 0.95 });
const text: TextTrack = {
  step: 6, sampled: 50,
  cues: [cue('先说结论', 0, 60), cue('这个方法真的有用', 60, 150), cue('第三句', 150, 210), cue('第四句话', 215, 270), cue('关注我', 270, 300),
    { ...cue('brand', 0, 300), role: 'watermark', box: [0.02, 0.02, 0.2, 0.03], size: 0.03 }],
};
const transcript: Transcript = { language: 'zh', fps: 30, words: [{ text: '先说', start: 2, end: 14, confidence: 0.9 }, { text: '结论。', start: 14, end: 30, confidence: 0.9 }] };

const colours = ['#1d3557', '#f4a261', '#2a9d8f', '#f1faee'];
const colourFill = (captions?: string[]): RetargetPlan => ({ shots: colours.map((color) => ({ color })), ...(captions ? { captions } : {}) });

let root = '';
let dir = '';
let pkg: TemplatePackage;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'loop-template-'));
  dir = path.join(root, 'template');
  const saved = await saveTemplate(rt, { measure, text, transcript, name: 'test', label: 'hand-written reference', outDir: dir });
  expect(saved.problems.filter((p) => p.level === 'error')).toEqual([]);
  pkg = await loadTemplate(rt, dir);
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); await rt.cleanup(); });

const at = (problems: Problem[], where: string, level: Problem['level'] = 'error'): Problem => {
  const p = problems.find((x) => x.at === where && x.level === level);
  if (!p) throw new Error('No ' + level + ' at ' + where + ' among: ' + JSON.stringify(problems, null, 1));
  return p;
};

describe('template: save', () => {
  it('keeps the structure, the band retarget makes, the beats and the contract, and nothing private', async () => {
    const t = pkg.template;
    expect(t.canvas).toEqual({ width: 720, height: 1280, fps: 30 });
    expect(t.shots.map((s) => [s.frames, s.in?.transition ?? 'cut', s.in?.frames ?? 0, s.source])).toEqual([[90, 'cut', 0, 'footage'], [110, 'cut', 0, 'picture'], [20, 'slide', 9, 'colour'], [80, 'dissolve', 13, 'picture']]);
    expect(t.captions?.beats).toEqual([{ start: 0, end: 60 }, { start: 60, end: 150 }, { start: 150, end: 210 }, { start: 215, end: 270 }, { start: 270, end: 300 }]);
    const direct = retarget({ measure, text, plan: colourFill(['a', 'b', 'c', 'd', 'e']) }).project?.tracks.find((x) => x.type === 'caption');
    expect(direct && 'box' in direct ? [direct.box, direct.style] : []).toEqual([t.captions?.box, t.captions?.style]);
    expect(t.source).toEqual({ label: 'hand-written reference', measure: expect.stringMatching(/^sha256:[0-9a-f]{16}$/) });
    const json = await readFile(path.join(dir, 'template.json'), 'utf8');
    expect(json).not.toContain('brand');
    expect(json).not.toContain('先说结论');
    expect(pkg.slots.shots.map((s) => [s.accepts.includes('card'), s.footage.frames])).toEqual([[true, 90], [true, 115], [false, 27], [true, 80]]);
    expect(pkg.slots.captions?.lines[1]).toMatchObject({ at: 'captions[1]', beat: [60, 150], seconds: 3, example: { text: '这个方法真的有用', chars: 8 } });
    expect(pkg.slots.voice.pace).toEqual({ charactersPerSecond: 4.3, language: 'zh' });
    const card = await readFile(path.join(dir, 'TEMPLATE.md'), 'utf8');
    expect(card).toContain('captions[1]');
    expect(card).toContain('Lists are matched by position');
    expect(roughTokens(card)).toBeLessThanOrEqual(600);
  });

  it('says that every shot takes a scene, and a check that works before the scenes exist', async () => {
    expect(pkg.slots.shots.map((s) => s.accepts[s.accepts.length - 1])).toEqual(['scene', 'scene', 'scene', 'scene']);
    const card = await readFile(path.join(dir, 'TEMPLATE.md'), 'utf8');
    expect(card).toContain('{"scene": "scenes/shot-01.html", "slots": {"title": "..."}}: every shot takes a scene');
    const lastRule = card.trim().split('\n').pop() ?? '';
    expect(lastRule).toMatch(/^- template check <this dir> --fill fill\.json checks the fill; template fill <this dir> --fill fill\.json --out <project> checks its files/);
    expect(lastRule).not.toContain('--assets');
    // A model is not told the commands (plan/prompt.ts leaves that line out of the card it sends).
    expect(planMessages({ card, slots: pkg.slots, brief: 'x', materials: [] })[1]?.content).not.toContain('template check');
  });

  it.skipIf(!chrome)('measures the caption capacity in the real band: right within one character for full-width text', () => {
    const c = pkg.template.captions;
    const cap = pkg.slots.captions?.capacity;
    const size = c?.style.size ?? 0;
    // Every CJK glyph advances by one em: whole characters per line of the box, times whole lines of 1.25 em.
    const perLine = Math.floor(((c?.box[2] ?? 0) * 720) / (size * 1280));
    const lines = Math.floor((c?.box[3] ?? 0) / (size * 1.25));
    console.log('capacity: CJK ' + cap?.cjk + ' (by hand ' + perLine * lines + ' = ' + lines + ' x ' + perLine + '), Latin ' + cap?.latin + ', ' + cap?.lines + ' lines, measured ' + cap?.measured);
    expect(cap?.measured).toBe(true);
    expect(Math.abs((cap?.cjk ?? 0) - perLine * lines)).toBeLessThanOrEqual(1);
    expect(cap?.lines).toBe(lines);
    expect(cap?.latin).toBeGreaterThan(1.5 * (cap?.cjk ?? 0));
    expect(cap?.latin).toBeLessThan(2.6 * (cap?.cjk ?? 0));
  });

  it('gives the same files when saved twice', async () => {
    const again = path.join(root, 'again');
    await saveTemplate(rt, { measure, text, transcript, name: 'test', label: 'hand-written reference', outDir: again });
    for (const f of ['template.json', 'slots.json', 'TEMPLATE.md']) expect(await readFile(path.join(again, f), 'utf8'), f).toBe(await readFile(path.join(dir, f), 'utf8'));
  });
});

describe('template: shots longer than a material can be', () => {
  it('cuts a long shot into equal parts with cuts of its own, and leaves the others and the transitions alone', () => {
    // Shots of 90, 110, 20 and 80 frames at 30 fps; at most 2 s (60 frames) each.
    const { measure: m, added } = splitLongShots(measure, 2);
    expect(added).toBe(3);
    expect(m.shots.map((s) => [s.index, s.start, s.end])).toEqual([[0, 0, 45], [1, 45, 90], [2, 90, 145], [3, 145, 200], [4, 200, 220], [5, 220, 260], [6, 260, 300]]);
    expect(m.boundaries.map((b) => [b.frame, b.kind, b.confidence])).toEqual([[45, 'cut', 0], [90, 'cut', 1], [145, 'cut', 0], [200, 'slide', 0.9], [220, 'dissolve', 0.8], [260, 'cut', 0]]);
    expect(splitLongShots(measure, 10)).toEqual({ measure, added: 0 });
  });
});

describe('template: checkFill', () => {
  it('accepts a fill that keeps to the contract', async () => {
    // Line 1 says a little of what the reference said in its beat (8 characters): a line of 1 would be a fragment.
    expect(await checkFill(rt, pkg, colourFill(['一', '方法有用', '三', '四', '五']))).toEqual([]);
  });

  it('names the slot, the limit and one fix for every rule', async () => {
    const cap = pkg.slots.captions?.capacity.cjk ?? 0;
    const long = '这一句话写得太长了'.repeat(5).slice(0, cap + 4);
    const p = await checkFill(rt, pkg, {
      shots: [{ keep: true }, { color: '#000000', picture: 'x.png' } as never, { card: { title: 'Hi' } }, { footage: 'clip.mp4', speed: 9 }],
      captions: ['一', long, '', '四', '五', '六'], extra: 1,
    } as RetargetPlan);
    expect(at(p, 'shots[0].keep').fix).toContain('footage');
    expect(at(p, 'shots[1]').message).toContain('this one has picture and color');
    expect(at(p, 'shots[2]').message).toContain('not card (a card needs at least 1 s');
    expect(at(p, 'shots[3].speed').message).toContain('0.25 to 4');
    expect(at(p, 'captions').message).toContain('6 caption lines; the template has 5 beats');
    expect(at(p, 'extra', 'warning').message).toContain('no key "extra"');
    const over = at(p, 'captions[1]');
    expect(over.message).toBe('Caption line 2 has ' + (cap + 4) + ' characters; this slot holds ' + cap + ' full-width characters (' + cap + ' full-width or ' + pkg.slots.captions?.capacity.latin + ' Latin, ' + pkg.slots.captions?.capacity.lines + ' lines of the caption band).');
    // The beat after it is empty, so the fix offers to move the end there.
    expect(over.fix).toMatch(/^Shorten it by \d+ or more characters, for example to ".+", or split it over two beats: move ".+" to captions\[2\]\.$/);
    const count = await checkFill(rt, pkg, { shots: colourFill().shots.slice(0, 3), captions: ['一'] });
    expect(at(count, 'shots').message).toBe('The fill has 3 shots; the template has 4. They are matched by position.');
    expect(at(count, 'captions', 'warning').message).toContain('The last 4 stay without a caption');
    const close = await checkFill(rt, pkg, { shots: [{ color: '#202020' }, { color: '#222222' }, { color: '#ffffff' }, { color: '#000000' }] });
    expect(at(close, 'shots[1].color').message).toContain('too close');
    // A card holds what retarget's card layout holds on this canvas, measured like the caption band.
    const card = pkg.slots.card;
    expect(card?.lines).toBeGreaterThanOrEqual(3);
    const cards = await checkFill(rt, pkg, { shots: [{ card: { title: '这是一个很长很长的标题', lines: Array.from({ length: (card?.lines ?? 0) + 1 }, () => '一行') } }, ...colourFill().shots.slice(1)] });
    expect(at(cards, 'shots[0].card.title').message).toBe('The title of the card in shot 1 has 11 characters; it holds ' + card?.title.cjk + ' full-width or ' + card?.title.latin + ' Latin characters on ' + card?.title.lines + ' line.');
    expect(at(cards, 'shots[0].card.lines').message).toContain('; ' + card?.lines + ' fit on the canvas');
  });

  it('takes a scene in any shot, checks its file in the project, and builds it as the shot\'s base', async () => {
    const project = path.join(root, 'with-scenes');
    await mkdir(path.join(project, 'scenes'), { recursive: true });
    await writeFile(path.join(project, 'scenes', 'a.html'), '<!doctype html><html><body><p data-slot="t">x</p></body></html>');
    // Shot 3 is 20 frames: too short for a card, not for a scene.
    const plan: RetargetPlan = { shots: [{ color: '#101010' }, { color: '#f0f0f0' }, { scene: 'scenes/a.html', slots: { t: 'new words' } }, { color: '#303080' }], captions: ['一', '方法有用', '三', '四', '五'] };
    expect(await checkFill(rt, pkg, plan, { dir: project })).toEqual([]);
    const wrong = await checkFill(rt, pkg, { ...plan, shots: [{ scene: 'scenes/gone.html' }, { scene: 'scenes/a.png' }, { scene: '../a.html' }, { scene: 'scenes/a.html', slots: { t: 1 } as never }] }, { dir: project });
    // A scene outside the project, slots that are not words, a missing file, a file that is not a page (it is missing too).
    expect(wrong.map((p) => p.at)).toEqual(['shots[2]', 'shots[3].slots', 'shots[0].scene', 'shots[1].scene']);
    await writeFile(path.join(project, 'scenes', 'a.png'), 'not a page');
    expect(at(await checkFill(rt, pkg, { ...plan, shots: [{ color: '#101010' }, { scene: 'scenes/a.png' }, ...plan.shots.slice(2)] }, { dir: project }), 'shots[1].scene').message).toBe('"scenes/a.png" is not an HTML file.');
    expect(at(wrong, 'shots[0].scene').message).toBe('"scenes/gone.html" does not exist in ' + project + '.');
    const r = await fillTemplate(rt, { templateDir: dir, fill: plan, outDir: project });
    expect(r.project?.segments[2]?.base).toEqual({ scene: 'scenes/a.html', slots: { t: 'new words' } });
    expect(r.project).toEqual(retarget({ measure, text, plan }).project);
  });

  it.skipIf(!ffmpeg)('probes footage: missing, and shorter than the slot needs', async () => {
    const assets = path.join(root, 'assets-check');
    await mkdir(assets, { recursive: true });
    // One second at 30 fps: shot 2 needs 115 frames (110 and half of the 9-frame push out of it).
    await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=30:duration=1', '-pix_fmt', 'yuv420p', path.join(assets, 'clip.mp4')]);
    const p = await checkFill(rt, pkg, { shots: [{ color: '#000000' }, { footage: 'clip.mp4', in: 10 }, { color: '#ffffff' }, { footage: 'gone.mp4' }] }, { dir: assets });
    const short = at(p, 'shots[1].footage');
    expect(short.message).toBe('Shot 2 needs 115 frames of footage (3.83 s at speed 1, the shot and half the transition after it), but "clip.mp4" has 30 frames (1.00 s at 30 fps): from frame 10 at speed 1 it runs out 95 source frames early and its last frame holds.');
    expect(short.fix).toBe('use a clip with at least 3.83 s after "in".');
    expect(at(p, 'shots[3].footage').message).toBe('"gone.mp4" does not exist in ' + assets + '.');
  });
  it.skipIf(!ffmpeg)('warns when cover would crop a picture or footage, or blow it up, with the numbers and the ways out', async () => {
    const assets = path.join(root, 'assets-fit');
    await mkdir(path.join(assets, 'assets'), { recursive: true });
    const make = (src: string, file: string, ...extra: string[]) => runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', src, ...extra, path.join(assets, 'assets', file)]);
    // A page-like picture wider than the 720x1280 canvas, on a light ground; one at the canvas's proportions; a small one.
    await make('color=c=0xf4f4f4:s=1280x800,drawbox=x=200:y=150:w=880:h=500:color=0x203060:t=fill', 'wide.png', '-frames:v', '1');
    const edgePixel = await runFfmpegOk(rt, ['-v', 'error', '-i', path.join(assets, 'assets', 'wide.png'), '-vf', 'crop=1:1:0:0,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1']);
    expect(edgePixel.stdout.length).toBe(3);
    const edge = '#' + [...edgePixel.stdout].map((v) => v.toString(16).padStart(2, '0')).join('');
    await make('color=c=0x203060:s=720x1280', 'tall.png', '-frames:v', '1');
    await make('testsrc=size=180x320:rate=30:duration=4', 'small.mp4', '-pix_fmt', 'yuv420p');
    await make('testsrc=size=1280x720:rate=30:duration=4', 'wide.mp4', '-pix_fmt', 'yuv420p');
    const fill: RetargetPlan = { shots: [{ picture: 'assets/wide.png' }, { footage: 'assets/small.mp4' }, { picture: 'assets/tall.png' }, { footage: 'assets/wide.mp4', fit: 'contain' }], captions: ['一', '二', '三', '四', '五'] };
    const p = await checkFill(rt, pkg, fill, { dir: assets });
    const crop = at(p, 'shots[0].fit', 'warning');
    expect(crop.message).toBe('"assets/wide.png" is 1280x800 in a 720x1280 shot: "cover" fills the shot and cuts 32% off its left and its right (65% of its width), with whatever text is there.');
    expect(crop.fix).toBe('Use material made at the canvas\'s proportions (9:16, for example 720x1280), or write "fit": "contain" to show it whole: it then leaves 32% of the shot above and below it on the default black ground, or add "ground": "' + edge + '", the colour along its edges, so that the bands join it.');
    const soft = at(p, 'shots[1].footage', 'warning');
    expect(soft.message).toBe('"assets/small.mp4" is 180x320 in a 720x1280 shot: "cover" shows it at 4.0 times its size, so it will look soft.');
    expect(soft.fix).toContain('at least 720x1280 pixels');
    // Material of the canvas's proportions is left alone; footage shown whole leaves a bare ground, which is said.
    expect(p.filter((x) => x.at.startsWith('shots[2]'))).toEqual([]);
    const bare = at(p, 'shots[3].fit', 'warning');
    expect(bare.message).toBe('"assets/wide.mp4" is 1280x720 in a 720x1280 shot: "contain" shows it whole and leaves 68% of the shot above and below it to the default black ground, a bare ground beside it.');
    expect(bare.fix).toBe('Design the shot instead: make it a scene that draws a ground and a frame, and show "assets/wide.mp4" in it as a video item in a box of its proportions (16:9, for example 1280x720) (video-scenes.md, "A screen inside a scene"); or use material made at the canvas\'s proportions (9:16, for example 720x1280).');
    expect(p.filter((x) => x.level === 'error')).toEqual([]);
    // A ground the fill gives is named instead of a suggestion; contain cuts nothing.
    const given = await checkFill(rt, pkg, { ...fill, shots: [{ picture: 'assets/wide.png', ground: '#ffffff' }, ...fill.shots.slice(1)] }, { dir: assets });
    expect(at(given, 'shots[0].fit', 'warning').fix).toContain('on its "ground" #ffffff.');
    const whole = await checkFill(rt, pkg, { ...fill, shots: [{ picture: 'assets/wide.png', fit: 'contain' }, ...fill.shots.slice(1)] }, { dir: assets });
    expect(whole.filter((x) => x.at.startsWith('shots[0]')).map((x) => x.message)).toEqual(['"assets/wide.png" is 1280x800 in a 720x1280 shot: "contain" shows it whole and leaves 65% of the shot above and below it to the default black ground, a bare ground beside it.']);
    expect(at(whole, 'shots[0].fit', 'warning').fix).toContain('as an image item in a box of its proportions (8:5, for example 1280x800)');
    // template fill says the same, and builds the project all the same.
    const r = await fillTemplate(rt, { templateDir: dir, fill, outDir: path.join(root, 'fit-project'), assetsDir: assets });
    expect(r.project).toBeDefined();
    expect(r.problems.map((x) => x.at)).toEqual(expect.arrayContaining(['shots[0].fit', 'shots[1].footage']));
  });
});

describe('template: fill', () => {
  it('equals retarget on the same inputs, and writes the template\'s structure on the fill\'s clock', async () => {
    const plan: RetargetPlan = { shots: [{ color: '#101010' }, { card: { title: 'Hello', lines: ['one line'] } }, { color: '#f0f0f0' }, { color: '#303080' }], captions: ['一', '二', '', '四'], captionColor: '#ffee00', note: 'a test' };
    const out = path.join(root, 'fill-equal');
    const r = await fillTemplate(rt, { templateDir: dir, fill: plan, outDir: out });
    expect(r.project).toBeDefined();
    expect(r.project).toEqual(retarget({ measure, text, plan }).project);
    expect(at(r.problems, 'captions', 'warning').message).toContain('4 caption lines');
    expect(JSON.parse(await readFile(path.join(out, 'video.json'), 'utf8'))).toEqual(r.project);
    const s = JSON.parse(await readFile(path.join(out, 'reference.measure.json'), 'utf8')) as Measure;
    expect(s.boundaries.map((b) => [b.kind, b.start, b.frame, b.end])).toEqual([['cut', 89, 90, 90], ['slide', 195, 200, 205], ['dissolve', 213, 220, 227]]);
  });

  it('equals retarget for a reference at 29.97 fps', async () => {
    const ntsc: Measure = { ...measure, source: { ...measure.source, fps: 29.97, duration: 300 / 29.97 } };
    const d = path.join(root, 'ntsc');
    await saveTemplate(rt, { measure: ntsc, text, name: 'ntsc', outDir: d });
    const plan = colourFill(['一', '二', '三', '四', '五']);
    const r = await fillTemplate(rt, { templateDir: d, fill: plan, outDir: path.join(root, 'ntsc-fill') });
    expect(r.project).toEqual(retarget({ measure: ntsc, text, plan }).project);
  });

  it.skipIf(!ffmpeg)('copies the fill\'s files from an assets directory and still equals retarget', async () => {
    const assets = path.join(root, 'assets-fill');
    await mkdir(path.join(assets, 'assets'), { recursive: true });
    // Large enough for the 720x1280 canvas: a smaller picture is blown up, and the check warns about it.
    await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=512x896:rate=30:duration=5', '-pix_fmt', 'yuv420p', path.join(assets, 'assets', 'clip.mp4')]);
    await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'color=c=red:size=512x896', '-frames:v', '1', path.join(assets, 'assets', 'pic.png')]);
    const plan: RetargetPlan = { shots: [{ footage: 'assets/clip.mp4', in: 3 }, { picture: 'assets/pic.png', zoom: 0.03 }, { color: '#2a9d8f' }, { footage: 'assets/clip.mp4', in: 30 }], captions: ['一', '方法有用', '三', '四', '五'] };
    const out = path.join(root, 'fill-files');
    const r = await fillTemplate(rt, { templateDir: dir, fill: plan, outDir: out, assetsDir: assets });
    // The picture fills 3.7 s of the 10 s: more than a third of the video, which the check says (a slide show); nothing else.
    expect(r.problems.map((p) => p.at + ' ' + p.level)).toEqual(['shots[1].picture warning']);
    expect(r.project).toEqual(retarget({ measure, text, plan }).project);
    expect((await readdir(path.join(out, 'assets'))).sort()).toEqual(['clip.mp4', 'pic.png']);
  });

  it.skipIf(!ffmpeg)('with speech, re-flows the beats as retarget does and writes the voice track', async () => {
    // A fake speaker: a tone of 0.2 s per character, made by ffmpeg; no model.
    const speaker: Speaker = {
      speak: async (line, out) => { await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=' + (0.2 * Array.from(line).length).toFixed(2), '-ac', '1', out]); },
    };
    const plan = colourFill(['一二三四五六', '一二三四五六七八九十', '', '一二三四', '一二']);
    const out = path.join(root, 'spoken');
    const r = await fillTemplate(rt, { templateDir: dir, fill: plan, outDir: out, speak: true, speaker });
    expect(r.problems.filter((p) => p.level === 'error')).toEqual([]);
    const want = [6, 10, 0, 4, 2].map((n) => Math.ceil(0.2 * n * 30));
    expect(r.spoken?.map((f, i) => Math.abs(f - (want[i] ?? 0)) <= 1)).toEqual([true, true, true, true, true]);
    const direct = retarget({ measure, text, plan: { ...plan, sound: 'assets/voice.m4a' }, spoken: { frames: r.spoken ?? [] }, wordsFile: 'assets/voice.words.json' });
    expect(r.project).toEqual(direct.project);
    // The words of the voice are written too: without a transcriber, every line's time is shared evenly among its words.
    const words = JSON.parse(await readFile(path.join(out, 'assets', 'voice.words.json'), 'utf8')) as { fps: number; tokens: { text: string; start: number; end: number; confidence: number }[] };
    expect(words.fps).toBe(30);
    expect(words.tokens).toHaveLength(6 + 10 + 4 + 2);
    expect(words.tokens.every((t, k) => t.end > t.start && (k === 0 || t.start >= (words.tokens[k - 1]?.end ?? 0)))).toBe(true);
    expect(r.project?.segments.map((s) => s.frames)).not.toEqual([90, 110, 20, 80]);
    expect(existsSync(path.join(out, 'assets', 'voice.m4a'))).toBe(true);
    const s = JSON.parse(await readFile(path.join(out, 'reference.measure.json'), 'utf8')) as Measure;
    expect(s.source.frames).toBe(direct.timing?.total);
    const starts = (direct.project?.segments ?? []).reduce<number[]>((acc, x) => [...acc, (acc[acc.length - 1] ?? 0) + (x.frames ?? 0)], [0]);
    expect(s.boundaries.map((b) => b.frame)).toEqual(starts.slice(1, -1));
  });

  it.skipIf(!ffmpeg)('uses the word times a speaker gives instead of guessing them', async () => {
    // A fake speaker that says the first character for 0.5 s and every other for 0.1 s, and reports those times
    // beside its clip, counted from 0.3 s (a speaker's clock need not start at the first sound).
    const speaker: Speaker = {
      speak: async (line, out) => {
        const chars = Array.from(line);
        await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=' + (0.5 + 0.1 * (chars.length - 1)).toFixed(2), '-ac', '1', out]);
        const words = chars.map((t, k) => ({ text: t, start: 0.3 + (k === 0 ? 0 : 0.5 + 0.1 * (k - 1)), end: 0.3 + 0.5 + 0.1 * k }));
        await writeFile(out + '.words.json', JSON.stringify({ words }));
      },
    };
    const out = path.join(root, 'spoken-words');
    const r = await fillTemplate(rt, { templateDir: dir, fill: colourFill(['一二三四', '五六', '', '七八九', '十']), outDir: out, speak: true, speaker });
    expect(r.problems.filter((p) => p.level === 'error')).toEqual([]);
    expect(r.notes.join(' ')).toContain("the speaker's own word times");
    const words = JSON.parse(await readFile(path.join(out, 'assets', 'voice.words.json'), 'utf8')) as { tokens: { text: string; start: number; end: number }[] };
    expect(words.tokens.map((t) => t.text).join('')).toBe('一二三四五六七八九十');
    // Line 1 starts at frame 0: its first character lasts 15 frames (0.5 s), the next ones 3 frames each.
    expect(words.tokens.slice(0, 4).map((t) => [t.start, t.end])).toEqual([[0, 15], [15, 18], [18, 21], [21, 24]]);
    expect((await readdir(path.join(out, 'assets', 'voice'))).some((f) => f.endsWith('.words.json'))).toBe(false);
  });

  it('refuses to fill with speech when no speaker is configured', async () => {
    const mute = { ...rt, env: { ...rt.env, POPOST_TTS_CMD: undefined } };
    const r = await fillTemplate(mute, { templateDir: dir, fill: colourFill(['一']), outDir: path.join(root, 'mute'), speak: true });
    expect(r.project).toBeUndefined();
    expect(at(r.problems, 'speak').fix).toContain('POPOST_TTS_CMD');
  });
});

describe.skipIf(!chrome || !ffmpeg)('template: swap tests (Chrome + ffmpeg)', () => {
  it('passes the short and at-capacity fills, refuses the one over capacity, and writes the evidence', async () => {
    const fills = generatedFills(pkg);
    expect(fills.map((f) => f.name)).toEqual(['short', 'at-capacity', 'over-capacity']);
    const e = await swapTest(rt, { templateDir: dir, fills, workDir: path.join(root, 'swap') });
    console.log(['fill            passed stage   structure transitions seconds', ...e.fills.map((f) => f.name.padEnd(16) + String(f.passed).padEnd(7) + f.stage.padEnd(8) + (f.scores ? f.scores.structure.toFixed(3).padStart(9) + f.scores.transitions.toFixed(3).padStart(12) : ' '.repeat(21)) + f.seconds.toFixed(1).padStart(8))].join('\n') + '\nall: ' + e.seconds.toFixed(1) + ' s');
    expect(e.fills.map((f) => [f.name, f.passed, f.stage])).toEqual([['short', true, 'done'], ['at-capacity', true, 'done'], ['over-capacity', false, 'check']]);
    expect(e.fills[2]?.problems[0]?.at).toBe('captions[0]');
    expect(e.fills[0]?.scores?.structure).toBeGreaterThanOrEqual(0.9);
    expect(JSON.parse(await readFile(path.join(dir, 'evidence.json'), 'utf8'))).toEqual(e);
  });
});
