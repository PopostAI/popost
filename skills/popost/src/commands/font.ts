/** `popost font list` / `font install --dir P --roles a,b`: the shared font library and what a project installs from it. */
import { withArgs, type CommandSpec } from '../args';
import { Project } from '../core/project';
import { printJson } from '../core/util';
import { listRoles } from '../fonts/palette';
import { cjkFontWarnings, installedFontLinks, installFonts } from '../fonts/project-fonts';
import type { CommandMain } from '../runtime';

const SPEC: CommandSpec = {
  prog: 'popost font',
  description:
    'List the font library or install roles into a project (fonts/, css/, fonts-manifest.json). install prints warnings when a cjk-* role goes into a project whose copy language is not Chinese: install those only for copy that has Chinese text.',
  positionals: [{ name: 'action', choices: ['list', 'install'], help: 'list the roles, or install some into a project' }],
  options: [
    { flag: '--dir', default: '.', help: 'project directory (install)' },
    { flag: '--roles', default: '', help: 'install: comma-separated role ids' },
  ],
};

export const main: CommandMain = (argv, rt) =>
  withArgs(argv, SPEC, rt, async (args) => {
    if (args.req('action') === 'list') {
      printJson(rt, { ok: true, roles: await listRoles(rt) }, true);
      return 0;
    }
    // Load first: a directory that is not a project must not be left with half-installed fonts.
    const project = await Project.load(rt, args.req('dir'));
    const { result: installed, fontLinks } = await installFonts(rt, project, args.req('roles'), true);
    // The tags the pages now carry and the pages that changed: the agent never writes these tags itself.
    const warnings = cjkFontWarnings(project, installed.installed.map((role) => role.id));
    printJson(rt, { ok: true, installed, cssInjected: true, links: installedFontLinks(project), fontLinks, ...(warnings.length ? { warnings } : {}) }, true);
    return 0;
  });
