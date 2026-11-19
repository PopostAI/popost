/**
 * `popost auth set|status|clear`: the API key of popost.ai kept in a user-level file (`credentials.ts`), so the same
 * command works on macOS, Windows and Linux without `export` / `$env:` syntax. The environment variable still wins.
 * Nothing here talks to the network, and the full key is never printed.
 */
import { UsageError, withArgs, type CommandSpec, type ParsedArgs } from '../args';
import { login, deviceLocation } from '../device-login';
import { errorText, fail, printJson } from '../core/util';
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
import { msg } from '../i18n';
import type { CommandMain, Runtime } from '../runtime';

const description = (): string =>
  msg(
    `Connect your Agent to your Popost account in the browser. For scripts you can also store a manual API key:

  popost auth login           connect this Agent in your browser with a one-time device code
  popost auth set --prompt    paste the key privately in your own terminal (hidden input)
  popost auth set --stdin     read the key from standard input (keeps it off the command line and out of shell history)
  popost auth set --key KEY   the same with the key as an argument
  popost auth status          show the credential source (connection, env, file or none) and API address without a network call
  popost auth clear           delete the stored key (idempotent)

The key is stored in <home>/.popost/credentials.json (directory: POPOST_HOME), readable by the current user only. Environment variables POPOST_API_KEY and POPOST_BASE_URL take precedence over the file. --base-url selects the full API URL for the intended environment (https; plain http only for localhost).`,
    `在浏览器里把你的 Agent 连接到 Popost 账号。脚本场景也可以手动保存一个 API Key：

  popost auth login           用一次性设备码在浏览器里连接这个 Agent
  popost auth set --prompt    在你自己的终端里私密粘贴 Key（输入不回显）
  popost auth set --stdin     从标准输入读取 Key（不出现在命令行和 shell 历史里）
  popost auth set --key KEY   同上，Key 作为参数传入
  popost auth status          显示凭据来源（connection、env、file 或 none）和 API 地址，不联网
  popost auth clear           删除已保存的 Key（可重复执行）

Key 保存在 <home>/.popost/credentials.json（目录：POPOST_HOME），只有当前用户可读。环境变量 POPOST_API_KEY 和 POPOST_BASE_URL 优先于该文件。--base-url 指定目标环境的完整 API 地址（https；只有 localhost 可以用 http）。`,
  );

const spec = (): CommandSpec => ({
  prog: 'popost auth',
  description: description(),
  positionals: [
    {
      name: 'action',
      choices: ['login', 'set', 'status', 'clear'],
      help: msg('store a key, show where the key comes from, or delete the stored key', '保存 Key、显示 Key 的来源，或删除已保存的 Key'),
    },
  ],
  options: [
    { flag: '--no-open', kind: 'flag', help: msg('login: print the verification link without opening a browser', 'login：只打印验证链接，不打开浏览器') },
    { flag: '--connect', help: msg('set: redeem a single-use connection code copied from the API Keys page', 'set：兑换从 API Keys 页面复制的一次性连接码') },
    { flag: '--key', help: msg('set: the API key', 'set：API Key') },
    { flag: '--stdin', kind: 'flag', help: msg('set: read the API key from standard input', 'set：从标准输入读取 API Key') },
    { flag: '--prompt', kind: 'flag', help: msg('set: hidden key input in the user’s own interactive terminal', 'set：在用户自己的交互式终端里输入 Key（不回显）') },
    { flag: '--base-url', help: msg('set: API address to store with the key (https)', 'set：和 Key 一起保存的 API 地址（https）') },
  ],
});

const MIN_KEY_LENGTH = 16;
const MAX_KEY_LENGTH = 512;

/** The trimmed key, or why it cannot be one. The message never contains the input. */
export const checkKey = (raw: string): { key: string } | { error: string } => {
  const key = raw.trim();
  if (!key) return { error: msg('the API key is empty', 'API Key 为空') };
  if (/\s/.test(key)) return { error: msg('the API key must be one word without spaces or line breaks: pass only the key', 'API Key 必须是一个不含空格或换行的整体：只传 Key 本身') };
  if (/^bearer$/i.test(key) || /^https?:\/\//i.test(key)) return { error: msg('that is not an API key: pass only the key itself, not a header or an address', '这不是 API Key：只传 Key 本身，不要传请求头或地址') };
  if (/^(export\s+)?[A-Za-z_][A-Za-z0-9_]*=/.test(key)) return { error: msg(`that looks like ${DEFAULT_KEY_ENV}=...: pass only the key, without the variable name`, `这看起来像 ${DEFAULT_KEY_ENV}=...：只传 Key，不要带变量名`) };
  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(key))
    return {
      error: msg(
        `that does not look like an API key (expected ${MIN_KEY_LENGTH}-${MAX_KEY_LENGTH} printable characters): copy it again from the key page`,
        `这不像是 API Key（应为 ${MIN_KEY_LENGTH}-${MAX_KEY_LENGTH} 个可打印字符）：请从 Key 页面重新复制`,
      ),
    };
  return { key };
};

const envValue = (rt: Runtime, name: string): string => (rt.env[name] ?? '').trim();

/** `what` names the refused action in both languages, e.g. `{ en: 'Saving a key', zh: '保存 Key' }`. */
const unsupported = (rt: Runtime, what: { en: string; zh: string }): number =>
  fail(
    rt,
    msg(
      `${what.en} is not available in this environment (the host has no user home directory): set the ${DEFAULT_KEY_ENV} environment variable instead`,
      `当前环境不支持${what.zh}（宿主没有用户主目录）：请改为设置环境变量 ${DEFAULT_KEY_ENV}`,
    ),
  );

const readKey = async (rt: Runtime, args: ParsedArgs): Promise<string> => {
  const inline = args.string('key');
  if (Number(args.flag('stdin')) + Number(args.flag('prompt')) + Number(inline !== undefined) !== 1)
    throw new UsageError(msg('give the key with exactly one of --prompt, --stdin or --key KEY', '只能用 --prompt、--stdin 或 --key KEY 中的一种方式提供 Key'));
  if (args.flag('prompt')) {
    if (!rt.readSecret)
      throw new UsageError(
        msg(
          'Hidden terminal input is unavailable. Configure the key using your host secret settings; do not paste it into chat.',
          '无法使用不回显的终端输入。请在宿主的密钥设置里配置 Key；不要把它粘贴到对话里。',
        ),
      );
    try { return await rt.readSecret(); }
    catch {
      throw new UsageError(
        msg(
          'Private key input was cancelled or unavailable; nothing was saved. Run auth set --prompt in your own interactive terminal.',
          '私密输入 Key 已取消或不可用；未保存任何内容。请在你自己的交互式终端里运行 auth set --prompt。',
        ),
      );
    }
  }
  if (inline !== undefined) return inline;
  if (!rt.stdin)
    throw new UsageError(
      msg(
        '--stdin is unavailable: use the host secret settings, or auth set --prompt in your own terminal.',
        '--stdin 不可用：请使用宿主的密钥设置，或在你自己的终端里运行 auth set --prompt。',
      ),
    );
  return rt.stdin();
};

/** A connection code is exchanged only with the explicitly selected API origin. No secrets are printed. */
const redeemConnection = async (rt: Runtime, code: string, baseUrl: string): Promise<string> => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(code))
    throw new UsageError(msg('Invalid connection code. Copy a fresh command from the API Keys page.', '连接码无效。请从 API Keys 页面重新复制命令。'));
  checkUrl(baseUrl, '--base-url');
  const url = new URL(baseUrl);
  const response = await rt.fetch(`${url.origin}/api/skill-connect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  const result = await response.json() as { success?: boolean; data?: { key?: unknown } };
  if (!response.ok || !result.success || typeof result.data?.key !== 'string')
    throw new UsageError(
      msg(
        'Connection code expired, was already used, or the key was revoked. Copy a fresh command from the API Keys page.',
        '连接码已过期、已被使用，或对应的 Key 已被撤销。请从 API Keys 页面重新复制命令。',
      ),
    );
  return result.data.key;
};

/** The notes `set`, `status` and `clear` print. */
const text = {
  shadowed: () =>
    msg(
      `${DEFAULT_KEY_ENV} is set in the environment and takes precedence over the stored key: unset it to use the stored one`,
      `环境变量里设置了 ${DEFAULT_KEY_ENV}，它优先于已保存的 Key：要使用已保存的 Key，请先取消这个环境变量`,
    ),
  saved: () =>
    msg(
      'Saved. Run the command that needed the key again; popost auth status shows which key is in use.',
      '已保存。请重新运行需要 Key 的命令；popost auth status 可以查看当前使用的是哪个 Key。',
    ),
  corrupt: (reason: string) =>
    msg(
      `the credentials file is unreadable (${reason}): run popost auth set again to replace it`,
      `凭据文件无法读取（${reason}）：请重新运行 popost auth set 替换它`,
    ),
  noKey: () =>
    msg(
      'No key is configured. Run popost auth login. Show the user its verification link and device code, keep the login running, and wait for browser approval. Verify with popost account; local auth status does not validate access.',
      '还没有配置 Key。请运行 popost auth login，把它给出的验证链接和设备码展示给用户，保持登录命令运行，等待用户在浏览器里批准。之后用 popost account 验证；本地的 auth status 不会校验访问权限。',
    ),
  disconnected: () =>
    msg('Local connection removed. Manage other connections on your account page.', '已移除本机连接。其他连接请在账号页面管理。'),
  stillSet: () =>
    msg(`${DEFAULT_KEY_ENV} is still set in the environment and keeps being used`, `环境变量里仍设置着 ${DEFAULT_KEY_ENV}，会继续使用它`),
} as const;

const set = async (rt: Runtime, args: ParsedArgs): Promise<number> => {
  const file = credentialsFile(rt);
  if (file === undefined) return unsupported(rt, { en: 'Saving a key', zh: '保存 Key' });
  const connect = args.string('connect');
  if (connect && (args.has('key') || args.flag('stdin') || args.flag('prompt')))
    throw new UsageError(msg('--connect cannot be combined with another key input', '--connect 不能和其他 Key 输入方式同时使用'));
  const connectedKey = connect ? await redeemConnection(rt, connect, args.string('base-url') || DEFAULT_BASE_URL) : undefined;
  const checked = checkKey(connectedKey ?? await readKey(rt, args));
  if ('error' in checked) return fail(rt, checked.error);
  const baseUrl = args.string('base-url')?.trim().replace(/\/+$/, '');
  if (args.has('base-url')) {
    try {
      checkUrl(baseUrl ?? '', '--base-url');
    } catch (error) {
      return fail(rt, errorText(error));
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
      ...(shadowed ? { warning: text.shadowed() } : {}),
      next: text.saved(),
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
      ...(stored.status === 'corrupt' ? { warning: text.corrupt(stored.reason) } : {}),
      keyPageUrl: page,
      ...(source === 'none' ? { next: text.noKey() } : {}),
    },
    true,
  );
  return 0;
};

const clear = async (rt: Runtime): Promise<number> => {
  const device = deviceLocation(rt);
  if (device && await rt.fs.stat(device)) {
    await rt.fs.rm(device);
    printJson(rt, { ok: true, action: 'clear', removed: true, next: text.disconnected() }, true);
    return 0;
  }
  const file = credentialsFile(rt);
  if (file === undefined) return unsupported(rt, { en: 'Removing a stored key', zh: '删除已保存的 Key' });
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
      ...(stillSet ? { warning: text.stillSet() } : {}),
    },
    true,
  );
  return 0;
};

export const main: CommandMain = (argv, rt) =>
  withArgs(argv, spec(), rt, async (args) => {
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
