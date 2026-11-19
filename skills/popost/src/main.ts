/**
 * `popost <command> …`: the command table of the Python `studio.py`, same names, flags, JSON output and exit codes.
 * Each group lives in its own module under `commands/` and exports a `CommandMain`.
 */
import type { CommandMain, Runtime } from './runtime';
import { errorText, printJson } from './core/util';
import { VERSION } from './version';

type Loader = () => Promise<CommandMain>;

/** Command name → the module that handles it, and whether that module receives the command name in argv. */
const GROUPS: Record<string, { load: Loader; keepName: boolean }> = {};
const register = (names: readonly string[], load: Loader, keepName: boolean) => {
  for (const name of names) GROUPS[name] = { load, keepName };
};

register(
  ['init', 'page', 'design', 'concept', 'import-concept', 'build', 'doctor', 'attach-template', 'attach-bundle'],
  async () => (await import('./commands/core')).main,
  true,
);
register(
  ['plan', 'series', 'reference', 'review', 'package', 'unpack', 'settings', 'template-profile'],
  async () => (await import('./commands/workflow')).main,
  true,
);
register(['auth'], async () => (await import('./commands/auth')).main, false);
register(['install'], async () => (await import('./commands/install')).main, false);
register(['setup'], async () => (await import('./commands/setup')).main, false);
register(['render', 'export', 'serve', 'present'], async () => (await import('./commands/render')).main, true);
register(['sheet'], async () => (await import('./commands/sheet')).main, true);
register(['font'], async () => (await import('./commands/font')).main, false);
register(['image'], async () => (await import('./commands/image')).main, false);
register(['provider'], async () => (await import('./commands/provider')).main, false);
register(['inspiration'], async () => (await import('./commands/inspiration')).main, false);
register(['pricing'], async () => (await import('./commands/pricing')).main, false);
register(['account'], async () => (await import('./commands/account')).main, false);
register(['link'], async () => (await import('./commands/link')).main, false);
register(['template'], async () => (await import('./commands/template')).main, false);
register(['cloud'], async () => (await import('./commands/cloud')).main, false);
register(['deck'], async () => (await import('./commands/deck')).main, false);
register(['ticket', 'validate', 'import'], async () => (await import('./commands/post-bundle')).main, true);

const usage = () =>
  [
    `popost ${VERSION}: create, reproduce and edit social media image posts as editable HTML projects.`,
    '',
    'usage: popost <command> [options]   (popost <command> --help for its options)',
    '',
    'install:   install (the Skill into your coding agents), auth (the popost.ai API key: set, status, clear)',
    'project:   setup, init, page, settings, plan, series, reference, design, template-profile, attach-template',
    'images:    image (prepare, quote, run, complete, status, info), provider, concept, import-concept',
    'fonts:     font',
    'review:    render, sheet, review, build, doctor, export, package, unpack',
    'editor:    present, serve, deck, cloud (push the project to your popost.ai account)',
    'sources:   ticket, validate, import, attach-bundle, link, inspiration, template',
    'account:   account (credit balance and plan), pricing (current link tariff; no charge)',
    '',
  ].join('\n');

/** Run one CLI invocation; returns the exit code. Never throws: an unexpected error is reported as JSON, exit 1. */
export const run = async (argv: readonly string[], rt: Runtime): Promise<number> => {
  const [name, ...rest] = argv;
  if (!name || name === '-h' || name === '--help' || name === 'help') {
    rt.stdout(usage());
    return name ? 0 : 2;
  }
  if (name === '--version' || name === '-V' || name === 'version') {
    rt.stdout(`${VERSION}\n`);
    return 0;
  }
  const group = GROUPS[name];
  if (!group) {
    rt.stderr(`popost: error: unknown command '${name}'\n${usage()}`);
    return 2;
  }
  try {
    const main = await group.load();
    return await main(group.keepName ? argv : rest, rt);
  } catch (error) {
    printJson(rt, { ok: false, error: errorText(error) });
    return 1;
  }
};
