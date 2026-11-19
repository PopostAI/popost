/** `popost install`: the Skill payload into the skills directory of the agents on the machine. */
import { describe, expect, it } from 'vitest';
import { listPayload } from '../src/install/payload';
import { PACKAGE_ROOT, createTestRuntime, mountPackageFiles, runCli, SKILL_ROOT, type TestRuntime } from '../src/testing/memory';
import { VERSION } from '../src/version';

const FILES = ['dist/', 'SKILL.md', 'README.md', 'agents/', 'references/', 'templates/', 'assets/canvas/', 'assets/fonts/*/LICENSE', 'assets/fonts/palette.json', 'assets/*.json'];
const manifest = (version: string) => JSON.stringify({ name: 'popost', version, files: FILES });
const PACKAGE: Record<string, string> = {
  'package.json': manifest('1.0.0'),
  'SKILL.md': '---\nname: popost\n---\n',
  'README.md': 'readme',
  'agents/openai.yaml': 'a: 1',
  'references/guide.md': 'guide',
  'templates/t/template.json': '{}',
  'assets/canvas/index.html': '<html>',
  'assets/fonts/inter/LICENSE': 'ofl',
  'assets/fonts/inter/Inter.woff2': 'BIG FONT',
  'assets/fonts/palette.json': '{}',
  'assets/series-plan.example.json': '{}',
  'assets/notes.md': 'not listed',
  'dist/cli.js': 'compiled',
  'src/main.ts': 'source',
  'tests/a.test.ts': 'test',
  'tools/x.py': 'py',
  'node_modules/dep/index.js': 'dep',
};
const HOME = '/home/u';

const scene = async (overrides: { homeDirs?: string[]; env?: Record<string, string>; homeDir?: string | undefined } = {}): Promise<TestRuntime> => {
  const files: Record<string, string> = Object.fromEntries(Object.entries(PACKAGE).map(([p, c]) => [`${SKILL_ROOT}/${p}`, c]));
  const rt = createTestRuntime({ homeDir: 'homeDir' in overrides ? overrides.homeDir : HOME, env: overrides.env ?? {}, files });
  for (const dir of overrides.homeDirs ?? []) await rt.fs.mkdir(dir);
  return rt;
};

type Out = { installed: { agent: string; skillDir: string; status: string; previousVersion?: string | null; files: number }[]; skipped: unknown[]; failed: { agent: string }[]; next: string; error: string; [k: string]: unknown };
const install = async (rt: TestRuntime, ...argv: string[]) => {
  const r = await runCli(rt, ['install', ...argv]);
  return { ...r, out: rt.json() as Out };
};
const exists = async (rt: TestRuntime, p: string) => (await rt.fs.stat(p)) !== null;
const CLAUDE = `${HOME}/.claude/skills/popost`;
const CODEX = `${HOME}/.agents/skills/popost`;

describe('payload', () => {
  it('is what package.json files lists, without dist, src, tests, tools, node_modules', async () => {
    const rt = await scene();
    expect(await listPayload(rt, SKILL_ROOT, FILES)).toEqual([
      'README.md',
      'SKILL.md',
      'agents/openai.yaml',
      'assets/canvas/index.html',
      'assets/fonts/inter/LICENSE',
      'assets/fonts/palette.json',
      'assets/series-plan.example.json',
      'package.json',
      'references/guide.md',
      'templates/t/template.json',
    ]);
  });

  it('follows the real package.json of this repository', async () => {
    const rt = createTestRuntime();
    await mountPackageFiles(rt.fs, ['package.json', 'SKILL.md', 'LICENSE', 'references', 'agents', 'src/version.ts', 'tests/fixtures']);
    const pkg = JSON.parse(await rt.fs.readText(`${SKILL_ROOT}/package.json`)) as { files: string[]; version: string };
    expect(pkg.version).toBe(VERSION);
    const list = await listPayload(rt, SKILL_ROOT, pkg.files);
    expect(list).toContain('SKILL.md');
    expect(list).toContain('package.json');
    expect(list.some((p) => p.startsWith('references/'))).toBe(true);
    expect(list.some((p) => /^(src|tests|tools|dist|node_modules)\//.test(p))).toBe(false);
    expect(PACKAGE_ROOT).toContain('popost');
  });
});

describe('install', () => {
  it('installs fresh into Claude Code and Codex and tells the next step', async () => {
    const rt = await scene({ homeDirs: [`${HOME}/.claude`, `${HOME}/.codex`] });
    const r = await install(rt);
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ ok: true, dryRun: false, version: VERSION });
    expect(r.out.installed).toEqual([
      { agent: 'claude-code', skillDir: CLAUDE, status: 'installed', files: 10 },
      { agent: 'codex', skillDir: CODEX, status: 'installed', files: 10 },
    ]);
    expect(r.out.skipped).toEqual([]);
    for (const dir of [CLAUDE, CODEX]) {
      expect(await rt.fs.readText(`${dir}/SKILL.md`)).toContain('name: popost');
      expect(await rt.fs.readText(`${dir}/assets/fonts/inter/LICENSE`)).toBe('ofl');
      for (const absent of ['dist', 'src', 'tests', 'tools', 'node_modules', 'assets/notes.md', 'assets/fonts/inter/Inter.woff2']) expect(await exists(rt, `${dir}/${absent}`)).toBe(false);
    }
    expect(r.out.next).toContain('Restart the agent');
    expect(r.out.next).toContain('https://popost.ai/account/api-keys');
    expect(r.out.next).toContain('companion CLI');
    expect(r.out.next).toContain('popost auth login');
    expect(r.out.next).toContain('Reproduce a post: "Use popost to reproduce this post link XX; my content is XX."');
    expect(r.out.next).toContain('search the template library');
    expect(await rt.fs.readdir(`${HOME}/.claude/skills`)).toEqual(['popost']); // no staging leftovers
  });

  it('skips agents that are not installed, with the reason', async () => {
    const rt = await scene({ homeDirs: [`${HOME}/.claude`] });
    const r = await install(rt);
    expect(r.out.installed.map((i: { agent: string }) => i.agent)).toEqual(['claude-code']);
    expect(r.out.skipped).toEqual([{ agent: 'codex', reason: expect.stringContaining(`${HOME}/.codex does not exist`) }]);
    expect(await exists(rt, CODEX)).toBe(false);
  });

  it('detects Codex through CODEX_HOME', async () => {
    const rt = await scene({ homeDirs: ['/opt/codex-home'], env: { CODEX_HOME: '/opt/codex-home' } });
    const r = await install(rt);
    expect(r.out.installed.map((i: { agent: string }) => i.agent)).toEqual(['codex']);
  });

  it('fails when no agent is present, naming the ways out', async () => {
    const rt = await scene();
    const r = await install(rt);
    expect(r.code).toBe(1);
    expect(r.out).toMatchObject({ ok: false });
    expect(String(r.out.error)).toContain('--agent all');
    expect(String(r.out.error)).toContain('--dir');
    expect(r.out.skipped).toHaveLength(2);
  });

  it('--agent all installs for every supported agent without checking homes; --agent picks one', async () => {
    const rt = await scene();
    expect((await install(rt, '--agent', 'all')).out.installed).toHaveLength(2);
    const one = await scene();
    const r = await install(one, '--agent', 'codex');
    expect(r.out.installed.map((i: { agent: string }) => i.agent)).toEqual(['codex']);
    expect(await exists(one, CLAUDE)).toBe(false);
  });

  it('rejects an unknown agent id (exit 2) and writes nothing', async () => {
    const rt = await scene({ homeDirs: [`${HOME}/.claude`] });
    const r = await runCli(rt, ['install', '--agent', 'workbuddy']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid choice: 'workbuddy'");
    expect(await exists(rt, CLAUDE)).toBe(false);
  });

  it('--dir installs into <dir>/popost, resolved against the working directory; not combinable with --agent', async () => {
    const rt = await scene();
    const r = await install(rt, '--dir', 'out/skills');
    expect(r.out.installed).toEqual([{ agent: 'custom', skillDir: '/work/out/skills/popost', status: 'installed', files: 10 }]);
    expect(await exists(rt, '/work/out/skills/popost/SKILL.md')).toBe(true);
    expect((await runCli(rt, ['install', '--dir', '/x', '--agent', 'codex'])).code).toBe(2);
  });

  it('reports up-to-date for the same version and leaves the install alone', async () => {
    const rt = await scene({ homeDirs: [`${HOME}/.claude`] });
    await install(rt);
    await rt.fs.writeFile(`${CLAUDE}/local-note.txt`, 'mine');
    const r = await install(rt);
    expect(r.out.installed).toEqual([{ agent: 'claude-code', skillDir: CLAUDE, status: 'up-to-date', previousVersion: '1.0.0', files: 10 }]);
    expect(await exists(rt, `${CLAUDE}/local-note.txt`)).toBe(true);
  });

  it('replaces the install when the version differs, dropping files the new version no longer has', async () => {
    const rt = await scene({ homeDirs: [`${HOME}/.claude`] });
    await install(rt);
    await rt.fs.writeFile(`${CLAUDE}/references/removed-later.md`, 'old');
    await rt.fs.writeFile(`${SKILL_ROOT}/package.json`, manifest('1.1.0'));
    await rt.fs.writeFile(`${SKILL_ROOT}/SKILL.md`, 'new skill');
    const r = await install(rt);
    expect(r.out.installed[0]).toMatchObject({ status: 'updated', previousVersion: '1.0.0' });
    expect(await rt.fs.readText(`${CLAUDE}/SKILL.md`)).toBe('new skill');
    expect(JSON.parse(await rt.fs.readText(`${CLAUDE}/package.json`)).version).toBe('1.1.0');
    expect(await exists(rt, `${CLAUDE}/references/removed-later.md`)).toBe(false);
    expect(await rt.fs.readdir(`${HOME}/.claude/skills`)).toEqual(['popost']);
  });

  it('--force reinstalls the same version', async () => {
    const rt = await scene({ homeDirs: [`${HOME}/.claude`] });
    await install(rt);
    await rt.fs.writeFile(`${CLAUDE}/SKILL.md`, 'edited');
    const r = await install(rt, '--force');
    expect(r.out.installed[0]).toMatchObject({ status: 'reinstalled' });
    expect(await rt.fs.readText(`${CLAUDE}/SKILL.md`)).toContain('name: popost');
  });

  it('--dry-run writes nothing and says what would happen', async () => {
    const rt = await scene({ homeDirs: [`${HOME}/.claude`] });
    const fresh = await install(rt, '--dry-run');
    expect(fresh.out).toMatchObject({ ok: true, dryRun: true });
    expect(fresh.out.installed[0]).toMatchObject({ status: 'would-install', files: 10 });
    expect(await exists(rt, `${HOME}/.claude/skills`)).toBe(false);
    await install(rt);
    await rt.fs.writeFile(`${SKILL_ROOT}/package.json`, manifest('2.0.0'));
    const update = await install(rt, '--dry-run');
    expect(update.out.installed[0]).toMatchObject({ status: 'would-update', previousVersion: '1.0.0' });
    expect(JSON.parse(await rt.fs.readText(`${CLAUDE}/package.json`)).version).toBe('1.0.0');
  });

  it('treats an install without a readable version as outdated', async () => {
    const rt = await scene({ homeDirs: [`${HOME}/.claude`] });
    await rt.fs.writeFile(`${CLAUDE}/SKILL.md`, 'hand made');
    const r = await install(rt);
    expect(r.out.installed[0]).toMatchObject({ status: 'updated', previousVersion: null });
  });

  it('reports a target that is a file, and still installs the others', async () => {
    const rt = await scene({ homeDirs: [`${HOME}/.claude`, `${HOME}/.codex`] });
    await rt.fs.writeFile(CLAUDE, 'a file');
    const r = await install(rt);
    expect(r.code).toBe(1);
    expect(r.out).toMatchObject({ ok: false });
    expect(r.out.failed[0]).toMatchObject({ agent: 'claude-code' });
    expect(r.out.installed.map((i: { agent: string }) => i.agent)).toEqual(['codex']);
  });

  it('needs --dir on a host without a home directory', async () => {
    const rt = await scene({ homeDir: undefined });
    const r = await runCli(rt, ['install']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--dir');
    expect((await install(rt, '--dir', '/skills')).code).toBe(0);
  });
});
