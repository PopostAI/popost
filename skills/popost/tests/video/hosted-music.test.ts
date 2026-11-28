/**
 * `popost video music quote` and `make`: generated background music, paid as speech is. The price first (exit code 3
 * without --confirm or above --max-credits, nothing asked for), then one job per order under the project's task,
 * waited for while it runs and downloaded as an MP3; the same command again pays nothing twice; a refused description
 * and a failed generator charge nothing and say what to do. It needs a connected account; a generator switched off on
 * the platform (HTTP 503) is said once and nothing is asked again. The platform is the in-memory fake.
 */
import { describe, expect, it } from 'vitest';
import { createTestRuntime, runCli } from '../../src/testing/memory';
import { musicSeconds } from '../../src/video/music/hosted';
import { ENV, fakePlatform, mp3, type FakeOptions } from './hosted-fake';

const OUT = '/work/p/assets/music.mp3';
const PROMPT = 'warm lo-fi hip hop, relaxed, 80 bpm, soft piano and vinyl crackle';

const setup = (o: FakeOptions = {}) => {
  const platform = fakePlatform({ balance: 500, ...o });
  const sleeps: number[] = [];
  let t = Date.UTC(2026, 10, 27);
  const rt = createTestRuntime({ env: ENV, fetchHandler: platform.handler, now: () => new Date(t), sleep: async (ms) => { sleeps.push(ms); t += ms; } });
  const make = (...more: string[]) => runCli(rt, ['video', 'music', 'make', '--project', '/work/p', '--prompt', PROMPT, '--seconds', '30', '--out', OUT, ...more]);
  const posts = () => platform.sent.filter((s) => s.method === 'POST' && s.path === '/music');
  return { rt, platform, sleeps, make, posts };
};

describe('popost video music quote', () => {
  it('prices a length rounded up to a whole second, 3 at least, and charges nothing; over the platform\'s maximum it is refused with that maximum', async () => {
    expect([musicSeconds(0.4), musicSeconds(3), musicSeconds(29.2), musicSeconds(30), musicSeconds(900)]).toEqual([3, 3, 30, 30, 900]);
    const { rt, platform } = setup();
    expect((await runCli(rt, ['video', 'music', 'quote', '--seconds', '29.2'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, available: true, seconds: 30, credits: 54 });
    expect(rt.json().note).toBeUndefined();
    expect(platform.sent.map((s) => [s.path, s.body])).toEqual([['/music/quote', { seconds: 30 }]]);
    expect((await runCli(rt, ['video', 'music', 'quote', '--seconds', '900'])).code).toBe(2);
    expect(rt.json()).toMatchObject({ ok: false, maxSeconds: 180, problems: [{ at: '--seconds', fix: expect.stringContaining('--seconds 180') }] });
    expect(platform.account.charged).toBe(0);
  });

  it('names the tier of the quote and its longest track, and refuses a length over that tier\'s longest track before anything is made', async () => {
    const { rt, platform, make, posts } = setup({ musicModel: (s) => (s <= 30 ? { model: 'clip', maxTrackSeconds: 30 } : { model: 'song', maxTrackSeconds: 180 }) });
    expect((await runCli(rt, ['video', 'music', 'quote', '--seconds', '20'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, seconds: 20, model: 'clip', maxTrackSeconds: 30 });
    expect((await runCli(rt, ['video', 'music', 'quote', '--seconds', '95'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ model: 'song', maxTrackSeconds: 180 });
    expect((await make()).code).toBe(3);
    expect((rt.json().confirm as { items: { what: string }[] }).items[0]?.what).toContain('(clip)');
    const short = setup({ musicModel: () => ({ model: 'clip', maxTrackSeconds: 20 }) });
    expect((await short.make('--confirm', '--max-credits', '60')).code).toBe(2);
    expect(short.rt.json()).toMatchObject({ ok: false, maxSeconds: 20, chargedCredits: 0 });
    expect(short.posts()).toHaveLength(0);
    expect(posts()).toHaveLength(0);
    expect(platform.account.charged).toBe(0);
  });

  it('a generator switched off on the platform (HTTP 503) is said once: the quote is answered, make charges nothing, nothing is asked again', async () => {
    const { rt, platform, make, posts } = setup({ musicOff: true });
    expect((await runCli(rt, ['video', 'music', 'quote', '--seconds', '30'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, available: false, note: expect.stringContaining('not available on popost.ai right now') });
    expect((await make('--confirm', '--max-credits', '60')).code).toBe(2);
    expect(String(rt.json().error)).toContain('not available on popost.ai right now');
    expect(platform.sent.filter((s) => s.path === '/music/quote')).toHaveLength(2);
    expect(posts()).toHaveLength(0);
    expect(platform.account.charged).toBe(0);
  });

  it('takes the length of a project when no seconds are given, and says what it needs without either', async () => {
    const { rt } = setup();
    const project = { version: 1, canvas: { width: 180, height: 320, fps: 30 }, materials: [], segments: [{ id: 's0', frames: 200, base: { color: '#101010' } }, { id: 's1', frames: 145, base: { color: '#202020' } }], tracks: [] };
    await rt.fs.writeFile('/work/p/video.json', JSON.stringify(project));
    expect((await runCli(rt, ['video', 'music', 'quote', '--project', 'p'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, seconds: 12, credits: 22 });
    expect((await runCli(rt, ['video', 'music', 'quote'])).code).toBe(2);
    expect(String(rt.json().error)).toContain('--seconds N');
  });

  it('needs a connected account: without one nothing is priced or made, and the user\'s own file is named as the way', async () => {
    const offline = createTestRuntime({});
    expect((await runCli(offline, ['video', 'music', 'quote', '--seconds', '30'])).code).toBe(2);
    expect(String(offline.json().error)).toContain('popost auth login');
    expect((await runCli(offline, ['video', 'music', 'make', '--prompt', PROMPT, '--seconds', '30', '--out', OUT, '--confirm', '--max-credits', '60'])).code).toBe(2);
    expect(String(offline.json().error)).toContain('popost video music own');
  });
});

describe('popost video music make', () => {
  it('prints the price with exit code 3 without --confirm, and above --max-credits; nothing is asked for or charged', async () => {
    const { rt, platform, make, posts } = setup();
    expect((await make()).code).toBe(3);
    expect(rt.json()).toMatchObject({
      ok: false, next: expect.stringContaining('--confirm --max-credits'),
      confirm: { credits: 54, balance: 500, items: [{ kind: 'music', what: expect.stringContaining('instrumental music: warm lo-fi'), credits: 54, seconds: 30 }] },
    });
    expect((await make('--confirm', '--max-credits', '40')).code).toBe(3);
    expect(rt.json()).toMatchObject({ ok: false, confirm: { credits: 54, maxCredits: 40 } });
    expect((await make('--vocals')).code).toBe(3);
    expect((rt.json().confirm as { items: { what: string }[] }).items[0]?.what).toContain('music with vocals');
    expect(posts()).toHaveLength(0);
    expect(platform.account.charged).toBe(0);
    expect(await rt.fs.stat(OUT)).toBeNull();
  });

  it('makes the track under the project\'s task, waits while it runs, and writes the MP3 with its receipt', async () => {
    const { rt, platform, sleeps, make, posts } = setup({ musicReads: 12 });
    expect((await make('--confirm', '--max-credits', '60')).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, file: OUT, seconds: 30, chargedCredits: 54, instrumental: true, next: expect.stringContaining('"sound": "assets/music.mp3"') });
    expect(posts()[0]?.body).toMatchObject({ prompt: PROMPT, seconds: 30, instrumental: true, maxCredits: 60 });
    expect(posts()[0]?.body?.operationKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    // The charge is booked under the task of the project, whose id the project keeps.
    const task = JSON.parse(await rt.fs.readText('/work/p/production/task.json')) as { id: string };
    expect(posts()[0]?.task).toBe(task.id);
    expect(platform.paths().filter((p) => p === 'GET /music/m-1')).toHaveLength(12);
    expect(sleeps).toEqual(Array(12).fill(3000));
    expect(rt.err).toEqual(['popost.ai is making 30 s of music (30 s so far)\n']);
    expect(await rt.fs.readFile(OUT)).toEqual(mp3());
    expect(JSON.parse(await rt.fs.readText(OUT + '.music.json'))).toMatchObject({ prompt: PROMPT, seconds: 30, vocals: false, id: 'm-1', chargedCredits: 54, failed: [] });
    expect(platform.account.charged).toBe(54);
  });

  it('the same command again pays nothing: the file is kept, a deleted one is downloaded again, a lost receipt finds the same job', async () => {
    const { rt, platform, make, posts } = setup();
    expect((await make('--confirm', '--max-credits', '60')).code).toBe(0);
    const before = platform.sent.length;
    // The receipt names the paid track: no price to agree and nothing sent, even without --confirm.
    expect((await make()).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, chargedCredits: 0, kept: true });
    expect(platform.sent.length).toBe(before);
    await rt.fs.rm(OUT);
    expect((await make()).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, chargedCredits: 0, kept: true });
    expect(platform.paths().slice(before)).toEqual(['GET /music/m-1']);
    expect(await rt.fs.readFile(OUT)).toEqual(mp3());
    // Without the receipt the price is asked again, and the same key answers the same job.
    await rt.fs.rm(OUT + '.music.json');
    expect((await make()).code).toBe(3);
    expect((await make('--confirm', '--max-credits', '60')).code).toBe(0);
    expect(posts().map((p) => p.body?.operationKey)).toEqual([posts()[0]?.body?.operationKey, posts()[0]?.body?.operationKey]);
    expect(platform.tracks.size).toBe(1);
    expect(platform.account.charged).toBe(54);
  });

  it('another description, length or --vocals is another track, priced and agreed anew', async () => {
    const { rt, platform, make, posts } = setup();
    expect((await make('--confirm', '--max-credits', '60')).code).toBe(0);
    expect((await make('--vocals')).code).toBe(3);
    expect((await runCli(rt, ['video', 'music', 'make', '--project', '/work/p', '--prompt', 'bright synth pop, 120 bpm', '--seconds', '30', '--out', OUT])).code).toBe(3);
    expect((await make('--vocals', '--confirm', '--max-credits', '60')).code).toBe(0);
    expect(posts().map((p) => p.body?.instrumental)).toEqual([true, false]);
    expect(new Set(posts().map((p) => p.body?.operationKey)).size).toBe(2);
    expect(platform.account.charged).toBe(108);
  });

  it('a refused description is not charged and comes with a fix and the suggestion; the suggestion is then made', async () => {
    const suggestion = 'mellow hip hop instrumental, relaxed, 80 bpm, piano';
    const { rt, platform, make, posts } = setup({ musicFailures: ['rejected'], musicSuggestion: suggestion });
    expect((await make('--confirm', '--max-credits', '60')).code).toBe(2);
    expect(rt.json()).toMatchObject({ ok: false, chargedCredits: 0, suggestion, problems: [{ level: 'error', at: '--prompt', fix: expect.stringMatching(/genre, mood, tempo and instruments.*no name of an artist.*popost\.ai suggests/s) }] });
    expect(platform.account.charged).toBe(0);
    expect(await rt.fs.stat(OUT)).toBeNull();
    expect((await runCli(rt, ['video', 'music', 'make', '--project', '/work/p', '--prompt', suggestion, '--seconds', '30', '--out', OUT, '--confirm', '--max-credits', '60'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, chargedCredits: 54 });
    expect(posts()[1]?.body).toMatchObject({ prompt: suggestion });
    expect(platform.account.charged).toBe(54);
  });

  it('a description refused inside the request reads the same, without a suggestion when there is none', async () => {
    const { rt, platform, make } = setup({ musicRefusal: 'CONTENT_REJECTED' });
    expect((await make('--confirm', '--max-credits', '60')).code).toBe(2);
    expect(rt.json()).toMatchObject({ ok: false, problems: [{ at: '--prompt', fix: expect.stringContaining('Write it again') }] });
    expect(rt.json().suggestion).toBeUndefined();
    expect(platform.account.charged).toBe(0);
  });

  it('a generator that fails charges nothing; the same command again asks for a new track under a new key', async () => {
    const { rt, platform, make, posts } = setup({ musicReads: 2, musicFailures: ['unavailable'] });
    expect((await make('--confirm', '--max-credits', '60')).code).toBe(2);
    expect(String(rt.json().error)).toContain('could not make the music');
    expect(platform.account.charged).toBe(0);
    expect((await make('--confirm', '--max-credits', '60')).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, chargedCredits: 54 });
    expect(new Set(posts().map((p) => p.body?.operationKey)).size).toBe(2);
    expect([...platform.tracks.values()].map((t) => t.state)).toEqual(['failed', 'ready']);
    expect(platform.account.charged).toBe(54);
    // A failed key is final on the platform: without the receipt the first run meets the old failure, the next one a new key.
    const lost = setup({ musicReads: 2, musicFailures: ['unavailable'] });
    expect((await lost.make('--confirm', '--max-credits', '60')).code).toBe(2);
    await lost.rt.fs.rm(OUT + '.music.json');
    expect((await lost.make('--confirm', '--max-credits', '60')).code).toBe(2);
    expect(lost.platform.tracks.size).toBe(1);
    expect((await lost.make('--confirm', '--max-credits', '60')).code).toBe(0);
    expect(lost.platform.account.charged).toBe(54);
    const down = setup({ musicRefusal: 'UPSTREAM_ERROR' });
    expect((await down.make('--confirm', '--max-credits', '60')).code).toBe(2);
    expect(String(down.rt.json().error)).toContain('could not make the music');
  });

  it('a price the platform finds above the ceiling ends like a quote above it, and a short balance before anything', async () => {
    // The two quotes (the command's price, then the call's) say 54, and the platform asks 70 when the track is made.
    let asked = 0;
    const { rt, platform, make } = setup({ musicPrice: () => (++asked > 2 ? 70 : 54) });
    expect((await make('--confirm', '--max-credits', '60')).code).toBe(3);
    expect(rt.json()).toMatchObject({ ok: false, confirm: { credits: 70, maxCredits: 60 } });
    expect(platform.account.charged).toBe(0);
    const poor = setup({ balance: 10 });
    expect((await poor.make('--confirm', '--max-credits', '60')).code).toBe(2);
    expect(String(poor.rt.json().error)).toContain('INSUFFICIENT_CREDITS');
    expect(poor.posts()).toHaveLength(0);
  });

  it('checks the description and the file name before anything is sent', async () => {
    const { rt, platform } = setup();
    const run = (prompt: string, out: string) => runCli(rt, ['video', 'music', 'make', '--prompt', prompt, '--seconds', '30', '--out', out, '--confirm', '--max-credits', '60']);
    expect((await run('x'.repeat(2001), OUT)).code).toBe(2);
    expect(String(rt.json().error)).toContain('1 to 2000');
    expect((await run(PROMPT, '/work/p/assets/music.wav')).code).toBe(2);
    expect(String(rt.json().error)).toContain('MP3');
    expect(platform.sent).toHaveLength(0);
    expect((await runCli(rt, ['video', 'music', '--help'])).stdout).toContain('make');
  });

  it('video doctor says music is made on popost.ai with a connected account, and not without one', async () => {
    const { rt } = setup();
    await runCli(rt, ['video', 'doctor']);
    expect(rt.json()).toMatchObject({ tools: { music: 'popost.ai', speak: 'popost.ai' }, hosted: { music: expect.stringContaining('popost video music make') } });
    const offline = createTestRuntime({});
    await runCli(offline, ['video', 'doctor']);
    expect(offline.json()).toMatchObject({ tools: { music: null } });
  });
});
