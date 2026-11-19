import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { UsageError } from './args';
import { credentialsDir, type CredentialsLocation } from './credentials';
import { checkUrl, DEFAULT_BASE_URL } from './providers/api';
import { printJson } from './core/util';
import type { Runtime } from './runtime';

export interface DeviceGrant {
  baseUrl: string;
  deviceCode: string;
  publicKey: string;
  privateKey: string;
}
const profileName = (env: Runtime['env']): string => {
  const configured = env.POPOST_AGENT_PROFILE?.trim();
  if (configured && !/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(configured))
    throw new UsageError('Use a short profile name containing letters, numbers, underscores or hyphens.');
  return (
    configured ||
    (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT
      ? 'claude-code'
      : env.CODEX_THREAD_ID || env.CODEX_CI
        ? 'codex'
        : 'terminal')
  );
};
export const deviceLocation = (rt: CredentialsLocation) => {
  const root = credentialsDir(rt);
  return root
    ? rt.path.join(
        root,
        'connections',
        encodeURIComponent(rt.env.POPOST_DISTRIBUTION_SITE || 'default'),
        profileName(rt.env) + '.json',
      )
    : undefined;
};
export const parseDeviceGrant = (value: string): DeviceGrant => {
  const data = JSON.parse(value) as DeviceGrant;
  if (
    !data ||
    ![data.baseUrl, data.privateKey, data.publicKey, data.deviceCode].every(
      (x) => typeof x === 'string' && x.length > 0,
    )
  )
    throw new Error('Invalid connection file');
  return data;
};
export const deviceApi = async <T>(
  fetcher: Runtime['fetch'],
  baseUrl: string,
  route: string,
  payload: unknown,
): Promise<T> => {
  const origin = new URL(checkUrl(baseUrl, 'base URL')).origin;
  const result = await fetcher(origin + '/api/device/' + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (result.status === 401 || result.status === 403)
    throw new UsageError('Account connection is unavailable. Run popost auth login to reconnect.');
  if (!result.ok)
    throw new UsageError('Could not reach the account service (' + result.status + '). Please try again.');
  const envelope = (await result.json()) as { success: boolean; data: T };
  if (!envelope.success) throw new UsageError('The account service could not complete this request.');
  return envelope.data;
};

export const deviceTokenProvider = (grant: DeviceGrant, fetcher: Runtime['fetch']) => {
  let cached: { token: string; until: number } | undefined;
  let pending: Promise<string> | undefined;
  const renew = async () => {
    const nonce = randomUUID();
    const time = Math.floor(Date.now() / 1000);
    const message = ['device-access-v1', grant.deviceCode, grant.publicKey, time, nonce].join('\n');
    const key = createPrivateKey({ key: Buffer.from(grant.privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
    const signature = sign(null, Buffer.from(message), key).toString('base64url');
    const result = await deviceApi<{ accessToken: string; expiresIn: number }>(fetcher, grant.baseUrl, 'access', {
      deviceCode: grant.deviceCode,
      publicKey: grant.publicKey,
      nonce,
      time,
      signature,
    });
    if (!/^pat_device_[A-Za-z0-9_-]{43}$/.test(result.accessToken))
      throw new UsageError('Unexpected connection response.');
    cached = { token: result.accessToken, until: Date.now() + (result.expiresIn - 30) * 1000 };
    return result.accessToken;
  };
  return async (baseUrl: string) => {
    if (baseUrl.replace(/\/+$/, '') !== grant.baseUrl)
      throw new UsageError('This connection belongs to another site. Check the selected API address.');
    if (cached && cached.until > Date.now()) return cached.token;
    pending ??= renew().finally(() => {
      pending = undefined;
    });
    return pending;
  };
};
export const login = async (rt: Runtime, requestedBase?: string, noOpen = false): Promise<number> => {
  const file = deviceLocation(rt);
  if (!file)
    throw new UsageError(
      'Browser sign-in needs persistent user storage. Use your host secret settings for this environment.',
    );
  if (rt.explicitApiKey)
    throw new UsageError('POPOST_API_KEY is set and selects the account. Unset it before connecting another account.');
  const baseUrl = (requestedBase || rt.env.POPOST_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const site = new URL(checkUrl(baseUrl, '--base-url'));
  if (site.username || site.password || site.search || site.hash || site.pathname !== '/api/open/v1')
    throw new UsageError('Use the full site API address ending in /api/open/v1.');
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'jwk' }).x!;
  const profile = profileName(rt.env);
  const agent =
    ({ codex: 'Codex', 'claude-code': 'Claude Code', terminal: 'CLI' } as Record<string, string>)[profile] || profile;
  const label = [agent, rt.deviceName].filter(Boolean).join(' · ').slice(0, 80);
  const start = await deviceApi<{ userCode: string; deviceCode: string; expiresIn: number; interval: number }>(
    rt.fetch,
    baseUrl,
    'start',
    { label, publicKey },
  );
  const url = site.origin + '/workspace/device';
  printJson(
    rt,
    {
      status: 'waiting',
      verificationUrl: url,
      userCode: start.userCode,
      expiresIn: start.expiresIn,
      next: 'Open the link and enter this code. Keep this command running.',
    },
    true,
  );
  if (!noOpen) await rt.openExternal?.(url);
  const until = Date.now() + Math.min(600, start.expiresIn) * 1000;
  while (Date.now() < until) {
    await (rt.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(
      Math.max(1, start.interval) * 1000,
    );
    const result = await deviceApi<{ status: string }>(rt.fetch, baseUrl, 'poll', {
      userCode: start.userCode,
      deviceCode: start.deviceCode,
    });
    if (result.status === 'pending') continue;
    if (result.status !== 'approved')
      throw new UsageError(
        result.status === 'denied' ? 'Connection declined.' : 'Code expired. Run popost auth login again.',
      );
    const grant: DeviceGrant = {
      deviceCode: start.deviceCode,
      publicKey,
      privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
      baseUrl,
    };
    const token = await deviceTokenProvider(grant, rt.fetch)(baseUrl);
    const { PopostClient } = await import('./providers/api');
    const account = (await new PopostClient(rt, { baseUrl, bearer: token }).request('GET', '/me')) as {
      user: { name: string };
    };
    const tmp = file + '.' + rt.randomUUID() + '.tmp';
    try {
      await rt.fs.writeFile(tmp, JSON.stringify(grant), { private: true });
      await rt.fs.rename(tmp, file);
    } finally {
      await rt.fs.rm(tmp);
    }
    printJson(
      rt,
      { ok: true, action: 'login', profile, account: account.user.name, manage: site.origin + '/account/api-keys' },
      true,
    );
    return 0;
  }
  throw new UsageError('Code expired. Run popost auth login again.');
};
