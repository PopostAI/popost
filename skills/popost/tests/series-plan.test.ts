/** `plan` and `series`: the series plan, its validation and the composition prompt (Python golden values). */
import { describe, expect, it } from 'vitest';
import { Project } from '../src/core/project';
import { sha256 } from '../src/core/util';
import * as seriesPlan from '../src/workflow/series-plan';
import { runCli } from '../src/testing/memory';
import { examplePlan, newProject, newProjectWithPages, newRuntime } from './workflow-helpers';

describe('series plan validation', () => {
  it('accepts the example plan', () => {
    expect(seriesPlan.validate(examplePlan(), ['p1', 'p2', 'p3', 'p4'])).toEqual([]);
  });

  it('rejects an incomplete growth plan and one bound to other pages', () => {
    const plan = examplePlan();
    plan.pages[1]!.swipeReason = '';
    expect(seriesPlan.validate(plan)).toEqual(['pages[1].swipeReason must name what the next page adds']);
    const concept = examplePlan();
    concept.concept = { enabled: true, imageCount: 4 };
    expect(seriesPlan.validate(concept)).toEqual(['concept.imageCount must be 1 (or 0 when the concept is disabled with a reason)']);
    expect(seriesPlan.validate(examplePlan(), ['p2', 'p1', 'p3', 'p4'])).toEqual(['plan page ids/order differ from project']);
  });

  it('reports every missing field in the order the agent should fix it', () => {
    const plan = { schema: 'popost-series.v1', audience: ' ', pages: [{ id: 'p1' }], hook: { text: 'x' }, cta: { enabled: true }, concept: [] };
    expect(seriesPlan.validate(plan)).toEqual([
      'audience must describe a concrete decision',
      'promise must describe a concrete decision',
      'payoff must describe a concrete decision',
      'visualDirection must describe a concrete decision',
      'pages[0].role is required',
      'pages[0].message is required',
      'pages[0].visual is required',
      'pages[0].copy is required',
      'hook needs text and a mechanism tied to the actual payoff',
      'enabled CTA needs action and audience benefit/reason',
      'concept must be an object',
    ]);
    expect(seriesPlan.validate('x')).toEqual(['schema must be popost-series.v1']);
    expect(seriesPlan.validate({ ...examplePlan(), pages: [] })).toEqual(['pages must be a nonempty ordered array']);
  });

  it('lets a plan that explains why it has no composition sheet use count 0 or 1, and a boolean count never counts', () => {
    const off = { ...examplePlan(), concept: { enabled: false, reason: 'native typography', imageCount: 0 } };
    expect(seriesPlan.validate(off)).toEqual([]);
    expect(seriesPlan.validate({ ...off, concept: { enabled: false, imageCount: 0 } })).not.toEqual([]);
    expect(seriesPlan.validate({ ...examplePlan(), concept: { imageCount: true } })).not.toEqual([]);
  });

  it('tells a disabled concept without a reason to add the reason, not to change the count', () => {
    const reason = 'concept: a disabled concept needs a reason (concept.reason)';
    const count = 'concept.imageCount must be 1 (or 0 when the concept is disabled with a reason)';
    const check = (concept: unknown) => seriesPlan.validate({ ...examplePlan(), concept });
    expect(check({ enabled: false, imageCount: 0 })).toEqual([reason]);
    expect(check({ enabled: false, imageCount: 2 })).toEqual([reason, count]);
    // wrong count with a reason, or a concept that is not disabled: only the count is wrong
    expect(check({ enabled: false, imageCount: 2, reason: 'native typography' })).toEqual([count]);
    expect(check({ enabled: true, imageCount: 0, reason: 'native typography' })).toEqual([count]);
    expect(check({ imageCount: 0 })).toEqual([count]);
    // the allowed combinations are unchanged
    expect(check({ enabled: false, imageCount: 1 })).toEqual([]);
    expect(check({ enabled: false, imageCount: 1, reason: 'native typography' })).toEqual([]);
    expect(check({ enabled: true })).toEqual([]);
  });

  it('hashes like the Python Skill (sorted keys, ensure_ascii=False)', () => {
    expect(seriesPlan.digest(examplePlan())).toBe('4bbc10f704c58dc6684804609eb07eec2f6d392b3fd5bd95e107870a5435ce5c');
  });
});

describe('plan and series commands', () => {
  it('attaches the plan, records its hash and drops a stale sequence review', async () => {
    const rt = await newRuntime();
    const project = await newProjectWithPages(rt);
    project.manifest.seriesReview = { old: true };
    await project.saveManifest();
    await rt.fs.writeFile('/work/plan.json', JSON.stringify(examplePlan()));
    const { code } = await runCli(rt, ['plan', '--dir', 'project', '--file', 'plan.json']);
    expect(code).toBe(0);
    expect(rt.json()).toEqual({ ok: true, path: '/work/project/series-plan.json' });
    const reloaded = await Project.load(rt, 'project');
    expect(reloaded.manifest.seriesPlan).toEqual({ path: 'series-plan.json', sha256: seriesPlan.digest(examplePlan()) });
    expect(reloaded.manifest.seriesReview).toBeUndefined();
    expect(JSON.parse(await rt.fs.readText('/work/project/series-plan.json'))).toEqual(examplePlan());
  });

  it('refuses a plan for other pages, a missing file and a file that is not JSON (exit 2)', async () => {
    const rt = await newRuntime();
    await newProject(rt); // one page only
    await rt.fs.writeFile('/work/plan.json', JSON.stringify(examplePlan()));
    expect((await runCli(rt, ['plan', '--dir', 'project', '--file', 'plan.json'])).code).toBe(2);
    expect(rt.json()).toEqual({ ok: false, error: 'plan page ids/order differ from project' });
    expect((await runCli(rt, ['plan', '--dir', 'project', '--file', 'nope.json'])).code).toBe(2);
    expect(rt.json().error).toBe("[Errno 2] No such file or directory: 'nope.json'");
    await rt.fs.writeFile('/work/bad.json', '{not json');
    expect((await runCli(rt, ['plan', '--dir', 'project', '--file', 'bad.json'])).code).toBe(2);
    expect((await runCli(rt, ['plan', '--dir', 'project', '--file', '/work'])).code).toBe(2);
    expect(rt.json().error).toBe("[Errno 21] Is a directory: '/work'");
  });

  it('writes one composition prompt for the whole sheet and generates nothing', async () => {
    const rt = await newRuntime();
    await newProjectWithPages(rt);
    await rt.fs.writeFile('/work/plan.json', JSON.stringify(examplePlan()));
    await runCli(rt, ['plan', '--dir', 'project', '--file', 'plan.json']);
    const { code } = await runCli(rt, ['series', 'prompt', '--dir', 'project']);
    expect(code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, count: 1, panels: 4, generated: false, promptFile: '/work/project/reference/composition-prompt.md' });
    const prompt = await rt.fs.readText('/work/project/reference/composition-prompt.md');
    expect(sha256(prompt)).toBe('c4f7e6422d19e8a9a58b299976c8d6c2040383bc5ca1d7ac9dcaca909c70de27'); // the Python wording plus the page proportion
    for (const page of examplePlan().pages) expect(prompt).toContain(`exact planned copy ${JSON.stringify(page.copy)}`);
    expect(prompt).toContain('arranged in 2 columns and 2 rows');
    expect(prompt).toContain('next-page motivation deliver the payoff and finish.');
    expect((await Project.load(rt, 'project')).manifest.concept).toMatchObject({ status: 'awaits_asset', prompt: 'reference/composition-prompt.md', imageCount: 1 });
  });

  it('lays the sheet out for the pages it holds: three 9:16 pages are one row of three, not a square grid', async () => {
    const rt = await newRuntime();
    await newProjectWithPages(rt, 3, 'project', 1080, 1920);
    const plan = examplePlan();
    plan.pages = plan.pages.slice(0, 3);
    await rt.fs.writeFile('/work/plan.json', JSON.stringify(plan));
    expect((await runCli(rt, ['plan', '--dir', 'project', '--file', 'plan.json'])).code).toBe(0);
    expect((await runCli(rt, ['series', 'prompt', '--dir', 'project'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, panels: 3, grid: { columns: 3, rows: 1 }, aspect: '16:9', pageAspect: '9:16' });
    const prompt = await rt.fs.readText('/work/project/reference/composition-prompt.md');
    expect(prompt).toContain('arranged in 3 columns and 1 row');
    expect(prompt).toContain("Draw every panel in the pages' own 9:16 proportion, so no page is squeezed or stretched");
    expect(prompt).not.toContain('2 columns');
    // what `image prepare` reads to agree with the prompt
    expect((await Project.load(rt, 'project')).manifest.concept).toMatchObject({ grid: { columns: 3, rows: 1 }, aspect: '16:9' });
  });

  it('designs the grid for a sheet ratio the model makes when asked (--aspect), and refuses anything that is not W:H', async () => {
    const rt = await newRuntime();
    await newProjectWithPages(rt, 3, 'project', 1080, 1920);
    const plan = examplePlan();
    plan.pages = plan.pages.slice(0, 3);
    await rt.fs.writeFile('/work/plan.json', JSON.stringify(plan));
    await runCli(rt, ['plan', '--dir', 'project', '--file', 'plan.json']);
    expect((await runCli(rt, ['series', 'prompt', '--dir', 'project', '--aspect', '9:16'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ grid: { columns: 2, rows: 2 }, aspect: '9:16' });
    expect(await rt.fs.readText('/work/project/reference/composition-prompt.md')).toContain('arranged in 2 columns and 2 rows');
    expect((await runCli(rt, ['series', 'prompt', '--dir', 'project', '--aspect', 'wide'])).code).toBe(2);
    expect(rt.json().error).toBe('--aspect must be W:H, for example 16:9 or 9:16');
  });

  it('needs a plan, and a reproduction (strict) project has no composition step', async () => {
    const rt = await newRuntime();
    await newProject(rt);
    expect((await runCli(rt, ['series', 'prompt', '--dir', 'project'])).code).toBe(2);
    expect(rt.json().error).toBe('schema must be popost-series.v1');
    await runCli(rt, ['init', '--dir', 'strict', '--brief', 'b', '--mode', 'strict']);
    expect((await runCli(rt, ['series', 'prompt', '--dir', 'strict'])).code).toBe(2);
    expect(rt.json().error).toBe('reproduction uses supplied references, no composition generation');
    expect((await runCli(rt, ['series', 'other', '--dir', 'project'])).code).toBe(2);
  });
});
