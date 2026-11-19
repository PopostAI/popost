/**
 * `reference`, `review`, `build` and `settings` (ports of test_popost_workflow.py). The series plan, the project ZIP, the
 * template commands and the post bundle have their own files.
 */
import { describe, expect, it } from 'vitest';
import { pageFingerprint } from '../src/core/fingerprint';
import { Project } from '../src/core/project';
import { sha256 } from '../src/core/util';
import { buildProject } from '../src/workflow/build';
import * as seriesPlan from '../src/workflow/series-plan';
import { runCli } from '../src/testing/memory';
import { examplePlan, forgeRender, newProject, newProjectWithPages, newRuntime, PNG_1X1, pageHtml } from './workflow-helpers';

const NOTE = '实际制作原生排版，测试不调用收费模型';

describe('reference', () => {
  it('registers local images as references, never as artwork', async () => {
    const rt = await newRuntime();
    await newProject(rt);
    await rt.fs.writeFile('/work/input.png', PNG_1X1);
    const { code } = await runCli(rt, ['reference', '--dir', 'project', '--file', 'input.png', '--role', 'style', '--page', 'p1']);
    expect(code).toBe(0);
    const digest = sha256(PNG_1X1);
    expect(rt.json()).toEqual({
      ok: true,
      references: [{ kind: 'local-reference', path: `reference/${digest.slice(0, 16)}.png`, role: 'style', pageId: 'p1', sha256: digest }],
    });
    const project = await Project.load(rt, 'project');
    expect(project.manifest.assets).toEqual([]);
    expect(await rt.fs.readFile(`/work/project/reference/${digest.slice(0, 16)}.png`)).toEqual(PNG_1X1);
  });

  it('takes several files at once and keeps the extension lower-cased', async () => {
    const rt = await newRuntime();
    await newProject(rt);
    await rt.fs.writeFile('/work/a.PNG', PNG_1X1);
    await rt.fs.writeFile('/work/b.png', PNG_1X1);
    expect((await runCli(rt, ['reference', '--dir', 'project', '--file', 'a.PNG', 'b.png'])).code).toBe(0);
    const refs = rt.json().references as { path: string; role: string; pageId: null }[];
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.path.slice(-4))).toEqual(['.png', '.png']);
    expect(refs[0]).toMatchObject({ role: 'layout', pageId: null });
  });

  it('reports a missing file, a directory, text and a bad role as errors', async () => {
    const rt = await newRuntime();
    await newProject(rt);
    await rt.fs.writeFile('/work/notimg.png', 'not an image');
    expect((await runCli(rt, ['reference', '--dir', 'project', '--file', 'nope.png'])).code).toBe(2);
    expect(rt.json().error).toBe('file not found: nope.png');
    expect((await runCli(rt, ['reference', '--dir', 'project', '--file', 'notimg.png'])).code).toBe(2);
    expect(rt.json().error).toBe('not a readable picture file: notimg.png');
    expect((await runCli(rt, ['reference', '--dir', 'project', '--file', 'project'])).code).toBe(2);
    expect(rt.json().error).toBe('project is a folder, not a file');
    const role = await runCli(rt, ['reference', '--dir', 'project', '--file', 'notimg.png', '--role', 'bogus']);
    expect(role.code).toBe(2);
    expect(role.stderr).toContain("invalid choice: 'bogus'");
    expect((await Project.load(rt, 'project')).manifest.sources).toEqual([]);
  });

  it('allows one composition contact sheet per series, and a strict project takes its reference as the fixture', async () => {
    const rt = await newRuntime();
    const project = await newProject(rt);
    await rt.fs.writeFile('/work/input.png', PNG_1X1);
    await project.importReference('input.png');
    expect(project.manifest.concept.status).toBe('pending');
    await project.importReference('input.png', 'layout', null, true);
    await expect(project.importReference('input.png', 'layout', null, true)).rejects.toThrow('one composition contact sheet per series');
    await runCli(rt, ['init', '--dir', 'strict', '--brief', 'b', '--mode', 'strict']);
    await runCli(rt, ['reference', '--dir', 'strict', '--file', 'input.png']);
    const strict = await Project.load(rt, 'strict');
    expect(strict.manifest.concept).toMatchObject({ status: 'reviewed', fixture: `reference/${sha256(PNG_1X1).slice(0, 16)}.png` });
  });
});

describe('review', () => {
  it('records findings bound to the current render', async () => {
    const rt = await newRuntime();
    const project = await newProject(rt);
    await project.writePageHtml('p1', pageHtml());
    await forgeRender(rt, project, 'p1');
    expect((await runCli(rt, ['review', '--dir', 'project', '--page', 'p1', '--note', '读图确认标题完整、位置和层级清楚'])).code).toBe(0);
    const result = rt.json();
    expect(result).toMatchObject({ ok: true, reviewer: 'agent', note: '读图确认标题完整、位置和层级清楚' });
    expect((await Project.load(rt, 'project')).manifest.reviews.p1).toEqual({
      reviewer: 'agent',
      note: '读图确认标题完整、位置和层级清楚',
      fingerprint: await pageFingerprint(project, 'p1'),
      pngHash: result.pngHash,
    });
  });

  it('needs a render, real findings and a render that is still current', async () => {
    const rt = await newRuntime();
    const project = await newProject(rt);
    expect((await runCli(rt, ['review', '--dir', 'project', '--page', 'p1', '--note', 'n'])).code).toBe(2);
    expect(rt.json().error).toBe('render this page before reviewing it');
    expect((await runCli(rt, ['review', '--dir', 'project', '--page', 'p1', '--note', '  '])).code).toBe(2);
    expect(rt.json().error).toBe('actual visual findings are required');
    await forgeRender(rt, project, 'p1');
    await project.writePageHtml('p1', pageHtml('内容已修改'));
    expect((await runCli(rt, ['review', '--dir', 'project', '--page', 'p1', '--note', 'cannot review stale png'])).code).toBe(2);
    expect(rt.json().error).toBe('render is stale; rerender before actual visual review');
    await rt.fs.writeFile('/work/project/exports/p1.render.json', '{}');
    expect((await runCli(rt, ['review', '--dir', 'project', '--page', 'p1', '--note', 'n'])).code).toBe(2);
    expect(rt.json().error).toBe('exports/p1.render.json has no "fingerprint" field');
  });

  it('treats an unknown page as a broken invocation (exit 1), not as user input', async () => {
    const rt = await newRuntime();
    await newProject(rt);
    expect((await runCli(rt, ['review', '--dir', 'project', '--page', 'nope', '--note', 'n'])).code).toBe(1);
    expect(String(rt.json().error)).toContain('no such page: nope');
  });

  it('reviews the sequence against the plan and every page fingerprint', async () => {
    const rt = await newRuntime();
    const project = await newProjectWithPages(rt);
    expect((await runCli(rt, ['review', '--dir', 'project', '--page', 'series', '--note', 'n'])).code).toBe(2);
    expect(rt.json().error).toBe('attach a series plan before reviewing the sequence');
    await seriesPlan.save(project, examplePlan());
    expect((await runCli(rt, ['review', '--dir', 'project', '--page', 'series', '--note', '整组读图'])).code).toBe(0);
    const review = rt.json();
    expect(review).toMatchObject({ reviewer: 'agent', note: '整组读图', planHash: seriesPlan.digest(examplePlan()) });
    expect(Object.keys(review.pages as object)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect((await Project.load(rt, 'project')).manifest.seriesReview).toEqual({ ...review, ok: undefined });
  });
});

describe('build', () => {
  const finish = async (rt: Awaited<ReturnType<typeof newRuntime>>) => {
    const project = await newProject(rt);
    const plan = { ...examplePlan(), pages: examplePlan().pages.slice(0, 1), concept: { enabled: false, reason: 'native typography fixture', imageCount: 1 } };
    await seriesPlan.save(project, plan);
    await project.appendDesignNote(NOTE);
    await project.writePageHtml('p1', pageHtml());
    await forgeRender(rt, project, 'p1');
    return project;
  };

  it('is ready to deliver only while the reviews match the current pages', async () => {
    const rt = await newRuntime();
    const project = await finish(rt);
    expect((await runCli(rt, ['review', '--dir', 'project', '--page', 'p1', '--note', '读图确认'])).code).toBe(0);
    expect((await runCli(rt, ['review', '--dir', 'project', '--page', 'series', '--note', '整组读图'])).code).toBe(0);
    expect((await runCli(rt, ['build', '--dir', 'project'])).code).toBe(0);
    expect(rt.json().build).toMatchObject({ structureReady: true, visualQa: 'reviewed-by-agent', readyToDeliver: true, blockers: [], reviewGaps: [] });
    expect(JSON.parse(await rt.fs.readText('/work/project/build-report.json'))).toMatchObject({ readyToDeliver: true });
    await project.writePageHtml('p1', pageHtml('内容已修改'));
    expect((await buildProject(await Project.load(rt, 'project'))).readyToDeliver).toBe(false);
  });

  it('names the review commands to run, with their real flags, for a page and for the series', async () => {
    const rt = await newRuntime();
    await finish(rt);
    await runCli(rt, ['build', '--dir', 'project']);
    const gaps = (rt.json().build as { reviewGaps: string[] }).reviewGaps;
    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toMatch(/^p1: no review of the current version: .*popost review --dir \/work\/project --page p1 --note "/);
    expect(gaps[1]).toMatch(/^series: no review of the current plan and pages: .*popost review --dir \/work\/project --page series --note "/);
    expect(gaps.join('')).not.toMatch(/[\u4e00-\u9fff]/);
    // what the messages ask for is accepted, and the gaps are gone
    expect((await runCli(rt, ['review', '--dir', '/work/project', '--page', 'p1', '--note', '读图确认'])).code).toBe(0);
    expect((await runCli(rt, ['review', '--dir', '/work/project', '--page', 'series', '--note', '整组读图'])).code).toBe(0);
    await runCli(rt, ['build', '--dir', 'project']);
    expect((rt.json().build as { reviewGaps: string[] }).reviewGaps).toEqual([]);
  });

  it('lists what blocks a fresh project, then what is left to look at (exit 2 until the structure is ready)', async () => {
    const rt = await newRuntime();
    await newProject(rt);
    expect((await runCli(rt, ['build', '--dir', 'project'])).code).toBe(2);
    expect(rt.json().build).toMatchObject({
      structureReady: false,
      visualQa: 'pending',
      readyToDeliver: false,
      blockers: [
        'the starter is not finished: design.md has no real design observation',
        'no series-plan.json: settle the hook, what each page adds, why the reader swipes on, the payoff and the CTA first',
        'concept pending: the series needs its one composition reference, or a recorded reason for going without one',
        'page p1 still has placeholder text that was never replaced',
      ],
      reviewGaps: [
        'p1: no review of the current version: look at its current render (popost render --dir /work/project --page p1 first if the PNG is missing or stale), ' +
          'then record it with popost review --dir /work/project --page p1 --note "what you checked and improved"',
      ],
    });
    await runCli(rt, ['design', '--dir', 'project', '--note', 'read png: two bars visible']);
    await runCli(rt, ['build', '--dir', 'project', '--concept-off']);
    const blockers = (rt.json().build as { blockers: string[] }).blockers.join('|');
    expect(blockers).not.toContain('starter');
    expect(blockers).not.toContain('concept pending');
  });

  it('needs a reference fixture in strict mode, and notices a reference that changed or went missing', async () => {
    const rt = await newRuntime();
    await runCli(rt, ['init', '--dir', 'strict', '--brief', 'b', '--mode', 'strict']);
    await runCli(rt, ['design', '--dir', 'strict', '--note', 'read png']);
    expect((await runCli(rt, ['build', '--dir', 'strict'])).code).toBe(2);
    expect((rt.json().build as { blockers: string[] }).blockers).toContain('strict mode has no local reference asset');
    await rt.fs.writeFile('/work/input.png', PNG_1X1);
    await runCli(rt, ['reference', '--dir', 'strict', '--file', 'input.png']);
    const reference = (rt.json().references as { path: string }[])[0]!.path;
    await runCli(rt, ['build', '--dir', 'strict']);
    expect((rt.json().build as { blockers: string[] }).blockers).not.toContain('strict mode has no local reference asset');
    await rt.fs.writeFile(`/work/strict/${reference}`, 'changed');
    await runCli(rt, ['build', '--dir', 'strict']);
    expect((rt.json().build as { blockers: string[] }).blockers).toContain('a reference file is missing or changed: look at it again and register it again');
    await rt.fs.rm(`/work/strict/${reference}`);
    await runCli(rt, ['build', '--dir', 'strict']);
    expect((rt.json().build as { blockers: string[] }).blockers).toContain('a reference file is missing or changed: look at it again and register it again');
  });

  it('flags scripts, missing layers, duplicate layer ids and leftover starter text', async () => {
    const rt = await newRuntime();
    const project = await newProject(rt);
    const blockersFor = async (html: string) => {
      await project.writePageHtml('p1', html);
      return (await buildProject(project, true)).blockers.filter((b) => b.startsWith('page p1'));
    };
    expect(await blockersFor('<div class="post"><script>x()</script></div>')).toEqual(['page p1 contains <script>', 'page p1 has no editable semantic layers']);
    expect(await blockersFor('<div class="post"><b data-layer-id="a"></b><i data-layer-id="a"></i></div>')).toEqual(['page p1 has duplicate layer ids']);
    expect(await blockersFor('<div class="post"><b data-layer-id="a">My Page 1 ok</b></div>')).toEqual([]);
    expect(await blockersFor('<div class="post"><h1 data-layer-id="a">Page 1</h1></div>')).toEqual(['page p1 still has placeholder text that was never replaced']);
    expect(await blockersFor('<div class="post"><p data-layer-id="a">Edit this live text layer.</p></div>')).toEqual(['page p1 still has placeholder text that was never replaced']);
    expect(await blockersFor('<div class=post data-layer-id=a><!-- <div class="x"> --></div>')).toEqual([]);
    expect(await blockersFor('<div class="my-post" data-layer-id="a"></div>')).toEqual(['page p1 has no class=post/page root']);
    expect(await blockersFor('<div class="x  page" data-layer-id="a"></div>')).toEqual([]);
  });
});

describe('settings', () => {
  it('sets platform, language and the image channel; unset flags keep what was there', async () => {
    const rt = await newRuntime();
    await newProject(rt);
    expect((await runCli(rt, ['settings', '--dir', 'project', '--platform', 'xiaohongshu', '--language', 'zh', '--channel', 'host', '--model', 'm1'])).code).toBe(0);
    expect(rt.json()).toEqual({ ok: true, provider: { channel: 'host', model: 'm1' } });
    await runCli(rt, ['settings', '--dir', 'project', '--model', 'm2']);
    expect(rt.json().provider).toEqual({ channel: 'host', model: 'm2' });
    const manifest = (await Project.load(rt, 'project')).manifest;
    expect(manifest).toMatchObject({ platform: 'xiaohongshu', language: 'zh' });
    expect((await runCli(rt, ['settings', '--dir', 'project', '--platform', 'wechat'])).code).toBe(2);
    expect((await runCli(rt, ['settings', '--dir', 'project', '--channel', 'free'])).code).toBe(2);
  });
});
