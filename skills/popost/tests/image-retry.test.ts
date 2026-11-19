/**
 * `popost image run` after an unknown outcome. The CLI gave up waiting while the platform went on and charged, so the
 * documented safe retry (re-quote, then run again under the original idempotency key) must be possible through `image`
 * itself: the key of the ambiguous attempt is reused, any other key is refused, nothing retries by itself, and the
 * platform charges once.
 */
import { describe, expect, it } from 'vitest';
import { Project } from '../src/core/project';
import { GENERATION_TIMEOUT_SEC } from '../src/providers/popost';
import type { FetchHandler } from '../src/testing/memory';
import { API, b64, cli, err, newScene, ok, text, type Json, type PopostStub } from './image-helpers';

const JOB = '/work/project/production/jobs';
const LEDGER = '/work/project/production/ledger.jsonl';
const PRICE = 12;

/** The platform's side of generation: one task per idempotency key; a known key is replayed, never charged again. */
const idempotentPlatform = (stub: PopostStub, hang: { remaining: number }) => {
  const tasks = new Map<string, { credits: number }>();
  const seen: { key: string; replayed: boolean; maxCredits: unknown }[] = [];
  const handler: FetchHandler = async (request) => {
    const generations = request.method === 'POST' && new URL(request.url).pathname === `${API}/images/generations`;
    if (!generations || stub.overrides.has(`POST ${API}/images/generations`)) return stub.fetch(request); // a test's own scripted answer wins
    const body = JSON.parse(text(new Uint8Array(await request.clone().arrayBuffer()))) as Json;
    const key = body.idempotencyKey as string;
    const replayed = tasks.has(key);
    seen.push({ key, replayed, maxCredits: body.maxCredits });
    if (!replayed) {
      tasks.set(key, { credits: PRICE }); // the work is done and charged, whether or not anyone is still listening
      stub.balance -= PRICE;
    }
    if (hang.remaining > 0) {
      hang.remaining -= 1;
      // the answer never comes; the caller gives up at its own timeout
      await new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
    }
    const [status, payload] = ok({ model: 'stub-model-a', images: [{ mimeType: 'image/png', data: b64(stub.inlinePng) }], usage: { credits: tasks.get(key)!.credits }, balance: stub.balance });
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  };
  return { handler, tasks, seen };
};

const setup = async (hangs = 1) => {
  const hang = { remaining: hangs };
  const state: { platform?: ReturnType<typeof idempotentPlatform> } = {};
  const { rt, stub } = await newScene({
    fetchHandler: (s) => (state.platform = idempotentPlatform(s, hang)).handler,
    files: {
      '/work/prompt.txt': 'a quiet desk at dawn',
      // the first attempt waits only briefly, so a hanging platform ends it as "outcome unknown"
      '/work/short.json': JSON.stringify({ popost: { generationTimeoutSec: 0.05 } }),
    },
  });
  const project = await Project.create(rt, 'project', 'brief', 'original');
  project.manifest.provider = { channel: 'official', model: null };
  await project.saveManifest();
  const image = (...args: string[]) => cli(rt, 'image', ...args, '--dir', 'project');
  const job = async (id = 'composition') => JSON.parse(await rt.fs.readText(`${JOB}/${id}.json`)) as Json;
  const ledger = async (): Promise<Json[]> => (await rt.fs.readText(LEDGER)).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Json);
  const quote = async (): Promise<string> => {
    const r = await image('quote');
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    return r.data.quote.quoteId as string;
  };
  const prepared = await image('prepare', '--prompt-file', '/work/prompt.txt', '--aspect', '3:4');
  expect(prepared.code, JSON.stringify(prepared.data)).toBe(0);
  return { rt, stub, project, image, job, ledger, quote, platform: state.platform! };
};

type T = Awaited<ReturnType<typeof setup>>;

/** Quote and run a first time with the platform not answering: the unknown outcome of the live run. */
const firstAttempt = async (t: T) => {
  const q1 = await t.quote();
  const run = await t.image('run', '--quote-id', q1, '--confirm', '--config', '/work/short.json');
  expect(run.code, JSON.stringify(run.data)).toBe(1);
  expect(run.data.error).toContain('ambiguous');
  const key = t.platform.seen[0]!.key;
  expect(key).toMatch(/^skill-/);
  return { q1, key };
};

const states = (rows: readonly Json[]) => rows.map((row) => `${String(row.quoteId).slice(0, 6)}:${String(row.state)}`);

describe('the default waiting time', () => {
  it('outlasts the platform: its web agent cap is 600 s, so the CLI waits longer instead of giving up on a generation that then charges', () => {
    expect(GENERATION_TIMEOUT_SEC).toBeGreaterThan(600);
  });
});

describe('image run after an ambiguous attempt', () => {
  it('reuses the key of that attempt on a fresh quote and an explicit run: the platform replays, the user pays once', async () => {
    const t = await setup();
    const { q1, key } = await firstAttempt(t);
    expect(await t.job()).toMatchObject({ status: 'quoted', quoteId: q1, runAttempted: true, attemptedQuoteId: q1 });
    expect(t.stub.balance).toBe(500 - PRICE); // charged by the platform although the CLI never saw the picture

    // nothing retries by itself, and the spent quote cannot be run again
    let r = await t.image('run', '--quote-id', q1, '--confirm');
    expect([r.code, r.data.error]).toEqual([2, 'this quote was already submitted; quote the job again, then run it with the new quote id']);

    const q2 = await t.quote();
    expect(q2).not.toBe(q1);
    r = await t.image('run', '--quote-id', q2);
    expect([r.code, r.data.error]).toEqual([2, 'explicit fee authorization required']);
    expect(t.platform.seen).toHaveLength(1);

    r = await t.image('run', '--quote-id', q2, '--confirm');
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(r.data).toMatchObject({ ok: true, quoteId: q2, idempotencyKey: key, billing: { charged: true, actualCredits: PRICE } });
    expect(t.platform.seen.map(({ key: k, replayed }) => [k, replayed])).toEqual([[key, false], [key, true]]);
    expect(t.platform.seen[1]!.maxCredits).toBe(PRICE);
    expect(t.platform.tasks.size).toBe(1);
    expect(t.stub.balance).toBe(500 - PRICE); // the replay charged nothing

    const job = await t.job();
    expect(job).toMatchObject({ status: 'generated', runAttempted: true });
    expect(await t.rt.fs.readFile(job.result[0].localPath)).toEqual(t.stub.inlinePng);
    // the old quote keeps its ambiguous record; the new one is reserved once and consumed once, under the same key
    const rows = await t.ledger();
    expect(states(rows)).toEqual([`${q1.slice(0, 6)}:reserved`, `${q1.slice(0, 6)}:ambiguous`, `${q2.slice(0, 6)}:reserved`, `${q2.slice(0, 6)}:consumed`]);
    expect(rows[0]!.meta.idempotencyKey).toBe(key);
    expect(rows[2]!.meta.idempotencyKey).toBe(key);
    expect(rows.filter((row) => row.state === 'reserved')).toHaveLength(2);

    r = await t.image('run', '--quote-id', q2, '--confirm');
    expect(r.code).toBe(2);
    expect(t.platform.seen).toHaveLength(2);
  });

  it('accepts --idempotency-key when it is that key', async () => {
    const t = await setup();
    const { key } = await firstAttempt(t);
    const q2 = await t.quote();
    const r = await t.image('run', '--quote-id', q2, '--confirm', '--idempotency-key', key);
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(r.data.idempotencyKey).toBe(key);
    expect(t.platform.seen.at(-1)).toMatchObject({ key, replayed: true });
  });

  it('refuses any other key, sending nothing', async () => {
    const t = await setup();
    const { key } = await firstAttempt(t);
    const q2 = await t.quote();
    const r = await t.image('run', '--quote-id', q2, '--confirm', '--idempotency-key', 'skill-some-other-key-0001');
    expect(r.code).toBe(2);
    expect(r.data.error).toContain(key);
    expect(r.data.error).toContain('must use it');
    expect(t.platform.seen).toHaveLength(1);
    expect(await t.job()).toMatchObject({ status: 'quoted', quoteId: q2 });
    expect(await t.ledger()).toHaveLength(2); // the first attempt's reserved + ambiguous records, nothing for the refused run
    // a malformed key is a usage error like on the provider CLI
    const bad = await t.image('run', '--quote-id', q2, '--confirm', '--idempotency-key', 'bad key!');
    expect(bad.code).toBe(2);
    expect(t.platform.seen).toHaveLength(1);
  });

  it('keeps the key through a retry that is itself unknown, never a new one', async () => {
    const t = await setup(2);
    const { key } = await firstAttempt(t);
    const q2 = await t.quote();
    const second = await t.image('run', '--quote-id', q2, '--confirm', '--config', '/work/short.json');
    expect(second.code).toBe(1);
    expect(second.data.error).toContain('ambiguous');
    expect(await t.job()).toMatchObject({ attemptedQuoteId: q2 });
    const q3 = await t.quote();
    const third = await t.image('run', '--quote-id', q3, '--confirm');
    expect(third.code, JSON.stringify(third.data)).toBe(0);
    expect(t.platform.seen.map((call) => call.key)).toEqual([key, key, key]);
    expect(t.platform.tasks.size).toBe(1);
    expect(t.stub.balance).toBe(500 - PRICE);
  });

  it('keeps the earlier attempt usable when a retry is refused before anything is sent (a price that moved)', async () => {
    const t = await setup();
    const { key } = await firstAttempt(t);
    const q2 = await t.quote();
    t.stub.models[0]!.creditsPerImage = 15;
    const refused = await t.image('run', '--quote-id', q2, '--confirm');
    expect(refused.code).toBe(1);
    expect(refused.data.error).toContain('the price changed');
    expect(t.platform.seen).toHaveLength(1);
    const q3 = await t.quote();
    const run = await t.image('run', '--quote-id', q3, '--confirm');
    expect(run.code, JSON.stringify(run.data)).toBe(0);
    expect(t.platform.seen.at(-1)).toMatchObject({ key, replayed: true, maxCredits: 15 });
    expect(t.stub.balance).toBe(500 - PRICE);
  });

  it('retries a job written before the CLI recorded the attempt, once it is quoted again', async () => {
    const t = await setup();
    const { q1, key } = await firstAttempt(t);
    const legacy = await t.job();
    delete legacy.attemptedQuoteId;
    await t.rt.fs.writeFile(`${JOB}/composition.json`, JSON.stringify(legacy));
    let r = await t.image('run', '--quote-id', q1, '--confirm');
    expect([r.code, r.data.error]).toEqual([2, 'submission already attempted; query its quote/ledger before any retry']);
    const q2 = await t.quote();
    expect(await t.job()).toMatchObject({ attemptedQuoteId: q1 });
    r = await t.image('run', '--quote-id', q2, '--confirm');
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(r.data.idempotencyKey).toBe(key);
  });
});

describe('image run where a retry is not allowed', () => {
  it('takes no key on a first run', async () => {
    const t = await setup(0);
    const q1 = await t.quote();
    const r = await t.image('run', '--quote-id', q1, '--confirm', '--idempotency-key', 'skill-first-run-key-1');
    expect(r.code).toBe(2);
    expect(r.data.error).toContain('only applies to a retry');
    expect(t.platform.seen).toEqual([]);
    expect((await t.job()).runAttempted).toBeUndefined();
  });

  it('takes no key on a rerun after a definite refusal either: nothing was charged, so it is a new run, not a retry', async () => {
    const t = await setup(0);
    const q1 = await t.quote();
    t.stub.set('POST', '/images/generations', err(422, 'CONTENT_REJECTED'));
    expect((await t.image('run', '--quote-id', q1, '--confirm')).code).toBe(1);
    const q2 = await t.quote();
    const keyed = await t.image('run', '--quote-id', q2, '--confirm', '--idempotency-key', 'skill-whatever-key-0001');
    expect(keyed.code).toBe(2);
    expect(keyed.data.error).toContain('only applies to a retry');
    t.stub.clear('POST', '/images/generations');
    const r = await t.image('run', '--quote-id', q2, '--confirm');
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(r.data.idempotencyKey).toMatch(/^skill-/); // derived from its own quote, as for any first run
    expect(t.platform.seen.map((call) => call.replayed)).toEqual([false]);
  });
});

/** A run that did not cost anything leaves its job open; only a charge or an unknown outcome closes it (retry.ts). */
describe('image run that was refused without a charge', () => {
  const noLedger = async (t: T) => expect(await t.rt.fs.stat(LEDGER)).toBeNull();
  const open = async (t: T) => {
    const job = await t.job();
    expect([job.runAttempted, job.attemptedQuoteId]).toEqual([undefined, undefined]);
    return job;
  };

  it('an expired quote is refused before anything is sent; the job quotes again and runs', async () => {
    const t = await setup(0);
    const q1 = await t.quote();
    const later = { ...t.rt, now: () => new Date(Date.UTC(2026, 10, 5, 5, 0, 0)) }; // hours after the 10 minute quote
    const at = (...args: string[]) => cli(later, 'image', ...args, '--dir', 'project');
    const refused = await at('run', '--quote-id', q1, '--confirm');
    expect(refused.code).toBe(1);
    expect(refused.data.error).toContain(`quote ${q1} expired at`);
    expect(refused.data.error).toContain('quote the job again (image quote --dir /work/project --id composition), then run the new quote id');
    expect(t.platform.seen).toEqual([]);
    expect(await open(t)).toMatchObject({ status: 'quoted', quoteId: q1 });
    await noLedger(t);
    const q2 = (await at('quote')).data.quote.quoteId as string;
    const run = await at('run', '--quote-id', q2, '--confirm');
    expect(run.code, JSON.stringify(run.data)).toBe(0);
    expect(run.data).toMatchObject({ ok: true, quoteId: q2, billing: { charged: true } });
    expect(t.platform.seen).toHaveLength(1);
  });

  it('a price that moved is refused before anything is sent; a new quote at the new price runs', async () => {
    const t = await setup(0);
    const q1 = await t.quote();
    t.stub.models[0]!.creditsPerImage = 15;
    const refused = await t.image('run', '--quote-id', q1, '--confirm');
    expect(refused.code).toBe(1);
    expect(refused.data.error).toContain('the price changed');
    expect(t.platform.seen).toEqual([]);
    await open(t);
    await noLedger(t);
    const q2 = await t.quote();
    const run = await t.image('run', '--quote-id', q2, '--confirm');
    expect(run.code, JSON.stringify(run.data)).toBe(0);
    expect(t.platform.seen).toMatchObject([{ replayed: false, maxCredits: 15 }]);
  });

  it('too few credits are refused before anything is sent, and after a top-up the same quote still runs', async () => {
    const t = await setup(0);
    const q1 = await t.quote();
    t.stub.balance = 5;
    const refused = await t.image('run', '--quote-id', q1, '--confirm');
    expect(refused.code).toBe(1);
    expect(refused.data.error).toContain('Not enough credits');
    expect(t.platform.seen).toEqual([]);
    await open(t);
    await noLedger(t);
    t.stub.balance = 500;
    const run = await t.image('run', '--quote-id', q1, '--confirm');
    expect(run.code, JSON.stringify(run.data)).toBe(0);
    expect(run.data.quoteId).toBe(q1);
  });

  it('a platform that cannot answer the price check, or a config that cannot be read, is refused before anything is sent and leaves the job open', async () => {
    const t = await setup(0);
    const q1 = await t.quote();
    t.stub.set('POST', '/images/quote', err(503, 'SERVICE_UNAVAILABLE'));
    const down = await t.image('run', '--quote-id', q1, '--confirm');
    expect(down.code).toBe(1);
    t.stub.clear('POST', '/images/quote');
    await t.rt.fs.writeFile('/work/bad.json', '{not json');
    const bad = await t.image('run', '--quote-id', q1, '--confirm', '--config', '/work/bad.json');
    expect(bad.code).toBe(2);
    await open(t);
    await noLedger(t);
    expect(t.platform.seen).toEqual([]);
    const run = await t.image('run', '--quote-id', q1, '--confirm');
    expect(run.code, JSON.stringify(run.data)).toBe(0);
  });

  it('a refusal by the platform (charged: false in the ledger) leaves the job open: the spent quote is not run again, a new one is, under a new key', async () => {
    const t = await setup(0);
    const q1 = await t.quote();
    t.stub.set('POST', '/images/generations', err(402, 'INSUFFICIENT_CREDITS', 'stub error', { required: 12, balance: 5 }));
    const refused = await t.image('run', '--quote-id', q1, '--confirm');
    expect(refused.code).toBe(1);
    expect(refused.data.error).toContain('the submit was refused');
    expect(refused.data.error).toContain('Not enough credits');
    expect(states(await t.ledger())).toEqual([`${q1.slice(0, 6)}:reserved`, `${q1.slice(0, 6)}:ambiguous`]);
    expect((await t.ledger()).at(-1)!.meta.charged).toBe(false);
    await open(t);

    const same = await t.image('run', '--quote-id', q1, '--confirm');
    expect(same.code).toBe(1);
    expect(same.data.error).toContain(`quote ${q1} was already submitted and refused without a charge; quote the job again (image quote --dir /work/project --id composition)`);

    t.stub.clear('POST', '/images/generations');
    const q2 = await t.quote();
    const run = await t.image('run', '--quote-id', q2, '--confirm');
    expect(run.code, JSON.stringify(run.data)).toBe(0);
    expect(t.platform.seen).toHaveLength(1);
    expect(t.platform.seen[0]!.replayed).toBe(false);
    expect(t.platform.tasks.size).toBe(1);
    expect(t.stub.balance).toBe(500 - PRICE);
    expect(await t.job()).toMatchObject({ status: 'generated', runAttempted: true });
  });
});

describe('a job that an older version closed after a refusal', () => {
  const closed = async (refused: boolean) => {
    const t = await setup(0);
    const q1 = await t.quote();
    if (refused) {
      t.stub.set('POST', '/images/generations', err(422, 'CONTENT_REJECTED'));
      expect((await t.image('run', '--quote-id', q1, '--confirm')).code).toBe(1);
      t.stub.clear('POST', '/images/generations');
    }
    // what the earlier version wrote: marked attempted; it named the refused attempt only when that reached the ledger
    await t.rt.fs.writeFile(`${JOB}/composition.json`, JSON.stringify({ ...(await t.job()), runAttempted: true, ...(refused ? { attemptedQuoteId: q1 } : {}) }));
    return { t, q1 };
  };

  it('opens again by the ledger: a refusal without a charge, once the job is quoted again', async () => {
    const { t } = await closed(true);
    const q2 = await t.quote();
    const run = await t.image('run', '--quote-id', q2, '--confirm');
    expect(run.code, JSON.stringify(run.data)).toBe(0);
    expect(t.platform.seen).toHaveLength(1);
  });

  it('opens again by the ledger: a run that never reached it, once the job is quoted again (until then it is only refused)', async () => {
    const { t, q1 } = await closed(false);
    const stuck = await t.image('run', '--quote-id', q1, '--confirm');
    expect([stuck.code, stuck.data.error]).toEqual([2, 'submission already attempted; query its quote/ledger before any retry']);
    const q2 = await t.quote();
    expect(await t.job()).toMatchObject({ attemptedQuoteId: q1 });
    const run = await t.image('run', '--quote-id', q2, '--confirm');
    expect(run.code, JSON.stringify(run.data)).toBe(0);
    expect(t.platform.seen).toHaveLength(1);
  });
});

describe('image run where the job stays closed', () => {
  it('an ambiguous attempt is not cleared by a later refusal: the retry that was refused leaves its key in force', async () => {
    const t = await setup();
    const { q1, key } = await firstAttempt(t);
    const q2 = await t.quote();
    t.stub.set('POST', '/images/generations', err(422, 'CONTENT_REJECTED'));
    expect((await t.image('run', '--quote-id', q2, '--confirm')).code).toBe(1);
    expect((await t.ledger()).filter((row) => row.quoteId === q2).map((row) => [row.state, row.meta.charged])).toEqual([['reserved', undefined], ['ambiguous', false]]);
    expect(await t.job()).toMatchObject({ runAttempted: true, attemptedQuoteId: q1 }); // q1 is still the unknown one
    t.stub.clear('POST', '/images/generations');
    const q3 = await t.quote();
    const run = await t.image('run', '--quote-id', q3, '--confirm');
    expect(run.code, JSON.stringify(run.data)).toBe(0);
    expect(run.data.idempotencyKey).toBe(key);
    expect(t.platform.seen.map((call) => call.key)).toEqual([key, key]);
    expect(t.platform.tasks.size).toBe(1);
    expect(t.stub.balance).toBe(500 - PRICE);
  });

  it('an ambiguous attempt still takes no new key: only the original one, on a new quote', async () => {
    const t = await setup();
    const { q1, key } = await firstAttempt(t);
    const q2 = await t.quote();
    const other = await t.image('run', '--quote-id', q2, '--confirm', '--idempotency-key', 'skill-some-other-key-0001');
    expect([other.code, other.data.error]).toEqual([2, expect.stringContaining(key)]);
    const spent = await t.image('run', '--quote-id', q1, '--confirm');
    expect([spent.code, spent.data.error]).toEqual([2, 'this quote was already submitted; quote the job again, then run it with the new quote id']);
    expect(t.platform.seen).toHaveLength(1);
  });

  it('a charged picture closes the job for good: a new quote is refused, the old one too', async () => {
    const t = await setup(0);
    const q1 = await t.quote();
    expect((await t.image('run', '--quote-id', q1, '--confirm')).code).toBe(0);
    let r = await t.image('run', '--quote-id', q1, '--confirm');
    expect([r.code, r.data.error]).toEqual([2, 'submission already attempted; query its quote/ledger before any retry']);
    const q2 = await t.quote();
    r = await t.image('run', '--quote-id', q2, '--confirm');
    expect([r.code, r.data.error]).toEqual([2, 'submission already attempted; query its quote/ledger before any retry']);
    expect(t.platform.seen).toHaveLength(1);
    expect(await t.job()).toMatchObject({ runAttempted: true, attemptedQuoteId: q1 });
  });
});
