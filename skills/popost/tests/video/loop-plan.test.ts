import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { askFill, extractJson, httpModel, listMaterials, lookTimes, materialLines, planMessages, seeShots, type ContentPart, type Message, type Model, type PlanMaterial } from '../../src/video/plan/index';
import { loadTemplate, saveTemplate, type TemplatePackage } from '../../src/video/template/index';
import type { Speaker } from '../../src/video/voice/index';
import { lineBudgets, measureVoicePace, PACE_SAMPLE, scriptOfLanguage } from '../../src/video/voice/pace';
import { spokenChars } from '../../src/video/retarget/pace';
import type { TextTrack } from '../../src/video/text/types';
import type { Measure } from '../../src/video/types';

const rt = await createDiskRuntime();
const ffmpeg = await hasFfmpeg(rt);

const still = { kind: 'static' as const, zoomPerS: 0, panPerS: [0, 0] as [number, number], confidence: 1 };
const shot = (index: number, start: number, end: number) => ({ index, start, end, camera: still, background: '#203040', palette: [{ hex: '#203040', share: 0.5 }], events: [] });
/** Three shots (90, 110 and 100 frames) joined by a cut and a dissolve, and three caption lines. */
const measure: Measure = {
  version: 1,
  source: { width: 720, height: 1280, fps: 30, frames: 300, duration: 10, hasAudio: true },
  boundaries: [{ frame: 90, kind: 'cut', start: 89, end: 90, confidence: 1 }, { frame: 200, kind: 'dissolve', start: 193, end: 207, confidence: 0.8 }],
  shots: [shot(0, 0, 90), shot(1, 90, 200), shot(2, 200, 300)],
  rhythm: { step: 3, change: Array.from({ length: 99 }, () => 0.1) },
  signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
};
const cue = (text: string, start: number, end: number) =>
  ({ text, start, end, box: [0.25, 0.825, 0.5, 0.05] as [number, number, number, number], role: 'caption' as const, size: 0.05, samples: 5, confidence: 0.95 });
const text: TextTrack = { step: 6, sampled: 50, cues: [cue('先说结论', 0, 90), cue('这个方法有用', 90, 200), cue('关注我', 200, 300)] };

let root = '';
let pkg: TemplatePackage;
let card = '';
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'loop-plan-'));
  const dir = path.join(root, 'template');
  await saveTemplate(rt, { measure, text, name: 'test', label: 'hand-written reference', outDir: dir });
  pkg = await loadTemplate(rt, dir);
  card = await readFile(path.join(dir, 'TEMPLATE.md'), 'utf8');
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); await rt.cleanup(); });

const materials: PlanMaterial[] = [
  { file: 'assets/tour.mp4', kind: 'footage', seconds: 12, frames: 360, fps: 30, width: 720, height: 1280, note: 'the home page, scrolling' },
  { file: 'assets/logo.png', kind: 'picture' },
];
const good = { shots: [{ footage: 'assets/tour.mp4', in: 0 }, { picture: 'assets/logo.png' }, { card: { title: '试试看' } }], captions: ['新的开头', '中间一句', '结尾'] };

/** A model that gives its answers in order and keeps what it was asked. */
const scripted = (answers: string[]): Model & { asked: Message[][] } => {
  const asked: Message[][] = [];
  return { name: 'scripted', asked, ask: async (messages) => { asked.push(messages.map((m) => ({ ...m }))); return { text: answers[asked.length - 1] ?? '', usage: { input: 100, output: 20 } }; } };
};

describe('plan: reading an answer', () => {
  it('finds the JSON object in a fence, after a sentence, after reasoning, and with braces inside strings', () => {
    expect(extractJson('```json\n{"shots": []}\n```').value).toEqual({ shots: [] });
    expect(extractJson('Here it is: {"captions": ["a } b", "c \\" {"]} Hope it helps.').value).toEqual({ captions: ['a } b', 'c " {'] });
    expect(extractJson('<think>maybe {"shots": 1}</think>{"shots": [2]}').value).toEqual({ shots: [2] });
    expect(extractJson('I cannot do that.').problem).toMatchObject({ level: 'error', at: '(answer)' });
    expect(extractJson('{"shots": [').problem?.message).toContain('no complete JSON object');
  });
});

describe('plan: the prompt', () => {
  it('holds the card, the materials, the brief and the exact counts, and nothing for a person at a terminal', () => {
    const [system, user] = planMessages({ card, slots: pkg.slots, brief: '介绍我们的新功能', materials, language: 'Chinese' });
    expect(system?.role).toBe('system');
    expect(system?.content).toContain('one JSON object and nothing else');
    const u = user?.content ?? '';
    expect(u).toContain('# Template: test');
    expect(u).toContain('- assets/tour.mp4: footage, 12 s (360 frames at 30 fps; "in" counts these frames), 720x1280. Shows: the home page, scrolling');
    expect(u).toContain('- assets/logo.png: picture');
    expect(u).toContain('介绍我们的新功能');
    expect(u).toContain('"shots": exactly 3 entries, for shots 0 1 2 in this order.');
    expect(u).toContain('"captions": exactly 3 strings, for beats 0 1 2 in this order');
    expect(u).toContain('written in Chinese');
    expect(u).not.toContain('template check');
    const none = planMessages({ card, slots: pkg.slots, brief: 'x', materials: [] })[1]?.content ?? '';
    expect(none).toContain('(none)');
    expect(none).toContain('obtain the required footage, illustrations or product pictures');
    expect(none).toContain('only for a reference graphic plate');
    expect(materialLines([{ file: 'a.mp4', kind: 'footage' }])).toEqual(['- a.mp4: footage']);
    // The card shows what each beat said, so the prompt does not list the beats again.
    expect(u).not.toContain('One line per beat');
  });

  it('lists every beat when the card had no room for them, and says what a spoken-only beat is', () => {
    const lines = pkg.slots.captions?.lines ?? [];
    const slots = { ...pkg.slots, captions: pkg.slots.captions ? { ...pkg.slots.captions, lines: lines.map((l, i) => (i === 1 ? { ...l, shown: false as const, unsure: true as const } : l)) } : undefined } as typeof pkg.slots;
    const terse = card.split('\n').filter((l) => !l.startsWith('## Beats') && !l.startsWith('- captions[')).join('\n');
    const u = planMessages({ card: terse, slots, brief: 'x', materials })[1]?.content ?? '';
    expect(u).toContain('## Beats');
    expect(u).toContain('One line per beat');
    expect(u).toContain('- captions[0] 3 s: "先说结论" (4)');
    expect(u).toMatch(/- captions\[1\] [\d.]+ s: "这个方法有用" \(6\) \(spoken only\) \(unsure\)/);
    expect(u).toContain('A beat marked "spoken only" is said by the voice and not drawn');
    expect(u).toContain('about as long as the source');
  });
});

describe('plan: asking a model', () => {
  it('takes a first answer that passes', async () => {
    const model = scripted([JSON.stringify(good)]);
    const r = await askFill(rt, { pkg, card, brief: 'x', model, materials });
    expect(r).toMatchObject({ fill: good, first: true, model: 'scripted' });
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]?.usage).toEqual({ input: 100, output: 20 });
    expect(model.asked).toHaveLength(1);
  });

  it('sends the problems back with their places and fixes, and takes the corrected answer', async () => {
    const short = { ...good, shots: good.shots.slice(0, 2) };
    const model = scripted(['Sure! ' + JSON.stringify(short), JSON.stringify(good)]);
    const r = await askFill(rt, { pkg, card, brief: 'x', model, materials });
    expect(r.fill).toEqual(good);
    expect(r.first).toBe(false);
    expect(r.attempts.map((a) => a.problems.filter((p) => p.level === 'error').length)).toEqual([1, 0]);
    const second = model.asked[1] ?? [];
    expect(second.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(second[3]?.content).toContain('The answer has 1 problem.');
    expect(second[3]?.content).toContain('- shots: The fill has 2 shots; the template has 3.');
    expect(second[3]?.content).toContain('Fix: Add 1 more');
  });

  it('refuses a file that is not among the materials, and a picture used as footage', async () => {
    const invented = { ...good, shots: [{ footage: 'assets/demo.mp4' }, { footage: 'assets/logo.png' }, good.shots[2]] };
    const model = scripted([JSON.stringify(invented), JSON.stringify(good)]);
    const r = await askFill(rt, { pkg, card, brief: 'x', model, materials });
    expect(r.attempts[0]?.problems.map((p) => [p.at, p.message])).toEqual([
      ['shots[0].footage', '"assets/demo.mp4" is not among the materials.'],
      ['shots[1].footage', '"assets/logo.png" is a picture, not a footage.'],
    ]);
    expect(r.attempts[0]?.problems[0]?.fix).toContain('assets/tour.mp4');
    expect(r.fill).toEqual(good);
  });

  it('gives no fill when no answer passes, and stops at the limit', async () => {
    const model = scripted(['no', '{"shots": "three"}', '{"shots": []}', JSON.stringify(good)]);
    const r = await askFill(rt, { pkg, card, brief: 'x', model, materials, attempts: 3 });
    expect(r.fill).toBeUndefined();
    expect(r.first).toBe(false);
    expect(r.attempts.map((a) => a.problems[0]?.at)).toEqual(['(answer)', 'shots', 'shots']);
    expect(model.asked).toHaveLength(3);
  });
});

describe('plan: lines the voice can say in their beat', () => {
  it('shows every line its limit, refuses a longer one before anything is spoken, and takes the shorter answer', async () => {
    // Beats of 3, 3.67 and 3.33 s; a voice of 2 characters a second: 6, 7 and 6 characters.
    const budgets = { max: lineBudgets((pkg.slots.captions?.lines ?? []).map((l) => l.seconds), 2), pace: 2 };
    expect(budgets.max).toEqual([6, 7, 6]);
    const long = { ...good, captions: ['这一句话实在是太长了', '中间一句', '结尾'] };
    const model = scripted([JSON.stringify(long), JSON.stringify(good)]);
    const r = await askFill(rt, { pkg, card, brief: 'x', model, materials, budgets });
    expect(r.attempts[0]?.problems).toHaveLength(1);
    expect(r.attempts[0]?.problems[0]).toMatchObject({ level: 'error', at: 'captions[0]' });
    expect(r.attempts[0]?.problems[0]?.message).toBe('The line has 10 characters; beat 0 lasts 3 s and the voice says about 2 a second, so it holds 6.');
    expect(r.fill).toEqual(good);
    const asked = model.asked[0]?.[1]?.content ?? '';
    expect(asked).toContain('## Limits of the lines');
    expect(asked).toContain('- captions[0] 3 s, at most 6 characters: "先说结论" (4)');
    expect(asked).toContain('Every line has its own limit');
    expect(asked).not.toContain('about as long as the source');
    // One character over a budget of 6 is within the slack; punctuation and spaces are not counted.
    const near = await askFill(rt, { pkg, card, brief: 'x', model: scripted([JSON.stringify({ ...good, captions: ['一二三，四五 六。', '中间一句', '结尾'] })]), materials, budgets });
    expect(near.first).toBe(true);
  });

  it.skipIf(!ffmpeg)('times a voice once: characters a second from a few short lines spoken one by one, kept in a file', async () => {
    let spoken = 0;
    // A fake voice: 0.25 s a character, so 4 characters a second.
    const speaker: Speaker = { speak: async (line, out) => { spoken++; await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=' + (0.25 * spokenChars(line).length).toFixed(2), '-ac', '1', out]); } };
    const cacheFile = path.join(root, 'pace', 'voice-pace.json');
    const pace = await measureVoicePace(rt, { speaker, voice: 'tone', script: 'cjk', cacheFile });
    expect(pace).toBeGreaterThan(3.8);
    expect(pace).toBeLessThan(4.2);
    expect(await measureVoicePace(rt, { speaker, voice: 'tone', script: 'cjk', cacheFile })).toBe(pace);
    expect(spoken).toBe(PACE_SAMPLE.cjk.length);
    await measureVoicePace(rt, { speaker, voice: 'tone', speed: 1.2, script: 'cjk', cacheFile });
    expect(spoken).toBe(2 * PACE_SAMPLE.cjk.length);
    expect(PACE_SAMPLE.cjk.every((l) => spokenChars(l).length <= 12)).toBe(true);
    expect([scriptOfLanguage('Chinese', ''), scriptOfLanguage('Mexican Spanish', '你好'), scriptOfLanguage(undefined, '介绍我们的提示词库 Popost'), scriptOfLanguage(undefined, 'a new tool')]).toEqual(['cjk', 'latin', 'cjk', 'latin']);
  });
});

describe('plan: shots filled by words', () => {
  const generate = { minSeconds: 5, maxSeconds: 5, images: ['assets/product.png'] };
  const wordy = { shots: [{ generate: 'a woman holds @image1 up to the camera, bright kitchen' }, { picture: 'assets/logo.png' }, { generate: 'close-up of @image1 on a table, slow push-in' }], captions: ['新的开头', '中间一句', '结尾'] };

  it('turns a "generate" shot into footage that is still to be made, with a request the program sized', async () => {
    const model = scripted([JSON.stringify(wordy)]);
    const r = await askFill(rt, { pkg, card, brief: 'x', model, materials, generate });
    expect(r.first).toBe(true);
    // Shot 1 is 3 s: a 5 s clip at speed 1. Shot 3 is 3.33 s plus half its transition: the same.
    expect(r.fill?.shots).toEqual([{ footage: 'assets/gen-01.mp4', in: 0 }, { picture: 'assets/logo.png' }, { footage: 'assets/gen-03.mp4', in: 0 }]);
    expect(r.requests).toEqual([
      { file: 'assets/gen-01.mp4', prompt: 'a woman holds @image1 up to the camera, bright kitchen', seconds: 5, aspect: '9:16', images: ['assets/product.png'] },
      { file: 'assets/gen-03.mp4', prompt: 'close-up of @image1 on a table, slow push-in', seconds: 5, aspect: '9:16', images: ['assets/product.png'] },
    ]);
    const asked = model.asked[0]?.[1]?.content ?? '';
    expect(asked).toContain('A shot may also be {"generate": "..."}');
    expect(asked).toContain('The product is the picture @image1');
  });

  it('shows the product to the model that writes the fill', async () => {
    const model = scripted([JSON.stringify(wordy)]);
    await askFill(rt, { pkg, card, brief: 'x', model, materials, generate, productPictures: ['data:image/jpeg;base64,AAAA'] });
    const user = model.asked[0]?.[1];
    const content = user && Array.isArray(user.content) ? user.content : [];
    expect(content.map((p) => p.type)).toEqual(['text', 'image_url']);
    expect((content[0] as { text: string }).text).toContain('The 1 picture below shows the product (@image1). Look at it before you write');
    expect((content[0] as { text: string }).text).toContain('# Template: test');
  });

  it('plays a clip slower when the shot is longer, and refuses a shot no clip can cover', async () => {
    const slow = await askFill(rt, { pkg, card, brief: 'x', model: scripted([JSON.stringify(wordy)]), materials, generate: { minSeconds: 2, maxSeconds: 2 } });
    expect((slow.fill?.shots[0] as { speed?: number }).speed).toBe(0.66);
    expect(slow.requests?.[0]?.seconds).toBe(2);
    const short = await askFill(rt, { pkg, card, brief: 'x', model: scripted([JSON.stringify(wordy), JSON.stringify(good)]), materials, generate: { minSeconds: 1, maxSeconds: 1 } });
    expect(short.attempts[0]?.problems[0]).toMatchObject({ level: 'error', at: 'shots[0].generate' });
    expect(short.attempts[0]?.problems[0]?.message).toContain('even at half speed it would run out');
    expect(short.fill).toEqual(good);
    const empty = await askFill(rt, { pkg, card, brief: 'x', model: scripted([JSON.stringify({ ...wordy, shots: [{ generate: ' ' }, wordy.shots[1], { generate: 'x', color: '#000' }] })]), materials, generate, attempts: 1 });
    expect(empty.attempts[0]?.problems.map((p) => p.at)).toEqual(['shots[0].generate', 'shots[2]']);
  });

  it('does not know "generate" unless it was allowed, and shows the notes on what the source showed', async () => {
    const off = await askFill(rt, { pkg, card, brief: 'x', model: scripted([JSON.stringify(wordy)]), materials, attempts: 1 });
    expect(off.fill).toBeUndefined();
    const u = planMessages({ card, slots: pkg.slots, brief: 'x', materials: [], generate: { product: false }, shotNotes: ['a woman talks to the camera', 'the product on a table', 'she waves'] })[1]?.content ?? '';
    expect(u).toContain('## What the source showed\n\n- shots[0]: a woman talks to the camera\n- shots[1]: the product on a table');
    expect(u).toContain('use "generate" for shots that need footage');
    expect(u).toContain('only where the reference itself uses a graphic plate');
    expect(u).not.toContain('@image1');
  });
});

describe.skipIf(!ffmpeg)('plan: what each shot shows', () => {
  let video = '';
  beforeAll(async () => {
    video = path.join(root, 'see.mp4');
    await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=4', '-pix_fmt', 'yuv420p', video]);
  });
  const shots = [{ start: 0, end: 1 }, { start: 1, end: 2.5 }, { start: 2.5, end: 4 }];
  const parts = (m: Message | undefined): ContentPart[] => (m && Array.isArray(m.content) ? m.content : []);

  it('looks inside a shot, away from its ends', () => {
    expect(lookTimes(2, 4, 3)).toEqual([2.5, 3, 3.5]);
    expect(lookTimes(0, 1, 1)).toEqual([0.5]);
  });

  it('sends a few small frames of every shot and takes one sentence for each, in batches', async () => {
    const model = scripted(['{"shots": ["a test card  with bars", "the same card"]}', '{"shots": ["the card again"]}']);
    const r = await seeShots(rt, { video, shots, model, framesPerShot: 2, maxSide: 96, batch: 2 });
    expect(r).toMatchObject({ notes: ['a test card with bars', 'the same card', 'the card again'], problems: [], requests: 2, usage: { input: 200, output: 40 } });
    const first = parts(model.asked[0]?.[0]);
    expect(first.map((p) => p.type)).toEqual(['text', 'text', 'image_url', 'image_url', 'text', 'image_url', 'image_url']);
    expect(first[0]).toMatchObject({ type: 'text' });
    expect((first[0] as { text: string }).text).toContain('exactly 2 strings, for shots 0 to 1 in order');
    expect((first[1] as { text: string }).text).toBe('Shot 0 (1.0 s):');
    const picture = (first[2] as { image_url: { url: string } }).image_url.url;
    expect(picture.startsWith('data:image/jpeg;base64,/9j/')).toBe(true);
    expect(picture.length).toBeLessThan(20_000);
    expect((parts(model.asked[1]?.[0])[1] as { text: string }).text).toBe('Shot 2 (1.5 s):');
  });

  it('asks once more when the count is wrong, and says which shots stay unread', async () => {
    const again = await seeShots(rt, { video, shots, model: scripted(['{"shots": ["only one"]}', '{"shots": ["a", "b", "c"]}']), framesPerShot: 1, maxSide: 64 });
    expect(again).toMatchObject({ notes: ['a', 'b', 'c'], requests: 2 });
    const never = await seeShots(rt, { video, shots, model: scripted(['no', 'still no']), framesPerShot: 1, maxSide: 64 });
    expect(never.notes).toEqual(['', '', '']);
    expect(never.problems[0]).toMatchObject({ level: 'error', at: 'shots[0-2]' });
    expect(never.problems[0]?.message).toContain('the model gave 0 sentences for 3 shots');
  });
});

describe('plan: the HTTP model', () => {
  // The model is reached through the runtime's fetch: here the real one, to a server on this machine.
  const net = { ...rt, fetch: globalThis.fetch };
  let server: Server;
  let url = '';
  const seen: { auth: string; body: { model?: string; response_format?: unknown; messages?: unknown[] } }[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (d: Buffer) => { raw += d.toString('utf8'); });
      req.on('end', () => {
        const auth = req.headers.authorization ?? '';
        seen.push({ auth, body: JSON.parse(raw) as { model?: string } });
        if (req.url !== '/v1/chat/completions') { res.writeHead(404).end('not here'); return; }
        if (auth !== 'Bearer test-key-123') { res.writeHead(401).end('bad key: ' + auth); return; }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: '{"ok": true}' } }], usage: { prompt_tokens: 12, completion_tokens: 5 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1/';
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });

  it('posts the messages with the key and reads the text and the usage', async () => {
    const reply = await httpModel(net, { url, model: 'small', key: 'test-key-123' }).ask([{ role: 'user', content: 'hi' }]);
    expect(reply).toEqual({ text: '{"ok": true}', usage: { input: 12, output: 5 } });
    expect(seen[seen.length - 1]).toMatchObject({ auth: 'Bearer test-key-123', body: { model: 'small', response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'hi' }] } });
    await httpModel(net, { url, model: 'small', key: 'test-key-123', json: false, body: { thinking: { type: 'disabled' } } }).ask([]);
    expect(seen[seen.length - 1]?.body.response_format).toBeUndefined();
    expect(seen[seen.length - 1]?.body).toMatchObject({ thinking: { type: 'disabled' } });
  });

  it('never shows the key in an error', async () => {
    const wrong = httpModel(net, { url, model: 'small', key: 'wrong-key-999' });
    await expect(wrong.ask([])).rejects.toThrow('The model endpoint answered 401: bad key: Bearer ***');
    await expect(wrong.ask([])).rejects.not.toThrow(/wrong-key-999/);
  });
});

describe.skipIf(!ffmpeg)('plan: materials of a directory', () => {
  it('lists footage with its length and pictures, with the notes of materials.json', async () => {
    const dir = path.join(root, 'assets-root');
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=90x160:rate=30:duration=2', '-pix_fmt', 'yuv420p', path.join(dir, 'assets', 'tour.mp4')]);
    await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'color=c=red:size=40x40', '-frames:v', '1', path.join(dir, 'assets', 'logo.png')]);
    await writeFile(path.join(dir, 'assets', 'notes.txt'), 'not a material');
    await writeFile(path.join(dir, 'materials.json'), JSON.stringify({ 'assets/tour.mp4': 'a test pattern' }));
    expect(await listMaterials(rt, dir)).toEqual([
      { file: 'assets/logo.png', kind: 'picture' },
      { file: 'assets/tour.mp4', kind: 'footage', seconds: 2, frames: 60, fps: 30, width: 90, height: 160, note: 'a test pattern' },
    ]);
  });
});
