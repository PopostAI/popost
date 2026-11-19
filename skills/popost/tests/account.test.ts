/** `popost account`: the credit balance and plan of the account behind the API key, against the in-memory open API. */
import { describe, expect, it } from 'vitest';
import { cli, err, KEY, newScene, ok, ORIGIN } from './image-helpers';

const scene = (options: Parameters<typeof newScene>[0] = {}) => newScene({ ...options, env: { POPOST_PROVIDER_CONFIG: '/work/no-config.json', ...options.env } });
const me = (balance: number) => ok({ user: { id: 'u1', name: 'Lin', email: 'lin@example.com' }, credits: { balance }, plan: { tier: 'pro' } });

describe('account', () => {
  it('prints the balance, the plan and the membership page, and sends the key', async () => {
    const t = await scene();
    t.stub.set('GET', '/me', me(120));
    const { code, data } = await cli(t.rt, 'account');
    expect(code, JSON.stringify(data)).toBe(0);
    expect(data).toMatchObject({ ok: true, user: { name: 'Lin', email: 'lin@example.com' }, credits: { balance: 120 }, plan: { tier: 'pro' }, pricing: `${ORIGIN}/pricing` });
    expect(JSON.stringify(data)).not.toContain('u1');
    expect(t.stub.calls('GET', '/me')[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('points an empty balance at the membership page', async () => {
    const t = await scene();
    t.stub.set('GET', '/me', me(0));
    const { code, data } = await cli(t.rt, 'account');
    expect(code).toBe(0);
    expect((data as { note: string }).note).toContain(`${ORIGIN}/pricing`);
  });

  it('reports a rejected key as a failure and never prints the key', async () => {
    const t = await scene();
    t.stub.set('GET', '/me', err(401, 'UNAUTHORIZED'));
    const { code, data, stdout } = await cli(t.rt, 'account');
    expect(code).toBe(1);
    expect(data).toMatchObject({ ok: false, code: 'UNAUTHORIZED' });
    expect(stdout).not.toContain(KEY);
  });

  it('makes no request without a key (exit 2)', async () => {
    const t = await scene({ env: { POPOST_API_KEY: '' } });
    const { code, data } = await cli(t.rt, 'account');
    expect(code).toBe(2);
    expect(data).toMatchObject({ ok: false, code: 'NO_API_KEY' });
    expect(t.stub.requests).toHaveLength(0);
  });
});
