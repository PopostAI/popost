import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deviceLocation, deviceTokenProvider, login, parseDeviceGrant } from '../src/device-login';
import { createTestRuntime } from '../src/testing/memory';

const base = 'https://example.test/api/open/v1';
const response = (data: unknown) => Response.json({ success: true, data });
describe('browser login', () => {
  it('stores only a verified grant, signs renewals and keeps credentials out of agent output', async () => {
    let key = '';
    let issued = 0;
    const token = 'pat_device_' + 'a'.repeat(43);
    const rt = createTestRuntime({
      homeDir: '/test',
      env: { POPOST_AGENT_PROFILE: 'codex' },
      sleep: async () => {},
      fetchHandler: async (request) => {
        const route = new URL(request.url).pathname;
        if (route === '/api/device/start') {
          key = (await request.json()).publicKey;
          return response({ userCode: 'BBBB-2222', deviceCode: 'device-id', expiresIn: 600, interval: 1 });
        }
        if (route === '/api/device/poll') return response({ status: 'approved' });
        if (route === '/api/device/access') {
          const p = await request.json();
          const bytes = ['device-access-v1', p.deviceCode, key, p.time, p.nonce].join('\n');
          expect(
            verify(
              null,
              Buffer.from(bytes),
              createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key }, format: 'jwk' }),
              Buffer.from(p.signature, 'base64url'),
            ),
          ).toBe(true);
          issued++;
          return response({ accessToken: token, expiresIn: 900 });
        }
        expect(route).toBe('/api/open/v1/me');
        expect(request.headers.get('authorization')).toBe('Bearer ' + token);
        return response({ user: { name: 'Test account' } });
      },
    });
    await login(rt, base, true);
    const grant = parseDeviceGrant(await rt.fs.readText(deviceLocation(rt)!));
    const output = rt.stdoutText();
    expect(output).toContain('BBBB-2222');
    expect(output).toContain('Test account');
    for (const secret of [grant.privateKey, token, grant.deviceCode]) expect(output).not.toContain(secret);
    const nextSession = deviceTokenProvider(grant, rt.fetch);
    await Promise.all([nextSession(base), nextSession(base)]);
    expect(issued).toBe(2);
    await expect(nextSession('https://another.example/api/open/v1')).rejects.toThrow('another site');
    expect(deviceLocation({ ...rt, env: { POPOST_AGENT_PROFILE: 'claude-code' } })).not.toBe(deviceLocation(rt));
  });
  it('leaves no stored connection when the user declines', async () => {
    const rt = createTestRuntime({
      homeDir: '/test',
      sleep: async () => {},
      fetchHandler: async (request) =>
        response(
          request.url.endsWith('/start')
            ? { userCode: 'BBBB-2222', deviceCode: 'device-id', expiresIn: 600, interval: 1 }
            : { status: 'denied' },
        ),
    });
    await expect(login(rt, base, true)).rejects.toThrow('declined');
    expect(await rt.fs.stat(deviceLocation(rt)!)).toBeNull();
  });
});
