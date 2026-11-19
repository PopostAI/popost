/**
 * `image prepare` for the composition reference: the picture ratio follows the pages and the grid the composition prompt
 * asks for (and the model), the references default to the project's layout and identity pictures, `--ref` takes role
 * shorthands, and a path that does not exist says which references are registered.
 */
import { describe, expect, it } from 'vitest';
import { Project } from '../src/core/project';
import { cli, newScene, tinyPng, type Json } from './image-helpers';
import { examplePlan } from './workflow-helpers';

const setup = async (options: { pages?: number; width?: number; height?: number; models?: Json[]; noKey?: boolean } = {}) => {
  const { pages = 3, width = 1080, height = 1920 } = options;
  const scene = await newScene({
    files: {
      '/work/prompt.txt': 'a hand written composition prompt',
      '/work/layout-a.png': tinyPng([10, 0, 0], 3),
      '/work/layout-b.png': tinyPng([20, 0, 0], 3),
      '/work/layout-c.png': tinyPng([30, 0, 0], 3),
      '/work/face.png': tinyPng([0, 90, 0], 3),
      '/work/mood.png': tinyPng([0, 0, 90], 3),
    },
  });
  if (options.models) scene.stub.models = options.models as typeof scene.stub.models;
  const project = await Project.create(scene.rt, 'project', 'brief', 'original', width, height);
  for (let i = 2; i <= pages; i++) await project.addPage(`p${i}`, `Page ${i}`, width, height);
  project.manifest.provider = { channel: 'official', model: null };
  await project.saveManifest();
  const rt = options.noKey ? { ...scene.rt, env: { ...scene.rt.env, POPOST_API_KEY: undefined } } : scene.rt;
  const run = (...argv: string[]) => cli(rt, ...argv);
  const image = (...args: string[]) => run('image', ...args, '--dir', 'project');
  const job = async (id = 'composition') => JSON.parse(await scene.rt.fs.readText(`/work/project/production/jobs/${id}.json`)) as Json;
  const register = async (file: string, role: string): Promise<string> => {
    const r = await run('reference', '--dir', 'project', '--file', file, '--role', role);
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    return (r.data.references[0] as Json).path as string;
  };
  const seriesPrompt = async (...extra: string[]) => {
    const plan = examplePlan();
    plan.pages = plan.pages.slice(0, pages);
    await scene.rt.fs.writeFile('/work/plan.json', JSON.stringify(plan));
    expect((await run('plan', '--dir', 'project', '--file', 'plan.json')).code).toBe(0);
    const r = await run('series', 'prompt', '--dir', 'project', ...extra);
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    return r.data as Json;
  };
  return { ...scene, run, image, job, register, seriesPrompt };
};

type T = Awaited<ReturnType<typeof setup>>;

const model = (extra: Json = {}): Json => ({ id: 'stub-model-a', name: 'Stub model A', kind: 'image', creditsPerImage: 12, aspectRatios: ['1:1', '3:4', '9:16', '16:9'], maxReferenceImages: 4, isDefault: true, ...extra });

const promptFile = '/work/project/reference/composition-prompt.md';
/** The prompt `series prompt` wrote (the test ran it first). */
const prepareSeries = (t: T, ...extra: string[]) => t.image('prepare', '--prompt-file', promptFile, ...extra);
/** A prompt somebody wrote by hand. */
const prepare = (t: T, ...extra: string[]) => t.image('prepare', '--prompt-file', '/work/prompt.txt', ...extra);

describe('the composition ratio follows the pages, the prompt and the model', () => {
  it('prepares three 9:16 pages as the one row of three the prompt asks for, on a 16:9 picture', async () => {
    const t = await setup({ models: [model()] });
    const series = await t.seriesPrompt();
    expect(series).toMatchObject({ grid: { columns: 3, rows: 1 }, aspect: '16:9' });
    const r = await prepareSeries(t);
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(r.data.job.aspect).toBe('16:9');
    expect(r.data.notes).toEqual(['aspect 16:9: 3 columns and 1 row of 9:16 pages']);
    expect(await t.rt.fs.readText(promptFile)).toContain('arranged in 3 columns and 1 row');
    // and the quote asks the platform for exactly that ratio
    expect((await t.image('quote')).code).toBe(0);
    expect(t.stub.calls('POST', '/images/quote')[0]!.json).toMatchObject({ aspectRatio: '16:9' });
  });

  it('takes the closest ratio the model makes and says how to design the prompt for it', async () => {
    const t = await setup({ models: [model({ aspectRatios: ['1:1', '3:4', '9:16'] })] });
    await t.seriesPrompt();
    const r = await prepareSeries(t);
    expect(r.data.job.aspect).toBe('1:1');
    expect(r.data.notes).toEqual([
      'aspect 1:1: 3 columns and 1 row of 9:16 pages',
      'the model makes 1:1, 3:4, 9:16, not the 16:9 the prompt was designed for; 1:1 is the closest fit for that grid',
      'for this model 2 columns and 2 rows at 9:16 would show the pages larger (75% of the picture instead of 59%): series prompt --dir /work/project --aspect 9:16, then prepare again',
    ]);
    // following that advice is one more prepare: the draft is replaced, the grid and the ratio agree
    expect(await t.seriesPrompt('--aspect', '9:16')).toMatchObject({ grid: { columns: 2, rows: 2 }, aspect: '9:16' });
    const again = await prepareSeries(t);
    expect(again.data.job.aspect).toBe('9:16');
    expect(again.data.replaced).toBe(true);
    expect(again.data.notes).toEqual(["replaced the earlier prepared job 'composition' (it had no quote and no run)", 'aspect 9:16: 2 columns and 2 rows of 9:16 pages']);
  });

  it('keeps the ratio the prompt was designed for when the model list cannot be read, and says so', async () => {
    const t = await setup({ noKey: true });
    await t.seriesPrompt();
    const r = await prepareSeries(t);
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(r.data.job.aspect).toBe('16:9');
    expect(r.data.notes).toHaveLength(2);
    expect(r.data.notes[1]).toMatch(/^the model's limits could not be read \(.+\); used the common picture ratios, quote checks the request$/);
  });

  it('works out the ratio from the pages when the prompt was not written by series prompt', async () => {
    const t = await setup({ models: [model()], pages: 4, width: 1080, height: 1440 });
    const r = await t.image('prepare', '--prompt-file', '/work/prompt.txt');
    expect(r.data.job.aspect).toBe('3:4');
    expect(r.data.notes).toEqual(['aspect 3:4: 2 columns and 2 rows of 3:4 pages']);
  });

  it('ignores a recorded grid that no longer holds every page', async () => {
    const t = await setup({ models: [model()] });
    await t.seriesPrompt(); // 3 pages: 3 x 1
    const project = await Project.load(t.rt, 'project');
    await project.addPage('p4', 'Page 4', 1080, 1920);
    await project.addPage('p5', 'Page 5', 1080, 1920);
    const r = await prepareSeries(t);
    expect(r.data.notes![0]).toBe('aspect 3:4: 3 columns and 2 rows of 9:16 pages'); // 5 pages: the sheet is re-planned
  });

  it('uses --aspect as given and reads no model list when no reference needs the model limit', async () => {
    const t = await setup({ models: [model()] });
    const r = await prepare(t, '--aspect', '4:3');
    expect(r.data.job.aspect).toBe('4:3');
    expect(r.data.notes).toBeUndefined();
    expect(t.stub.requests).toEqual([]);
  });

  it('gives a material job 9:16 unless told otherwise, and never a default reference', async () => {
    const t = await setup({ models: [model()] });
    await t.register('/work/layout-a.png', 'layout');
    const r = await t.image('prepare', '--prompt-file', '/work/prompt.txt', '--purpose', 'material', '--id', 'hero');
    expect(r.data.job).toMatchObject({ aspect: '9:16', refs: [] });
    expect(t.stub.requests).toEqual([]);
  });

  it('asks a bring-your-own-key channel for its declared ratios, not the platform', async () => {
    const t = await setup();
    const project = await Project.load(t.rt, 'project');
    project.manifest.provider = { channel: 'custom', model: null };
    await project.saveManifest();
    await t.rt.fs.writeFile('/work/cfg.json', JSON.stringify({ custom: { capabilities: { aspects: ['1:1', '9:16'] } } }));
    await t.seriesPrompt();
    const r = await prepareSeries(t, '--config', '/work/cfg.json');
    expect(r.data.job.aspect).toBe('1:1'); // 16:9 is not declared
    expect(t.stub.requests).toEqual([]);
  });
});

describe('the composition job takes the project references unless told otherwise', () => {
  const registered = async (t: T) => {
    const a = await t.register('/work/layout-a.png', 'layout');
    const b = await t.register('/work/layout-b.png', 'layout');
    const face = await t.register('/work/face.png', 'identity');
    const mood = await t.register('/work/mood.png', 'style');
    return { a, b, face, mood };
  };
  const abs = (path: string) => `/work/project/${path}`;

  it('defaults to the layout references and the identity reference, never the style ones', async () => {
    const t = await setup({ models: [model()] });
    const { a, b, face } = await registered(t);
    const r = await prepare(t);
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(r.data.job.refs).toEqual([abs(a), abs(b), abs(face)]);
    expect(Object.keys(r.data.job.refHashes)).toEqual([abs(a), abs(b), abs(face)]);
    expect(r.data.notes).toContain('references: 3 registered (2 layout, 1 identity), the project defaults');
    // the quote sends all three (the stub model takes up to 4)
    expect((await t.image('quote')).code).toBe(0);
    expect(t.stub.calls('POST', '/images/quote')[0]!.json).toMatchObject({ referenceImageCount: 3 });
  });

  it('cuts the defaults to what the model takes, keeping the identity picture first', async () => {
    const t = await setup({ models: [model({ maxReferenceImages: 2 })] });
    const { a, face } = await registered(t);
    const r = await prepare(t);
    expect(r.data.job.refs).toEqual([abs(a), abs(face)]);
    expect(r.data.notes.some((note: string) => note.startsWith('left out 1 reference because the model takes at most 2:'))).toBe(true);
  });

  it('adds nothing when no reference is registered, and an explicit list replaces the defaults', async () => {
    const t = await setup({ models: [model()] });
    expect((await prepare(t)).data.job.refs).toEqual([]);
    const { face } = await registered(t);
    const only = await prepare(t, '--ref', '/work/mood.png');
    expect(only.data.job.refs).toEqual(['/work/mood.png']);
    expect(only.data.job.refs).not.toContain(abs(face));
  });

  it('takes --ref layout, --ref identity and --ref all by role', async () => {
    const t = await setup({ models: [model({ maxReferenceImages: 10 })] });
    const { a, b, face, mood } = await registered(t);
    expect((await prepare(t, '--ref', 'layout')).data.job.refs).toEqual([abs(a), abs(b)]);
    expect((await prepare(t, '--ref', 'identity')).data.job.refs).toEqual([abs(face)]);
    expect((await prepare(t, '--ref', 'all')).data.job.refs).toEqual([abs(a), abs(b), abs(face), abs(mood)]);
    expect((await prepare(t, '--ref', 'style')).data.job.refs).toEqual([abs(mood)]);
    // roles and paths mix, and a picture named twice goes once
    const mixed = await prepare(t, '--ref', 'identity', '--ref', abs(face), '--ref', '/work/layout-c.png');
    expect(mixed.data.job.refs).toEqual([abs(face), '/work/layout-c.png']);
  });

  it('lets a material job use the same shorthands', async () => {
    const t = await setup({ models: [model()] });
    const { face } = await registered(t);
    const r = await t.image('prepare', '--prompt-file', '/work/prompt.txt', '--purpose', 'material', '--id', 'hero', '--ref', 'identity');
    expect(r.data.job.refs).toEqual([abs(face)]);
  });

  it('says that no reference of that role is registered, and how to register one', async () => {
    const t = await setup({ models: [model()] });
    await t.register('/work/layout-a.png', 'layout');
    const r = await prepare(t, '--ref', 'identity');
    expect(r.code).toBe(2);
    expect(r.data.error).toBe('--ref identity: no identity reference is registered; register one with: reference --dir <project> --file <image> --role identity, or pass a file path.');
    expect((await prepare(t, '--ref', 'all')).code).toBe(0);
    const none = await setup({ models: [model()] });
    expect((await prepare(none, '--ref', 'all')).data.error).toContain('--ref all: no reference is registered');
  });
});

describe('a reference path that does not exist', () => {
  it('lists the registered references and names the likely one when the hash name has a typo', async () => {
    const t = await setup({ models: [model()] });
    const layout = await t.register('/work/layout-a.png', 'layout');
    const face = await t.register('/work/face.png', 'identity');
    const mistyped = `${layout.slice(0, 'reference/'.length + 5)}${layout.slice('reference/'.length + 6)}`; // one character of the hash missing, as in a real run
    const r = await prepare(t, '--ref', mistyped);
    expect(r.code).toBe(2);
    expect(r.data.error).toBe(
      `reference file not found: ${mistyped}. Registered references: ${layout} (layout), ${face} (identity). Did you mean ${layout}? Use one of these paths, or --ref layout|identity|style|content|all.`,
    );
    expect(await t.rt.fs.stat('/work/project/production/jobs/composition.json')).toBeNull(); // nothing was written
  });

  it('names no guess when nothing is close, and tells how to register a first reference', async () => {
    const t = await setup({ models: [model()] });
    const none = await prepare(t, '--ref', 'reference/nothing-like-it.png');
    expect(none.data.error).toBe('reference file not found: reference/nothing-like-it.png. No reference is registered; register one with: reference --dir <project> --file <image> --role layout.');
    const layout = await t.register('/work/layout-a.png', 'layout');
    const far = await prepare(t, '--ref', 'reference/nothing-like-it.png');
    expect(far.data.error).toBe(`reference file not found: reference/nothing-like-it.png. Registered references: ${layout} (layout). Use one of these paths, or --ref layout|identity|style|content|all.`);
  });

  it('finds a registered reference by its project path from any working directory', async () => {
    const t = await setup({ models: [model()] });
    const layout = await t.register('/work/layout-a.png', 'layout');
    const r = await prepare(t, '--ref', layout);
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(r.data.job.refs).toEqual([`/work/project/${layout}`]);
    expect(Object.keys(r.data.job.refHashes)).toEqual([`/work/project/${layout}`]);
  });
});
