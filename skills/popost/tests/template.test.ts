/** `template locate|candidates|conflict` and `attach-template` (ports of test_template_plugins.py and the template cases). */
import { describe, expect, it } from 'vitest';
import { Project } from '../src/core/project';
import { buildProject } from '../src/workflow/build';
import * as plugins from '../src/workflow/template-plugins';
import { runCli, type TestRuntime } from '../src/testing/memory';
import { FIXTURES, newProject, newRuntime } from './workflow-helpers';

const SKILL_A = `${FIXTURES}/scene-skill-a`;

const skill = (rt: TestRuntime, dir: string, text: string | Uint8Array, files: Record<string, string> = {}) =>
  Promise.all([
    rt.fs.writeFile(`/work/${dir}/SKILL.md`, text),
    ...Object.entries(files).map(([name, data]) => rt.fs.writeFile(`/work/${dir}/${name}`, data)),
  ]);

describe('locate', () => {
  it('reads the whole SKILL.md: name, version, hash, references', async () => {
    const rt = await newRuntime();
    const info = await plugins.locateSkill(rt, SKILL_A);
    expect(info).toMatchObject({ ok: true, route: 'found', name: 'scene-skill-a', version: '1.0.0', skillId: 'scene-skill-a', resourcesPresent: true, missingRefs: [] });
    if (!info.ok) throw new Error('unreachable');
    expect(info.sha256).toHaveLength(64);
    expect(info.references).toEqual([{ path: `${SKILL_A}/references/note.md`, exists: true }]);
    expect(info.fullTextBytes).toBeGreaterThan(0);
  });

  it('is an error, never a silent fallback, when SKILL.md is missing, a directory or not UTF-8', async () => {
    const rt = await newRuntime();
    expect(await plugins.locateSkill(rt, `${FIXTURES}/no-such-skill`)).toMatchObject({ ok: false, route: 'error' });
    await rt.fs.mkdir('/work/empty');
    const missing = await plugins.locateSkill(rt, 'empty');
    expect(missing).toEqual({ ok: false, route: 'error', path: '/work/empty', error: 'SKILL.md 缺失：/work/empty/SKILL.md（资源错误，不静默替换）' });
    await skill(rt, 'bad', new Uint8Array([0x2d, 0x2d, 0x2d, 0xff, 0xfe]));
    expect(await plugins.locateSkill(rt, 'bad')).toMatchObject({ ok: false, error: 'SKILL.md 非合法 UTF-8（资源错误，不降级自由创作）' });
    expect((await runCli(rt, ['template', 'locate', '--path', 'empty'])).code).toBe(2);
    expect(rt.json()).toMatchObject({ ok: false, route: 'error' });
  });

  it('finds a link whose target is missing, which listing the folder cannot do', async () => {
    const rt = await newRuntime();
    await skill(rt, 'scene', '---\nname: scene\ndescription: travel\n---\nRead [missing](references/missing.md).', { 'references/a.md': 'a' });
    const located = await plugins.locateSkill(rt, 'scene');
    if (!located.ok) throw new Error('unreachable');
    expect(located.resourcesPresent).toBe(false);
    expect(located.missingRefs).toEqual(['/work/scene/references/missing.md']);
    expect(located.references.map((r) => r.exists)).toEqual([true, false]);
  });

  it('lists .md and .json references in order, follows #anchors and <links>, skips URLs and anchors', async () => {
    const rt = await newRuntime();
    await skill(rt, 'scene', 'See [m](references/m.md#a), [web](https://x.y), [z](<z.md>) and [h](#top).', {
      'references/b.json': '{}',
      'references/a.md': 'a',
      'references/skip.txt': 'x',
    });
    const located = await plugins.locateSkill(rt, 'scene');
    if (!located.ok) throw new Error('unreachable');
    expect(located.references.map((r) => [r.path.replace('/work/scene/', ''), r.exists])).toEqual([
      ['references/a.md', true],
      ['references/b.json', true],
      ['references/m.md', false],
      ['z.md', false],
    ]);
  });

  it('falls back to SOURCE-SKILL.md, keeps a byte-order mark and hashes with universal newlines like Python', async () => {
    const rt = await newRuntime();
    await rt.fs.writeFile('/work/src/SOURCE-SKILL.md', '---\nname: src\n---\nbody');
    expect(await plugins.locateSkill(rt, 'src')).toMatchObject({ ok: true, name: 'src' });
    await skill(rt, 'crlf', '---\r\nname: x\r\nversion: 2\r\n---\r\nbody\r\n');
    await skill(rt, 'lf', '---\nname: x\nversion: 2\n---\nbody\n');
    const crlf = await plugins.locateSkill(rt, 'crlf');
    const lf = await plugins.locateSkill(rt, 'lf');
    if (!crlf.ok || !lf.ok) throw new Error('unreachable');
    expect(crlf.sha256).toBe(lf.sha256);
    expect(crlf.version).toBe('2');
    await skill(rt, 'bom', new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('---\nname: bom\n---\nx')]));
    const bom = await plugins.locateSkill(rt, 'bom');
    expect(bom).toMatchObject({ ok: true, name: '' }); // the BOM stays in the text, so no front matter is found
  });

  it('reads quoted front-matter values and leaves a missing version null', () => {
    expect(plugins.parseFrontmatter('---\nname: "A b"\nversion: \'3\'\ndescription: d\n---\nx')).toEqual({ name: 'A b', version: '3', description: 'd' });
    expect(plugins.parseFrontmatter('no front matter')).toEqual({});
  });
});

describe('candidates', () => {
  it('scores lexical matches on the name only, three levels deep, and never claims to be authoritative', async () => {
    const rt = await newRuntime();
    await skill(rt, 'roots/a', '---\nname: travel-guide\nversion: 1\n---\n');
    await skill(rt, 'roots/b/c', '---\nname: compare\n---\n');
    await skill(rt, 'roots/b/c/d', '---\nname: depth three\n---\n');
    await skill(rt, 'roots/b/c/d/e', '---\nname: depth four\n---\n');
    await skill(rt, 'roots/b/c/d/e/f', '---\nname: too deep\n---\n');
    const result = await plugins.recallCandidates(rt, 'compare travel-guide', ['roots'], 'xiaohongshu');
    expect(result).toMatchObject({ ok: true, platform_hint: 'xiaohongshu', count: 3 });
    expect(result.candidates.map((c) => [c.path.replace('/work/roots/', ''), c.score, c.matchedTokens])).toEqual([
      ['a', 3, ['guide', 'travel', 'travel-guide']],
      ['b/c', 1, ['compare']],
      ['b/c/d', 0, []], // three levels below the root is the limit: b/c/d/e is not scanned
    ]);
    expect(result.candidates.every((c) => c.verdict_authoritative === false)).toBe(true);
  });

  it('matches the words of a hyphenated name, as a brief writes them', async () => {
    const rt = await newRuntime();
    await skill(rt, 'roots/ranking', '---\nname: minimal-data-ranking\n---\n');
    await skill(rt, 'roots/other', '---\nname: travel-guide\n---\n');
    const result = await plugins.recallCandidates(rt, 'a minimal data ranking for this week', ['roots']);
    expect(result.candidates.map((c) => [c.name, c.score, c.matchedTokens])).toEqual([
      ['minimal-data-ranking', 3, ['data', 'minimal', 'ranking']],
      ['travel-guide', 0, []],
    ]);
  });

  it('finds the fixture by its structure words, and never scores a platform word', async () => {
    const rt = await newRuntime();
    const named = await plugins.recallCandidates(rt, 'scene skill a', [FIXTURES], 'xiaohongshu');
    expect(named.candidates.map((c) => c.name)).toContain('scene-skill-a');
    const platform = await plugins.recallCandidates(rt, '小红书 tiktok x', [FIXTURES], 'xiaohongshu');
    expect(platform.candidates.reduce((sum, c) => sum + c.score, 0)).toBe(0); // the platform word is never a content key
  });

  it('ignores roots that are not directories, and runs from the CLI with colon-separated roots', async () => {
    const rt = await newRuntime();
    await skill(rt, 'roots/a', '---\nname: guide\n---\n');
    expect((await runCli(rt, ['template', 'candidates', '--brief', 'guide', '--roots', `roots:${FIXTURES}:nowhere`, '--platform-hint', 'x'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, platform_hint: 'x' });
    expect((rt.json().candidates as { name: string }[]).map((c) => c.name)).toEqual(['guide', 'scene-skill-a']);
    expect((await runCli(rt, ['template', 'candidates', '--brief', 'b'])).code).toBe(2);
  });
});

describe('conflict', () => {
  it('flags requiresReview for template + reference + strict, and never asserts a conflict', () => {
    const result = plugins.detectConflict(true, true, true);
    expect(result).toMatchObject({ requiresReview: true, conflict: null, authorizationField: 'templateConflictAuthorization' });
    expect(result.note).toContain('requiresReview');
    expect(plugins.detectConflict(true, true, false)).toMatchObject({ requiresReview: false, note: '' });
    expect(plugins.detectConflict(true, false, true).requiresReview).toBe(false);
    expect(plugins.detectConflict(false, true, true).requiresReview).toBe(false);
  });

  it('reads --x / --no-x pairs with the last one winning, absent meaning false', async () => {
    const rt = await newRuntime();
    await runCli(rt, ['template', 'conflict', '--template', '--reference', '--strict']);
    expect(rt.json()).toMatchObject({ templateChosen: true, referenceSupplied: true, strict: true, requiresReview: true });
    await runCli(rt, ['template', 'conflict', '--template', '--no-template', '--reference', '--strict']);
    expect(rt.json()).toMatchObject({ templateChosen: false, requiresReview: false });
    await runCli(rt, ['template', 'conflict', '--no-template', '--template', '--reference', '--strict']);
    expect(rt.json()).toMatchObject({ templateChosen: true, requiresReview: true });
    await runCli(rt, ['template', 'conflict']);
    expect(rt.json()).toMatchObject({ templateChosen: false, referenceSupplied: false, strict: false, requiresReview: false });
    expect((await runCli(rt, ['template', 'conflict', '--bogus'])).code).toBe(2);
  });
});

describe('template command', () => {
  it('locates a good Skill with exit 0 and exits 2 for a bad sub-command', async () => {
    const rt = await newRuntime();
    expect((await runCli(rt, ['template', 'locate', '--path', SKILL_A])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, route: 'found' });
    const unknown = await runCli(rt, ['template', 'nope']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("invalid choice: 'nope'");
    expect((await runCli(rt, ['template'])).code).toBe(2);
  });
});

describe('template-profile', () => {
  const setup = async () => {
    const rt = await newRuntime();
    await newProject(rt);
    await rt.fs.writeFile('/work/tpl/SKILL.md', '---\nname: tpl\nversion: 1\n---\nSee [x](references/x.md).\n');
    await rt.fs.writeFile('/work/tpl/references/x.md', 'x');
    const write = (profile: unknown) => rt.fs.writeFile('/work/profile.json', JSON.stringify(profile));
    return { rt, write };
  };

  it('binds concrete rules to the template hash and replaces earlier template sources', async () => {
    const { rt, write } = await setup();
    await runCli(rt, ['attach-template', '--dir', 'project', '--path', 'tpl']);
    await write({ skillPath: 'tpl', rules: ['title 64px bold', 'two colours'], pageTypes: ['cover'] });
    expect((await runCli(rt, ['template-profile', '--dir', 'project', '--file', 'profile.json'])).code).toBe(0);
    expect(rt.json()).toEqual({ ok: true, profile: 'template-profile.json' });
    const saved = JSON.parse(await rt.fs.readText('/work/project/template-profile.json'));
    const source = (await Project.load(rt, 'project')).manifest.sources;
    expect(source).toEqual([{ kind: 'template', path: 'tpl', sha256: saved.sourceHash, profilePath: 'template-profile.json' }]);
    expect(saved).toMatchObject({ skillPath: 'tpl', rules: ['title 64px bold', 'two colours'], pageTypes: ['cover'] });
  });

  it('rejects an incomplete profile, vague rules and a template whose resources are missing', async () => {
    const { rt, write } = await setup();
    const attempt = async (profile: unknown) => {
      await write(profile);
      const { code } = await runCli(rt, ['template-profile', '--dir', 'project', '--file', 'profile.json']);
      return [code, rt.json().error];
    };
    expect(await attempt({ skillPath: 'tpl', rules: ['r'] })).toEqual([2, 'template profile missing pageTypes']);
    expect(await attempt({ rules: ['r'], pageTypes: ['c'] })).toEqual([2, 'template profile missing skillPath']);
    expect(await attempt({ skillPath: 'tpl', rules: [], pageTypes: ['c'] })).toEqual([2, 'template profile missing rules']);
    expect(await attempt({ skillPath: 'tpl', rules: ['r', ' '], pageTypes: ['c'] })).toEqual([2, 'template rules must be concrete text decisions']);
    expect(await attempt({ skillPath: 'tpl', rules: 'one rule', pageTypes: ['c'] })).toEqual([2, 'template rules must be concrete text decisions']);
    await rt.fs.rm('/work/tpl/references/x.md');
    expect(await attempt({ skillPath: 'tpl', rules: ['r'], pageTypes: ['c'] })).toEqual([2, 'template resources missing']);
    expect(await attempt({ skillPath: 'nowhere', rules: ['r'], pageTypes: ['c'] })).toEqual([2, 'template resources missing']);
  });

  it('build warns until a profile is bound, then notices a template that changed afterwards', async () => {
    const { rt, write } = await setup();
    const project = await Project.load(rt, 'project');
    await runCli(rt, ['attach-template', '--dir', 'project', '--path', 'tpl']);
    let report = await buildProject(await Project.load(rt, 'project'), true);
    expect(report.warnings).toEqual(['template 尚未绑定设计规则 profile']);
    expect(report.reviewGaps).toContain('template: 设计规则尚未绑定');
    await write({ skillPath: 'tpl', rules: ['r'], pageTypes: ['c'] });
    await runCli(rt, ['template-profile', '--dir', 'project', '--file', 'profile.json']);
    report = await buildProject(await Project.load(rt, 'project'), true);
    expect(report.warnings).toEqual([]);
    expect(report.blockers).not.toContain('template 来源已变更，请重读并更新规则');
    await rt.fs.writeFile('/work/tpl/SKILL.md', '---\nname: tpl\n---\nchanged\n');
    report = await buildProject(await Project.load(rt, project.root), true);
    expect(report.blockers).toContain('template 来源已变更，请重读并更新规则');
  });
});
