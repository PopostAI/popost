import { Project } from '../src/core/project';
import { quoteStep } from '../src/setup/quote';
import { parseSpec } from '../src/setup/spec';
/**
 * `popost setup`: one spec, one call. A fresh project end to end (references, fonts from a demo library so nothing goes to
 * the network, series plan, image jobs, quotes from the platform stub), the whole-spec check that reports every problem
 * at once, a second run that skips everything, and the rules about jobs that were quoted.
 */
import { describe, expect, it } from 'vitest';
import { runCli, type FetchHandler } from '../src/testing/memory';
import { demoRole, mountLibrary } from './font-helpers';
import { newScene, tinyPng, type Json, type Scene } from './image-helpers';
import { examplePlan } from './workflow-helpers';

const ROLES = [demoRole('latin-inter-tight'), demoRole('latin-poppins', 1)];

const plan = (pages: number): string => {
  const example = examplePlan();
  example.pages = example.pages.slice(0, pages);
  return JSON.stringify(example);
};

/** The spec of the issue's example, trimmed to what the stub can price. */
const fullSpec = (): Json => ({
  brief: 'Cozy bedroom set for a winter sale',
  mode: 'original',
  width: 1080,
  height: 1920,
  pages: 3,
  settings: { platform: 'tiktok', language: 'en', channel: 'official', model: 'stub-model-a' },
  references: [
    { file: 'inputs/ref-1.png', role: 'layout', page: 'p1' },
    { file: 'inputs/product.png', role: 'identity' },
  ],
  fonts: ['latin-inter-tight', 'latin-poppins'],
  plan: 'series-plan.json',
  images: [
    { id: 'scene-bed', promptFile: 'prompts/scene-bed.md', aspect: '9:16', purpose: 'material', ref: 'identity' },
    { id: 'scene-sofa', promptFile: 'prompts/scene-sofa.md', aspect: '3:4', ref: ['identity', 'inputs/ref-1.png'] },
  ],
});

const world = async (options: { fetchHandler?: (scene: Scene['stub']) => FetchHandler; withFontFiles?: boolean } = {}) => {
  const scene = await newScene({
    fetchHandler: options.fetchHandler,
    files: {
      '/work/spec/inputs/ref-1.png': tinyPng([10, 0, 0], 3),
      '/work/spec/inputs/product.png': tinyPng([0, 90, 0], 3),
      '/work/spec/inputs/notes.txt': 'not a picture',
      '/work/spec/prompts/scene-bed.md': 'A cozy bed with a knitted blanket, warm light',
      '/work/spec/prompts/scene-sofa.md': 'A deep sofa by a window, snow outside',
      '/work/spec/series-plan.json': plan(3),
    },
  });
  await mountLibrary(scene.rt, ROLES, options.withFontFiles ?? true);
  const { rt, stub } = scene;
  const write = (path: string, data: string) => rt.fs.writeFile(`/work/${path}`, data);
  const read = (path: string) => rt.fs.readText(`/work/${path}`);
  const writeSpec = (spec: Json) => write('spec/setup.json', JSON.stringify(spec));
  const setup = async (spec?: Json, ...extra: string[]) => {
    if (spec) await writeSpec(spec);
    const { code, stdout, stderr } = await runCli(rt, ['setup', '--dir', 'project', '--spec', 'spec/setup.json', ...extra]);
    return { code, stderr, data: JSON.parse(stdout) as Json };
  };
  const manifest = async () => JSON.parse(await read('project/social-studio-project.json')) as Json;
  const job = async (id: string) => JSON.parse(await read(`project/production/jobs/${id}.json`)) as Json;
  return { rt, stub, write, read, writeSpec, setup, manifest, job };
};

const statuses = (data: Json): Record<string, string> => Object.fromEntries((data.steps as Json[]).map((step) => [step.step, step.status]));

describe('a fresh project end to end', () => {
  it('runs every step from one spec, quotes the image jobs and says what comes next', async () => {
    const w = await world();
    const r = await w.setup(fullSpec());
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(r.data.ok).toBe(true);
    expect(statuses(r.data)).toEqual({ init: 'done', settings: 'done', pages: 'done', references: 'done', fonts: 'done', plan: 'done', images: 'done', quote: 'done' });
    expect((r.data.steps as Json[]).map((step) => step.step)).toEqual(['init', 'settings', 'pages', 'references', 'fonts', 'plan', 'images', 'quote']);

    const manifest = await w.manifest();
    expect(manifest).toMatchObject({ mode: 'original', platform: 'tiktok', language: 'en', provider: { channel: 'official', model: 'stub-model-a' } });
    expect(manifest.pages.map((p: Json) => [p.id, p.width, p.height])).toEqual([['p1', 1080, 1920], ['p2', 1080, 1920], ['p3', 1080, 1920]]);
    const references = manifest.sources.filter((s: Json) => s.kind === 'local-reference');
    expect(references.map((s: Json) => [s.role, s.pageId])).toEqual([['layout', 'p1'], ['identity', null]]);
    expect(manifest.fonts.map((f: Json) => f.id)).toEqual(['latin-inter-tight', 'latin-poppins']);
    expect(await w.read('project/pages/p3.html')).toContain('<link rel="stylesheet" href="../css/latin-poppins.css">');
    // a page written whole must keep the links, so the step says what they are
    const fonts = (r.data.steps as Json[]).find((step) => step.step === 'fonts')!;
    expect(fonts.detail).toContain('<link rel="stylesheet" href="../css/latin-inter-tight.css"><link rel="stylesheet" href="../css/latin-poppins.css">');
    expect(fonts.detail).toContain('do not write these tags yourself');
    expect(fonts.fontLinks).toEqual({ linked: ['p1', 'p2', 'p3'] }); // the step says which pages it linked
    expect(manifest.seriesPlan).toMatchObject({ path: 'series-plan.json' });

    const bed = await w.job('scene-bed');
    expect(bed).toMatchObject({ purpose: 'material', aspect: '9:16', status: 'quoted' });
    expect(bed.refs).toEqual([`/work/project/${references[1].path}`]);
    expect(bed.prompt).toBe('A cozy bed with a knitted blanket, warm light');
    const sofa = await w.job('scene-sofa');
    expect(sofa).toMatchObject({ aspect: '3:4', status: 'quoted' });
    expect(sofa.refs).toEqual([`/work/project/${references[1].path}`, '/work/spec/inputs/ref-1.png']);

    expect(r.data.quotes).toEqual([
      expect.objectContaining({ id: 'scene-bed', quoteId: bed.quoteId, credits: '12', model: 'stub-model-a', aspect: '9:16' }),
      expect.objectContaining({ id: 'scene-sofa', quoteId: sofa.quoteId, credits: '12', aspect: '3:4' }),
    ]);
    expect(r.data.totalCredits).toBe('24');
    expect(r.data.balance).toBe(500);
    expect(r.data.next).toContain(`popost image run --dir project --quote-id ${bed.quoteId},${sofa.quoteId} --confirm`);
    expect(r.data.next).toMatch(/fee authorization.*write the pages while they generate.*right before the first render/s);
    expect(w.stub.calls('POST', '/images/quote')).toHaveLength(2);
    expect(w.stub.calls('POST', '/images/generations')).toHaveLength(0); // nothing is generated or charged
  });

  it('runs again with the same spec and skips everything, quotes included', async () => {
    const w = await world();
    const first = await w.setup(fullSpec());
    const files = ['project/social-studio-project.json', 'project/production/jobs/scene-bed.json', 'project/production/jobs/scene-sofa.json', 'project/series-plan.json', 'project/pages/p2.html'];
    const withoutTime = async () => (await Promise.all(files.map((f) => w.read(f)))).map((text) => text.replace(/"updatedAt": "[^"]*"/, ''));
    const before = await withoutTime();
    const quotes = w.stub.calls('POST', '/images/quote').length;

    const second = await w.setup();
    expect(second.code, JSON.stringify(second.data)).toBe(0);
    expect(statuses(second.data)).toEqual({ init: 'skipped', settings: 'skipped', pages: 'skipped', references: 'skipped', fonts: 'skipped', plan: 'skipped', images: 'skipped', quote: 'skipped' });
    expect(await withoutTime()).toEqual(before);
    expect(w.stub.calls('POST', '/images/quote')).toHaveLength(quotes);
    expect(second.data.quotes).toEqual(first.data.quotes);
    expect(second.data.totalCredits).toBe('24');
    expect((await w.manifest()).sources.filter((s: Json) => s.kind === 'local-reference')).toHaveLength(2);
  });

  it('quotes again only a job whose quote expired', async () => {
    const w = await world();
    const first = await w.setup(fullSpec());
    const quoteFile = `project/production/quotes/${first.data.quotes[0].quoteId}.json`;
    const record = JSON.parse(await w.read(quoteFile)) as Json;
    await w.write(quoteFile, JSON.stringify({ ...record, expiresAt: '2000-01-01T00:00:00+00:00' }));
    const second = await w.setup();
    expect(second.code, JSON.stringify(second.data)).toBe(0);
    expect(statuses(second.data)).toMatchObject({ images: 'skipped', quote: 'done' });
    expect(second.data.quotes[0].quoteId).not.toBe(first.data.quotes[0].quoteId);
    expect(second.data.quotes[1].quoteId).toBe(first.data.quotes[1].quoteId);
    expect(w.stub.calls('POST', '/images/quote')).toHaveLength(3);
  });

  it('accepts an explicit page list, names the pages, and adds the missing ones to a project that exists', async () => {
    const w = await world();
    const r = await w.setup({ brief: 'b', pages: ['p1', 'cover', 'p3'] });
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect((await w.manifest()).pages.map((p: Json) => [p.id, p.name, p.width, p.height])).toEqual([['p1', 'Page 1', 1080, 1350], ['cover', 'cover', 1080, 1350], ['p3', 'Page 3', 1080, 1350]]);
    expect((await w.setup({ pages: 4, width: 1000, height: 1000 })).data.steps).toEqual([
      { step: 'init', status: 'skipped', detail: 'the project exists (original, 3 pages) and is kept as it is' },
      { step: 'pages', status: 'done', detail: 'added p2, p4 (1000x1000); the project has 5 pages' },
    ]);
  });

  it('links the installed fonts into a page it adds later, though the fonts step has nothing to do', async () => {
    const w = await world();
    await w.setup({ brief: 'b', pages: 2, fonts: ['latin-poppins'] });
    expect(await w.read('project/pages/p2.html')).toContain('latin-poppins.css');
    const earlier = await w.read('project/pages/p2.html');
    const r = await w.setup({ pages: 3, fonts: ['latin-poppins'] });
    expect(statuses(r.data)).toEqual({ init: 'skipped', pages: 'done', fonts: 'skipped' });
    expect((r.data.steps as Json[]).find((step) => step.step === 'pages')!.fontLinks).toEqual({ linked: ['p3'] });
    expect(await w.read('project/pages/p2.html')).toBe(earlier); // the pages that were there are not rewritten
    expect(await w.read('project/pages/p3.html')).toContain('<link rel="stylesheet" href="../css/latin-poppins.css">');
  });
});

describe('Chinese font roles in a project whose copy is not Chinese', () => {
  const WARNING = (language: string) =>
    `cjk-sans is a Chinese font role, but this project's copy language is ${language}: its stylesheet is large and the export repeats it on every page; install it only if the copy has Chinese text.`;

  const withCjk = async (settings: Json | undefined, fonts: string[] = ['latin-poppins', 'cjk-sans']) => {
    const w = await world();
    await mountLibrary(w.rt, [...ROLES, demoRole('cjk-sans')], true);
    const r = await w.setup({ brief: 'b', pages: 2, ...(settings ? { settings } : {}), fonts });
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    return { w, r };
  };

  it('warns at the top of the result, installs the role anyway, and keeps the step entry as it was', async () => {
    const { w, r } = await withCjk({ language: 'en' });
    expect(r.data.warnings).toEqual([WARNING('en')]);
    expect(statuses(r.data)).toMatchObject({ settings: 'done', fonts: 'done' });
    expect((r.data.steps as Json[]).find((step) => step.step === 'fonts')).not.toHaveProperty('warnings');
    expect((await w.manifest()).fonts.map((font: Json) => font.id)).toEqual(['latin-poppins', 'cjk-sans']);
    expect(await w.read('project/pages/p2.html')).toContain('../css/cjk-sans.css');
  });

  it('uses the language the project already has when the spec gives none, and keeps the warnings when a later step fails', async () => {
    const w = await world();
    await mountLibrary(w.rt, [...ROLES, demoRole('cjk-sans')], true);
    await w.setup({ brief: 'b', settings: { language: 'en' } });
    w.stub.balance = 5; // the quote step is refused after the fonts step
    const r = await w.setup({ ...fullSpec(), settings: undefined, fonts: ['cjk-sans'] });
    expect(r.code).toBe(1);
    expect(r.data).toMatchObject({ ok: false, failedStep: 'quote', warnings: [WARNING('en')] });
  });

  it('says nothing for Chinese copy, an unknown language, or fonts that are not Chinese; nor when the role is already installed', async () => {
    expect((await withCjk({ language: 'zh-CN' })).r.data.warnings).toBeUndefined();
    expect((await withCjk(undefined)).r.data.warnings).toBeUndefined();
    expect((await withCjk({ language: 'en' }, ['latin-poppins'])).r.data.warnings).toBeUndefined();
    const { w } = await withCjk({ language: 'en' });
    const again = await w.setup();
    expect(statuses(again.data)).toMatchObject({ fonts: 'skipped' });
    expect(again.data.warnings).toBeUndefined();
  });
});

describe('the whole spec is checked first', () => {
  it('reports every problem in one result and changes nothing', async () => {
    const w = await world();
    const r = await w.setup({
      mood: 'cozy',
      mode: 'fancy',
      width: 0,
      pages: 0,
      settings: { platform: 'myspace', colour: 'red' },
      references: [{ file: 'inputs/nope.png', page: 'p9' }, { file: 'inputs/notes.txt', role: 'layout' }, { file: 'inputs/ref-1.png', role: 'banner' }, 'inputs/ref-1.png'],
      fonts: ['latin-inter-tight', 'latin-nope'],
      plan: 'series-plan.json',
      images: [
        { id: 'a', promptFile: 'prompts/missing.md', aspect: 'wide', ref: 'style' },
        { id: 'b', promptFile: 'prompts/scene-bed.md', ref: ['inputs/missing.png', 'inputs/notes.txt'] },
        { id: 'composition', promptFile: 'prompts/scene-bed.md' },
        { promptFile: 'prompts/scene-bed.md' },
        { id: 'c', promptFile: 'prompts/scene-bed.md', extra: true },
      ],
      quote: 'yes',
    });
    expect(r.code).toBe(2);
    expect(r.data.ok).toBe(false);
    expect(r.data.error).toMatch(/^the spec has \d+ problems; nothing was changed/);
    const problems = r.data.problems as string[];
    expect(problems.length).toBeGreaterThanOrEqual(15);
    for (const expected of [
      'mood: unknown key',
      'mode: "fancy" is not one of "original", "strict"',
      'width: must be a whole number from 1 to 16384',
      'pages: a page count must be a whole number from 1 to 50',
      'settings.platform: "myspace" is not one of',
      'settings.colour: unknown key',
      'references[0].file: file not found: inputs/nope.png',
      'references[0].page: "p9" is not a page of this project (pages: p1)',
      'references[1].file: not a readable picture file: inputs/notes.txt',
      'references[2].role: "banner" is not one of',
      'references[3]: must be an object',
      'fonts: unknown font roles: latin-nope',
      'plan: plan page ids/order differ from project (the project will have: p1; set "pages" to match the plan)',
      'images[0].promptFile: file not found: prompts/missing.md',
      'images[0].aspect: "wide" must be W:H',
      'images[0].ref: "style": no style reference is registered',
      'images[1].ref: picture not found: inputs/missing.png',
      'images[1].ref: not a readable picture file: inputs/notes.txt',
      'images[2].id: "composition" is reserved for the composition job',
      'images[3].id: required',
      'images[4].extra: unknown key',
      'quote: must be true or false',
      'brief: required: the project does not exist yet',
    ])
      expect(problems.some((p) => p.includes(expected)), `${expected}\n${problems.join('\n')}`).toBe(true);
    expect(await w.rt.fs.stat('/work/project')).toBeNull();
    expect(w.stub.requests).toHaveLength(0);
  });

  it('refuses a directory that is neither a project nor empty, a mode that cannot change, and twin jobs', async () => {
    const w = await world();
    await w.write('project/stray.txt', 'x');
    const stray = await w.setup({ brief: 'b' });
    expect((stray.data.problems as string[])[0]).toContain('dir: project is not empty and is not a popost project');

    const v = await world();
    await v.setup({ brief: 'b', mode: 'strict' });
    // The host's word for the mode is accepted: "replicate" is strict, so the rerun changes nothing.
    expect((await v.setup({ mode: 'replicate' })).data.ok).toBe(true);
    const mismatch = await v.setup({ mode: 'original', quote: true, images: [
      { id: 'a', promptFile: 'prompts/scene-bed.md', aspect: '1:1' },
      { id: 'b', promptFile: 'prompts/scene-bed.md', aspect: '1:1' },
      { purpose: 'composition', promptFile: 'prompts/scene-sofa.md' },
    ] });
    expect(mismatch.data.problems).toEqual([
      'mode: the project already exists as "strict" and its mode cannot change: remove "mode" or set it to "strict"',
      'images[1]: "b" asks for the same picture as "a" (same prompt, aspect and references): keep one, or change the prompt of the other',
      'images[2].purpose: a strict (reproduction) project has no composition job: it uses the supplied references',
    ]);
    const empty = await v.setup({ quote: true });
    expect(empty.data.problems).toEqual(['quote: there are no images to quote']);
    const fresh = await world();
    const noP1 = await fresh.setup({ brief: 'b', pages: ['cover', 'p2'] });
    expect(noP1.data.problems).toEqual(['pages: a new project starts with page p1: begin the list with "p1"']);
  });

  it('answers a missing or broken spec file without touching anything', async () => {
    const w = await world();
    const missing = await runCli(w.rt, ['setup', '--dir', 'project', '--spec', 'nope.json']);
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.stdout).error).toContain('file not found: nope.json');
    await w.write('spec/broken.json', '{ "brief": ');
    const broken = await runCli(w.rt, ['setup', '--dir', 'project', '--spec', 'spec/broken.json']);
    expect(JSON.parse(broken.stdout).error).toMatch(/^spec\/broken\.json is not valid JSON/);
    const array = await w.setup([] as never);
    expect(array.data.problems).toEqual(['spec: must be a JSON object (see popost setup --help)']);
    expect(await w.rt.fs.stat('/work/project')).toBeNull();
  });
});

describe('a step that fails stops the run, and the same spec carries on after the fix', () => {
  it('names the failing step, what is done, and resumes when the cause is gone', async () => {
    const w = await world({ withFontFiles: false, fetchHandler: (stub) => (request) => (new URL(request.url).pathname.includes('/fonts/') ? new Response('gone', { status: 404 }) : stub.fetch(request)) });
    const spec = { ...fullSpec(), images: [fullSpec().images[0]] };
    const r = await w.setup(spec);
    expect(r.code).toBe(2);
    expect(r.data).toMatchObject({ ok: false, failedStep: 'fonts' });
    expect(r.data.error).toContain('cannot download font file');
    expect(statuses(r.data)).toEqual({ init: 'done', settings: 'done', pages: 'done', references: 'done' });
    expect(r.data.next).toContain('run the same popost setup command again');
    expect(await w.rt.fs.stat('/work/project/production')).toBeNull(); // nothing after the failing step ran

    await mountLibrary(w.rt, ROLES, true); // the fonts are there now
    const again = await w.setup();
    expect(again.code, JSON.stringify(again.data)).toBe(0);
    expect(statuses(again.data)).toEqual({ init: 'skipped', settings: 'skipped', pages: 'skipped', references: 'skipped', fonts: 'done', plan: 'done', images: 'done', quote: 'done' });
  });

  it('stops at a refused quote with its exit code, keeps the prepared jobs, and quotes them when it works', async () => {
    const w = await world();
    w.stub.balance = 5;
    const r = await w.setup(fullSpec());
    expect(r.code).toBe(1);
    expect(r.data).toMatchObject({ ok: false, failedStep: 'quote' });
    expect(r.data.error).toMatch(/scene-bed: .*5/);
    expect(statuses(r.data)).toMatchObject({ images: 'done' });
    expect((await w.job('scene-bed')).status).toBe('prepared');

    w.stub.balance = 500;
    const again = await w.setup();
    expect(statuses(again.data)).toMatchObject({ images: 'skipped', quote: 'done' });
    expect(again.data.totalCredits).toBe('24');
  });

  it('keeps the rules of image prepare: a job that was quoted is not replaced, a draft is', async () => {
    const w = await world();
    await w.setup({ ...fullSpec(), quote: false });
    expect((await w.job('scene-bed')).status).toBe('prepared');

    await w.write('spec/prompts/scene-bed.md', 'A cozy bed, but at night');
    const draft = await w.setup();
    expect(statuses(draft.data)).toMatchObject({ images: 'done', quote: 'skipped' });
    const images = (draft.data.steps as Json[]).find((step) => step.step === 'images');
    expect(images.detail).toBe('prepared scene-bed; unchanged: scene-sofa');
    expect(images.notes).toContain("scene-bed: replaced the earlier prepared job 'scene-bed' (it had no quote and no run)");
    expect((await w.job('scene-bed')).prompt).toBe('A cozy bed, but at night');

    const quoted = await w.setup({ ...fullSpec(), quote: undefined });
    expect(quoted.code, JSON.stringify(quoted.data)).toBe(0);
    const quoteId = (await w.job('scene-bed')).quoteId as string;
    expect(quoteId).toMatch(/^q_/);

    await w.write('spec/prompts/scene-bed.md', 'A cozy bed, back in daylight');
    const refused = await w.setup();
    expect(refused.code).toBe(2);
    expect(refused.data).toMatchObject({ ok: false, failedStep: 'images' });
    expect(refused.data.error).toContain(`job 'scene-bed' is already quoted (quote ${quoteId}) and is not replaced`);
    expect(statuses(refused.data)).toEqual({ init: 'skipped', settings: 'skipped', pages: 'skipped', references: 'skipped', fonts: 'skipped', plan: 'skipped' });
    expect((await w.job('scene-bed')).quoteId).toBe(quoteId);
    expect((await w.job('scene-bed')).prompt).toBe('A cozy bed, but at night');
  });

  it('leaves a job that was already submitted alone', async () => {
    const w = await world();
    const first = await w.setup(fullSpec());
    const [bed, sofa] = first.data.quotes as Json[];
    const run = await runCli(w.rt, ['image', 'run', '--dir', 'project', '--quote-id', `${bed.quoteId},${sofa.quoteId}`, '--confirm']);
    expect(run.code, run.stdout).toBe(0);
    const again = await w.setup();
    expect(again.code, JSON.stringify(again.data)).toBe(0);
    expect(statuses(again.data)).toMatchObject({ images: 'skipped', quote: 'skipped' });
    expect((again.data.steps as Json[]).find((step) => step.step === 'quote').detail).toBe('left alone: scene-bed: submitted; scene-sofa: submitted');
    expect(again.data.quotes).toBeUndefined();
    expect(w.stub.calls('POST', '/images/generations')).toHaveLength(2);
  });
});

describe('other channels and composition', () => {
  it('prepares the jobs of the host channel without quoting them, and says the host tool makes them', async () => {
    const w = await world();
    const spec = { ...fullSpec(), settings: { channel: 'host' } };
    const r = await w.setup(spec);
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(statuses(r.data)).toMatchObject({ images: 'done', quote: 'skipped' });
    expect((r.data.steps as Json[]).find((step) => step.step === 'quote').detail).toBe('host channel, nothing to quote: scene-bed, scene-sofa');
    expect(r.data.quotes).toBeUndefined();
    expect(r.data.next).toContain('host image tool');
    expect(w.stub.calls('POST', '/images/quote')).toHaveLength(0);
  });

  it('prepares a composition job from a prompt file and quotes it with the others', async () => {
    const w = await world();
    const spec = { ...fullSpec(), images: [...fullSpec().images, { purpose: 'composition', promptFile: 'prompts/scene-sofa.md', aspect: '3:4', ref: 'layout' }] };
    spec.images[1] = { ...spec.images[1], promptFile: 'prompts/scene-bed.md', aspect: '1:1' };
    const r = await w.setup(spec);
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(r.data.quotes.map((q: Json) => q.id)).toEqual(['scene-bed', 'scene-sofa', 'composition']);
    expect(await w.job('composition')).toMatchObject({ purpose: 'composition', aspect: '3:4', status: 'quoted' });
    expect(r.data.totalCredits).toBe('36');
  });

  it('does not ask again for a composition job whose picture is registered', async () => {
    const w = await world();
    const spec = { brief: 'b', pages: 3, quote: false, images: [{ purpose: 'composition', promptFile: 'prompts/scene-sofa.md', aspect: '3:4' }] };
    expect((await w.setup(spec)).code).toBe(0);
    const done = await runCli(w.rt, ['image', 'complete', '--dir', 'project', '--file', 'spec/inputs/ref-1.png', '--note', 'looks right']);
    expect(done.code, done.stdout).toBe(0);
    const again = await w.setup({ ...spec, quote: undefined });
    expect(again.code, JSON.stringify(again.data)).toBe(0);
    expect(statuses(again.data)).toEqual({ init: 'skipped', pages: 'skipped', images: 'skipped', quote: 'skipped' });
    expect((again.data.steps as Json[]).find((step) => step.step === 'quote').detail).toBe('left alone: composition: completed');
  });

  it('prepares without quoting when the spec has no images, and says to write the pages', async () => {
    const w = await world();
    const r = await w.setup({ brief: 'b', pages: 2 });
    expect(r.data.quotes).toBeUndefined();
    expect(r.data.next).toBe('Write the pages (one complete HTML file per page), then popost render --dir project --page all.');
  });
});

describe('popost setup --help', () => {
  it('documents the spec fields and an example, and the main help lists the command', async () => {
    const { rt } = await world();
    const help = await runCli(rt, ['setup', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('usage: popost setup [-h] --dir DIR --spec SPEC [--config CONFIG] [--accept-unknown-cost]');
    for (const field of ['brief', 'mode', 'width, height', 'pages', 'settings', 'references', 'fonts', 'plan', 'images', 'quote', 'promptFile', 'example:'])
      expect(help.stdout, field).toContain(field);
    const example = /example:\n([\s\S]*?)\n\noutput:/.exec(help.stdout)![1]!;
    expect(() => JSON.parse(example)).not.toThrow();
    expect((await runCli(rt, ['--help'])).stdout).toContain('project:   setup, init,');
  });
});


describe('retained quote billing boundaries', () => {
  it('rejects a retained official quote plus a fresh custom job before any new quotes', async () => {
    const w = await world();
    await w.setup(fullSpec());
    const file = '/work/project/production/jobs/scene-sofa.json';
    const job = JSON.parse(await w.rt.fs.readText(file));
    job.provider.channel = 'custom';
    job.status = 'prepared';
    delete job.quoteId;
    await w.rt.fs.writeFile(file, JSON.stringify(job));
    const before = w.stub.calls('POST', '/images/quote').length;
    await expect(quoteStep({
      rt: w.rt, project: await Project.load(w.rt, 'project'), dir: 'project', specDir: '/work/spec',
      spec: parseSpec(fullSpec()).spec, acceptUnknownCost: false,
      outcome: { quotes: [], totalCredits: null, totalAmount: null, billingUnit: null, balance: null, hostJobs: [] },
    })).rejects.toThrow('one billing service');
    expect(w.stub.calls('POST', '/images/quote')).toHaveLength(before);
    expect(w.stub.calls('POST', '/images/generations')).toHaveLength(0);
  });
});
