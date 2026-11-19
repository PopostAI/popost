/** `init`, `page`, `design`, `concept`, `import-concept`, `attach-*`, `doctor` (ports of test_studio_v2.py and friends). */
import { describe, expect, it } from 'vitest';
import { Project, SCHEMA } from '../src/core/project';
import { sha256 } from '../src/core/util';
import { buildProject } from '../src/workflow/build';
import { newProject, newRuntime, PNG_1X1 } from './workflow-helpers';
import { runCli } from '../src/testing/memory';

describe('init and design', () => {
  it('creates a v2 project whose design.md carries the brief', async () => {
    const rt = await newRuntime();
    const { code } = await runCli(rt, ['init', '--dir', 'proj', '--brief', 'two bars after gym', '--mode', 'original']);
    expect(code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, mode: 'original', pages: ['p1'], manifest: '/work/proj/social-studio-project.json' });
    const project = await Project.load(rt, 'proj');
    expect(project.manifest.schema).toBe(SCHEMA);
    expect(project.manifest.workflowVersion).toBe(3);
    const design = await rt.fs.readText(project.designMd);
    expect(design).toContain('two bars after gym');
    expect(design).toContain('init: design.md 初稿来自 brief');
  });

  it('honours --width / --height and refuses a non-empty directory', async () => {
    const rt = await newRuntime();
    await runCli(rt, ['init', '--dir', 'proj', '--brief', 'b', '--width', '1080', '--height', '1440']);
    expect((await Project.load(rt, 'proj')).manifest.pages[0]).toMatchObject({ width: 1080, height: 1440 });
    const again = await runCli(rt, ['init', '--dir', 'proj', '--brief', 'b']);
    expect(again.code).toBe(1); // the Python CLI died with a traceback (1); the generic handler reports it as JSON
    expect(rt.json().ok).toBe(false);
  });

  it('appends design notes', async () => {
    const rt = await newRuntime();
    await newProject(rt);
    const { code } = await runCli(rt, ['design', '--dir', 'project', '--note', 'read png: two bars visible']);
    expect(code).toBe(0);
    expect(rt.json()).toEqual({ ok: true, appended: 'read png: two bars visible' });
    expect(await rt.fs.readText('/work/project/design.md')).toMatch(/\n- read png: two bars visible\n$/);
  });
});

describe('page', () => {
  it('adds pages with generated ids and lists them', async () => {
    const rt = await newRuntime();
    await newProject(rt);
    expect((await runCli(rt, ['page', 'add', '--dir', 'project'])).code).toBe(0);
    expect(rt.json()).toEqual({ ok: true, added: 'p2' });
    await runCli(rt, ['page', 'add', '--dir', 'project', '--id', 'cover', '--name', 'Cover', '--width', '1080', '--height', '1080']);
    await runCli(rt, ['page', 'ls', '--dir', 'project']);
    const pages = rt.json().pages as { id: string; name: string; width: number; height: number }[];
    expect(pages.map((p) => p.id)).toEqual(['p1', 'p2', 'cover']);
    expect(pages[2]).toMatchObject({ name: 'Cover', width: 1080, height: 1080 });
  });

  it('keeps the page order the manifest was saved with', async () => {
    const rt = await newRuntime();
    const project = await newProject(rt);
    await runCli(rt, ['page', 'add', '--dir', 'project', '--id', 'p2']);
    const reloaded = await Project.load(rt, 'project');
    reloaded.manifest.pages = ['p2', 'p1'].map((id) => ({ id, name: id, htmlPath: `pages/${id}.html`, width: 1080, height: 1350 }));
    await reloaded.saveManifest();
    expect((await Project.load(rt, project.root)).manifest.pages.map((p) => p.id)).toEqual(['p2', 'p1']);
  });

  it('rejects unsafe ids and bad choices', async () => {
    const rt = await newRuntime();
    await newProject(rt);
    expect((await runCli(rt, ['page', 'add', '--dir', 'project', '--id', '../x'])).code).toBe(1);
    const bad = await runCli(rt, ['page', 'rm', '--dir', 'project']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('invalid choice');
  });
});

describe('concept', () => {
  it('records the enhanced prompt as awaits_asset and rejects strict projects', async () => {
    const rt = await newRuntime();
    await newProject(rt);
    expect((await runCli(rt, ['concept', '--dir', 'project', '--prompt', 'enhanced x'])).code).toBe(0);
    expect(rt.json()).toEqual({ ok: true, status: 'awaits_asset', prompt: 'enhanced x' });
    expect((await Project.load(rt, 'project')).manifest.concept).toMatchObject({ status: 'awaits_asset', prompt: 'enhanced x' });
    await runCli(rt, ['init', '--dir', 'strict', '--brief', 'b', '--mode', 'strict']);
    const strict = await runCli(rt, ['concept', '--dir', 'strict', '--prompt', 'x']);
    expect(strict.code).toBe(2);
    expect(strict.stdout).toContain('strict');
  });

  it('imports the one composition reference with its review', async () => {
    const rt = await newRuntime();
    await newProject(rt);
    await rt.fs.writeFile('/work/ref.png', PNG_1X1);
    const { code } = await runCli(rt, ['import-concept', '--dir', 'project', '--file', 'ref.png', '--review', 'two bars visible']);
    expect(code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, status: 'reviewed', reference: { kind: 'composition', path: 'reference/composition-reference.png' } });
    const project = await Project.load(rt, 'project');
    expect(project.manifest.concept).toMatchObject({ status: 'reviewed', fixture: 'reference/composition-reference.png', imageCount: 1 });
    expect(await rt.fs.readText(project.designMd)).toContain('two bars visible');
    // a second contact sheet is refused, and `concept` refuses once one exists
    expect((await runCli(rt, ['import-concept', '--dir', 'project', '--file', 'ref.png', '--review', 'again'])).code).toBe(1);
    const reuse = await runCli(rt, ['concept', '--dir', 'project', '--prompt', 'p']);
    expect(reuse.code).toBe(2);
    expect(rt.json().error).toBe('reuse the one existing composition reference');
  });
});

describe('attach-template and attach-bundle', () => {
  it('attaches a scene Skill with its hash and notes it in design.md', async () => {
    const rt = await newRuntime();
    await newProject(rt);
    await rt.fs.writeFile('/work/tpl/SKILL.md', '---\nname: demo-tpl\nversion: 1.0\n---\n# tpl\n');
    await rt.fs.mkdir('/work/tpl/references');
    const { code, stdout } = await runCli(rt, ['attach-template', '--dir', 'project', '--path', 'tpl', '--authorized']);
    expect(code).toBe(0);
    expect(stdout).toContain('attached');
    expect(rt.json()).toEqual({ ok: true, attached: 'tpl' });
    const source = (await Project.load(rt, 'project')).manifest.sources[0]!;
    expect(source).toMatchObject({ kind: 'template', path: 'tpl', version: '1.0', authorized: true });
    expect(source.note).toBe(`tpl v1.0 sha=${String(source.sha256).slice(0, 12)} refs=0`);
    expect(await rt.fs.readText('/work/project/design.md')).toContain('- template: tpl v1.0 (0 refs)');
  });

  it('reports a missing SKILL.md as an error', async () => {
    const rt = await newRuntime();
    await newProject(rt);
    await rt.fs.mkdir('/work/empty');
    const { code } = await runCli(rt, ['attach-template', '--dir', 'project', '--path', 'empty']);
    expect(code).toBe(2);
    expect(String(rt.json().error)).toContain('SKILL.md 缺失');
  });

  it('records a post bundle file by hash', async () => {
    const rt = await newRuntime();
    await newProject(rt);
    await rt.fs.writeFile('/work/bundle.json', '{"x":1}');
    expect((await runCli(rt, ['attach-bundle', '--dir', 'project', '--bundle', 'bundle.json'])).code).toBe(0);
    const digest = sha256('{"x":1}');
    expect((await Project.load(rt, 'project')).manifest.sources[0]).toEqual({
      kind: 'bundle-url',
      note: `bundle bundle.json sha=${digest.slice(0, 12)}`,
      bundlePath: 'bundle.json',
      sha256: digest,
    });
  });
});

describe('doctor and usage', () => {
  it('reports the project and what the environment can do', async () => {
    const rt = await newRuntime();
    await newProject(rt);
    expect((await runCli(rt, ['doctor', '--dir', 'project'])).code).toBe(0);
    const doctor = rt.json().doctor as Record<string, unknown> & { fonts: { library: unknown } };
    expect(doctor).toMatchObject({ mode: 'original', pages: ['p1'], assets: 0, planAttached: false, deps: { playwright: true, localProcesses: false }, editorHost: null });
    expect(doctor.fonts.library).toEqual({ available: false, roles: [] });
  });

  it('exits 2 with usage on bad arguments, 0 on --help', async () => {
    const rt = await newRuntime();
    const missing = await runCli(rt, ['init', '--dir', 'p']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('the following arguments are required: --brief');
    expect((await runCli(rt, ['init', '--dir', 'p', '--brief', 'b', '--mode', 'loose'])).stderr).toContain('invalid choice');
    expect((await runCli(rt, ['init', '--width', 'x', '--dir', 'p', '--brief', 'b'])).stderr).toContain('invalid int value');
    const help = await runCli(rt, ['build', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--concept-off');
  });

  it('fails clearly on a directory that is not a project', async () => {
    const rt = await newRuntime();
    await rt.fs.mkdir('/work/nothing');
    const { code } = await runCli(rt, ['design', '--dir', 'nothing', '--note', 'n']);
    expect(code).toBe(1);
    expect(String(rt.json().error)).toContain('不是 v2 工程');
  });
});

describe('page HTML used by build', () => {
  it('needs a class=post/page root: a CSS rule alone is not one', async () => {
    const rt = await newRuntime();
    const project = await newProject(rt);
    await project.writePageHtml('p1', '<html><body><div class="post"><h1>x</h1></div></body></html>');
    expect((await buildProject(project, true)).blockers.join('')).not.toContain('缺 class');
    await project.writePageHtml('p1', '<html><head><style>.post{color:red}</style></head><body><div><h1>x</h1></div></body></html>');
    expect((await buildProject(project, true)).blockers.some((b) => b.includes('缺 class'))).toBe(true);
  });
});
