/** A command group with sub-commands, parsed like argparse's `add_subparsers`: unknown or missing ones exit 2. */
import { withArgs, type CommandSpec, type ParsedArgs } from '../args';
import type { Runtime } from '../runtime';

export interface Subcommand {
  spec: Omit<CommandSpec, 'prog'>;
  /** `argv` is what follows the sub-command name, for the few commands that care about flag order. */
  run: (args: ParsedArgs, rt: Runtime, argv: readonly string[]) => Promise<number>;
}

export const runSubcommand = async (
  prog: string,
  table: Readonly<Record<string, Subcommand>>,
  argv: readonly string[],
  rt: Runtime,
): Promise<number> => {
  const names = Object.keys(table);
  const usage = `usage: ${prog} [-h] {${names.join(',')}} ...\n`;
  const [name, ...rest] = argv;
  if (name === '-h' || name === '--help') {
    rt.stdout(`${usage}\ncommands:\n${names.map((n) => `  ${n}  ${table[n]!.spec.description ?? ''}`).join('\n')}\n`);
    return 0;
  }
  const command = name === undefined ? undefined : table[name];
  if (!command) {
    const problem = name === undefined ? 'the following arguments are required: cmd' : `argument cmd: invalid choice: '${name}' (choose from ${names.map((n) => `'${n}'`).join(', ')})`;
    rt.stderr(`${usage}${prog}: error: ${problem}\n`);
    return 2;
  }
  return withArgs(rest, { prog: `${prog} ${name}`, ...command.spec }, rt, (args) => command.run(args, rt, rest));
};
