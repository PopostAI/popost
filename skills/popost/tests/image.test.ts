/**
 * `popost image prepare|quote|run|complete|status` (port of image_jobs.py and its parts of test_popost_workflow.py):
 * one composition job per project, material jobs, fee authorization, reference binding, host and custom channels.
 */
import { describe, expect, it } from 'vitest';
import { Project } from '../src/core/project';
import type { FetchHandler } from '../src/testing/memory';
import { API, cli, err, everythingWritten, KEY, newScene, ORIGIN, restrictTo, tinyPng, type PopostStub } from './image-helpers';

const JOB = '/work/project/production/jobs';

const setup = async (options: { channel?: string; mode?: 'original' | 'strict'; config?: Record<string, unknown>; fetchHandler?: (stub: PopostStub) => FetchHandler } = {}) => {
  const scene = await newScene({
    fetchHandler: options.fetchHandler,
    files: { '/work/prompt.txt': '无文字氛围底版：柔和渐变背景', '/work/ref.png': tinyPng([1, 2, 3], 3), '/work/result.png': tinyPng([4, 5, 6], 4), '/work/notes.txt': 'not an image', '/work/cfg.json': JSON.stringify(options.config ?? {}) },
  });
  const project = await Project.create(scene.rt, 'project', 'brief', options.mode ?? 'original');
  project.manifest.provider = { channel: options.channel ?? 'official', model: null };
  await project.saveManifest();
  const image = (...args: string[]) => cli(scene.rt, 'image', ...args, '--dir', 'project');
  const job = async (id = 'composition') => JSON.parse(await scene.rt.fs.readText(`${JOB}/${id}.json`));
  return { ...scene, project, image, job };
};

type Setup = Awaited<ReturnType<typeof setup>>;

const prepareAndQuote = async (t: Setup, ...extra: string[]) => {
  await t.image('prepare', '--prompt-file', '/work/prompt.txt', '--aspect', '3:4', ...extra);
  const quote = await t.image('quote');
  expect(quote.code, JSON.stringify(quote.data)).toBe(0);
  return quote.data.quote.quoteId as string;
};

describe('prepare and status', () => {
  it('writes one composition job, bound to the reference hashes, and reports who executes it', async () => {
    const t = await setup();
    const { code, data } = await t.image('prepare', '--prompt-file', '/work/prompt.txt', '--ref', '/work/ref.png');
    expect(code, JSON.stringify(data)).toBe(0);
    expect(data).toMatchObject({ ok: true, jobFile: `${JOB}/composition.json`, executor: 'provider-cli' });
    expect(Object.keys(data.job)).toEqual(['id', 'purpose', 'count', 'provider', 'prompt', 'refs', 'status', 'aspect', 'refHashes']);
    // one 3:4-ish page: the sheet is the single page, at the closest ratio the model makes (stub model: 1:1, 3:4, 9:16)
    expect(data.job).toMatchObject({ id: 'composition', purpose: 'composition', count: 1, status: 'prepared', aspect: '3:4', prompt: '无文字氛围底版：柔和渐变背景', refs: ['/work/ref.png'], provider: { channel: 'official' } });
    expect(data.notes).toEqual(['aspect 3:4: 1 column and 1 row of 4:5 pages']);
    expect(Object.keys(data.job.refHashes)).toEqual(['/work/ref.png']);
    expect(await t.job()).toEqual(data.job);
    const status = await t.image('status');
    expect([status.code, status.data.job.status]).toEqual([0, 'prepared']);
  });

  it('allows exactly one composition job; preparing a draft again replaces it and says so', async () => {
    const t = await setup();
    await t.image('prepare', '--prompt-file', '/work/prompt.txt', '--id', 'ignored-page-id');
    expect(await t.job()).toMatchObject({ id: 'composition' }); // the id is forced
    await t.rt.fs.writeFile('/work/other.txt', 'another prompt');
    const again = await t.image('prepare', '--prompt-file', '/work/other.txt', '--aspect', '9:16');
    expect(again.code, JSON.stringify(again.data)).toBe(0);
    expect(again.data.replaced).toBe(true);
    expect(again.data.notes).toContain("replaced the earlier prepared job 'composition' (it had no quote and no run)");
    expect(await t.job()).toMatchObject({ prompt: 'another prompt', aspect: '9:16', status: 'prepared' });
    expect((await t.rt.fs.readdir(JOB)).length).toBe(1);
    // a material draft is replaced the same way, and a first prepare says nothing about replacing
    const first = await t.image('prepare', '--prompt-file', '/work/prompt.txt', '--purpose', 'material', '--id', 'hero');
    expect(first.data.replaced).toBeUndefined();
    const second = await t.image('prepare', '--prompt-file', '/work/other.txt', '--purpose', 'material', '--id', 'hero');
    expect([second.data.replaced, (await t.job('hero')).prompt]).toEqual([true, 'another prompt']);
  });

  it('keeps a failed prepare from touching the draft it would have replaced', async () => {
    const t = await setup();
    await t.image('prepare', '--prompt-file', '/work/prompt.txt', '--aspect', '3:4');
    const r = await t.image('prepare', '--prompt-file', '/work/missing.txt');
    expect(r.code).toBe(2);
    expect(await t.job()).toMatchObject({ prompt: '无文字氛围底版：柔和渐变背景', aspect: '3:4' });
  });

  it('never replaces a job that was quoted, run or completed, and says what to do with it instead', async () => {
    const t = await setup();
    const qid = await prepareAndQuote(t);
    let r = await t.image('prepare', '--prompt-file', '/work/prompt.txt');
    expect(r.code).toBe(2);
    expect(r.data.error).toContain(`job 'composition' is already quoted (quote ${qid}) and is not replaced`);
    expect(r.data.error).toContain(`image run --dir /work/project --id composition --quote-id ${qid} --confirm`);
    expect(r.data.error).toContain('image quote --dir /work/project --id composition');
    expect(r.data.error).toContain('production/ledger.jsonl has no record');
    expect(await t.job()).toMatchObject({ status: 'quoted', quoteId: qid });

    await t.image('run', '--quote-id', qid, '--confirm');
    r = await t.image('prepare', '--prompt-file', '/work/prompt.txt');
    expect(r.code).toBe(2);
    expect(r.data.error).toContain("job 'composition' was already submitted, so it is never replaced or sent twice");
    expect(r.data.error).toContain('production/results/composition');
    expect(r.data.error).toContain('image complete --dir /work/project --id composition');
    expect(await t.job()).toMatchObject({ status: 'generated' });

    // a run the platform refused without a charge leaves a spent quote, not a closed job
    const failed = await setup();
    const q2 = await prepareAndQuote(failed);
    failed.stub.set('POST', '/images/generations', err(422, 'CONTENT_REJECTED'));
    await failed.image('run', '--quote-id', q2, '--confirm');
    r = await failed.image('prepare', '--prompt-file', '/work/prompt.txt');
    expect(r.code).toBe(2);
    expect(r.data.error).toContain(`quote ${q2}) but its run was refused without a charge, so that quote cannot be run again`);
    expect(r.data.error).toContain('image quote --dir /work/project --id composition, then image run --dir /work/project --id composition --quote-id <new quote> --confirm');
    expect(r.data.error).toContain('remove production/jobs/composition.json (nothing was charged)');
    expect(await failed.job()).toMatchObject({ status: 'quoted' });

    // a run that was charged or left unknown is never replaced or sent twice
    const unknown = await setup();
    const q3 = await prepareAndQuote(unknown);
    await unknown.rt.fs.writeFile(`${JOB}/composition.json`, JSON.stringify({ ...(await unknown.job()), runAttempted: true, attemptedQuoteId: q3 }));
    r = await unknown.image('prepare', '--prompt-file', '/work/prompt.txt');
    expect(r.data.error).toContain('already submitted');
    expect(r.data.error).toContain('image status --dir /work/project --id composition');
    expect(r.data.error).toContain('the original key is reused');

    const material = await setup({ channel: 'host' });
    await material.image('prepare', '--prompt-file', '/work/prompt.txt', '--purpose', 'material', '--id', 'hero');
    await material.image('complete', '--id', 'hero', '--file', '/work/result.png', '--tool', 'image_gen', '--note', 'seen');
    r = await material.image('prepare', '--prompt-file', '/work/prompt.txt', '--purpose', 'material', '--id', 'hero');
    expect([r.code, r.data.error]).toEqual([2, "job 'hero' is complete (its picture is registered as assets/hero.png); reuse that asset instead of preparing the job again"]);
  });

  it('keeps the composition id for the composition and makes material jobs 9:16 unless told otherwise', async () => {
    const t = await setup();
    let r = await t.image('prepare', '--prompt-file', '/work/prompt.txt', '--purpose', 'material');
    expect([r.code, r.data.error]).toEqual([2, 'composition id is reserved']);
    r = await t.image('prepare', '--prompt-file', '/work/prompt.txt', '--purpose', 'material', '--id', 'hero');
    expect(r.code).toBe(0);
    expect(r.data.job).toMatchObject({ id: 'hero', purpose: 'material', aspect: '9:16' });
    r = await t.image('prepare', '--prompt-file', '/work/prompt.txt', '--purpose', 'material', '--id', 'wide', '--aspect', '16:9');
    expect(r.data.job.aspect).toBe('16:9');
    r = await t.image('prepare', '--prompt-file', '/work/prompt.txt', '--purpose', 'material', '--id', 'bad id!');
    expect([r.code, r.data.error]).toEqual([2, 'invalid job id']);
  });

  it('refuses a composition job in strict mode and without a prompt file', async () => {
    const strict = await setup({ mode: 'strict' });
    let r = await strict.image('prepare', '--prompt-file', '/work/prompt.txt');
    expect([r.code, r.data.error]).toEqual([2, 'supplied target is the reproduction reference']);
    const t = await setup();
    r = await t.image('prepare');
    expect([r.code, r.data.error]).toEqual([2, '--prompt-file is required']);
    r = await t.image('prepare', '--prompt-file', '/work/missing.txt');
    expect(r.code).toBe(2);
    expect(r.data.ok).toBe(false);
    r = await t.image('status');
    expect(r.code).toBe(2); // no job yet
  });

  it('exits 2 with usage on an unknown action or a missing --dir', async () => {
    const t = await setup();
    expect((await cli(t.rt, 'image', 'frobnicate', '--dir', 'project')).code).toBe(2);
    expect((await cli(t.rt, 'image', 'status')).code).toBe(2);
  });
});

describe('quote and run on the official channel', () => {
  it('quotes a job, binds the quote id, and runs only with the explicit confirmation', async () => {
    const t = await setup();
    const qid = await prepareAndQuote(t);
    expect(await t.job()).toMatchObject({ status: 'quoted', quoteId: qid });
    expect(t.stub.calls('POST', '/images/quote')[0]!.json).toMatchObject({ n: 1, aspectRatio: '3:4', model: 'stub-model-a' });
    expect(await t.rt.fs.stat(`/work/project/production/quotes/${qid}.json`)).not.toBeNull();

    let r = await t.image('run', '--quote-id', qid);
    expect([r.code, r.data.error]).toEqual([2, 'explicit fee authorization required']);
    r = await t.image('run', '--quote-id', 'q_other', '--confirm');
    expect([r.code, r.data.error]).toEqual([2, `no job is bound to quote q_other; quote the job first (image quote --id <job>), and run the quote id it printed (jobs and their quotes: composition=${qid})`]);
    r = await t.image('run', '--id', 'composition', '--quote-id', 'q_other', '--confirm');
    expect([r.code, r.data.error]).toEqual([2, 'quote this job first; run must use its bound quote id']);
    r = await t.image('run', '--confirm');
    expect(r.code).toBe(2);
    expect(t.stub.calls('POST', '/images/generations')).toEqual([]);

    r = await t.image('run', '--quote-id', qid, '--confirm');
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(r.data).toMatchObject({ ok: true, quoteId: qid, billing: { charged: true, actualCredits: 12 } });
    const job = await t.job();
    expect(job).toMatchObject({ status: 'generated', runAttempted: true });
    expect(job.result[0].localPath).toBe(`/work/project/production/results/composition/${r.data.taskId}_0.png`);
    expect(await t.rt.fs.readFile(job.result[0].localPath)).toEqual(t.stub.inlinePng);
    const ledger = (await t.rt.fs.readText('/work/project/production/ledger.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l).state);
    expect(ledger).toEqual(['reserved', 'consumed']);
    expect(t.stub.calls('POST', '/images/generations')[0]!.json).toMatchObject({ maxCredits: 12, n: 1, aspectRatio: '3:4' });
    for (const blob of await everythingWritten(t.rt)) expect(blob).not.toContain(KEY);

    const again = await t.image('run', '--quote-id', qid, '--confirm');
    expect(again.code).toBe(2);
    expect(t.stub.calls('POST', '/images/generations')).toHaveLength(1);
  });

  it('never submits a quote twice, and a run the platform refused without a charge leaves the job open for a new quote', async () => {
    const t = await setup();
    const qid = await prepareAndQuote(t);
    t.stub.set('POST', '/images/generations', err(422, 'CONTENT_REJECTED'));
    const first = await t.image('run', '--quote-id', qid, '--confirm');
    expect(first.code).toBe(1);
    expect(first.data).toMatchObject({ ok: false, code: 1 });
    const open = await t.job();
    expect(open).toMatchObject({ status: 'quoted', quoteId: qid });
    expect([open.runAttempted, open.attemptedQuoteId]).toEqual([undefined, undefined]); // nothing was charged: not marked as attempted
    const ledger = (await t.rt.fs.readText('/work/project/production/ledger.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(ledger.map((row) => [row.state, row.meta.charged])).toEqual([['reserved', undefined], ['ambiguous', false]]);

    const second = await t.image('run', '--quote-id', qid, '--confirm');
    expect(second.code).toBe(1);
    expect(second.data.error).toContain(`quote ${qid} was already submitted and refused without a charge; quote the job again (image quote --dir /work/project --id composition)`);
    expect(t.stub.calls('POST', '/images/generations')).toHaveLength(1);

    t.stub.clear('POST', '/images/generations');
    const next = (await t.image('quote')).data.quote.quoteId as string;
    expect(next).not.toBe(qid);
    const run = await t.image('run', '--quote-id', next, '--confirm');
    expect(run.code, JSON.stringify(run.data)).toBe(0);
    expect(run.data).toMatchObject({ ok: true, quoteId: next, billing: { charged: true } });
    expect(t.stub.calls('POST', '/images/generations')).toHaveLength(2);
    expect(await t.job()).toMatchObject({ status: 'generated', runAttempted: true });
  });

  it('stops when a reference file changed after prepare', async () => {
    const t = await setup();
    await t.image('prepare', '--prompt-file', '/work/prompt.txt', '--ref', '/work/ref.png');
    await t.rt.fs.writeFile('/work/ref.png', tinyPng([9, 9, 9], 3));
    const asked = t.stub.requests.length; // prepare may read the model list; the changed reference must stop the quote before any more
    const r = await t.image('quote');
    expect([r.code, r.data.error]).toEqual([2, 'reference changed; do not consume the old quote']);
    expect(t.stub.requests).toHaveLength(asked);
    expect(t.stub.calls('POST', '/images/quote')).toEqual([]);
  });

  it('passes quote errors through with the CLI exit code (unauthorized 1, no key 2)', async () => {
    const t = await setup();
    await t.image('prepare', '--prompt-file', '/work/prompt.txt');
    t.stub.set('GET', '/models', err(401, 'UNAUTHORIZED', 'bad key'));
    let r = await t.image('quote');
    expect(r.code).toBe(1);
    expect(r.data.error).toContain('POPOST_API_KEY');
    expect((await t.job()).status).toBe('prepared');
    const noKey = await setup();
    await noKey.image('prepare', '--prompt-file', '/work/prompt.txt');
    r = await cli({ ...noKey.rt, env: { ...noKey.rt.env, POPOST_API_KEY: undefined } }, 'image', 'quote', '--dir', 'project');
    expect([r.code, r.data.code]).toEqual([2, 2]);
  });

  it('rejects an aspect that is not W:H before any request', async () => {
    const t = await setup();
    await t.image('prepare', '--prompt-file', '/work/prompt.txt', '--aspect', 'wide');
    const r = await t.image('quote');
    expect(r.code).toBe(2);
    expect(t.stub.requests).toEqual([]);
  });

  it('works under the web host restriction, and a result URL outside it ends as "generated and charged, fetch it again"', async () => {
    const t = await setup({ fetchHandler: (stub) => restrictTo(stub.fetch, [`${ORIGIN}${API}/`]) });
    const qid = await prepareAndQuote(t);
    const run = await t.image('run', '--quote-id', qid, '--confirm');
    expect(run.code, JSON.stringify(run.data)).toBe(0); // one inline image: nothing outside the prefix is needed
    const t2 = await setup({ fetchHandler: (stub) => restrictTo(stub.fetch, [`${ORIGIN}${API}/`]) });
    const q2 = await prepareAndQuote(t2);
    t2.stub.set('POST', '/images/generations', [200, { success: true, data: { model: 'stub-model-a', images: [{ url: `${ORIGIN}/files/gen-1.png` }], usage: { credits: 12 }, balance: 488 }, error: null }]);
    const r = await t2.image('run', '--quote-id', q2, '--confirm');
    expect(r.code).toBe(1);
    expect(r.data.error).toContain('已生成');
    expect(r.data.error).toContain('不允许访问');
    const states = (await t2.rt.fs.readText('/work/project/production/ledger.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l).state);
    expect(states).toEqual(['reserved', 'consumed']); // charged: recorded as consumed, never regenerated
    // and the job stays closed: a new quote does not make a charged picture runnable again
    expect(await t2.job()).toMatchObject({ status: 'quoted', runAttempted: true, attemptedQuoteId: q2 });
    const q3 = (await t2.image('quote')).data.quote.quoteId as string;
    const again = await t2.image('run', '--quote-id', q3, '--confirm');
    expect([again.code, again.data.error]).toEqual([2, 'submission already attempted; query its quote/ledger before any retry']);
    expect(t2.stub.calls('POST', '/images/generations')).toHaveLength(1);
  });
});

describe('host channel and complete', () => {
  it('leaves generation to the host tool and registers its real result as the composition reference', async () => {
    const t = await setup({ channel: 'host' });
    const prepared = await t.image('prepare', '--prompt-file', '/work/prompt.txt');
    expect(prepared.data.executor).toBe('agent-host-tool');
    let r = await t.image('quote');
    expect([r.code, r.data.error]).toEqual([2, 'host: call the actual available image tool with this job prompt, count=1, then complete with its real file']);
    r = await t.image('complete', '--file', '/work/result.png', '--note', '看过图');
    expect([r.code, r.data.error]).toEqual([2, 'name the host tool actually called']);
    r = await t.image('complete', '--file', '/work/result.png', '--tool', 'image_gen');
    expect([r.code, r.data.error]).toEqual([2, 'real image file and inspection note required']);
    r = await t.image('complete', '--file', '/work/notes.txt', '--tool', 'image_gen', '--note', 'n');
    expect(r.code).toBe(2);
    expect(r.data.error).toContain('cannot identify image file');
    r = await t.image('complete', '--file', '/work/result.png', '--tool', 'image_gen', '--note', '看过图，三条色带清晰');
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(r.data.job).toMatchObject({ status: 'completed', tool: 'image_gen', inspection: '看过图，三条色带清晰', asset: { kind: 'composition', role: 'style' } });
    const reloaded = await Project.load(t.rt, 'project');
    expect(reloaded.manifest.concept).toMatchObject({ status: 'reviewed', imageCount: 1 });
    expect(reloaded.manifest.sources.filter((s) => s.kind === 'composition')).toHaveLength(1);
    r = await t.image('complete', '--file', '/work/result.png', '--tool', 'image_gen', '--note', 'again');
    expect([r.code, r.data.error]).toEqual([2, 'already complete']);
    r = await t.image('quote');
    expect([r.code, r.data.error]).toEqual([2, 'job is complete; reuse its asset']);
    const second = await t.image('prepare', '--prompt-file', '/work/prompt.txt', '--id', 'other', '--purpose', 'composition');
    expect([second.code, second.data.error]).toEqual([2, 'reuse existing composition reference']);
  });

  it('registers a material result as a named project asset', async () => {
    const t = await setup({ channel: 'host' });
    await t.image('prepare', '--prompt-file', '/work/prompt.txt', '--purpose', 'material', '--id', 'hero');
    const r = await t.image('complete', '--id', 'hero', '--file', '/work/result.png', '--tool', 'image_gen', '--note', '看过图');
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(r.data.job.asset).toMatchObject({ id: 'hero', path: 'assets/hero.png', kind: 'image' });
    expect(await t.rt.fs.readFile('/work/project/assets/hero.png')).toEqual(tinyPng([4, 5, 6], 4));
    expect((await Project.load(t.rt, 'project')).manifest.assets.map((a) => a.id)).toEqual(['hero']);
  });
});

describe('custom channel through a job', () => {
  it('quotes and runs with the user config and accepts an unknown cost only when told to', async () => {
    const config = { custom: { mode: 'openai-compatible', baseUrl: 'https://custom.example.test', model: 'm1', skipModelDiscovery: true, billing: { unit: 'USD' }, auth: { envVar: 'MY_KEY' } } };
    const png = tinyPng([7, 7, 7], 2);
    const handler = (): FetchHandler => async (request) => {
      if (new URL(request.url).pathname === '/v1/images/generations') return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(png).toString('base64') }] }), { headers: { 'content-type': 'application/json' } });
      return new Response('{}', { status: 404 });
    };
    const t = await setup({ channel: 'custom', config, fetchHandler: handler });
    const withKey = { ...t.rt, env: { ...t.rt.env, MY_KEY: 'byok-secret-1234' } };
    const run = (...args: string[]) => cli(withKey, 'image', ...args, '--dir', 'project');
    await run('prepare', '--prompt-file', '/work/prompt.txt');
    const refused = await run('quote', '--config', '/work/cfg.json');
    expect(refused.code).toBe(1);
    const quote = await run('quote', '--config', '/work/cfg.json', '--accept-unknown-cost');
    expect(quote.code, JSON.stringify(quote.data)).toBe(0);
    expect(quote.data.billing).toMatchObject({ priceStatus: 'unknown', unit: 'USD' });
    const qid = quote.data.quote.quoteId;
    const gen = await run('run', '--config', '/work/cfg.json', '--quote-id', qid, '--confirm', '--accept-unknown-cost');
    expect(gen.code, JSON.stringify(gen.data)).toBe(0);
    expect(await t.rt.fs.readFile(gen.data.materials[0].localPath)).toEqual(png);
    for (const blob of await everythingWritten(t.rt)) expect(blob).not.toContain('byok-secret-1234');
  });
});
