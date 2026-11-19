/**
 * Image provider adapter (port of provider_adapter.py), the `popost provider …` command. Quote and confirm delegate to
 * the provider CLI; host tools are run by the agent and their real results imported. Nothing here spends money by
 * itself: `confirm` is blocked unless the caller passes the confirmation, and it never sets it on its own.
 *
 * Delegation runs the provider CLI in this process (no subprocess), through a `CliRunner` that tests can replace.
 */
import { createHash } from 'node:crypto';
import { printJson } from '../core/util';
import type { Runtime } from '../runtime';
import type { JsonRecord } from './base';
import { main as providerCliMain } from './cli';
import { runSubcommand, type SubcommandEntry } from './cli-args';
import { resolvePath } from './paths';
import { msg } from '../i18n';

export const OFFICIAL_CHANNEL = 'popost'; // the popost.ai platform; the default model is private config or the platform's, never hard-coded
export const MAX_CREDITS_PER_REQUEST = 200;
export const REF_ROLES = ['identity', 'style', 'action'] as const;

/** Bad input to an adapter function (Python `ValueError`): reported as a `blocked` result, exit 1. */
export class AdapterInputError extends Error {
  override name = 'ValueError';
}

export interface RunnerResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the provider CLI for an argv (what follows `popost provider cli`). `injected` labels results of a test double. */
export type CliRunner = ((argv: readonly string[]) => Promise<RunnerResult>) & { injected?: boolean };

/** The real runner: the provider CLI in this process, its output captured. */
export const processRunner =
  (rt: Runtime): CliRunner =>
  async (argv) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await providerCliMain(argv, { ...rt, stdout: (text) => void out.push(text), stderr: (text) => void err.push(text) });
    return { code, stdout: out.join(''), stderr: err.join('') };
  };

const runJson = async (argv: readonly string[], runner: CliRunner) => {
  const { code, stdout, stderr } = await runner(argv);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = null;
  }
  return { code, parsed, stderr };
};

// ---------------- refs with roles ----------------
export interface RoleRef {
  path: string;
  role: string;
}

export interface NormalizedRefs {
  refs: RoleRef[];
  identityRefs: RoleRef[];
  hasIdentity: boolean;
}

/** `[{path, role}]` or `[path, role]` pairs, with the role checked. Identity and style references are not interchangeable. */
export const normalizeRoleRefs = (refs: readonly unknown[] | null | undefined): NormalizedRefs => {
  const out: RoleRef[] = (refs ?? []).map((ref) => {
    let path: unknown;
    let role: unknown;
    if (Array.isArray(ref) && ref.length === 2) [path, role] = ref;
    else if (ref !== null && typeof ref === 'object' && !Array.isArray(ref)) ({ path, role } = ref as JsonRecord);
    else throw new AdapterInputError(msg('a ref must be {path,role} or [path,role]', 'ref 必须是 {path,role} 或 [path,role]'));
    if (typeof path !== 'string' || !path) throw new AdapterInputError(msg('ref.path must be a non-empty string', 'ref.path 必须是非空字符串'));
    if (typeof role !== 'string' || !(REF_ROLES as readonly string[]).includes(role)) {
      const got = role === undefined ? msg('nothing', '空值') : JSON.stringify(role);
      throw new AdapterInputError(msg(`ref.role must be one of ${REF_ROLES.join('/')}, got ${got}`, `ref.role 必须是 ${REF_ROLES.join('/')} 之一，收到 ${got}`));
    }
    return { path, role };
  });
  const identityRefs = out.filter((r) => r.role === 'identity');
  return { refs: out, identityRefs, hasIdentity: identityRefs.length > 0 };
};

/** The `--ref` file list the CLI takes: by path, de-duplicated, in order. */
export const refsToProviderArgs = (refs: readonly RoleRef[]): string[] => [...new Set(refs.map((r) => r.path))].flatMap((path) => ['--ref', path]);

// ---------------- channels ----------------
/** Channel capabilities. The platform channel is `not_tested` unless the caller gives a runner and asks to probe. */
export const checkChannels = async (runner?: CliRunner): Promise<JsonRecord> => {
  const channels: Record<string, unknown> = {
    manual: { status: 'available', measured: null, note: msg('local files; register the sha256 with inventory when used', '本地文件；用时 inventory 登记 sha256') },
    [OFFICIAL_CHANNEL]: {
      status: 'not_tested',
      measured: false,
      defaultModel: null,
      maxCreditsPerRequest: MAX_CREDITS_PER_REQUEST,
      note: msg(
        "not probed over the network here; a real check happens in an explicit quote. Default model = the private config's defaultModel, else the platform default",
        '未在本模块联网探测；真实 check 由显式 quote 流程触发。默认模型 = 私有配置 defaultModel，否则平台默认',
      ),
    },
    host: {
      status: 'declared',
      measured: false,
      note: msg('only records results the host declares; nothing is called or tested on its behalf', '仅登记宿主声明的结果，不代调、不实测'),
    },
    pending: ['parse-service', 'future-host-tools'],
  };
  if (runner) {
    const { code, parsed } = await runJson(['check', '--json'], runner);
    const ok = code === 0 && typeof parsed === 'object' && parsed !== null && Boolean((parsed as JsonRecord).ok);
    channels[OFFICIAL_CHANNEL] = { status: ok ? 'measured' : 'unavailable', measured: ok, defaultModel: null, maxCreditsPerRequest: MAX_CREDITS_PER_REQUEST, injected: Boolean(runner.injected), raw: parsed };
  }
  return { ok: true, channels };
};

export const blocked = (reason: string): JsonRecord => ({ ok: false, status: 'blocked', error: { code: 'NO_TOOL', msg: reason } });

const sha256Of = async (rt: Runtime, path: string): Promise<string | null> => {
  const abs = resolvePath(rt, path);
  return (await rt.fs.stat(abs))?.isFile ? createHash('sha256').update(await rt.fs.readFile(abs)).digest('hex') : null;
};

const tail = (text: string): string => (text ? text.trim().slice(-500) : '');

/** manual: registers a local file (sha256) through the CLI's `inventory`. A missing file is blocked, nothing delegated. */
export const registerManual = async (rt: Runtime, path: string, runner: CliRunner = processRunner(rt)): Promise<JsonRecord> => {
  const sha256 = await sha256Of(rt, path);
  if (sha256 === null) return blocked(msg(`the manual file does not exist: ${path}`, `manual 文件不存在: ${path}`));
  const { code, parsed } = await runJson(['inventory', '--file', path, '--json'], runner);
  return { ok: code === 0, channel: 'manual', path, sha256, delegated: parsed, exit: code };
};

export interface QuoteSlot {
  prompt: string;
  aspect?: string;
  refs?: readonly unknown[];
  count?: number;
  provider?: string;
  model?: string | null;
  config?: string | null;
}

/** popost / custom, the first step: a quote, never a charge. */
export const quoteSlot = async (rt: Runtime, slot: QuoteSlot, runner: CliRunner = processRunner(rt)): Promise<JsonRecord> => {
  const { aspect = '1:1', count = 1, provider = OFFICIAL_CHANNEL } = slot;
  const normalized = normalizeRoleRefs(slot.refs);
  const argv = ['--provider', provider, ...(slot.config ? ['--config', slot.config] : []), 'quote', '--prompt', slot.prompt, '--aspect-ratio', aspect, '--count', String(count)];
  if (slot.model) argv.push('--model', slot.model);
  argv.push(...refsToProviderArgs(normalized.refs));
  const { code, parsed, stderr } = await runJson(argv, runner);
  const note = msg('a quote only; generate needs the user to authorize the cost explicitly', '仅报价；须用户明确费用授权 才可 generate');
  return { ok: code === 0, channel: provider, phase: 'quote', refsNormalized: normalized, note, delegated: parsed, exit: code, stderr: tail(stderr) };
};

/** The second step. `confirm` defaults to false and blocks; this module never sets it itself. */
export const confirmGenerate = async (rt: Runtime, quoteId: string, outDir: string, options: { confirm?: boolean; config?: string | null } = {}, runner: CliRunner = processRunner(rt)): Promise<JsonRecord> => {
  if (!options.confirm)
    return {
      ok: false,
      status: 'blocked',
      exit: 3,
      error: {
        code: 'UNCONFIRMED',
        msg: msg(
          'no explicit confirmation from the user was given (confirm=false blocks by default); this module never confirms a real charge by itself.',
          '未收到用户明确确认凭证（confirm=false 默认阻断）；本模块不会自动确认真实扣费。',
        ),
      },
    };
  const argv = [...(options.config ? ['--config', options.config] : []), 'generate', '--quote-id', quoteId, '--confirm', '--out-dir', outDir];
  const { code, parsed, stderr } = await runJson(argv, runner);
  return { ok: code === 0, channel: OFFICIAL_CHANNEL, phase: 'generate', delegated: parsed, exit: code, stderr: tail(stderr) };
};

/** host: records a result the host really produced. Never marked measured. */
export const importHostAsset = async (rt: Runtime, path: string, license = '', attribution = ''): Promise<JsonRecord> => {
  const sha256 = await sha256Of(rt, path);
  if (sha256 === null) return blocked(msg(`the host asset file does not exist: ${path}`, `host 资产文件不存在: ${path}`));
  const note = msg(
    'supplied by the host; this module neither fetches it, nor tests the connection, nor claims it was measured',
    '宿主代供；本模块不代取、不实测连通、不冒充 measured',
  );
  return { ok: true, channel: 'host', status: 'declared', measured: false, path, sha256, license, attribution, note };
};

// ---------------- the command ----------------
/** `--ref path:role` pairs; the role is whatever follows the last colon. */
const refsFromCli = (items: readonly string[]): RoleRef[] =>
  items.map((item) => {
    const cut = item.lastIndexOf(':');
    if (cut < 0) throw new AdapterInputError(msg(`--ref needs path:role, got ${JSON.stringify(item)}`, `--ref 需 path:role，收到 ${JSON.stringify(item)}`));
    return { path: item.slice(0, cut), role: item.slice(cut + 1) };
  });

const exitFrom = (result: JsonRecord): number => (result.ok ? 0 : Number(result.exit) || 1);

const emit = (rt: Runtime, result: JsonRecord): number => {
  printJson(rt, result, true);
  return exitFrom(result);
};

const entries = (rt: Runtime): Record<string, SubcommandEntry> => ({
  check: {
    spec: { description: msg('declare the channel capabilities (popost is not_tested by default)', '声明通道能力（popost 默认 not_tested）') },
    run: async () => emit(rt, await checkChannels()),
  },
  quote: {
    spec: {
      description: msg('step one: a quote only', '第一段：只报价'),
      options: [
        { flag: '--prompt', required: true },
        { flag: '--provider', choices: [OFFICIAL_CHANNEL, 'custom'], default: OFFICIAL_CHANNEL },
        { flag: '--model' },
        { flag: '--config' },
        { flag: '--aspect', default: '1:1' },
        { flag: '--count', kind: 'int', default: 1 },
        { flag: '--ref', kind: 'append', help: msg('path:role, role ∈ identity/style/action', 'path:role，role∈identity/style/action') },
      ],
    },
    run: async (a) =>
      emit(rt, await quoteSlot(rt, { prompt: a.req('prompt'), aspect: a.req('aspect'), refs: refsFromCli(a.list('ref')), count: a.number('count') ?? 1, provider: a.req('provider'), model: a.string('model'), config: a.string('config') })),
  },
  confirm: {
    spec: {
      description: msg('step two: submit, only once the user has confirmed', '第二段：用户已确认才提交'),
      options: [{ flag: '--quote-id', required: true }, { flag: '--config' }, { flag: '--out-dir', required: true }, { flag: '--confirm', kind: 'flag' }],
    },
    run: async (a) => emit(rt, await confirmGenerate(rt, a.req('quote-id'), a.req('out-dir'), { confirm: a.flag('confirm'), config: a.string('config') })),
  },
  manual: {
    spec: { description: msg('register a local asset', '登记本地素材'), options: [{ flag: '--file', required: true }] },
    run: async (a) => emit(rt, await registerManual(rt, a.req('file'))),
  },
  'host-import': {
    spec: {
      description: msg('register an asset the host says it supplied (declared only)', '登记宿主声明代供的素材（仅 declared）'),
      options: [{ flag: '--file', required: true }, { flag: '--license', default: '' }, { flag: '--attribution', default: '' }],
    },
    run: async (a) => emit(rt, await importHostAsset(rt, a.req('file'), a.string('license') ?? '', a.string('attribution') ?? '')),
  },
});

const cliHelp = () =>
  msg(
    '  cli  the low-level two-step CLI (quote, generate, status, download, models, check, inventory): popost provider cli --help\n',
    '  cli  底层两段式命令（quote、generate、status、download、models、check、inventory）：popost provider cli --help\n',
  );

/** `popost provider <check|quote|confirm|manual|host-import>`, or `provider cli …`; bad input is a `blocked` result with exit 1. */
export const adapterMain = async (argv: readonly string[], rt: Runtime): Promise<number> => {
  try {
    if (argv[0] === 'cli') return await providerCliMain(argv.slice(1), rt);
    return await runSubcommand('popost provider', entries(rt), argv, rt, cliHelp());
  } catch (error) {
    if (!(error instanceof AdapterInputError)) throw error;
    printJson(rt, blocked(error.message), true);
    return 1;
  }
};
