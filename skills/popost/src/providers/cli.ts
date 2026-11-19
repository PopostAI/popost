/**
 * The two-step material CLI (port of provider_cli.py): `quote` (price only) then `generate` (charges, after
 * confirmation), plus `status`, `download`, `models`, `check` and `inventory`. Reached as `popost provider cli …`, and in
 * process by the image jobs (`executeCli`), which never need an argv.
 *
 * Exit codes: 0 done, 1 business refusal, 2 usage / environment error, 3 not confirmed. Output is one JSON document.
 */
import { formatHelp, parseArgs, UsageError, type CommandSpec, type OptionSpec, type ParsedArgs } from '../args';
import { printJson } from '../core/util';
import type { CommandMain, Runtime } from '../runtime';
import type { JsonRecord } from './base';
import { cmdCheck, cmdDownload, cmdInventory, cmdModels, cmdStatus } from './cli-commands';
import { loadConfig, type Ctx, type Globals } from './cli-config';
import { withProviderArgs } from './cli-args';
import { cmdGenerate, type GenerateArgs } from './cli-generate';
import { cmdQuote, type QuoteArgs } from './cli-quote';
import { CliReject, exitCodeOf, ImageProviderError } from './errors';
import { allProviderKinds, OFFICIAL_PROVIDER } from './index';
import { scrub, secretValues } from './secrets';

export type CliCommand =
  | { readonly name: 'quote'; readonly args: QuoteArgs }
  | { readonly name: 'generate'; readonly args: GenerateArgs }
  | { readonly name: 'status'; readonly args: { taskId: string; raw: boolean } }
  | { readonly name: 'download'; readonly args: { taskId: string; outDir: string } }
  | { readonly name: 'models' }
  | { readonly name: 'check' }
  | { readonly name: 'inventory'; readonly args: { file: string[] } };

export interface CliInvocation {
  readonly provider?: string;
  readonly config?: string;
  readonly globals: Globals;
  readonly command: CliCommand;
}

export interface CliOutcome {
  readonly code: number;
  readonly result: JsonRecord;
}

export const noGlobals: Globals = { mock: false, dryRun: false, acceptUnknownCost: false };

const dispatch = (ctx: Ctx, name: string, command: CliCommand): Promise<JsonRecord> => {
  switch (command.name) {
    case 'quote':
      return cmdQuote(ctx, name, command.args);
    case 'generate':
      return cmdGenerate(ctx, command.args);
    case 'status':
      return cmdStatus(ctx, name, command.args.taskId, command.args.raw);
    case 'download':
      return cmdDownload(ctx, name, command.args.taskId, command.args.outDir);
    case 'models':
      return cmdModels(ctx, name);
    case 'check':
      return cmdCheck(ctx, name);
    case 'inventory':
      return cmdInventory(ctx, command.args.file);
  }
};

/**
 * Runs one invocation. Refusals come back as `{ok: false, code, error}` with that code; anything unexpected (a bug, a
 * broken file system) is thrown. Everything in the result is scrubbed of credential values.
 */
export const executeCli = async (rt: Runtime, invocation: CliInvocation): Promise<CliOutcome> => {
  let cfg: JsonRecord = {};
  try {
    cfg = await loadConfig(rt, invocation.config);
    const name = invocation.provider || (cfg.defaultProvider as string | undefined) || OFFICIAL_PROVIDER;
    if (!allProviderKinds().includes(name)) throw new CliReject(2, `未知 provider ${name}`);
    const result = await dispatch({ rt, cfg, g: invocation.globals }, name, invocation.command);
    return { code: 0, result: scrub(result, secretValues(rt, cfg)) };
  } catch (error) {
    const refusal = refusalOf(error);
    if (!refusal) throw error;
    return { code: refusal.code, result: scrub({ ok: false, code: refusal.code, error: refusal.message }, secretValues(rt, cfg)) };
  }
};

const refusalOf = (error: unknown): { code: number; message: string } | null => {
  if (error instanceof CliReject) return { code: error.code, message: error.message };
  if (error instanceof ImageProviderError) return { code: exitCodeOf(error), message: error.message };
  return null;
};

// ---------------- argv ----------------
const COMMON: readonly OptionSpec[] = [
  { flag: '--mock', kind: 'flag', help: '本地模拟，不联网不扣费（结果必须标注 mock）' },
  { flag: '--dry-run', kind: 'flag', help: '构建请求不提交' },
  { flag: '--mock-dir' },
  { flag: '--quote-dir' },
  { flag: '--ledger' },
  { flag: '--task-dir', help: '同步通道（popost）本地任务记录目录；默认报价目录同级 tasks/' },
  { flag: '--accept-unknown-cost', kind: 'flag', help: 'BYOK only: explicitly acknowledge unknown provider billing' },
  { flag: '--json', kind: 'flag' },
];

const REFS: readonly OptionSpec[] = [{ flag: '--ref', kind: 'append' }, { flag: '--ref-url', kind: 'append' }];
const PROMPT: readonly OptionSpec[] = [{ flag: '--prompt-file' }, { flag: '--prompt' }];

const SPECS: Record<CliCommand['name'], Omit<CommandSpec, 'prog'>> = {
  quote: {
    description: '只报价，不提交不扣费',
    options: [...PROMPT, { flag: '--aspect-ratio', default: '1:1', help: 'W:H；须为所选模型实际支持的比例' }, { flag: '--model' }, ...REFS, { flag: '--count', kind: 'int', default: 1 }, { flag: '--valid-sec', kind: 'int', default: 600 }, ...COMMON],
  },
  generate: {
    description: '确认后提交（须 --quote-id + --confirm）',
    options: [
      { flag: '--quote-id', required: true },
      { flag: '--confirm', kind: 'flag', help: '用户已明确确认的令牌（非自动确认）' },
      ...PROMPT,
      { flag: '--aspect-ratio' },
      { flag: '--model' },
      ...REFS,
      { flag: '--count', kind: 'int' },
      { flag: '--out-dir' },
      { flag: '--poll-interval', kind: 'number' },
      { flag: '--poll-timeout', kind: 'number' },
      { flag: '--idempotency-key', help: 'popost：人工安全重试时复用 ambiguous 记录里的同一幂等键（平台不重复扣费）' },
      ...COMMON,
    ],
  },
  status: { description: '只读查询已有 taskId', options: [{ flag: '--task-id', required: true }, { flag: '--raw', kind: 'flag' }, ...COMMON] },
  download: { description: 'completed 后下载', options: [{ flag: '--task-id', required: true }, { flag: '--out-dir', required: true }, ...COMMON] },
  models: { description: '实时模型/价格清单', options: [...COMMON] },
  check: { description: '能力 preflight（不输出凭据）', options: [...COMMON] },
  inventory: { description: 'manual 通道登记用户直接提供的本地素材', options: [{ flag: '--file', kind: 'append', required: true }, ...COMMON] },
};

const globalsOf = (a: ParsedArgs): Globals => ({
  mock: a.flag('mock'),
  dryRun: a.flag('dry-run'),
  mockDir: a.string('mock-dir'),
  quoteDir: a.string('quote-dir'),
  ledger: a.string('ledger'),
  taskDir: a.string('task-dir'),
  acceptUnknownCost: a.flag('accept-unknown-cost'),
});

const commandOf = (name: CliCommand['name'], a: ParsedArgs): CliCommand => {
  switch (name) {
    case 'quote':
      return { name, args: { promptFile: a.string('prompt-file'), prompt: a.string('prompt'), aspectRatio: a.req('aspect-ratio'), model: a.string('model'), ref: a.list('ref'), refUrl: a.list('ref-url'), count: a.number('count') ?? 1, validSec: a.number('valid-sec') ?? 600 } };
    case 'generate':
      return {
        name,
        args: {
          quoteId: a.req('quote-id'),
          confirm: a.flag('confirm'),
          promptFile: a.string('prompt-file'),
          prompt: a.string('prompt'),
          aspectRatio: a.string('aspect-ratio'),
          model: a.string('model'),
          ref: a.list('ref'),
          refUrl: a.list('ref-url'),
          count: a.number('count'),
          outDir: a.string('out-dir'),
          pollInterval: a.number('poll-interval'),
          pollTimeout: a.number('poll-timeout'),
          idempotencyKey: a.string('idempotency-key'),
        },
      };
    case 'status':
      return { name, args: { taskId: a.req('task-id'), raw: a.flag('raw') } };
    case 'download':
      return { name, args: { taskId: a.req('task-id'), outDir: a.req('out-dir') } };
    case 'inventory':
      return { name, args: { file: a.list('file') } };
    default:
      return { name };
  }
};

const TOP: CommandSpec = { prog: 'popost provider cli', options: [{ flag: '--provider', help: '付费默认 popost（popost.ai 平台）；custom=自带 Key；manual/host 非生成' }, { flag: '--config' }] };
const NAMES = Object.keys(SPECS) as CliCommand['name'][];

/** Global options come before the sub-command (`--provider P --config F quote …`), as in argparse. */
const splitGlobals = (argv: readonly string[]): { head: string[]; name: string | undefined; rest: string[] } => {
  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;
    if (token === '--provider' || token === '--config') i += 2;
    else if (token.startsWith('-')) i += 1;
    else break;
  }
  return { head: argv.slice(0, i), name: argv[i], rest: argv.slice(i + 1) };
};

const usageError = (rt: Runtime, message: string): number => {
  rt.stderr(`usage: ${TOP.prog} [-h] [--provider PROVIDER] [--config CONFIG] {${NAMES.join(',')}} ...\n${TOP.prog}: error: ${message}\n`);
  return 2;
};

const print = (rt: Runtime, outcome: CliOutcome): number => {
  printJson(rt, outcome.result, true);
  return outcome.code;
};

/** `popost provider cli [--provider P] [--config F] <command> [options]`. */
export const main: CommandMain = async (argv, rt) => {
  const { head, name, rest } = splitGlobals(argv);
  let top: ParsedArgs;
  try {
    top = parseArgs(head, TOP);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    return usageError(rt, error.message);
  }
  if (top.help) {
    rt.stdout(`${formatHelp(TOP)}\ncommands: ${NAMES.join(', ')}\n`);
    return 0;
  }
  if (name === undefined) return usageError(rt, 'the following arguments are required: cmd');
  const command = NAMES.find((n) => n === name);
  if (!command) return usageError(rt, `argument cmd: invalid choice: '${name}' (choose from ${NAMES.map((n) => `'${n}'`).join(', ')})`);
  const spec: CommandSpec = { prog: `${TOP.prog} ${command}`, ...SPECS[command] };
  return withProviderArgs(rest, spec, rt, async (a) =>
    print(rt, await executeCli(rt, { provider: top.string('provider'), config: top.string('config'), globals: globalsOf(a), command: commandOf(command, a) })),
  );
};
