/** `popost font list` / `font install --dir P --roles a,b`: the shared font library and what a project installs from it. */
import { withArgs, type CommandSpec } from '../args';
import { Project } from '../core/project';
import { printJson } from '../core/util';
import { listRoles } from '../fonts/palette';
import { cjkFontWarnings, installedFontLinks, installFonts } from '../fonts/project-fonts';
import { msg } from '../i18n';
import type { CommandMain } from '../runtime';

const spec = (): CommandSpec => ({
  prog: 'popost font',
  description: msg(
    'List the font library or install roles into a project (fonts/, css/, fonts-manifest.json). install prints warnings when a cjk-* role goes into a project whose copy language is not Chinese: install those only for copy that has Chinese text.',
    '列出字库，或把字体角色安装到工程里（fonts/、css/、fonts-manifest.json）。把 cjk-* 角色装进文案语言不是中文的工程时，install 会给出 warnings：只有文案里有中文时才安装它们。',
  ),
  positionals: [
    { name: 'action', choices: ['list', 'install'], help: msg('list the roles, or install some into a project', '列出字体角色，或把其中一些安装到工程里') },
  ],
  options: [
    { flag: '--dir', default: '.', help: msg('project directory (install)', '工程目录（install 用）') },
    { flag: '--roles', default: '', help: msg('install: comma-separated role ids', 'install：逗号分隔的角色 id') },
  ],
});

export const main: CommandMain = (argv, rt) =>
  withArgs(argv, spec(), rt, async (args) => {
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
