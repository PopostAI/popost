/**
 * `image quote` and `image run` for several jobs at once: one quote per job and one list; the runs go out side by side
 * (bounded), each exactly the single run it would have been, one result per job, a non-zero exit when any job did not
 * succeed, and one job's failure never cancels or retries another.
 */
import { describe, expect, it } from 'vitest';
import { Project } from '../src/core/project';
import { API, cli, err, newScene, tinyPng, type Json } from './image-helpers';

const JOBS = '/work/project/production/jobs';
const LEDGER = '/work/project/production/ledger.jsonl';
const PRICE = 12;
const GENERATIONS = `POST ${API}/images/generations`;

interface Tracker {
  inFlight: number;
  /** The most generation requests that were open at the same moment. */
  max: number;
  sent: { prompt: string; key: string; maxCredits: unknown }[];
  /** What the platform does with a prompt: refuse it, or never answer. */
  behaviour: Map<string, 'reject' | 'hang'>;
}

const setup = async (ids: readonly string[], options: { delayMs?: number; balance?: number } = {}) => {
  const tracker: Tracker = { inFlight: 0, max: 0, sent: [], behaviour: new Map() };
  const files: Record<string, string | Uint8Array> = { '/work/short.json': JSON.stringify({ popost: { generationTimeoutSec: 0.05 } }), '/work/ref.png': tinyPng([1, 2, 3], 3) };
  for (const id of ids) files[`/work/${id}.txt`] = `picture ${id}`;
  const scene = await newScene({
    files,
    fetchHandler: (stub) => async (request) => {
      if (request.method !== 'POST' || new URL(request.url).pathname !== `${API}/images/generations`) return stub.fetch(request);
      const body = (await request.clone().json()) as Json;
      tracker.sent.push({ prompt: body.prompt, key: body.idempotencyKey, maxCredits: body.maxCredits });
      tracker.inFlight += 1;
      tracker.max = Math.max(tracker.max, tracker.inFlight);
      try {
        const mode = tracker.behaviour.get(body.prompt);
        if (mode === 'reject') {
          const [status, payload] = err(422, 'CONTENT_REJECTED');
          return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
        }
        if (mode === 'hang') await new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
        return await stub.fetch(request);
      } finally {
        tracker.inFlight -= 1;
      }
    },
  });
  if (options.delayMs) scene.stub.delays.set(GENERATIONS, options.delayMs);
  if (options.balance !== undefined) scene.stub.balance = options.balance;
  const project = await Project.create(scene.rt, 'project', 'brief', 'original');
  project.manifest.provider = { channel: 'official', model: null };
  await project.saveManifest();
  const image = (...args: string[]) => cli(scene.rt, 'image', ...args, '--dir', 'project');
  for (const id of ids) {
    const r = await image('prepare', '--purpose', 'material', '--id', id, '--prompt-file', `/work/${id}.txt`, '--aspect', '9:16');
    expect(r.code, JSON.stringify(r.data)).toBe(0);
  }
  const job = async (id: string) => JSON.parse(await scene.rt.fs.readText(`${JOBS}/${id}.json`)) as Json;
  const patch = async (id: string, change: Json) => scene.rt.fs.writeFile(`${JOBS}/${id}.json`, JSON.stringify({ ...(await job(id)), ...change }));
  const ledger = async (): Promise<Json[]> => ((await scene.rt.fs.stat(LEDGER)) ? (await scene.rt.fs.readText(LEDGER)).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Json) : []);
  const quoteAll = async (...selection: string[]) => {
    const r = await image('quote', ...selection);
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    return r.data as Json;
  };
  return { ...scene, tracker, image, job, patch, ledger, quoteAll };
};

type T = Awaited<ReturnType<typeof setup>>;

const ids3 = ['a', 'b', 'c'];
const generationCalls = (t: T) => t.stub.calls('POST', '/images/generations');

describe('image quote for several jobs', () => {
  it('quotes each named job and prints one list with every quote id and the total', async () => {
    const t = await setup(ids3);
    const r = await t.image('quote', '--id', 'a,b,c');
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(r.data).toMatchObject({ ok: true, action: 'quote', quoted: 3, failed: 0, totalCredits: '36', balance: 500, concurrency: 4 });
    expect(r.data.jobs.map((row: Json) => [row.id, row.ok, row.credits, row.model, row.aspect])).toEqual([['a', true, '12', 'stub-model-a', '9:16'], ['b', true, '12', 'stub-model-a', '9:16'], ['c', true, '12', 'stub-model-a', '9:16']]);
    expect(new Set(r.data.quoteIds).size).toBe(3);
    expect(r.data.next).toBe(`image run --dir project --quote-id ${r.data.quoteIds.join(',')} --confirm`);
    for (const [i, id] of ids3.entries()) expect(await t.job(id)).toMatchObject({ status: 'quoted', quoteId: r.data.quoteIds[i] });
    expect(await t.rt.fs.stat(r.data.jobs[0].quoteFile)).not.toBeNull();
    expect(t.stub.calls('POST', '/images/quote')).toHaveLength(3);
    expect(generationCalls(t)).toEqual([]); // a quote never submits
  });

  it('--all takes every prepared job that has no result and was not submitted, and says why it left the others out', async () => {
    const t = await setup(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    await t.patch('b', { status: 'generated', runAttempted: true, attemptedQuoteId: 'q_old' });
    await t.patch('c', { status: 'completed' });
    await t.patch('d', { status: 'quoted', runAttempted: true }); // charged or unknown: only by name
    await t.patch('e', { provider: { channel: 'host', model: null } });
    await t.patch('g', { status: 'quoted', quoteId: 'q_stale' }); // quoted but never run: quoted again, the old quote is replaced
    const r = await t.image('quote', '--all');
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(r.data.jobs.map((row: Json) => row.id)).toEqual(['a', 'f', 'g']);
    expect(r.data.skipped).toEqual([
      { id: 'b', reason: 'already generated' },
      { id: 'c', reason: 'complete' },
      { id: 'd', reason: 'already submitted (outcome unknown or charged); retry only by naming it with --id' },
      { id: 'e', reason: 'host channel: generate it with the host image tool, then image complete' },
    ]);
    expect((await t.job('g')).quoteId).not.toBe('q_stale');
    expect(t.stub.calls('POST', '/images/quote')).toHaveLength(3);
  });

  it('--all with nothing to quote is an input error that names what was skipped', async () => {
    const t = await setup(['a']);
    await t.patch('a', { status: 'completed' });
    const r = await t.image('quote', '--all');
    expect([r.code, r.data.error]).toEqual([2, 'no job to quote (a: complete)']);
    const none = await setup([]);
    expect((await none.image('quote', '--all')).data.error).toBe('no job to quote; prepare jobs first with image prepare');
  });

  it('keeps the quotes that worked when one job cannot be quoted, and exits with that job\'s code', async () => {
    const t = await setup(['a', 'b', 'c']);
    await t.rt.fs.writeFile('/work/ref2.png', tinyPng([5, 5, 5], 3));
    await t.image('prepare', '--purpose', 'material', '--id', 'r', '--prompt-file', '/work/a.txt', '--aspect', '3:4', '--ref', '/work/ref2.png');
    await t.rt.fs.writeFile('/work/ref2.png', tinyPng([6, 6, 6], 3)); // the reference changed after prepare
    const r = await t.image('quote', '--id', 'a,r,c');
    expect(r.code).toBe(2);
    expect(r.data).toMatchObject({ ok: false, quoted: 2, failed: 1, totalCredits: '24' });
    expect(r.data.jobs.map((row: Json) => [row.id, row.ok])).toEqual([['a', true], ['r', false], ['c', true]]);
    expect(r.data.jobs[1]).toMatchObject({ code: 2, error: 'reference changed; do not consume the old quote' });
    expect((await t.job('a')).status).toBe('quoted');
    expect((await t.job('r')).status).toBe('prepared');
  });

  it('refuses two jobs that ask for the same picture, before any quote', async () => {
    const t = await setup(['a']);
    await t.image('prepare', '--purpose', 'material', '--id', 'twin', '--prompt-file', '/work/a.txt', '--aspect', '9:16');
    const r = await t.image('quote', '--id', 'a,twin');
    expect([r.code, r.data.error]).toEqual([2, "jobs 'a' and 'twin' ask for the same picture (same prompt, aspect and references); keep one, or change the prompt of the other"]);
    expect(t.stub.requests).toEqual([]);
  });

  it('says so when the quotes together cost more than the balance, although each one alone is covered', async () => {
    const t = await setup(['a', 'b'], { balance: 20 });
    const r = await t.image('quote', '--id', 'a,b');
    expect(r.code).toBe(1);
    expect(r.data).toMatchObject({ ok: false, quoted: 2, totalCredits: '24', balance: 20 });
    expect(r.data.error).toContain('they total 24 credits and the balance is 20');
    expect(r.data.next).toBeUndefined();
    expect(r.data.quoteIds).toHaveLength(2); // the quotes exist: run fewer of them
  });
});

describe('image run for several quotes', () => {
  it('runs the jobs side by side and prints one result per job, in the order given', async () => {
    const t = await setup(ids3, { delayMs: 60 });
    const quoted = await t.quoteAll('--all');
    const r = await t.image('run', '--quote-id', [...quoted.quoteIds].reverse().join(','), '--confirm');
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(t.tracker.max).toBe(3); // all three were open at the same time
    expect(r.data).toMatchObject({ ok: true, action: 'run', total: 3, succeeded: 3, failed: 0, ambiguous: 0, concurrency: 4 });
    expect(r.data.jobs.map((row: Json) => [row.id, row.outcome, row.ok, row.quoteId])).toEqual([
      ['c', 'ok', true, quoted.quoteIds[2]],
      ['b', 'ok', true, quoted.quoteIds[1]],
      ['a', 'ok', true, quoted.quoteIds[0]],
    ]);
    for (const row of r.data.jobs) {
      // what a single run prints
      expect(row).toMatchObject({ ok: true, billing: { charged: true, actualCredits: PRICE }, ledger: LEDGER });
      expect(row.taskId).toMatch(/^pt-/);
      expect(row.idempotencyKey).toMatch(/^skill-/);
      expect(await t.rt.fs.readFile(row.materials[0].localPath)).toEqual(t.stub.inlinePng);
      expect(row.materials[0].localPath).toContain(`/production/results/${row.id}/`);
    }
    for (const id of ids3) expect(await t.job(id)).toMatchObject({ status: 'generated', runAttempted: true });
  });

  it('gives every job its own idempotency key, confirmed total and ledger entry', async () => {
    const t = await setup(ids3, { delayMs: 30 });
    const quoted = await t.quoteAll('--all');
    await t.image('run', '--quote-id', quoted.quoteIds.join(','), '--confirm');
    expect(new Set(t.tracker.sent.map((s) => s.key)).size).toBe(3);
    for (const sent of t.tracker.sent) expect([sent.key.startsWith('skill-'), sent.maxCredits]).toEqual([true, PRICE]);
    const rows = await t.ledger();
    expect(rows).toHaveLength(6); // reserved + consumed per quote, none lost to the concurrent appends
    for (const quoteId of quoted.quoteIds) expect(rows.filter((row) => row.quoteId === quoteId).map((row) => row.state)).toEqual(['reserved', 'consumed']);
    expect(t.stub.balance).toBe(500 - 3 * PRICE);
  });

  it('never has more than four generations open, and --concurrency lowers that', async () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'];
    const t = await setup(six, { delayMs: 40 });
    const quoted = await t.quoteAll('--all');
    const r = await t.image('run', '--quote-id', quoted.quoteIds.join(','), '--confirm');
    expect([r.code, r.data.succeeded, t.tracker.max]).toEqual([0, 6, 4]);
    const two = await setup(six, { delayMs: 40 });
    const q2 = await two.quoteAll('--all');
    expect((await two.image('run', '--quote-id', q2.quoteIds.join(','), '--confirm', '--concurrency', '2')).data).toMatchObject({ succeeded: 6, concurrency: 2 });
    expect(two.tracker.max).toBe(2);
    const one = await setup(['a', 'b', 'c'], { delayMs: 20 });
    const q1 = await one.quoteAll('--all');
    await one.image('run', '--quote-id', q1.quoteIds.join(','), '--confirm', '--concurrency', '1');
    expect(one.tracker.max).toBe(1);
  });

  it('--all-quoted runs every quote that has not been run and leaves the rest', async () => {
    const t = await setup(['a', 'b', 'c', 'd']);
    const first = await t.quoteAll('--id', 'a,b');
    expect((await t.image('run', '--id', 'a', '--quote-id', first.quoteIds[0], '--confirm')).code).toBe(0); // a is already run
    expect((await t.image('quote', '--id', 'c')).code).toBe(0); // d is never quoted
    const r = await t.image('run', '--all-quoted', '--confirm');
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(r.data.jobs.map((row: Json) => row.id)).toEqual(['b', 'c']);
    expect(r.data.skipped).toEqual([{ id: 'a', reason: 'already generated' }, { id: 'd', reason: 'not quoted yet' }]);
    expect(generationCalls(t)).toHaveLength(3);
    const again = await t.image('run', '--all-quoted', '--confirm');
    expect(again.code).toBe(2);
    expect(again.data.error).toContain('no quoted job is ready to run');
    expect(generationCalls(t)).toHaveLength(3);
  });

  it('a quote that was already run is reported, not run again, when the same list is sent twice', async () => {
    const t = await setup(['a', 'b']);
    const quoted = await t.quoteAll('--all');
    expect((await t.image('run', '--id', 'a', '--quote-id', quoted.quoteIds[0], '--confirm')).code).toBe(0);
    const r = await t.image('run', '--quote-id', quoted.quoteIds.join(','), '--confirm');
    expect(r.code).toBe(1);
    expect(r.data).toMatchObject({ ok: false, succeeded: 1, failed: 1 });
    expect(r.data.jobs[0]).toMatchObject({ id: 'a', outcome: 'failed', charged: true, code: 1 }); // charged by the first run
    expect(r.data.jobs[0].error).toContain('was already run and made its picture');
    expect(r.data.jobs[1]).toMatchObject({ id: 'b', outcome: 'ok' });
    expect(generationCalls(t)).toHaveLength(2); // a once, b once
  });

  it('one job refused by the platform fails alone: the others finish, nothing is retried, the exit code says so', async () => {
    const t = await setup(ids3, { delayMs: 30 });
    const quoted = await t.quoteAll('--all');
    t.tracker.behaviour.set('picture b', 'reject');
    const r = await t.image('run', '--quote-id', quoted.quoteIds.join(','), '--confirm');
    expect(r.code).toBe(1);
    expect(r.data).toMatchObject({ ok: false, total: 3, succeeded: 2, failed: 1, ambiguous: 0 });
    expect(r.data.jobs.map((row: Json) => [row.id, row.outcome])).toEqual([['a', 'ok'], ['b', 'failed'], ['c', 'ok']]);
    expect(r.data.jobs[1]).toMatchObject({ ok: false, code: 1, charged: false, quoteId: quoted.quoteIds[1] });
    expect(r.data.jobs[1].error).toContain('提交被拒绝');
    expect(t.tracker.sent).toHaveLength(3); // one request per job, none repeated
    expect(await t.job('b')).toMatchObject({ status: 'quoted', quoteId: quoted.quoteIds[1] });
    expect((await t.job('b')).runAttempted).toBeUndefined(); // exactly what a single refused run leaves: nothing was charged, the job is open
    expect(await t.job('a')).toMatchObject({ status: 'generated' });
    expect(await t.job('c')).toMatchObject({ status: 'generated' });
    // the spent quote is not run again, as alone; the job quotes again and runs
    const again = await t.image('run', '--id', 'b', '--quote-id', quoted.quoteIds[1]!, '--confirm');
    expect(again.code).toBe(1);
    expect(again.data.error).toContain(`quote ${quoted.quoteIds[1]} was already submitted and refused without a charge; quote the job again (image quote --dir /work/project --id b)`);
    t.tracker.behaviour.delete('picture b');
    const redo = await t.image('quote', '--all');
    expect(redo.data.jobs.map((row: Json) => row.id)).toEqual(['b']); // --all leaves the generated ones out and takes the refused one
    const ok = await t.image('run', '--all-quoted', '--confirm');
    expect([ok.code, ok.data.succeeded]).toEqual([0, 1]);
    expect(t.tracker.sent).toHaveLength(4);
  });

  it('an unknown outcome of one job is reported as ambiguous, stays that job\'s, and is retried only under its own key', async () => {
    const t = await setup(ids3);
    const quoted = await t.quoteAll('--all');
    t.tracker.behaviour.set('picture b', 'hang');
    const r = await t.image('run', '--quote-id', quoted.quoteIds.join(','), '--confirm', '--config', '/work/short.json');
    expect(r.code).toBe(1);
    expect(r.data).toMatchObject({ ok: false, succeeded: 2, failed: 0, ambiguous: 1 });
    expect(r.data.jobs.map((row: Json) => [row.id, row.outcome])).toEqual([['a', 'ok'], ['b', 'ambiguous'], ['c', 'ok']]);
    expect(r.data.jobs[1]).toMatchObject({ ok: false, charged: 'unknown' });
    expect(r.data.jobs[1].error).toContain('ambiguous');
    expect(r.data.next).toContain('outcome unknown for b');
    expect((await t.ledger()).filter((row) => row.quoteId === quoted.quoteIds[1]).map((row) => row.state)).toEqual(['reserved', 'ambiguous']);
    expect(t.tracker.sent).toHaveLength(3);
    const key = t.tracker.sent.find((s) => s.prompt === 'picture b')!.key;

    // --all-quoted does not touch it; naming it quotes it again and the run reuses the original key
    expect((await t.image('run', '--all-quoted', '--confirm')).data.error).toContain('no quoted job is ready to run');
    t.tracker.behaviour.delete('picture b');
    const again = await t.image('quote', '--id', 'b,');
    expect(again.data.error).toBe('--id has an empty entry; separate several with single commas');
    const requote = await t.image('quote', '--id', 'b');
    expect(requote.code, JSON.stringify(requote.data)).toBe(0);
    const newQuote = requote.data.quote.quoteId as string;
    expect(newQuote).not.toBe(quoted.quoteIds[1]);
    const retry = await t.image('run', '--id', 'b', '--quote-id', newQuote, '--confirm');
    expect(retry.code, JSON.stringify(retry.data)).toBe(0);
    expect(retry.data.idempotencyKey).toBe(key);
    expect(t.tracker.sent.filter((s) => s.prompt === 'picture b').map((s) => s.key)).toEqual([key, key]);
  });

  it('keeps an expired quote from closing its job: it is reported, the job is not marked attempted, and a new quote runs', async () => {
    const t = await setup(['a', 'b']);
    const quoted = await t.quoteAll('--all');
    const later = { ...t.rt, now: () => new Date(Date.UTC(2026, 10, 5, 5, 0, 0)) }; // hours after the 10 minute quotes
    const late = (...args: string[]) => cli(later, 'image', ...args, '--dir', 'project');
    const r = await late('run', '--quote-id', quoted.quoteIds.join(','), '--confirm');
    expect(r.code).toBe(1);
    expect(r.data).toMatchObject({ ok: false, succeeded: 0, failed: 2 });
    expect(r.data.jobs[0]).toMatchObject({ id: 'a', outcome: 'failed', charged: false, code: 1 });
    expect(r.data.jobs[0].error).toContain('expired at');
    expect(r.data.jobs[0].error).toContain('quote the job again');
    expect(t.tracker.sent).toEqual([]);
    expect((await t.job('a')).runAttempted).toBeUndefined();
    const fresh = (await late('quote', '--all')).data;
    const ok = await late('run', '--quote-id', fresh.quoteIds.join(','), '--confirm');
    expect([ok.code, ok.data.succeeded]).toEqual([0, 2]);
  });

  it('after the host cancelled, no further job is started and each says so', async () => {
    const t = await setup(ids3);
    const quoted = await t.quoteAll('--all');
    const controller = new AbortController();
    const cancelling = { ...t.rt, signal: controller.signal };
    t.stub.set('POST', '/images/generations', () => {
      controller.abort(new Error('turn ended'));
      return [200, { success: true, data: { model: 'stub-model-a', images: [{ mimeType: 'image/png', data: Buffer.from(t.stub.inlinePng).toString('base64') }], usage: { credits: PRICE }, balance: 488 }, error: null }];
    });
    const r = await cli(cancelling, 'image', 'run', '--dir', 'project', '--quote-id', quoted.quoteIds.join(','), '--confirm', '--concurrency', '1');
    expect(r.code).toBe(1);
    expect(r.data.jobs.map((row: Json) => [row.id, row.outcome])).toEqual([['a', 'ok'], ['b', 'failed'], ['c', 'failed']]);
    expect(r.data.jobs[1]).toMatchObject({ charged: false, error: 'cancelled before this job was submitted; nothing was sent or charged' });
    expect(generationCalls(t)).toHaveLength(1);
    expect((await t.job('b')).runAttempted).toBeUndefined();
  });
});

describe('flags of a batch', () => {
  const cases: [string, string[], string][] = [
    ['--all with --id', ['quote', '--all', '--id', 'a'], '--all and --id are alternatives: name jobs with --id a,b,c, or take every prepared job with --all'],
    ['an empty entry', ['quote', '--id', 'a,,b'], '--id has an empty entry; separate several with single commas'],
    ['a job named twice', ['quote', '--id', 'a,a'], '--id names a twice'],
    ['an unknown job', ['quote', '--id', 'a,zzz'], "no job 'zzz' to quote (prepared jobs: a, b, c)"],
    ['an invalid job id', ['quote', '--id', 'a,b c'], 'invalid job id: b c'],
    ['--quote-id on a batch quote', ['quote', '--id', 'a,b', '--quote-id', 'q1'], '--quote-id belongs to run, not to quote'],
    ['--all-quoted on quote', ['quote', '--all-quoted'], '--all-quoted picks quotes to run; to quote every prepared job use --all'],
    ['--all on run', ['run', '--all', '--confirm'], '--all picks jobs to quote; to run every quoted job use --all-quoted'],
    ['--all on prepare', ['prepare', '--all'], '--all applies to quote only'],
    ['--all-quoted on status', ['status', '--all-quoted'], '--all-quoted applies to run only'],
    ['--all-quoted with --quote-id', ['run', '--all-quoted', '--quote-id', 'q1,q2', '--confirm'], '--all-quoted and --quote-id are alternatives: name quotes with --quote-id q1,q2, or take every quote not yet run with --all-quoted'],
    ['--id on a batch run', ['run', '--id', 'a', '--quote-id', 'q1,q2', '--confirm'], 'a run of several jobs finds each job by its quote id: drop --id'],
    ['one key for several jobs', ['run', '--quote-id', 'q1,q2', '--idempotency-key', 'abcdefgh1234', '--confirm'], "--idempotency-key is one job's key; a run of several jobs reuses the key of each job's own ambiguous attempt by itself"],
    ['several --id on run', ['run', '--id', 'a,b', '--confirm'], 'run takes one --id; to run several jobs give their quote ids: --quote-id q1,q2 or --all-quoted'],
    ['several --id on status', ['status', '--id', 'a,b'], 'status takes one --id'],
    ['a list of quote ids on quote of one job', ['quote', '--id', 'a', '--quote-id', 'q1,q2'], '--quote-id lists apply to run only'],
    ['too many at a time', ['quote', '--id', 'a,b', '--concurrency', '5'], '--concurrency must be 1 to 4: the platform allows 4 generations in flight per user'],
    ['none at a time', ['quote', '--id', 'a,b', '--concurrency', '0'], '--concurrency must be 1 to 4: the platform allows 4 generations in flight per user'],
  ];
  it.each(cases)('refuses %s with exit 2 and sends nothing', async (_name, args, message) => {
    const t = await setup(ids3);
    const before = t.stub.requests.length;
    const r = await t.image(...args);
    expect([r.code, r.data.error]).toEqual([2, message]);
    expect(t.stub.requests).toHaveLength(before);
  });

  it('refuses a run without --confirm, an unknown or doubled quote id and a quote that is not any job\'s, all before anything is sent', async () => {
    const t = await setup(ids3);
    const quoted = await t.quoteAll('--all');
    const [q1, q2] = quoted.quoteIds as string[];
    let r = await t.image('run', '--quote-id', `${q1},${q2}`);
    expect([r.code, r.data.error]).toEqual([2, 'explicit fee authorization required']);
    r = await t.image('run', '--quote-id', `${q1},q_nobody`, '--confirm');
    expect(r.code).toBe(2);
    expect(r.data.error).toBe(`no job is bound to quote q_nobody; quote the job first, and run the quote id it printed (jobs and their quotes: a=${q1}, b=${q2}, c=${quoted.quoteIds[2]})`);
    r = await t.image('run', '--quote-id', `${q1},${q1}`, '--confirm');
    expect([r.code, r.data.error]).toEqual([2, '--quote-id names ' + q1 + ' twice']);
    expect(generationCalls(t)).toEqual([]);
    expect((await t.job('a')).runAttempted).toBeUndefined();
  });

  it('keeps one job with one quote id working exactly as before, with or without a list of one', async () => {
    const t = await setup(['a', 'b']);
    const quoted = await t.quoteAll('--id', 'a,b');
    const single = await t.image('run', '--id', 'a', '--quote-id', quoted.quoteIds[0], '--confirm', '--concurrency', '3');
    expect(single.code, JSON.stringify(single.data)).toBe(0);
    expect(single.data.action).toBeUndefined(); // the CLI's own answer, not a batch document
    expect(single.data).toMatchObject({ ok: true, quoteId: quoted.quoteIds[0], billing: { charged: true } });
    const one = await t.image('quote', '--id', 'b');
    expect(one.data.quote.quoteId).toBeDefined(); // a single quote still prints the quote record
    expect(one.data.jobs).toBeUndefined();
  });
});

describe('a single job without --id', () => {
  const composition = '/work/project/production/jobs/composition.json';

  it('runs the material job that holds the quote, in a project that has no composition job', async () => {
    const t = await setup(['a', 'b']);
    const [qa, qb] = (await t.quoteAll('--id', 'a,b')).quoteIds as string[];
    expect(await t.rt.fs.stat(composition)).toBeNull();
    const r = await t.image('run', '--quote-id', qb!, '--confirm');
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(r.data.action).toBeUndefined(); // the single run's own answer, not a batch document
    expect(r.data).toMatchObject({ ok: true, quoteId: qb, billing: { charged: true } });
    expect(await t.job('b')).toMatchObject({ status: 'generated', runAttempted: true, quoteId: qb });
    expect(await t.job('a')).toMatchObject({ status: 'quoted', quoteId: qa });
    expect((await t.job('a')).runAttempted).toBeUndefined();
    expect(generationCalls(t)).toHaveLength(1);
    expect(r.data.materials[0].localPath).toContain('/production/results/b/');
    const again = await t.image('run', '--quote-id', qb!, '--confirm'); // the quote still names its job, which refuses a second submission
    expect([again.code, again.data.error]).toEqual([2, 'submission already attempted; query its quote/ledger before any retry']);
    expect(generationCalls(t)).toHaveLength(1);
  });

  it('names the jobs and their quotes when no job holds the quote, and sends nothing', async () => {
    const t = await setup(['a', 'b']);
    const [qa, qb] = (await t.quoteAll('--id', 'a,b')).quoteIds as string[];
    const r = await t.image('run', '--quote-id', 'q_nobody', '--confirm');
    expect([r.code, r.data.error]).toEqual([2, `no job is bound to quote q_nobody; quote the job first (image quote --id <job>), and run the quote id it printed (jobs and their quotes: a=${qa}, b=${qb})`]);
    expect(r.data.error).not.toContain('ENOENT');
    expect(generationCalls(t)).toEqual([]);
  });

  it('asks for --id when several jobs hold the same quote, and keeps the checks of an explicit --id', async () => {
    const t = await setup(['a', 'b']);
    const [qa, qb] = (await t.quoteAll('--id', 'a,b')).quoteIds as string[];
    await t.patch('b', { quoteId: qa });
    let r = await t.image('run', '--quote-id', qa!, '--confirm');
    expect([r.code, r.data.error]).toEqual([2, `quote ${qa} is bound to several jobs (a, b); pass --id <job> to say which one to run`]);
    r = await t.image('run', '--id', 'a', '--quote-id', qb!, '--confirm'); // --id and the quote disagree
    expect([r.code, r.data.error]).toEqual([2, 'quote this job first; run must use its bound quote id']);
    expect(generationCalls(t)).toEqual([]);
  });

  it.each([
    ['quote', ['quote']],
    ['run', ['run', '--confirm']],
    ['status', ['status']],
    ['complete', ['complete', '--file', '/work/ref.png', '--note', 'seen']],
  ])('%s falls back to the composition id and, when that job is missing, lists the jobs that exist', async (_action, args) => {
    const t = await setup(['a', 'b']);
    const r = await t.image(...args);
    expect([r.code, r.data.error]).toEqual([2, 'no composition job in this project, and no --id was given; existing jobs: a, b; pass --id <job>']);
    expect(JSON.stringify(r.data)).not.toContain('ENOENT');
    expect(t.stub.requests).toEqual([]);
  });

  it('tells the same for a job id that does not exist, and for a project with no jobs at all', async () => {
    const t = await setup(['a', 'b']);
    const named = await t.image('status', '--id', 'hero');
    expect([named.code, named.data.error]).toEqual([2, "no job 'hero' in this project; existing jobs: a, b; pass --id <job>"]);
    const empty = await setup([]);
    const r = await empty.image('status');
    expect([r.code, r.data.error]).toEqual([2, 'no composition job in this project, and no --id was given; this project has no jobs yet; create one with image prepare']);
    expect((await t.image('status', '--id', 'a')).data.job).toMatchObject({ id: 'a', status: 'prepared' });
  });
});


describe('billing-service boundaries', () => {
  it('refuses a mixed-channel batch before quoting or submitting', async () => {
    const t = await setup(['a', 'b']);
    const file = `${JOBS}/b.json`;
    const job = JSON.parse(await t.rt.fs.readText(file));
    job.provider.channel = 'custom';
    await t.rt.fs.writeFile(file, JSON.stringify(job));
    const r = await cli(t.rt, 'image', 'quote', '--dir', '/work/project', '--all');
    expect(r.code).not.toBe(0);
    expect(t.stub.calls('POST', '/images/quote')).toHaveLength(0);
    expect(t.stub.calls('POST', '/images/generations')).toHaveLength(0);
  });
});
