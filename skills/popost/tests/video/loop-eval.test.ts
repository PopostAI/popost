/**
 * `popost video eval` through the CLI: it refuses outside a checkout of the repository, records a decision in the
 * ledger of a checkout, runs the round trip, and runs the floor on a held-out set while printing means only. The
 * checkout is a scratch git repository with the engine's directory and a ledger; the evaluation set is one synthesized
 * clip. Runs that render skip without ffmpeg or Chrome.
 */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome, type DiskRuntime } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';

const rt: DiskRuntime = await createDiskRuntime();
afterAll(() => rt.cleanup());
const ready = (await hasFfmpeg(rt)) && hasChrome();
const git = ((): boolean => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();
const at = (p: string): string => rt.path.join(rt.dir, p);
/** The runtime with its working directory in the scratch checkout. */
const inRepo = (env: Record<string, string> = {}): DiskRuntime => ({ ...rt, cwd: at('repo'), env: { ...rt.env, ...env } });
const ledger = async (): Promise<Record<string, unknown>[]> => (await rt.fs.readText(at('repo/docs/video/eval/ledger.jsonl'))).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

describe.skipIf(!git)('popost video eval', () => {
  beforeAll(async () => {
    await rt.fs.mkdir(at('repo/skills/popost/src/video'));
    await rt.fs.writeFile(at('repo/docs/video/eval/ledger.jsonl'), JSON.stringify({ kind: 'decision', hypothesis: 'an older line' }) + '\n');
    execFileSync('git', ['init', '-q', at('repo')]);
  });

  it('refuses outside a checkout of the repository, and says where to run it', async () => {
    expect((await runCli(rt, ['video', 'eval', 'decide', 'accepted', 'the numbers'])).code).toBe(2);
    expect(String(rt.json().error)).toContain('is not inside one. Run it from the checkout.');
  });

  it('decide adds one line to the ledger and leaves the lines before it as they were', async () => {
    const repo = inRepo();
    expect((await runCli(repo, ['video', 'eval', 'decide', 'rejected', 'structure', 'fell', 'by', '0.02'])).code).toBe(0);
    expect(repo.json()).toMatchObject({ ok: true, ledger: at('repo/docs/video/eval/ledger.jsonl'), row: { kind: 'decision', decision: 'rejected', hypothesis: 'structure fell by 0.02', commit: 'unknown' } });
    const rows = await ledger();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ kind: 'decision', hypothesis: 'an older line' });
    expect((await runCli(repo, ['video', 'eval', 'decide', 'accepted'])).code).toBe(2);
    expect(String(repo.json().error)).toContain('Say why');
  });

  it('writes the ledger POPOST_VIDEO_LEDGER names, and refuses a name with no file there', async () => {
    await rt.fs.writeFile(at('lab/video/eval/ledger.jsonl'), '');
    const repo = inRepo({ POPOST_VIDEO_LEDGER: at('lab/video/eval/ledger.jsonl') });
    expect((await runCli(repo, ['video', 'eval', 'decide', 'accepted', 'kept', 'as', 'it', 'was'])).code).toBe(0);
    expect(repo.json()).toMatchObject({ ok: true, ledger: at('lab/video/eval/ledger.jsonl'), row: { kind: 'decision', decision: 'accepted' } });
    expect((await rt.fs.readText(at('lab/video/eval/ledger.jsonl'))).trim().split('\n')).toHaveLength(1);
    expect(await ledger()).toHaveLength(2);
    const typo = inRepo({ POPOST_VIDEO_LEDGER: at('lab/nowhere.jsonl') });
    expect((await runCli(typo, ['video', 'eval', 'decide', 'accepted', 'kept'])).code).toBe(2);
    expect(String(typo.json().error)).toContain('POPOST_VIDEO_LEDGER names');
  });

  it.skipIf(!ready)('roundtrip renders a random project, measures it against its truth and records the means', async () => {
    const repo = inRepo();
    expect((await runCli(repo, ['video', 'eval', 'roundtrip', '--seeds', '1', '--note', 'a test run'])).code).toBe(0);
    expect(repo.json()).toMatchObject({ ok: true, cases: 1, work: at('repo/.popost/video/roundtrip') });
    expect((repo.json().table as string[])[0]).toMatch(/^cases 1, false boundaries \d+, false events \d+$/);
    expect((await ledger()).at(-1)).toMatchObject({ kind: 'roundtrip', hypothesis: 'a test run', data: 'seeds 1', cases: 1, decision: 'open' });
  });

  it.skipIf(!ready)('floor on the held-out set prints means only, and names no case in the ledger', async () => {
    await rt.fs.mkdir(at('data/clips'));
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x284:r=30:d=1', '-f', 'lavfi', '-i', 'smptebars=s=160x284:r=30:d=1',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]', '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', at('data/clips/secret-name.mp4')]);
    await rt.fs.writeFile(at('data/cases.json'), JSON.stringify([{ id: 'c7', type: 'kind of case', video: 'clips/secret-name.mp4', materials: [], brief: '' }]));
    await rt.fs.writeFile(at('data/split.json'), JSON.stringify({ dev: [], heldout: ['c7'] }));
    const repo = inRepo({ POPOST_VIDEO_DATA: at('data') });
    const r = await runCli(repo, ['video', 'eval', 'floor', '--set', 'heldout']);
    expect(r.code).toBe(0);
    expect(repo.json()).toMatchObject({ ok: true, set: 'heldout', cases: 1, failed: 0 });
    expect(Object.keys(repo.json()).sort()).toEqual(['cases', 'failed', 'ledger', 'means', 'ok', 'set']);
    for (const secret of ['c7', 'secret-name', 'kind of case']) {
      // The scratch directory's random name is left out: it could hold the letters by chance.
      expect((r.stdout + r.stderr).split(rt.dir).join('')).not.toContain(secret);
      expect(JSON.stringify(await ledger())).not.toContain(secret);
    }
    expect((await ledger()).at(-1)).toMatchObject({ kind: 'floor', data: 'real set, heldout', cases: 1, decision: 'baseline' });
    expect((await runCli(inRepo(), ['video', 'eval', 'floor', '--set', 'dev'])).code).toBe(2);
    expect(String(rt.json().error)).toContain('POPOST_VIDEO_DATA');
  });
});
