/**
 * Argument handling shared by the provider commands: argparse-style sub-commands, values that start with `-`, and the
 * two custom argparse types of provider_cli.py (`aspect_arg`, `idempotency_arg`).
 */
import { formatHelp, parseArgs, UsageError, type CommandSpec, type ParsedArgs } from '../args';
import { msg } from '../i18n';
import type { Runtime } from '../runtime';

/**
 * argparse takes a token that starts with `-` but contains a space as a value, not as an option (`--prompt "- one thing"`,
 * `--prompt "--ar 3:4 a cat"`). The shared parser sees it as an unknown option, so such a value is glued to its flag
 * (`--prompt=...`) first. Only single-value options are affected; flags and lists keep the shared parser's behaviour.
 */
export const joinSpacedValues = (argv: readonly string[], spec: Omit<CommandSpec, 'prog'>): string[] => {
  const known = new Set((spec.options ?? []).map((o) => o.flag));
  const single = new Set((spec.options ?? []).filter((o) => o.kind === undefined || o.kind === 'string' || o.kind === 'append').map((o) => o.flag));
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const next = argv[i + 1];
    if (single.has(token) && next !== undefined && next.startsWith('-') && /\s/.test(next) && !known.has(next.split('=')[0]!)) {
      out.push(`${token}=${next}`);
      i += 1;
    } else out.push(token);
  }
  return out;
};

const ASPECT = /^[1-9][0-9]{0,2}:[1-9][0-9]{0,2}$/;
const IDEMPOTENCY = /^[A-Za-z0-9._-]{8,128}$/;

/** The custom argparse types, applied after parsing: a bad value is a usage error (exit 2) like in argparse. */
export const checkCustomTypes = (args: ParsedArgs): void => {
  const aspect = args.string('aspect-ratio');
  if (aspect !== undefined && !ASPECT.test(aspect))
    throw new UsageError(msg('argument --aspect-ratio: the ratio must be W:H, for example 1:1, 3:4, 9:16', 'argument --aspect-ratio: 画幅须为 W:H，例如 1:1、3:4、9:16'));
  const key = args.string('idempotency-key');
  if (key !== undefined && !IDEMPOTENCY.test(key))
    throw new UsageError(msg('argument --idempotency-key: must be 8–128 letters, digits or . _ -', 'argument --idempotency-key: 须为 8–128 位字母、数字或 . _ -'));
};

/** Like `withArgs`, with spaced values joined and the custom types checked. */
export const withProviderArgs = async (
  argv: readonly string[],
  spec: CommandSpec,
  rt: Runtime,
  body: (args: ParsedArgs) => Promise<number>,
): Promise<number> => {
  let args: ParsedArgs;
  try {
    args = parseArgs(joinSpacedValues(argv, spec), spec);
    if (!args.help) checkCustomTypes(args);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    rt.stderr(`usage: ${spec.prog} [-h] ...\n${spec.prog}: error: ${error.message}\n`);
    return 2;
  }
  if (args.help) {
    rt.stdout(formatHelp(spec));
    return 0;
  }
  return body(args);
};

export interface SubcommandEntry {
  readonly spec: Omit<CommandSpec, 'prog'>;
  readonly run: (args: ParsedArgs) => Promise<number>;
}

/** argparse's `add_subparsers(required=True)`: a missing or unknown sub-command is a usage error (exit 2). */
export const runSubcommand = async (
  prog: string,
  table: Readonly<Record<string, SubcommandEntry>>,
  argv: readonly string[],
  rt: Runtime,
  extraHelp = '',
): Promise<number> => {
  const names = Object.keys(table);
  const usage = `usage: ${prog} [-h] {${names.join(',')}} ...\n`;
  const [name, ...rest] = argv;
  if (name === '-h' || name === '--help') {
    rt.stdout(`${usage}\ncommands:\n${names.map((n) => `  ${n}  ${table[n]!.spec.description ?? ''}`).join('\n')}\n${extraHelp}`);
    return 0;
  }
  const command = name === undefined ? undefined : table[name];
  if (!command) {
    const problem = name === undefined ? 'the following arguments are required: cmd' : `argument cmd: invalid choice: '${name}' (choose from ${names.map((n) => `'${n}'`).join(', ')})`;
    rt.stderr(`${usage}${prog}: error: ${problem}\n`);
    return 2;
  }
  return withProviderArgs(rest, { prog: `${prog} ${name}`, ...command.spec }, rt, command.run);
};
