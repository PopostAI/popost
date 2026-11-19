/**
 * `popost auth set|status|clear`: the API key of popost.ai kept in a user-level file (`credentials.ts`), so the same
 * command works on macOS, Windows and Linux without `export` / `$env:` syntax. The environment variable still wins.
 * Nothing here talks to the network, and the full key is never printed.
 */
import { UsageError, withArgs, type CommandSpec, type ParsedArgs } from '../args';
import { login, deviceLocation } from '../device-login';
import { fail, printJson } from '../core/util';
import {
  BASE_URL_ENV,
  clearStoredCredentials,
  credentialsFile,
  keyPageUrl,
  maskKey,
  readStoredCredentials,
  writeStoredCredentials,
} from '../credentials';
import { checkUrl, DEFAULT_BASE_URL, DEFAULT_KEY_ENV } from '../providers/api';
import type { CommandMain, Runtime } from '../runtime';

const DESCRIPTION = `Connect your Agent to your Popost account in the browser. For scripts you can also store a manual API key:

  popost auth login           connect this Agent in your browser with a one-time device code
  popost auth set --prompt    paste the key privately in your own terminal (hidden input)
  popost auth set --stdin     read the key from standard input (keeps it off the command line and out of shell history)
  popost auth set --key KEY   the same with the key as an argument
  popost auth status          show the credential source (connection, env, file or none) and API address without a network call
  popost auth clear           delete the stored key (idempotent)

The key is stored in <home>/.popost/credentials.json (directory: POPOST_HOME), readable by the current user only. Environment variables POPOST_API_KEY and POPOST_BASE_URL take precedence over the file. --base-url selects the full API URL for the intended environment (https; plain http only for localhost).`;

const SPEC: CommandSpec = {
  prog: 'popost auth',
  description: DESCRIPTION,
  positionals: [{ name: 'action', choices: ['login', 'set', 'status', 'clear'], help: 'store a key, show where the key comes from, or delete the stored key' }],
  options: [
    { flag: '--no-open', kind: 'flag', help: 'login: print the verification link without opening a browser' },
    { flag: '--connect', help: 'set: redeem a single-use connection code copied from the API Keys page' },
    { flag: '--key', help: 'set: the API key' },
    { flag: '--stdin', kind: 'flag', help: 'set: read the API key from standard input' },
    { flag: '--prompt', kind: 'flag', help: 'set: hidden key input in the user’s own interactive terminal' },
    { flag: '--base-url', help: 'set: API address to store with the key (https)' },
  ],
};

const MIN_KEY_LENGTH = 16;
const MAX_KEY_LENGTH = 512;

/** The trimmed key, or why it cannot be one. The message never contains the input. */
export const checkKey = (raw: string): { key: string } | { error: string } => {
  const key = raw.trim();
  if (!key) return { error: 'the API key is empty' };
  if (/\s/.test(key)) return { error: 'the API key must be one word without spaces or line breaks: pass only the key' };
  if (/^bearer$/i.test(key) || /^https?:\/\//i.test(key)) return { error: 'that is not an API key: pass only the key itself, not a header or an address' };
  if (/^(export\s+)?[A-Za-z_][A-Za-z0-9_]*=/.test(key)) return { error: `that looks like ${DEFAULT_KEY_ENV}=...: pass only the key, without the variable name` };
  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(key))
    return { error: `that does not look like an API key (expected ${MIN_KEY_LENGTH}-${MAX_KEY_LENGTH} printable characters): copy it again from the key page` };
  return { key };
};

const envValue = (rt: Runtime, name: string): string => (rt.env[name] ?? '').trim();

const unsupported = (rt: Runtime, what: string): number =>
  fail(rt, `${what} is not available in this environment (the host has no user home directory): set the ${DEFAULT_KEY_ENV} environment variable instead`);

const readKey = async (rt: Runtime, args: ParsedArgs): Promise<string> => {
  const inline = args.string('key');
  if (Number(args.flag('stdin')) + Number(args.flag('prompt')) + Number(inline !== undefined) !== 1)
    throw new UsageError('give the key with exactly one of --prompt, --stdin or --key KEY');
  if (args.flag('prompt')) {
    if (!rt.readSecret) throw new UsageError('Hidden terminal input is unavailable. Configure the key using your host secret settings; do not paste it into chat.');
    try { return await rt.readSecret(); }
    catch { throw new UsageError('Private key input was cancelled or unavailable; nothing was saved. Run auth set --prompt in your own interactive terminal.'); }
  }
  if (inline !== undefined) return inline;
  if (!rt.stdin) throw new UsageError('--stdin is unavailable: use the host secret settings, or auth set --prompt in your own terminal.');
  return rt.stdin();
};

/** A connection code is exchanged only with the explicitly selected API origin. No secrets are printed. */
const redeemConnection = async (rt: Runtime, code: string, baseUrl: string): Promise<string> => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new UsageError('Invalid connection code. Copy a fresh command from the API Keys page.');
  checkUrl(baseUrl, '--base-url');
  const url = new URL(baseUrl);
  const response = await rt.fetch(`${url.origin}/api/skill-connect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  const result = await response.json() as { success?: boolean; data?: { key?: unknown } };
  if (!response.ok || !result.success || typeof result.data?.key !== 'string')
    throw new UsageError('Connection code expired, was already used, or the key was revoked. Copy a fresh command from the API Keys page.');
  return result.data.key;
};

const set = async (rt: Runtime, args: ParsedArgs): Promise<number> => {
  const file = credentialsFile(rt);
  if (file === undefined) return unsupported(rt, 'Saving a key');
  const connect = args.string('connect');
  if (connect && (args.has('key') || args.flag('stdin') || args.flag('prompt'))) throw new UsageError('--connect cannot be combined with another key input');
  const connectedKey = connect ? await redeemConnection(rt, connect, args.string('base-url') || DEFAULT_BASE_URL) : undefined;
  const checked = checkKey(connectedKey ?? await readKey(rt, args));
  if ('error' in checked) return fail(rt, checked.error);
  const baseUrl = args.string('base-url')?.trim().replace(/\/+$/, '');
  if (args.has('base-url')) {
    try {
      checkUrl(baseUrl ?? '', '--base-url');
    } catch (error) {
      return fail(rt, error instanceof Error ? error.message : String(error));
    }
  }
  const before = await readStoredCredentials(rt);
  const previous = before.status === 'ok' ? before.credentials.apiKey : undefined;
  const envKey = envValue(rt, DEFAULT_KEY_ENV);
  await writeStoredCredentials(rt, file, { apiKey: checked.key, baseUrl: baseUrl || undefined });
  const device = deviceLocation(rt);
  if (device) await rt.fs.rm(device);
  const shadowed = envKey !== '' && envKey !== previous && envKey !== checked.key;
  printJson(
    rt,
    {
      ok: true,
      action: 'set',
      key: maskKey(checked.key),
      baseUrl: baseUrl || null,
      credentialsFile: file,
      keyPageUrl: keyPageUrl(baseUrl || envValue(rt, BASE_URL_ENV) || DEFAULT_BASE_URL),
      ...(shadowed ? { warning: `${DEFAULT_KEY_ENV} is set in the environment and takes precedence over the stored key: unset it to use the stored one` } : {}),
      next: 'Saved. Run the command that needed the key again; popost auth status shows which key is in use.',
    },
    true,
  );
  return 0;
};

const status = async (rt: Runtime): Promise<number> => {
  const stored = await readStoredCredentials(rt);
  const envKey = envValue(rt, DEFAULT_KEY_ENV);
  const fileCredentials = stored.status === 'ok' ? stored.credentials : {};
  const envBase = envValue(rt, BASE_URL_ENV);
  // The runtime already folded the file into env; a value equal to the stored one is the file's.
  const source = rt.deviceAccess ? 'connection' : !envKey ? 'none' : envKey === fileCredentials.apiKey ? 'file' : 'env';
  const baseUrlSource = !envBase ? 'default' : envBase === fileCredentials.baseUrl ? 'file' : 'env';
  const baseUrl = (envBase || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const page = keyPageUrl(baseUrl);
  printJson(
    rt,
    {
      ok: true,
      source,
      key: envKey ? maskKey(envKey) : null,
      baseUrl,
      baseUrlSource,
      credentialsFile: rt.deviceAccess ? deviceLocation(rt) : stored.status === 'unsupported' ? null : stored.file,
      fileStatus: stored.status,
      ...(stored.status === 'corrupt' ? { warning: `the credentials file is unreadable (${stored.reason}): run popost auth set again to replace it` } : {}),
      keyPageUrl: page,
      ...(source === 'none' ? { next: `No key is configured. Run popost auth login. Show the user its verification link and device code, keep the login running, and wait for browser approval. Verify with popost account; local auth status does not validate access.` } : {}),
    },
    true,
  );
  return 0;
};

const clear = async (rt: Runtime): Promise<number> => {
  const device = deviceLocation(rt);
  if (device && await rt.fs.stat(device)) {
    await rt.fs.rm(device);
    printJson(rt,{ok:true,action:'clear',removed:true,next:'Local connection removed. Manage other connections on your account page.'},true);
    return 0;
  }
  const file = credentialsFile(rt);
  if (file === undefined) return unsupported(rt, 'Removing a stored key');
  const stored = await readStoredCredentials(rt);
  const envKey = envValue(rt, DEFAULT_KEY_ENV);
  const stillSet = envKey !== '' && !(stored.status === 'ok' && stored.credentials.apiKey === envKey);
  await clearStoredCredentials(rt, file);
  printJson(
    rt,
    {
      ok: true,
      action: 'clear',
      removed: stored.status !== 'absent',
      credentialsFile: file,
      ...(stillSet ? { warning: `${DEFAULT_KEY_ENV} is still set in the environment and keeps being used` } : {}),
    },
    true,
  );
  return 0;
};

export const main: CommandMain = (argv, rt) =>
  withArgs(argv, SPEC, rt, async (args) => {
    try {
      const action = args.req('action');
      if (action === 'login') return await login(rt, args.string('base-url'), args.flag('no-open'));
      return action === 'set' ? await set(rt, args) : action === 'status' ? await status(rt) : await clear(rt);
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      rt.stderr(`popost auth: error: ${error.message}\n`);
      return 2;
    }
  });
