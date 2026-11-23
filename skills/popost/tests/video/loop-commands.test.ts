/**
 * The loop's commands of `popost video` run through the CLI: template save, show, check, fill, see and test, plan,
 * materials, retarget and readback, each reading its JSON. The reference is written by hand (a measurement and caption
 * cues); the model behind plan and template see is a stub behind the runtime's fetch; the generator and the text reader
 * are small Node scripts that keep the contracts of the tools in skills/popost/tools/video/. Commands that decode or
 * render skip without ffmpeg or Chrome.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome, type DiskRuntime } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import type { TextTrack } from '../../src/video/text/types';
import type { Measure, Project } from '../../src/video/types';

/** What the stub model answers next, in order; each request takes one. */
const answers: string[] = [];
const asked: { model?: string; messages?: unknown[] }[] = [];
const model = (request: Request): Promise<Response> =>
  request.json().then((body: { model?: string; messages?: unknown[] }) => {
    asked.push(body);
    return new Response(JSON.stringify({ choices: [{ message: { content: answers.shift() ?? '' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { headers: { 'content-type': 'application/json' } });
  });

const rt: DiskRuntime = await createDiskRuntime({ fetchHandler: model });
afterAll(() => rt.cleanup());
const ffmpeg = await hasFfmpeg(rt);
const chrome = hasChrome();
const json = () => rt.json();
const at = (p: string): string => rt.path.join(rt.dir, p);
const read = (p: string): Promise<string> => rt.fs.readText(at(p));
const put = (p: string, data: string | Uint8Array): Promise<void> => rt.fs.writeFile(at(p), data);
const withEnv = (env: Record<string, string | undefined>): DiskRuntime => ({ ...rt, env: { ...rt.env, ...env } });
const LLM = { POPOST_LLM_URL: 'http://model.invalid/v1', POPOST_LLM_MODEL: 'stub' };

const still = { kind: 'static' as const, zoomPerS: 0, panPerS: [0, 0] as [number, number], confidence: 1 };
const shot = (index: number, start: number, end: number) => ({ index, start, end, camera: still, background: '#203040', palette: [{ hex: '#203040', share: 0.5 }], events: [] });
/** Four shots of 90, 110, 20 and 80 frames at 30 fps, and five caption lines: the reference loop-template.test.ts uses. */
const measure: Measure = {
  version: 1,
  source: { width: 720, height: 1280, fps: 30, frames: 300, duration: 10, hasAudio: false },
  boundaries: [
    { frame: 90, kind: 'cut', start: 89, end: 90, confidence: 1 },
    { frame: 200, kind: 'slide', start: 195, end: 205, direction: 'left', mode: 'push', confidence: 0.9 },
    { frame: 220, kind: 'dissolve', start: 213, end: 227, confidence: 0.8 },
  ],
  shots: [shot(0, 0, 90), shot(1, 90, 200), shot(2, 200, 220), shot(3, 220, 300)],
  rhythm: { step: 3, change: Array.from({ length: 99 }, (_x, k) => (k * 3 < 90 ? 0.12 : 0.004)) },
  signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
};
const cue = (text: string, start: number, end: number) => ({ text, start, end, box: [0.25, 0.825, 0.5, 0.05] as [number, number, number, number], role: 'caption' as const, size: 0.05, samples: 5, confidence: 0.95 });
const text: TextTrack = { step: 6, sampled: 50, cues: [cue('先说结论', 0, 60), cue('这个方法真的有用', 60, 150), cue('第三句', 150, 210), cue('第四句话', 215, 270), cue('关注我', 270, 300)] };

/** A fill written by hand for a project the agent builds up: a scene, a picture, a colour and a card. */
const handFill = (captions: string[]) => ({ shots: [{ scene: 'scenes/shot-01.html' }, { picture: 'assets/pic.png', zoom: 0.03 }, { color: '#2a9d8f' }, { card: { title: '试试看' } }], captions });
const SCENE = '<!doctype html><html><head><meta charset="utf-8"></head><body><h1 data-slot="title">标题</h1></body></html>\n';

beforeAll(async () => {
  await put('ref/measure.json', JSON.stringify(measure));
  await put('ref/text.json', JSON.stringify(text));
});

describe('popost video template', () => {
  it('save writes a template from a described reference, and says what to run next', async () => {
    expect((await runCli(rt, ['video', 'template', 'save', 'ref', '--out', 'tpl', '--name', 'demo'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, dir: at('tpl'), files: ['template.json', 'slots.json', 'TEMPLATE.md'], shots: 4, beats: 5, errors: 0, next: 'popost video template show ' + at('tpl') });
    expect((await runCli(rt, ['video', 'template', 'save', 'nowhere', '--out', 'x', '--name', 'x'])).code).toBe(2);
    expect(String(json().error)).toContain('Run: popost video describe <video> --out ');
  });

  it('show prints the card and the slots; a directory that is not a template is refused with exit code 2', async () => {
    expect((await runCli(rt, ['video', 'template', 'show', 'tpl'])).code).toBe(0);
    expect(String(json().card)).toContain('# Template: demo');
    expect((json().slots as { shots: unknown[] }).shots).toHaveLength(4);
    expect((await runCli(rt, ['video', 'template', 'show', 'ref'])).code).toBe(2);
    expect(String(json().error)).toContain('No template.json at');
  });

  it('check reports every problem of a hand-written fill with its fix, and the text the repair loop sends a model', async () => {
    await put('bad.json', JSON.stringify({ shots: [{ color: '#000000' }], captions: ['一'] }));
    expect((await runCli(rt, ['video', 'template', 'check', 'tpl', '--fill', 'bad.json'])).code).toBe(2);
    expect(json()).toMatchObject({ ok: false, errors: 1 });
    expect((json().problems as { at: string; fix?: string }[]).find((p) => p.at === 'shots')?.fix).toContain('Add 3 more entries');
    expect(String(json().repair)).toMatch(/^The answer has 1 problem\. Correct it, change nothing else/);
    // Held to a voice of 2 characters a second, the second line (3 s) holds 6.
    await put('long.json', JSON.stringify({ shots: [{ color: '#000000' }, { color: '#ffffff' }, { color: '#2a9d8f' }, { color: '#f4a261' }], captions: ['一', '这一行写得实在太长了吧', '三', '四', '五'] }));
    expect((await runCli(rt, ['video', 'template', 'check', 'tpl', '--fill', 'long.json'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, filesChecked: false });
    expect((await runCli(rt, ['video', 'template', 'check', 'tpl', '--fill', 'long.json', '--pace', '2'])).code).toBe(2);
    expect((json().problems as { at: string }[]).map((p) => p.at)).toEqual(['captions[1]']);
  });

  it('fill builds the project inside the directory the agent builds up, leaves its files alone, and runs again after a change', async () => {
    await put('project/assets/pic.png', 'a picture the agent made');
    await put('project/scenes/shot-01.html', SCENE);
    await put('fill.json', JSON.stringify(handFill(['一', '二', '三', '四', '五'])));
    // The fill's files are looked for in the project itself when --assets is not given.
    await put('lost.json', JSON.stringify({ ...handFill(['一']), shots: [{ scene: 'scenes/gone.html' }, ...handFill([]).shots.slice(1)] }));
    expect((await runCli(rt, ['video', 'template', 'fill', 'tpl', '--fill', 'lost.json', '--out', 'project'])).code).toBe(2);
    expect((json().problems as { at: string; message: string }[]).find((p) => p.at === 'shots[0].scene')?.message).toBe('"scenes/gone.html" does not exist in ' + at('project') + '.');
    expect(await rt.fs.stat(at('project/video.json'))).toBeNull();
    expect((await runCli(rt, ['video', 'template', 'fill', 'tpl', '--fill', 'fill.json', '--out', 'project'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, dir: at('project'), project: at('project/video.json'), written: ['video.json', 'reference.measure.json', 'reference.facts.json'], segments: 4 });
    const first = JSON.parse(await read('project/video.json')) as Project;
    expect(first.segments.map((s) => s.base)).toMatchObject([{ scene: 'scenes/shot-01.html' }, { material: 'image-1' }, { color: '#2a9d8f' }, {}]);
    // A caption changed: the project follows, the agent's files stay as they were.
    await put('fill.json', JSON.stringify(handFill(['新的一', '二', '三', '四', '五'])));
    expect((await runCli(rt, ['video', 'template', 'fill', 'tpl', '--fill', 'fill.json', '--out', 'project'])).code).toBe(0);
    const again = await read('project/video.json');
    expect(again).toContain('新的一');
    expect(await read('project/scenes/shot-01.html')).toBe(SCENE);
    expect(await read('project/assets/pic.png')).toBe('a picture the agent made');
    expect((await rt.fs.readdir(at('project'))).sort()).toEqual(['assets', 'reference.facts.json', 'reference.measure.json', 'scenes', 'video.json']);
  });

  it('check and fill look at the paths a fill gives the picture places of a scene: relative to the scene file', async () => {
    const logo = '<!doctype html><html><head><meta charset="utf-8"></head><body><h1 data-slot="title">标题</h1><img data-slot="logo" src="../assets/pic.png"></body></html>\n';
    await put('slotted/assets/pic.png', 'a picture the agent made');
    await put('slotted/scenes/shot-01.html', logo);
    const withLogo = (path: string) => ({ ...handFill(['一', '二', '三', '四', '五']), shots: [{ scene: 'scenes/shot-01.html', slots: { title: '新', logo: path } }, ...handFill([]).shots.slice(1)] });
    type Report = { problems: { at: string; message: string; fix: string }[] };
    const slotProblem = (): Report['problems'][number] | undefined => (json() as Report).problems.find((p) => p.at === 'shots[0].slots.logo');
    // Written from the project directory: the picture is there, but the path starts from scenes/.
    await put('slot-fill.json', JSON.stringify(withLogo('assets/pic.png')));
    expect((await runCli(rt, ['video', 'template', 'check', 'tpl', '--fill', 'slot-fill.json', '--assets', 'slotted'])).code).toBe(2);
    expect(slotProblem()?.message).toBe('"assets/pic.png", the picture of the place "logo" in scenes/shot-01.html, does not exist: the path of a picture place is relative to the scene file (the folder scenes/), so it names "scenes/assets/pic.png" in ' + at('slotted') + '.');
    expect(slotProblem()?.fix).toBe('Write "../assets/pic.png": the picture is at "assets/pic.png" in the project, and the path starts from the folder scenes/.');
    expect((await runCli(rt, ['video', 'template', 'fill', 'tpl', '--fill', 'slot-fill.json', '--out', 'slotted'])).code).toBe(2);
    expect(slotProblem()?.at).toBe('shots[0].slots.logo');
    await put('slot-fill.json', JSON.stringify(withLogo('../assets/nothere.png')));
    expect((await runCli(rt, ['video', 'template', 'check', 'tpl', '--fill', 'slot-fill.json', '--assets', 'slotted'])).code).toBe(2);
    expect(slotProblem()?.fix).toContain('Put the picture at ' + at('slotted/assets/nothere.png'));
    // The right path passes, and a fill from --assets copies the picture into the project with the scene.
    await put('slot-fill.json', JSON.stringify(withLogo('../assets/pic.png')));
    expect((await runCli(rt, ['video', 'template', 'check', 'tpl', '--fill', 'slot-fill.json', '--assets', 'slotted'])).code).toBe(0);
    expect((await runCli(rt, ['video', 'template', 'fill', 'tpl', '--fill', 'slot-fill.json', '--assets', 'slotted', '--out', 'slotted-copy'])).code).toBe(0);
    expect(await read('slotted-copy/assets/pic.png')).toBe('a picture the agent made');
  });

  it.skipIf(!ffmpeg)('see asks the model what each shot shows and writes shots.txt', async () => {
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=90x160:rate=30:duration=10', '-pix_fmt', 'yuv420p', at('ref.mp4')]);
    expect((await runCli(rt, ['video', 'template', 'see', 'tpl', '--video', 'ref.mp4'])).code).toBe(2);
    expect(String(json().error)).toContain('No model is configured');
    answers.push(JSON.stringify({ shots: ['a test card', 'the same card', 'a flash', 'the card again'] }));
    expect((await runCli(withEnv(LLM), ['video', 'template', 'see', 'tpl', '--video', 'ref.mp4'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, model: 'stub', file: at('tpl/shots.txt'), shots: 4, read: 4, requests: 1 });
    expect(await read('tpl/shots.txt')).toBe('a test card\nthe same card\na flash\nthe card again\n');
  });

  it.skipIf(!ffmpeg || !chrome)('test runs the swap tests in the work directory and writes the evidence', async () => {
    expect((await runCli(rt, ['video', 'template', 'test', 'tpl'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, evidence: at('tpl/evidence.json'), work: at('.popost/video/template-test/demo'), passed: 2, fills: 3 });
    expect((json().results as { name: string; stage: string }[]).map((f) => [f.name, f.stage])).toEqual([['short', 'done'], ['at-capacity', 'done'], ['over-capacity', 'check']]);
  });
});

describe('popost video plan', () => {
  const good = { shots: [{ picture: 'assets/pic.png' }, { color: '#1d3557' }, { color: '#f4a261' }, { card: { title: '试试看' } }], captions: ['一', '二', '三', '四', '五'] };

  it('--dry prints everything needed to write the fill by hand: slots, limits, budgets, rules, materials and the request', async () => {
    expect((await runCli(rt, ['video', 'plan', 'tpl', '--brief', '介绍新功能', '--assets', 'project', '--pace', '4', '--dry'])).code).toBe(0);
    const d = json();
    expect(d).toMatchObject({ ok: true, dry: true, template: at('tpl'), brief: '介绍新功能', answer: { shots: 4, captions: 5 } });
    expect((d.slots as { captions: { capacity: { cjk: number } } }).captions.capacity.cjk).toBeGreaterThan(0);
    expect((d.budgets as { pace: number; lines: { at: string; max: number }[] }).lines[1]).toEqual({ at: 'captions[1]', seconds: 3, max: 12 });
    expect(d.rules as string[]).toContain('- "shots": exactly 4 entries, for shots 0 1 2 3 in this order.');
    expect(d.materials).toEqual([{ file: 'assets/pic.png', kind: 'picture' }]);
    expect(Object.keys(d.forms as object)).toEqual(['footage', 'picture', 'color', 'card', 'scene']);
    expect((d.messages as { role: string }[]).map((m) => m.role)).toEqual(['system', 'user']);
    expect(String(d.next)).toContain('popost video template fill ' + at('tpl') + ' --fill <fill.json> --out <project-dir> --assets ' + at('project') + ' --pace 4');
    expect(d.rules as string[]).toContain('- Write "shots" and "captions" only. Leave out "voice", "speed" and every other optional key unless the brief gives its exact value.');
  });

  it('--dry --voice tells the writer to put the voice into the fill, which template fill --speak reads from it', async () => {
    expect((await runCli(rt, ['video', 'plan', 'tpl', '--brief', '介绍新功能', '--pace', '4', '--voice', 'v1', '--dry'])).code).toBe(0);
    const d = json();
    expect(d.answer).toEqual({ shots: 4, captions: 5, voice: 'v1' });
    expect(d.rules as string[]).toContain('- Write "shots", "captions" and "voice": "v1", exactly so: template fill --speak speaks the lines with that voice. Leave out "speed" and every other optional key unless the brief gives its exact value.');
    expect(String((d.messages as { content: string }[])[1]?.content)).toContain('{"shots": [...], "captions": [...], "voice": "v1"}');
    expect((await runCli(rt, ['video', 'plan', 'tpl', '--brief', '介绍新功能', '--pace', '4', '--voice', 'v1', '--speed', '1.1', '--dry'])).code).toBe(0);
    expect(json().answer).toEqual({ shots: 4, captions: 5, voice: 'v1', speed: 1.1 });
    expect((json().rules as string[]).find((r) => r.startsWith('- Write "shots"'))).toContain('"voice": "v1" and "speed": 1.1, exactly so');
  });

  it('asks the configured model, sends the problems back, and writes the fill that passes with its attempts', async () => {
    expect((await runCli(rt, ['video', 'plan', 'tpl', '--brief', 'x'])).code).toBe(2);
    expect(String(json().error)).toContain('or use --dry');
    answers.push(JSON.stringify({ ...good, shots: good.shots.slice(0, 3) }), JSON.stringify(good));
    expect((await runCli(withEnv(LLM), ['video', 'plan', 'tpl', '--brief', 'x', '--assets', 'project', '--out', 'planned.json', '--voice', 'v1'])).code).toBe(2);
    expect(String(json().error)).toContain('--voice times the voice');
    expect((await runCli(withEnv(LLM), ['video', 'plan', 'tpl', '--brief', 'x', '--assets', 'project', '--out', 'planned.json', '--voice', 'v1', '--pace', '5'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, model: 'stub', fill: at('planned.json'), attemptsFile: at('planned.attempts.json'), first: false });
    expect((json().attempts as { errors: number }[]).map((a) => a.errors)).toEqual([1, 0]);
    expect(JSON.parse(await read('planned.json'))).toEqual({ ...good, voice: 'v1' });
    // The model is told to leave the voice out: the program adds it.
    expect(JSON.stringify(asked[asked.length - 1]?.messages)).toContain('Leave out \\"voice\\"');
  });
});

describe('popost video materials, retarget and readback', () => {
  /** A generator: writes the prompt into the file it is given, and says what it cost. */
  const GEN = "import fs from 'node:fs';\nconst [kind, req, out] = process.argv.slice(2);\nconst r = JSON.parse(fs.readFileSync(req, 'utf8'));\nfs.writeFileSync(out, kind + ':' + r.prompt);\nconsole.log(JSON.stringify({ credits: 20 }));\n";

  it('materials checks a list, refuses without a generator, and makes what is missing through POPOST_GEN_CMD', async () => {
    await put('requests.json', JSON.stringify([{ file: 'assets/logo.png', prompt: 'a red logo' }, { file: '../out.png', prompt: 'x' }]));
    expect((await runCli(rt, ['video', 'materials', 'requests.json', '--out', 'made', '--check'])).code).toBe(2);
    expect((json().problems as { at: string }[]).map((p) => p.at)).toEqual(['[1].file']);
    await put('requests.json', JSON.stringify([{ file: 'assets/logo.png', prompt: 'a red logo' }]));
    expect((await runCli(rt, ['video', 'materials', 'requests.json', '--out', 'made'])).code).toBe(2);
    expect(String(json().error)).toContain('set POPOST_GEN_CMD to a tool of yours');
    await put('gen.mjs', GEN);
    const making = withEnv({ POPOST_GEN_CMD: process.execPath + ' ' + at('gen.mjs') });
    expect((await runCli(making, ['video', 'materials', 'requests.json', '--out', 'made'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, made: 1, kept: 0, failed: 0, credits: 20, notes: at('made/materials.json') });
    expect(await read('made/assets/logo.png')).toBe('image:a red logo');
  });

  it('retarget builds a project on the structure of the described reference', async () => {
    await put('plan.json', JSON.stringify({ shots: [{ color: '#1d3557' }, { color: '#f4a261' }, { color: '#2a9d8f' }, { color: '#f1faee' }], captions: ['一', '二', '三', '四', '五'] }));
    expect((await runCli(rt, ['video', 'retarget', 'ref', '--plan', 'plan.json', '--out', 'retargeted'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, dir: at('retargeted'), project: at('retargeted/video.json'), written: ['video.json'], segments: 4 });
    await put('short.json', JSON.stringify({ shots: [{ color: '#000000' }] }));
    expect((await runCli(rt, ['video', 'retarget', 'ref', '--plan', 'short.json', '--out', 'nothing'])).code).toBe(2);
    expect((json().problems as { at: string }[])[0]?.at).toBe('shots');
  });

  it.skipIf(!ffmpeg)('readback reads a render with the text reader and writes readback.json', async () => {
    const OCR = "import { readFileSync, writeFileSync } from 'node:fs';\nconst [list, out] = process.argv.slice(2);\nwriteFileSync(out, JSON.stringify(JSON.parse(readFileSync(list, 'utf8')).map((f) => ({ frame: f.frame, lines: [] }))));\n";
    await put('ocr.mjs', OCR);
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:size=90x160:rate=30:duration=10', '-pix_fmt', 'yuv420p', at('render.mp4')]);
    expect((await runCli(rt, ['video', 'readback', 'retargeted', 'render.mp4'])).code).toBe(2);
    expect(String(json().error)).toContain('POPOST_OCR_CMD');
    const r = await runCli(withEnv({ POPOST_OCR_CMD: process.execPath + ' ' + at('ocr.mjs') }), ['video', 'readback', 'retargeted', 'render.mp4']);
    expect(json()).toMatchObject({ file: at('retargeted/readback.json'), texts: 5, legible: 0, speechChecked: false });
    // A reader that finds no text: no caption is legible, which is an error.
    expect(r.code).toBe(2);
    expect(await rt.fs.stat(at('retargeted/readback.json'))).not.toBeNull();
  });

  it('the command list names every command of the old development command line, and the new ones', async () => {
    const help = await runCli(rt, ['video', '--help']);
    for (const name of ['check', 'render', 'frame', 'capture', 'measure', 'text', 'transcript', 'describe', 'retarget', 'template', 'plan', 'materials', 'scene', 'draft', 'compare', 'readback', 'preview', 'synth', 'eval', 'look'])
      expect(help.stdout).toContain('  ' + name + '  ');
    expect((await runCli(rt, ['video', 'template', '--help'])).stdout).toContain('{save,see,show,check,fill,test}');
    expect((await runCli(rt, ['video', 'eval', '--help'])).stdout).toContain('{roundtrip,floor,decide}');
  });
});
