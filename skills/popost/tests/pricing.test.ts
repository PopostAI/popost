import { describe, expect, it } from 'vitest';
import { cli, err, KEY, newScene, ok } from './image-helpers';

const scene = () => newScene({ env: { POPOST_PROVIDER_CONFIG: '/work/no-config.json' } });

describe('read-only pricing and parse authorization', () => {
  it('reads changing prices without creating any paid tasks, and marks the tariff as a ceiling', async () => {
    const t = await scene();
    let cost = 6;
    t.stub.set('GET', '/pricing', () => ok({ unit: 'credits', linkParse: { creditsPerRequest: cost }, balance: 10 }));
    expect((await cli(t.rt, 'link', 'quote')).data).toMatchObject({ ok: true, charged: false, linkParse: { creditsPerRequest: 6, sufficient: true } });
    const saveQuote = await cli(t.rt, 'inspiration', 'quote');
    expect(saveQuote.data).toMatchObject({ ok: true, charged: false, linkParse: { creditsPerRequest: 6, sufficient: true } });
    expect(saveQuote.data.next).toContain('inspiration add URL');
    cost = 15;
    expect((await cli(t.rt, 'pricing')).data).toMatchObject({ ok: true, charged: false, linkParse: { creditsPerRequest: 15, sufficient: false } });
    expect(t.stub.requests.map(r => r.method)).toEqual(['GET', 'GET', 'GET']);
  });
  it('makes no request without a key and does not treat it as a local-work failure', async () => {
    const t = await newScene({ env: { POPOST_API_KEY: '', POPOST_PROVIDER_CONFIG: '/work/no-config.json' } });
    expect((await cli(t.rt, 'link', 'quote')).data).toMatchObject({ ok: false, code: 'NO_API_KEY', charged: false });
    expect(t.stub.requests).toHaveLength(0);
    expect((await cli(t.rt, 'init', '--dir', '/work/local', '--brief', 'local typography')).code).toBe(0);
  });
  it.each([-1, 1.5, null, '6'])('refuses malformed prices (%s) rather than inventing a tariff', async (cost) => {
    const t = await scene();
    t.stub.set('GET', '/pricing', ok({ unit: 'credits', linkParse: { creditsPerRequest: cost }, balance: 10 }));
    const r = await cli(t.rt, 'pricing');
    expect(r.data).toMatchObject({ ok: false, code: 'BAD_RESPONSE', charged: false });
    expect(t.stub.calls('POST', '/links/parse')).toHaveLength(0);
  });
  it('does not submit a paid fallback when pricing is unavailable', async () => {
    const t = await scene();
    t.stub.set('GET', '/pricing', err(404, 'NOT_FOUND'));
    const r = await cli(t.rt, 'pricing');
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain(KEY);
    expect(t.stub.calls('POST', '/links/parse')).toHaveLength(0);
  });
  it.each([[], ['--confirm'], ['--max-credits', '6'], ['--confirm', '--max-credits', '-1']].map(args => [args]))('requires confirmation and a valid cap before any request (%j)', async (args) => {
    const t = await scene();
    const r = await cli(t.rt, 'link', 'parse', 'https://x.com/someone/status/1234567890', ...args);
    expect(r.code).toBe(2);
    expect(t.stub.requests).toHaveLength(0);
  });
  it('submits exactly the authorized ceiling and respects a server price-change refusal', async () => {
    const t = await scene();
    t.stub.set('POST', '/links/parse', err(402, 'CREDIT_LIMIT_EXCEEDED', 'price changed', { required: 9, maxCredits: 6 }));
    const r = await cli(t.rt, 'link', 'parse', 'https://x.com/someone/status/1234567890', '--confirm', '--max-credits', '6');
    expect(r.data).toMatchObject({ ok: false, code: 'CREDIT_LIMIT_EXCEEDED' });
    expect(t.stub.calls('POST', '/links/parse')[0]!.json).toMatchObject({ maxCredits: 6 });
    expect(t.stub.calls('POST', '/links/parse')).toHaveLength(1);
  });
});
