/** `popost template locate|candidates|conflict`: scene Skill (template) mounting, pure local (`template_plugins.py`). */
import type { CommandMain } from '../runtime';
import { printJson } from '../core/util';
import { runSubcommand, type Subcommand } from '../workflow/subcommands';
import { searchTemplateIndex, type SearchableTemplate } from '../workflow/community-search';
import { detectConflict, locateSkill, recallCandidates } from '../workflow/template-plugins';

/** argparse's `--x` / `--no-x` pair writes one value: the one given last wins, and absent means false. */
const lastOf = (argv: readonly string[], on: string, off: string): boolean => {
  const last = argv.findLast((token) => token === on || token === off);
  return last === on;
};

const locate: Subcommand = {
  spec: { description: '定位真实场景 Skill 并读 SKILL.md 全文', options: [{ flag: '--path', required: true }] },
  run: async (args, rt) => {
    const info = await locateSkill(rt, args.req('path'));
    printJson(rt, info, true);
    return info.ok ? 0 : 2;
  },
};

const candidates: Subcommand = {
  spec: {
    description: '词法召回候选（非权威）',
    options: [{ flag: '--brief', required: true }, { flag: '--roots', required: true, help: '冒号分隔的多个根目录' }, { flag: '--platform-hint' }],
  },
  run: async (args, rt) => {
    const roots = args.req('roots').split(':');
    printJson(rt, await recallCandidates(rt, args.req('brief'), roots, args.string('platform-hint') ?? null), true);
    return 0;
  },
};

const conflict: Subcommand = {
  spec: {
    description: '模板 vs 参考在 strict 下是否需人工复核',
    options: ['--template', '--no-template', '--reference', '--no-reference', '--strict', '--no-strict'].map((flag) => ({ flag, kind: 'flag' as const })),
  },
  run: async (_args, rt, argv) => {
    const result = detectConflict(
      lastOf(argv, '--template', '--no-template'),
      lastOf(argv, '--reference', '--no-reference'),
      lastOf(argv, '--strict', '--no-strict'),
    );
    printJson(rt, result, true);
    return 0;
  },
};

const search: Subcommand = {
  spec: { description: 'Search the bundled community index without selecting a template', options: [{ flag: '--query', required: true }, { flag: '--platform' }, { flag: '--category' }, { flag: '--limit' }] },
  run: async (args, rt) => {
    const root = rt.path.join(rt.skillRoot, 'templates/community');
    const index = JSON.parse(await rt.fs.readText(rt.path.join(root, 'index.json'))) as { schemaVersion?: number; templates?: SearchableTemplate[] };
    if (index.schemaVersion !== 2 || !Array.isArray(index.templates) || index.templates.some((entry) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id))) { printJson(rt, { ok: false, error: 'Invalid community template index' }, true); return 2; }
    const limit = Number(args.string('limit') ?? 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) { printJson(rt, { ok: false, error: 'limit must be between 1 and 50' }, true); return 2; }
    const results = searchTemplateIndex(index.templates, { q: args.req('query'), platform: args.string('platform') ?? undefined, category: args.string('category') ?? undefined, limit });
    printJson(rt, { ok: true, automaticSelection: false, items: results.map(({ template, score }) => ({ ...template, score, skillPath: rt.path.join(root, template.id, 'SKILL.md') })) }, true);
    return 0;
  },
};

export const main: CommandMain = (argv, rt) => runSubcommand('popost template', { locate, candidates, conflict, search }, argv, rt);
