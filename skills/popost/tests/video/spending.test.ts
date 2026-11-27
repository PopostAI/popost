/**
 * Paid commands, paid as images are: a voice-over priced first (exit code 3 without --confirm), one budget per video
 * across commands, and the clips the user agreed to: `popost video materials` on the built-in generator (run in this
 * process as POPOST_GEN_CMD="popost video generate") against the in-memory video endpoints, with speech on the same
 * account. No network and no ffmpeg: the only programs are the generator and the length of a sound.
 */
import { describe, expect, it } from 'vitest';
import { sha256 } from '../../src/core/util';
import { run } from '../../src/main';
import type { LocalPrograms, Runtime } from '../../src/runtime';
import type { TestRuntime } from '../../src/testing/memory';
import { cli, ok, ORIGIN, type Json } from '../image-helpers';
import { MALE, wav } from './hosted-fake';
import { scene } from './video-api-fake';

const PROJECT = '/work/p';
const RECORD = PROJECT + '/production/approved-clips.json';
const TWO = [
  { file: 'assets/a.mp4', prompt: 'a desk by a window', seconds: 5 },
  { file: 'assets/b.mp4', prompt: 'a chair in the sun', seconds: 5 },
];

/** The generator command runs in this process with the environment it is given; ffmpeg only tells a sound's length. */
const withPrograms = (rt: TestRuntime): TestRuntime => {
  let dirs = 0;
  const none = new Uint8Array();
  const programs: LocalPrograms = {
    parallelism: 1,
    tempDir: async (prefix) => {
      const dir = '/tmp/' + prefix + ++dirs;
      await rt.fs.mkdir(dir);
      return dir;
    },
    run: async (argv, options = {}) => {
      if (argv.slice(0, 3).join(' ') === 'popost video generate') {
        const out: string[] = [], said: string[] = [];
        const inner: Runtime = { ...rt, env: { ...rt.env, ...options.env }, stdout: (t) => void out.push(t), stderr: (t) => void said.push(t) };
        const code = await run(argv.slice(1), inner);
        return { code, stdout: new TextEncoder().encode(out.join('')), stderr: said.join('') };
      }
      if (argv.includes('null')) return { code: 0, stdout: none, stderr: 'size=N/A time=00:00:01.00 bitrate=N/A' };
      return { code: 1, stdout: none, stderr: argv[0] + ' is not run in this test' };
    },
  };
  return { ...rt, programs, env: { ...rt.env, POPOST_GEN_CMD: 'popost video generate' } };
};

const setup = async () => {
  const s = await scene();
  return { ...s, rt: withPrograms(s.rt) };
};

const list = async (rt: TestRuntime, requests: Json[]): Promise<void> => {
  await rt.fs.mkdir(PROJECT);
  await rt.fs.writeFile(PROJECT + '/requests.json', JSON.stringify(requests));
};

const materials = (rt: TestRuntime, ...more: string[]) => cli(rt, 'video', 'materials', PROJECT + '/requests.json', '--out', PROJECT, '--no-anchor', ...more);

const record = async (rt: TestRuntime): Promise<Json> => JSON.parse(await rt.fs.readText(RECORD));

describe('popost video materials --confirm --max-credits', () => {
  it('prices the list first and charges nothing; the first confirmed run makes it and records the agreed clips', async () => {
    const { rt, stub, api } = await setup();
    await list(rt, TWO);
    const asked = await materials(rt);
    expect(asked.code).toBe(3);
    expect(asked.data).toMatchObject({
      ok: false, made: 0, chargedCredits: 0, next: expect.stringContaining('--confirm --max-credits'),
      confirm: { credits: 50, balance: 500, items: [{ kind: 'video', what: 'assets/a.mp4', credits: 25 }, { kind: 'video', what: 'assets/b.mp4', credits: 25 }] },
    });
    expect([api.balance, stub.calls('POST', '/videos/generations').length, await rt.fs.stat(RECORD)]).toEqual([500, 0, null]);
    const made = await materials(rt, '--confirm', '--max-credits', '50');
    expect(made.code).toBe(0);
    expect(made.data).toMatchObject({ ok: true, made: 2, credits: 50, chargedCredits: 50 });
    expect(api.balance).toBe(450);
    const { plan, clips } = await record(rt);
    expect(clips).toEqual([
      { key: expect.stringMatching(/^video-[0-9a-f]{64}$/), file: 'assets/a.mp4', what: 'a desk by a window', seconds: 5, credits: 25, by: 'plan', at: expect.any(String) },
      { key: expect.stringMatching(/^video-[0-9a-f]{64}$/), file: 'assets/b.mp4', what: 'a chair in the sun', seconds: 5, credits: 25, by: 'plan', at: expect.any(String) },
    ]);
    expect(plan.map((p: Json) => [p.file, p.key])).toEqual([['assets/a.mp4', clips[0].key], ['assets/b.mp4', clips[1].key]]);
  });

  it('a run cut short by its ceiling goes on with the rest of the agreed clips; a rerun of an approved key neither asks nor charges', async () => {
    const { rt, stub, api } = await setup();
    await list(rt, TWO);
    const first = await materials(rt, '--confirm', '--max-credits', '30');
    expect(first.code).toBe(3);
    expect(first.data).toMatchObject({ made: 1, chargedCredits: 25, confirm: { credits: 25, items: [{ what: 'assets/b.mp4' }] } });
    expect(first.data.confirm.reason).toBeUndefined();
    // 5 credits were left, b costs 25: once the user agrees to more, b is still one of the agreed clips.
    const rest = await materials(rt, '--confirm', '--max-credits', '25');
    expect(rest).toMatchObject({ code: 0, data: { made: 1, kept: 1, chargedCredits: 25 } });
    // The file is gone: the same request finds its paid task and downloads the clip again.
    await rt.fs.rm(PROJECT + '/assets/a.mp4');
    const again = await materials(rt, '--confirm', '--max-credits', '0');
    expect(again).toMatchObject({ code: 0, data: { made: 1, kept: 1, chargedCredits: 0 } });
    expect(await rt.fs.stat(PROJECT + '/assets/a.mp4')).not.toBeNull();
    expect([api.balance, stub.calls('POST', '/videos/generations').length, (await record(rt)).clips.length]).toEqual([450, 2, 2]);
  });
});

describe('a clip that is not among the agreed clips', () => {
  it('a regeneration under a new key stops as unplanned whatever the budget, and is made once the user approves that clip', async () => {
    const { rt, api } = await setup();
    await list(rt, TWO);
    expect((await materials(rt, '--confirm', '--max-credits', '50')).code).toBe(0);
    await list(rt, [...TWO, { file: 'assets/a-2.mp4', prompt: 'a desk by a window, warmer light', seconds: 5 }]);
    const asked = await materials(rt, '--confirm', '--max-credits', '500');
    expect(asked.code).toBe(3);
    expect(asked.data).toMatchObject({
      made: 0, kept: 2, chargedCredits: 0, next: expect.stringContaining('--approve-unplanned'),
      confirm: { credits: 25, reason: 'unplanned', clip: { key: expect.stringMatching(/^video-/), file: 'assets/a-2.mp4', what: 'a desk by a window, warmer light', seconds: 5, credits: 25 } },
    });
    const key = asked.data.confirm.clip.key as string;
    expect(asked.data.problems[0]).toMatchObject({ at: 'assets/a-2.mp4', fix: expect.stringContaining('--approve-unplanned ' + key) });
    expect(api.balance).toBe(450);
    const approved = await materials(rt, '--confirm', '--max-credits', '25', '--approve-unplanned', key);
    expect(approved).toMatchObject({ code: 0, data: { made: 1, kept: 2, chargedCredits: 25 } });
    expect((await record(rt)).clips.at(-1)).toMatchObject({ key, file: 'assets/a-2.mp4', credits: 25, by: 'user' });
    expect(api.balance).toBe(425);
  });

  it('the built-in generator called on its own into the project is held to the same agreement', async () => {
    const { rt, api } = await setup();
    await list(rt, TWO);
    expect((await materials(rt, '--confirm', '--max-credits', '50')).code).toBe(0);
    await rt.fs.writeFile('/work/req.json', JSON.stringify({ prompt: 'a lamp', seconds: 5 }));
    const make = (...more: string[]) => cli(rt, 'video', 'generate', 'video', '/work/req.json', PROJECT + '/assets/lamp.mp4', '--confirm', '--max-credits', '100', ...more);
    const asked = await make();
    expect(asked.code).toBe(3);
    expect(asked.data.confirm).toMatchObject({ credits: 25, reason: 'unplanned', clip: { file: 'assets/lamp.mp4', what: 'a lamp', seconds: 5 } });
    expect(asked.stderr).toContain('--approve-unplanned');
    const yes = await make('--approve-unplanned', asked.data.confirm.clip.key);
    expect(yes).toMatchObject({ code: 0, data: { credits: 25, chargedCredits: 25, key: asked.data.confirm.clip.key } });
    expect(api.balance).toBe(425);
  });

  it('a changed request is unplanned: another prompt, another length, another resolution', async () => {
    const { rt, api } = await setup();
    await list(rt, TWO);
    expect((await materials(rt, '--confirm', '--max-credits', '50')).code).toBe(0);
    await rt.fs.rm(PROJECT + '/assets/b.mp4');
    const changed = async (requests: Json[], r = rt) => {
      await list(r, requests);
      const asked = await materials(r, '--confirm', '--max-credits', '500');
      expect(asked.code).toBe(3);
      expect(asked.data.confirm).toMatchObject({ reason: 'unplanned', clip: { file: 'assets/b.mp4' } });
      return asked.data.confirm;
    };
    expect(await changed([TWO[0], { ...TWO[1], prompt: 'a chair in the shade' }])).toMatchObject({ credits: 25, clip: { what: 'a chair in the shade' } });
    expect(await changed([TWO[0], { ...TWO[1], seconds: 8 }])).toMatchObject({ credits: 40, clip: { seconds: 8 } });
    // The generator runs with the environment of the command: 720p for both.
    expect(await changed(TWO, withPrograms({ ...rt, env: { ...rt.env, POPOST_VIDEO_RESOLUTION: '720p' } }))).toMatchObject({ credits: 50 });
    // As agreed, it is a rerun: the clip comes back and nothing is charged.
    await list(rt, TWO);
    expect(await materials(rt, '--confirm', '--max-credits', '0')).toMatchObject({ code: 0, data: { made: 1, chargedCredits: 0 } });
    expect(api.balance).toBe(450);
  });
});

/** Speech on the same account (a credit per started 10 characters, taken from the balance), and a project speaker on a popost: voice. */
const withSpeech = async () => {
  const s = await setup();
  const { rt, stub, api } = s;
  const price = (text: unknown): number => Math.ceil(String(text).length / 10);
  stub.files.set('line.wav', wav());
  stub.set('GET', '/me', () => ok({ credits: { balance: api.balance } }));
  stub.set('GET', '/voices', () => ok({ items: [MALE], total: 1 }));
  stub.set('POST', '/voices/quote', (req) => ok({ credits: price(req.json?.text) }));
  stub.set('POST', '/voices/speech', (req) => {
    api.charge(req.headers['x-popost-task'], 'voice', price(req.json?.text));
    return ok({ audioUrl: ORIGIN + '/files/line.wav', chargedCredits: price(req.json?.text), words: null });
  });
  const reference = wav();
  await rt.fs.mkdir(PROJECT + '/assets/voices');
  await rt.fs.writeFile(PROJECT + '/assets/voices/host.wav', reference);
  await rt.fs.writeFile(PROJECT + '/voices.json', JSON.stringify({ version: 1, speakers: [{ id: 'host', reference: 'assets/voices/host.wav', sha256: sha256(reference), mode: 'audio-first', providerVoice: 'popost:' + MALE.id }] }));
  const speak = (text: string, ...more: string[]) => cli(rt, 'video', 'voice', 'speak', PROJECT, '--speaker', 'host', '--text', text, '--out', PROJECT + '/assets/line.wav', ...more);
  return { ...s, speak };
};

describe('popost video voice speak on a popost: voice', () => {
  it('prints the price with exit code 3 and charges nothing without --confirm, and speaks with it', async () => {
    const { stub, api, speak } = await withSpeech();
    const asked = await speak('Hello there');
    expect(asked.code).toBe(3);
    expect(asked.data).toMatchObject({ ok: false, confirm: { credits: 2, balance: 500, items: [{ kind: 'speech', what: '"Hello there" in the voice Default male', credits: 2 }] }, next: expect.stringContaining('--confirm --max-credits') });
    expect([stub.calls('POST', '/voices/speech').length, api.balance]).toEqual([0, 500]);
    expect(await speak('Hello there', '--confirm', '--max-credits', '2')).toMatchObject({ code: 0, data: { ok: true, chargedCredits: 2 } });
    expect(api.balance).toBe(498);
  });

  it('a ceiling below the price asks again, and a balance below it is INSUFFICIENT_CREDITS; neither speaks', async () => {
    const { stub, api, speak } = await withSpeech();
    const low = await speak('Hello there', '--confirm', '--max-credits', '1');
    expect(low).toMatchObject({ code: 3, data: { confirm: { credits: 2, maxCredits: 1 }, next: expect.stringContaining('more than --max-credits') } });
    api.balance = 1;
    const poor = await speak('Hello there', '--confirm', '--max-credits', '5');
    expect(poor.code).toBe(2);
    expect(String(poor.data.error)).toMatch(/Not enough credits: this needs 2 credits and the balance is 1.*popost account.*\[INSUFFICIENT_CREDITS\]/);
    expect([stub.calls('POST', '/voices/speech').length, api.balance]).toEqual([0, 1]);
  });
});

describe('one budget for the whole video', () => {
  it('each paid command runs within what is left, and the one that would go past it asks without charging', async () => {
    const { rt, stub, api, speak: say } = await withSpeech();
    const speak = (text: string, left: number) => say(text, '--confirm', '--max-credits', String(left));
    // The budget the user agreed to: 60 credits for the video.
    const line = await speak('Hello there', 60);
    expect(line).toMatchObject({ code: 0, data: { ok: true, chargedCredits: 2 } });
    await list(rt, TWO);
    const clips = await materials(rt, '--confirm', '--max-credits', String(60 - 2));
    expect(clips).toMatchObject({ code: 0, data: { made: 2, chargedCredits: 50 } });
    // 8 are left; a line of 10 credits is asked about, and nothing is spoken or charged.
    const long = await speak('This line is long enough to cost ten credits, which is more than the eight credits that are left.', 60 - 2 - 50);
    expect(long.code).toBe(3);
    expect(long.data).toMatchObject({ ok: false, confirm: { credits: 10, maxCredits: 8, balance: 448, items: [{ kind: 'speech', credits: 10 }] } });
    expect(stub.calls('POST', '/voices/speech')).toHaveLength(1);
    expect(api.balance).toBe(448);
  });
});

describe('the budget kept by what popost.ai counts', () => {
  it('usage gives what is left, refunds and clips paid by a run that stopped included, and every charge is under the project\'s task', async () => {
    const { rt, stub, api, speak: say } = await withSpeech();
    const usage = async (): Promise<Json> => {
      const r = await cli(rt, 'usage', '--dir', PROJECT, '--budget', '80');
      expect(r.code, JSON.stringify(r.data)).toBe(0);
      return r.data;
    };
    // The budget the user agreed: 80 credits. Nothing was sent from the project yet.
    expect(await usage()).toMatchObject({ task: null, credits: 0, budget: { agreed: 80, spent: 0, left: 80 } });
    expect(await say('Hello there', '--confirm', '--max-credits', String((await usage()).budget.left))).toMatchObject({ code: 0, data: { chargedCredits: 2 } });
    const id = JSON.parse(await rt.fs.readText(PROJECT + '/production/task.json')).id as string;
    expect(await usage()).toMatchObject({ task: id, title: 'p', credits: 2, items: [{ kind: 'voice', credits: 2, count: 1 }], budget: { left: 78 } });
    // The clips are paid for, but the generator stops waiting before they are made: it prints no chargedCredits.
    await list(rt, TWO);
    api.readyAfter = 3;
    const impatient = withPrograms({ ...rt, env: { ...rt.env, POPOST_GEN_WAIT_MIN: '0.1' } });
    const stopped = await materials(impatient, '--confirm', '--max-credits', String((await usage()).budget.left));
    expect(stopped).toMatchObject({ code: 2, data: { made: 0, chargedCredits: 0 } });
    // Adding up chargedCredits says 2; the platform says 52, and that is what is left of the budget from.
    expect(await usage()).toMatchObject({ credits: 52, items: [{ kind: 'voice', credits: 2 }, { kind: 'video', credits: 50, count: 2 }], budget: { left: 28 } });
    const picked = await materials(rt, '--confirm', '--max-credits', String((await usage()).budget.left));
    expect(picked).toMatchObject({ code: 0, data: { made: 2, chargedCredits: 0 } });
    expect((await usage()).budget).toMatchObject({ spent: 52, left: 28 });
    // A clip that fails is refunded: it does not count.
    await list(rt, [...TWO, { file: 'assets/c.mp4', prompt: 'a lamp on the desk', seconds: 5 }]);
    api.failWith = { code: 'CONTENT_REJECTED', message: 'the prompt was flagged' };
    const asked = await materials(rt, '--confirm', '--max-credits', '28');
    const key = asked.data.confirm.clip.key as string;
    expect((await materials(rt, '--confirm', '--max-credits', '28', '--approve-unplanned', key)).code).toBe(2);
    expect(await usage()).toMatchObject({ credits: 52, budget: { left: 28 } });
    // Every paid call carried the project's task, and the agent's session is not there without one.
    const paid = [...stub.calls('POST', '/voices/speech'), ...stub.calls('POST', '/videos/generations')];
    expect(paid.length).toBe(4);
    expect(paid.every((call) => call.path.startsWith('/api/open/v1/'))).toBe(true);
    for (const call of paid) expect([call.headers['x-popost-task'], call.headers['x-popost-task-title'], call.headers['x-popost-agent-session']]).toEqual([id, 'p', undefined]);
    expect(api.balance).toBe(500 - 52);
  });
});
