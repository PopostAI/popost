/** `--page` of `render` / `page check`: `all`, one page id or a comma-separated list. */
import type { Project } from '../core/project';
import { msg } from '../i18n';

/** Python's `ValueError`, whose name is part of the error text agents see. */
class ValueError extends Error {
  override name = 'ValueError';
}

/**
 * The pages `spec` names, each once, in the order given (`all`: the manifest order). An unknown id fails like
 * `Project.page` does, so a typo in a list names the page that is wrong.
 */
export const selectPages = (project: Project, spec: string): string[] => {
  if (spec === 'all') return project.manifest.pages.map((page) => page.id);
  const wanted = [...new Set(spec.split(',').map((id) => id.trim()).filter(Boolean))];
  if (!wanted.length) throw new ValueError(msg('--page needs a page id, a comma-separated list such as p1,p3, or all', '--page 需要一个页 id、逗号分隔的列表（如 p1,p3）或 all'));
  for (const id of wanted) project.page(id);
  return wanted;
};
