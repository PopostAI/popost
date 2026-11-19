import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestRuntime, mountPackageFiles, PACKAGE_ROOT, runCli } from '../src/testing/memory';
import { Project } from '../src/core/project';
import { pageFingerprint } from '../src/core/fingerprint';
import { parseArgs } from '../src/args';
import { VERSION } from '../src/version';

describe('skeleton', () => {
  it('prints the version and usage', async () => {
    const rt = createTestRuntime();
    expect((await runCli(rt, ['--version'])).stdout.trim()).toBe(VERSION);
    expect((await runCli(rt, [])).code).toBe(2);
    expect((await runCli(rt, ['nope'])).code).toBe(2);
  });

  it('keeps the CLI version equal to SKILL.md metadata.version', () => {
    const skill = readFileSync(`${PACKAGE_ROOT}/SKILL.md`, 'utf8');
    expect(/version:\s*"([^"]+)"/.exec(skill)?.[1]).toBe(VERSION);
  });

  it('parses argparse-style options', () => {
    const args = parseArgs(['--dir', 'P', '--file', 'a.png', 'b.png', '--force', '--width=10'], {
      prog: 't',
      options: [
        { flag: '--dir', required: true },
        { flag: '--file', kind: 'list' },
        { flag: '--force', kind: 'flag' },
        { flag: '--width', kind: 'int', default: 1080 },
        { flag: '--quote-id' },
      ],
    });
    expect(args.req('dir')).toBe('P');
    expect(args.list('file')).toEqual(['a.png', 'b.png']);
    expect(args.flag('force')).toBe(true);
    expect(args.number('width')).toBe(10);
    expect(args.string('quote-id')).toBeUndefined();
  });

  it('creates and reloads a project with the starter page', async () => {
    const rt = createTestRuntime();
    await mountPackageFiles(rt.fs, ['assets/project-starter']);
    const created = await Project.create(rt, 'P', 'brief', 'original', 1080, 1440);
    const loaded = await Project.load(rt, '/work/P');
    expect(loaded.manifest.pages.map((p) => p.htmlPath)).toEqual(['pages/p1.html']);
    expect(await loaded.readPageHtml('p1')).toContain('data-canvas-width="1080"');
    expect(await pageFingerprint(created, 'p1')).toMatch(/^[0-9a-f]{64}$/);
  });
});
