/** `font list` / `font install`: the library, the local and downloaded sources, and what a project records. */
import { describe, expect, it } from 'vitest';
import { Project } from '../src/core/project';
import { createTestRuntime, mountPackageFiles, runCli, type FetchHandler } from '../src/testing/memory';
import { demoRole, mountLibrary, type DemoRole } from './font-helpers';
import { newProject, newRuntime } from './workflow-helpers';

const runtimeWith = async (
  roles: readonly DemoRole[],
  options: { withFiles?: boolean; env?: Record<string, string>; fetchHandler?: FetchHandler } = {},
) => {
  const base = await newRuntime();
  const rt = createTestRuntime({ fs: base.fs, env: options.env ?? {}, fetchHandler: options.fetchHandler });
  const digest = await mountLibrary(rt, roles, options.withFiles ?? true);
  return { rt, digest };
};

describe('font list', () => {
  it('prints the roles of the palette', async () => {
    const roles = [demoRole('serif-a'), demoRole('sans-b', 1)];
    const { rt } = await runtimeWith(roles);
    expect((await runCli(rt, ['font', 'list'])).code).toBe(0);
    const printed = rt.json() as { ok: boolean; roles: { id: string }[] };
    expect(printed.ok).toBe(true);
    expect(printed.roles.map((r) => r.id)).toEqual(['serif-a', 'sans-b']);
  });

  it('lists the roles of the real palette that ships with the package', async () => {
    const rt = await newRuntime();
    await mountPackageFiles(rt.fs, ['assets/fonts/palette.json']);
    expect((await runCli(rt, ['font', 'list'])).code).toBe(0);
    const roles = (rt.json() as { roles: { id: string; assetSha256: object }[] }).roles;
    expect(roles.length).toBeGreaterThanOrEqual(41);
    expect(roles.map((r) => r.id)).toContain('editorial-serif');
  });

  it('fails clearly when the library is missing', async () => {
    const rt = await newRuntime();
    expect((await runCli(rt, ['font', 'list'])).code).toBe(1);
    expect(String(rt.json().error)).toContain('font palette not found');
  });

  it('answers usage errors with exit 2', async () => {
    const { rt } = await runtimeWith([demoRole('a')]);
    expect((await runCli(rt, ['font'])).code).toBe(2);
    expect((await runCli(rt, ['font', 'remove'])).code).toBe(2);
  });
});

describe('font install from the Skill checkout', () => {
  it('copies the role into the project, links its CSS from every page and records it', async () => {
    const role = demoRole('serif-a');
    const { rt } = await runtimeWith([role]);
    const project = await newProject(rt, 'P');
    await project.addPage('p2', 'Two');
    const { code } = await runCli(rt, ['font', 'install', '--dir', 'P', '--roles', 'serif-a']);
    expect(code).toBe(0);
    const out = rt.json() as { ok: boolean; cssInjected: boolean; installed: { installed: Record<string, unknown>[]; totalBytes: number } };
    expect(out).toMatchObject({ ok: true, cssInjected: true, links: '<link rel="stylesheet" href="../css/serif-a.css">' });
    expect(out.installed.installed[0]).toMatchObject({
      id: 'serif-a',
      family: 'Family serif-a',
      cssPath: 'css/serif-a.css',
      licensePath: 'fonts/serif-a/LICENSE',
      fileCount: 2,
    });

    for (const [name, data] of Object.entries(role.files)) expect(await rt.fs.readFile(`/work/P/fonts/serif-a/${name}`)).toEqual(data);
    expect(await rt.fs.readText('/work/P/fonts/serif-a/LICENSE')).toBe(role.license);
    expect(await rt.fs.readText('/work/P/css/serif-a.css')).toContain("url('../fonts/serif-a/serif-a-0.woff2')");
    expect(await rt.fs.readText('/work/P/css/chosen.css')).toContain('/* === serif-a · Family serif-a === */');
    const fontsManifest = JSON.parse(await rt.fs.readText('/work/P/fonts-manifest.json')) as { version: string; installed_roles: { id: string }[] };
    expect(fontsManifest).toMatchObject({ version: '2.0.0', installed_roles: [{ id: 'serif-a' }] });

    const reloaded = await Project.load(rt, 'P');
    expect(reloaded.manifest.fonts.map((f) => f.id)).toEqual(['serif-a']);
    expect(reloaded.manifest.fonts[0]).toMatchObject({ cssFamily: 'Family serif-a', cssPath: 'css/serif-a.css' });
    for (const pid of ['p1', 'p2'])
      expect(await reloaded.readPageHtml(pid)).toContain('<link rel="stylesheet" href="../css/serif-a.css"></head>');
  });

  it('keeps earlier roles when another is added, and links each font once', async () => {
    const { rt } = await runtimeWith([demoRole('serif-a'), demoRole('sans-b', 1)]);
    await newProject(rt, 'P');
    await runCli(rt, ['font', 'install', '--dir', 'P', '--roles', 'serif-a']);
    await runCli(rt, ['font', 'install', '--dir', 'P', '--roles', 'sans-b,serif-a']);
    const printed = rt.json() as { installed: { totalInstalled: number } };
    expect(printed.installed.totalInstalled).toBe(2);
    const manifest = JSON.parse(await rt.fs.readText('/work/P/fonts-manifest.json')) as { installed_roles: { id: string }[] };
    expect(manifest.installed_roles.map((r) => r.id).sort()).toEqual(['sans-b', 'serif-a']);
    const html = await (await Project.load(rt, 'P')).readPageHtml('p1');
    expect(html.match(/href="\.\.\/css\/serif-a\.css"/g)).toHaveLength(1);
    expect(html).toContain('../css/sans-b.css');
    expect(await rt.fs.readText('/work/P/css/chosen.css')).toContain('sans-b');
  });

  it('rejects unknown roles before touching the project', async () => {
    const { rt } = await runtimeWith([demoRole('serif-a')]);
    await newProject(rt, 'P');
    const result = await runCli(rt, ['font', 'install', '--dir', 'P', '--roles', 'serif-a,nope']);
    expect(result.code).toBe(1);
    expect(String(rt.json().error)).toContain('unknown font roles: nope');
    expect(await rt.fs.stat('/work/P/fonts')).toBeNull();
  });

  it('does not leave fonts behind in a directory that is not a project', async () => {
    const { rt } = await runtimeWith([demoRole('serif-a')]);
    const result = await runCli(rt, ['font', 'install', '--dir', 'plain', '--roles', 'serif-a']);
    expect(result.code).toBe(1);
    expect(await rt.fs.stat('/work/plain')).toBeNull();
  });
});

describe('font install: Chinese roles in a project whose copy is not Chinese', () => {
  const WARNING = (language: string) =>
    `cjk-sans is a Chinese font role, but this project's copy language is ${language}: its stylesheet is large and the export repeats it on every page; install it only if the copy has Chinese text.`;

  const installed = async (language: string | null, roles = 'cjk-sans') => {
    const { rt } = await runtimeWith([demoRole('cjk-sans'), demoRole('cjk-serif', 1), demoRole('latin-inter', 1)]);
    await newProject(rt, 'P');
    if (language) await runCli(rt, ['settings', '--dir', 'P', '--language', language]);
    const { code } = await runCli(rt, ['font', 'install', '--dir', 'P', '--roles', roles]);
    expect(code).toBe(0);
    return { rt, out: rt.json() as { ok: boolean; installed: { installed: { id: string }[] }; warnings?: string[] } };
  };

  it('warns, but still installs, when the project language is English', async () => {
    const { rt, out } = await installed('en');
    expect(out.ok).toBe(true);
    expect(out.warnings).toEqual([WARNING('en')]);
    expect(out.installed.installed.map((role) => role.id)).toEqual(['cjk-sans']);
    expect((await Project.load(rt, 'P')).manifest.fonts.map((font) => font.id)).toEqual(['cjk-sans']);
    expect(await rt.fs.readText('/work/P/css/cjk-sans.css')).toContain('Family cjk-sans');
  });

  it('warns once per Chinese role and not for the others', async () => {
    const { out } = await installed('en-US', 'latin-inter,cjk-sans,cjk-serif');
    expect(out.warnings).toEqual([WARNING('en-US'), WARNING('en-US').replace('cjk-sans', 'cjk-serif')]);
  });

  it('says nothing for a Chinese project, an unknown language, or roles that are not Chinese', async () => {
    for (const language of ['zh', 'zh-CN', 'zh_TW', 'ZH-hans', 'en+zh', 'Chinese', '中文']) expect((await installed(language)).out.warnings, language).toBeUndefined();
    expect((await installed(null)).out.warnings).toBeUndefined();
    expect((await installed('en', 'latin-inter')).out.warnings).toBeUndefined();
  });
});

describe('font install from the public font bucket', () => {
  const serve = (roles: readonly DemoRole[], urls: string[]): FetchHandler => (request) => {
    urls.push(request.url);
    const match = /\/(?:@)?[0-9a-f]{12}\/([^/]+)\/(.+)$/.exec(request.url);
    const data = match && roles.find((r) => r.id === match[1])?.files[match[2]!];
    return data ? new Response(data.slice()) : new Response('missing', { status: 404 });
  };

  it('downloads the files the package does not ship from the public bucket version', async () => {
    const role = demoRole('serif-a');
    const urls: string[] = [];
    const { rt, digest } = await runtimeWith([role], { withFiles: false, fetchHandler: serve([role], urls) });
    await newProject(rt, 'P');
    expect((await runCli(rt, ['font', 'install', '--dir', 'P', '--roles', 'serif-a'])).code).toBe(0);
    expect(urls.sort()).toEqual(
      Object.keys(role.files).map((name) => `https://static.popost.ai/fonts/popost/${digest}/serif-a/${name}`).sort(),
    );
    for (const [name, data] of Object.entries(role.files)) expect(await rt.fs.readFile(`/work/P/fonts/serif-a/${name}`)).toEqual(data);
  });

  it('honours POPOST_FONT_BASE_URL', async () => {
    const role = demoRole('serif-a', 1);
    const urls: string[] = [];
    const { rt, digest } = await runtimeWith([role], {
      withFiles: false,
      env: { POPOST_FONT_BASE_URL: 'https://fonts.example.test/base/' },
      fetchHandler: serve([role], urls),
    });
    await newProject(rt, 'P');
    expect((await runCli(rt, ['font', 'install', '--dir', 'P', '--roles', 'serif-a'])).code).toBe(0);
    expect(urls).toEqual([`https://fonts.example.test/base/@${digest}/serif-a/serif-a-0.woff2`]);
  });

  it('refuses a file whose hash is not the palette hash, and reports a missing file', async () => {
    const role = demoRole('serif-a', 1);
    const tampered: FetchHandler = () => new Response('not the font');
    const bad = await runtimeWith([role], { withFiles: false, fetchHandler: tampered });
    await newProject(bad.rt, 'P');
    expect((await runCli(bad.rt, ['font', 'install', '--dir', 'P', '--roles', 'serif-a'])).code).toBe(1);
    expect(String(bad.rt.json().error)).toContain('does not match the library hash');

    const gone = await runtimeWith([role], { withFiles: false, fetchHandler: () => new Response('', { status: 404 }) });
    await newProject(gone.rt, 'P');
    expect((await runCli(gone.rt, ['font', 'install', '--dir', 'P', '--roles', 'serif-a'])).code).toBe(1);
    expect(String(gone.rt.json().error)).toContain('HTTP 404');
  });

  it('keeps a download cache when the host names a cache directory', async () => {
    const role = demoRole('serif-a');
    const urls: string[] = [];
    const { rt } = await runtimeWith([role], {
      withFiles: false,
      env: { POPOST_CACHE_DIR: '/cache' },
      fetchHandler: serve([role], urls),
    });
    await newProject(rt, 'P');
    await newProject(rt, 'Q');
    await runCli(rt, ['font', 'install', '--dir', 'P', '--roles', 'serif-a']);
    const first = urls.length;
    expect(first).toBe(2);
    await runCli(rt, ['font', 'install', '--dir', 'Q', '--roles', 'serif-a']);
    expect(urls.length).toBe(first);
    expect(await rt.fs.readFile('/work/Q/fonts/serif-a/serif-a-1.woff2')).toEqual(role.files['serif-a-1.woff2']);
  });
});
