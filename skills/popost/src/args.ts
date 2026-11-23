/**
 * A small argparse-compatible parser: the CLI keeps the flags, defaults, choices and exit codes of the Python Skill it
 * replaces (`--flag value`, `--flag=value`, store_true flags, `nargs='+'` lists, required options, choices, `-h/--help`,
 * usage errors on stderr with exit code 2).
 */
import type { Runtime } from './runtime';

export type OptionKind = 'string' | 'int' | 'number' | 'flag' | 'list' | 'append';

export interface OptionSpec {
  /** Long flag, e.g. `--quote-id`; the value is read back by `quoteId` or `quote-id`. */
  readonly flag: string;
  readonly kind?: OptionKind;
  readonly required?: boolean;
  readonly default?: string | number | boolean;
  readonly choices?: readonly string[];
  readonly help?: string;
  readonly metavar?: string;
}

export interface PositionalSpec {
  readonly name: string;
  readonly choices?: readonly string[];
  /** Defaults to true. */
  readonly required?: boolean;
  /** The last positional only: it takes every remaining argument, read back with `list` (argparse's nargs='+', or '*' when not required). */
  readonly variadic?: boolean;
  readonly help?: string;
}

export interface CommandSpec {
  readonly prog: string;
  readonly description?: string;
  readonly positionals?: readonly PositionalSpec[];
  readonly options?: readonly OptionSpec[];
}

type Value = string | number | boolean | string[];

export class UsageError extends Error {}

const keyOf = (flag: string): string => flag.replace(/^-+/, '').replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export class ParsedArgs {
  constructor(
    private readonly values: ReadonlyMap<string, Value>,
    readonly help: boolean,
  ) {}
  private get(name: string): Value | undefined {
    return this.values.get(keyOf(name));
  }
  /** A string option or positional; `undefined` when absent and without a default. */
  string(name: string): string | undefined {
    const value = this.get(name);
    return value === undefined ? undefined : String(value);
  }
  /** A required string option (the parser has already rejected a missing one). */
  req(name: string): string {
    const value = this.string(name);
    if (value === undefined) throw new UsageError(`missing ${name}`);
    return value;
  }
  number(name: string): number | undefined {
    const value = this.get(name);
    return typeof value === 'number' ? value : undefined;
  }
  flag(name: string): boolean {
    return this.get(name) === true;
  }
  list(name: string): string[] {
    const value = this.get(name);
    return Array.isArray(value) ? [...value] : value === undefined ? [] : [String(value)];
  }
  has(name: string): boolean {
    return this.values.has(keyOf(name));
  }
}

const describeChoices = (choices: readonly string[]) => choices.map((c) => `'${c}'`).join(', ');

const convert = (spec: OptionSpec, raw: string): string | number => {
  if (spec.kind === 'int') {
    if (!/^[-+]?\d+$/.test(raw.trim())) throw new UsageError(`argument ${spec.flag}: invalid int value: '${raw}'`);
    return Number.parseInt(raw, 10);
  }
  if (spec.kind === 'number') {
    const value = Number(raw);
    if (raw.trim() === '' || Number.isNaN(value))
      throw new UsageError(`argument ${spec.flag}: invalid float value: '${raw}'`);
    return value;
  }
  if (spec.choices && !spec.choices.includes(raw))
    throw new UsageError(`argument ${spec.flag}: invalid choice: '${raw}' (choose from ${describeChoices(spec.choices)})`);
  return raw;
};

const isOptionToken = (token: string) => token.startsWith('-') && token !== '-' && !/^-\d/.test(token);

export const parseArgs = (argv: readonly string[], spec: CommandSpec): ParsedArgs => {
  const options = new Map((spec.options ?? []).map((o) => [o.flag, o]));
  const values = new Map<string, Value>();
  const positionals: string[] = [];
  let help = false;
  let onlyPositionals = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (onlyPositionals || !isOptionToken(token)) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      onlyPositionals = true;
      continue;
    }
    if (token === '-h' || token === '--help') {
      help = true;
      continue;
    }
    const eq = token.indexOf('=');
    const flag = eq > 0 ? token.slice(0, eq) : token;
    const option = options.get(flag);
    if (!option) throw new UsageError(`unrecognized arguments: ${token}`);
    const key = keyOf(flag);
    if (option.kind === 'flag') {
      if (eq > 0) throw new UsageError(`argument ${flag}: ignored explicit argument '${token.slice(eq + 1)}'`);
      values.set(key, true);
      continue;
    }
    if (option.kind === 'list') {
      const items = eq > 0 ? [token.slice(eq + 1)] : [];
      while (eq < 0 && i + 1 < argv.length && !isOptionToken(argv[i + 1]!)) items.push(argv[++i]!);
      if (!items.length) throw new UsageError(`argument ${flag}: expected at least one argument`);
      values.set(key, items.map((item) => String(convert(option, item))));
      continue;
    }
    const raw = eq > 0 ? token.slice(eq + 1) : argv[++i];
    if (raw === undefined || (eq < 0 && isOptionToken(raw) && option.kind !== 'number' && option.kind !== 'int'))
      throw new UsageError(`argument ${flag}: expected one argument`);
    const value = convert(option, raw);
    if (option.kind === 'append') {
      const previous = values.get(key);
      values.set(key, [...(Array.isArray(previous) ? previous : []), String(value)]);
    } else values.set(key, value);
  }
  if (help) return new ParsedArgs(values, true);
  const declared = spec.positionals ?? [];
  if (positionals.length > declared.length && !declared.at(-1)?.variadic)
    throw new UsageError(`unrecognized arguments: ${positionals.slice(declared.length).join(' ')}`);
  declared.forEach((positional, index) => {
    const raws = positional.variadic ? positionals.slice(index) : positionals.slice(index, index + 1);
    if (!raws.length) return;
    for (const raw of raws)
      if (positional.choices && !positional.choices.includes(raw))
        throw new UsageError(
          `argument ${positional.name}: invalid choice: '${raw}' (choose from ${describeChoices(positional.choices)})`,
        );
    values.set(keyOf(positional.name), positional.variadic ? raws : raws[0]!);
  });
  const missing = [
    ...declared.filter((p) => p.required !== false && !values.has(keyOf(p.name))).map((p) => p.name),
    ...(spec.options ?? []).filter((o) => o.required && !values.has(keyOf(o.flag))).map((o) => o.flag),
  ];
  if (missing.length) throw new UsageError(`the following arguments are required: ${missing.join(', ')}`);
  for (const option of spec.options ?? []) {
    const key = keyOf(option.flag);
    if (!values.has(key) && option.default !== undefined) values.set(key, option.default);
  }
  return new ParsedArgs(values, false);
};

const optionUsage = (option: OptionSpec): string => {
  const meta = option.metavar ?? keyOf(option.flag).toUpperCase();
  if (option.kind === 'flag') return option.flag;
  if (option.kind === 'list') return `${option.flag} ${meta} [${meta} ...]`;
  return `${option.flag} ${option.choices ? `{${option.choices.join(',')}}` : meta}`;
};

export const formatUsage = (spec: CommandSpec): string => {
  const parts = [
    ...(spec.options ?? []).map((o) => (o.required ? optionUsage(o) : `[${optionUsage(o)}]`)),
    ...(spec.positionals ?? []).map((p) => {
      const name = p.choices ? `{${p.choices.join(',')}}` : p.name;
      return p.variadic ? (p.required === false ? `[${name} ...]` : `${name} [${name} ...]`) : name;
    }),
  ];
  return `usage: ${spec.prog} [-h] ${parts.join(' ')}`.trimEnd();
};

export const formatHelp = (spec: CommandSpec): string => {
  const lines = [formatUsage(spec), ''];
  if (spec.description) lines.push(spec.description, '');
  if (spec.positionals?.length) {
    lines.push('positional arguments:');
    for (const p of spec.positionals) lines.push(`  ${p.choices ? `{${p.choices.join(',')}}` : p.name}  ${p.help ?? ''}`);
    lines.push('');
  }
  lines.push('options:', '  -h, --help  show this help message and exit');
  for (const o of spec.options ?? []) {
    const extra = [
      o.required ? 'required' : '',
      o.default !== undefined && o.kind !== 'flag' ? `default: ${o.default}` : '',
    ].filter(Boolean);
    lines.push(`  ${optionUsage(o)}  ${[o.help, extra.length ? `(${extra.join('; ')})` : ''].filter(Boolean).join(' ')}`);
  }
  return lines.join('\n') + '\n';
};

/**
 * Parse `argv` for `spec` and run `body`. `-h/--help` prints the help (exit 0); a usage error prints usage and the
 * message to stderr (exit 2), as argparse does.
 */
export const withArgs = async (
  argv: readonly string[],
  spec: CommandSpec,
  rt: Runtime,
  body: (args: ParsedArgs) => Promise<number>,
): Promise<number> => {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv, spec);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    rt.stderr(`${formatUsage(spec)}\n${spec.prog}: error: ${error.message}\n`);
    return 2;
  }
  if (args.help) {
    rt.stdout(formatHelp(spec));
    return 0;
  }
  return body(args);
};
