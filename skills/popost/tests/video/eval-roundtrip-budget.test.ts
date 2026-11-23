/**
 * The round trip's scores do not depend on the CPU budget (eval/roundtrip.ts, ENCODER_THREADS). x264 writes other
 * bytes for another thread count, and the encoder took its threads from the budget: seed 2 scored 0.888 at a budget
 * of 1 and 0.893 at 4, and eval-r5's 40 seeds 0.869 at 3 against 0.8682 at 4.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import { runRoundTrip } from '../../src/video/eval/roundtrip';
import { hasFfmpeg } from '../../src/video/media/ffmpeg';

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ready = (await hasFfmpeg(rt)) && hasChrome();

describe.skipIf(!ready)('round trip at any CPU budget', () => {
  it('scores a seed the same at budgets 1 and 4', async () => {
    const at = (cpus: string) => ({ ...rt, env: { ...rt.env, POPOST_CPUS: cpus } });
    const run = async (cpus: string) => {
      const r = await runRoundTrip(at(cpus), { seeds: [2], workDir: rt.path.join(rt.dir, 'budget-' + cpus) });
      return r.cases.map((c) => ({ score: c.score, falseBoundaries: c.falseBoundaries, falseEvents: c.falseEvents }));
    };
    const one = await run('1');
    expect(one).toHaveLength(1);
    expect(await run('4')).toEqual(one);
  }, 240_000);
});
