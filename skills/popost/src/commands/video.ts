/**
 * `popost video <command>`: videos as editable projects. A project (video.json and its files) is drawn frame by frame in
 * Chromium and encoded with ffmpeg; a reference video is measured by programs into facts a model can read; a template
 * keeps a reference's structure and takes new content. Every command prints one JSON document: `{"ok": true, …}`, or
 * `{"ok": false, "error": …}` with exit code 2 for something the caller can fix. The commands run local programs on real
 * files, so they need a desktop or a container (`popost video doctor` says what is missing).
 */
import type { CommandMain } from '../runtime';
import { elementsCommands } from '../video/commands/elements';
import { loopCommands, loopGroups } from '../video/commands/loop';
import { makeCommands, makeGroups } from '../video/commands/make';
import { mediaCommands } from '../video/commands/media';
import { readCommands, readGroups } from '../video/commands/read';
import type { Commands } from '../video/commands/shared';
import { runSubcommand, type Subcommand } from '../workflow/subcommands';

const PROG = 'popost video';
const COMMANDS: Commands = { ...mediaCommands, ...makeCommands, ...readCommands, ...loopCommands };
const GROUPS: Readonly<Record<string, Commands>> = { ...makeGroups, ...readGroups, ...loopGroups, elements: elementsCommands };

/** The groups appear in the command list (help, usage errors) as commands that take a command of their own. */
const groupEntry = (commands: Commands): Subcommand => ({
  spec: { description: '{' + Object.keys(commands).join(',') + '}' },
  run: async () => 2, // never reached: a group is dispatched below, before the table is consulted
});

export const main: CommandMain = (argv, rt) => {
  const [name, ...rest] = argv;
  const group = name === undefined ? undefined : GROUPS[name];
  if (group) return runSubcommand(PROG + ' ' + name, group, rest, rt);
  const table = { ...COMMANDS, ...Object.fromEntries(Object.entries(GROUPS).map(([n, c]) => [n, groupEntry(c)])) };
  return runSubcommand(PROG, table, argv, rt);
};
