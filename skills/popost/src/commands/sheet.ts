/**
 * `sheet`: one JPEG overview of several pictures, so a model looks at the whole post (or a set of generated assets) with
 * one image instead of opening each one. Every picture that is opened stays in a conversation and slows each later step.
 * Failures print `{"ok": false, "error": …}` with exit code 2; a directory that is not a project is a crash (exit 1), like `render`.
 */
import type { ParsedArgs } from '../args';
import { sniffImage } from '../core/image';
import { Project } from '../core/project';
import { errorText, fail, isFile, printJson, relPosix, writeAtomic } from '../core/util';
import { cachedPng } from '../render/png';
import { renderSheet, type SheetPicture } from '../render/sheet';
import { layoutSheet } from '../render/sheet-layout';
import type { CommandMain, Runtime } from '../runtime';
import { failureText, isExpectedFailure, ValueError } from '../workflow/errors';
import { readUserBytes } from '../workflow/io';
import { runSubcommand, type Subcommand } from '../workflow/subcommands';
import { msg } from '../i18n';

const picture = (label: string, source: string, bytes: Uint8Array): SheetPicture => {
  const info = sniffImage(bytes, source);
  return { label, source, width: info.width, height: info.height, mime: info.mime, data: bytes };
};

const labelList = (args: ParsedArgs): string[] | null =>
  args.has('labels') ? args.req('labels').split(',').map((label) => label.trim()) : null;

/** Why the options do not add up, or `null`. Checked before any project is loaded or any file is read. */
const optionProblem = (args: ParsedArgs): string | null => {
  const files = args.has('files');
  if (files && args.has('dir'))
    return msg('use --dir (the rendered pages of a project) or --files, not both', '--dir（项目的渲染页）和 --files 只能用一个');
  if (!files && !args.has('dir'))
    return msg(
      'give --dir P (the rendered pages of a project) or --files a.png b.png … --out sheet.jpg',
      '请给 --dir P（项目的渲染页）或 --files a.png b.png … --out sheet.jpg',
    );
  const out = args.string('out');
  if (out !== undefined && !/\.jpe?g$/i.test(out)) return msg('--out must end in .jpg or .jpeg: the sheet is a JPEG', '--out 必须以 .jpg 或 .jpeg 结尾：总览图是 JPEG');
  if (files) {
    if (args.has('page') || args.flag('compare')) return msg('--page and --compare only go with --dir', '--page 和 --compare 只能配合 --dir 使用');
    if (out === undefined) return msg('--files needs --out (where to write the sheet)', '--files 需要 --out（总览图写到哪里）');
    const labels = labelList(args);
    if (labels && labels.length !== args.list('files').length)
      return msg(
        `--labels has ${labels.length} labels for ${args.list('files').length} files`,
        `--labels 有 ${labels.length} 个标签，但 --files 有 ${args.list('files').length} 个文件`,
      );
    return null;
  }
  return args.has('labels') ? msg('--labels only goes with --files', '--labels 只能配合 --files 使用') : null;
};

/** The pages the sheet shows, in the project's page order (`--page` only filters). */
const selectedPages = (project: Project, spec: string): string[] => {
  const all = project.manifest.pages.map((page) => page.id);
  if (spec === 'all') return all;
  const wanted = spec.split(',').map((id) => id.trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !all.includes(id));
  if (unknown.length)
    throw new ValueError(
      msg(`unknown page: ${unknown.join(', ')} (the project has ${all.join(', ')})`, `未知的页：${unknown.join(', ')}（项目现有 ${all.join(', ')}）`),
    );
  return all.filter((id) => wanted.includes(id));
};

/** The current render of each page (`render` leaves `exports/<page>.png` and its receipt), or an error that says what to run. */
const renderedPages = async (project: Project, pids: readonly string[], dir: string): Promise<SheetPicture[]> => {
  const { rt } = project;
  const paths = new Map<string, string>();
  const problems: string[] = [];
  for (const pid of pids) {
    const png = rt.path.join(project.exportsDir, `${pid}.png`);
    if (!(await isFile(rt, png))) problems.push(msg(`${pid} (not rendered)`, `${pid}（未渲染）`));
    else if (await cachedPng(project, pid)) paths.set(pid, png);
    else problems.push(msg(`${pid} (changed since it was rendered)`, `${pid}（渲染后有改动）`));
  }
  if (problems.length) {
    const page = pids.length === 1 ? pids[0] : 'all';
    throw new ValueError(
      msg(
        `no current render for ${problems.join(', ')}; run popost render --dir ${dir} --page ${page} first`,
        `${problems.join('、')} 没有最新的渲染；请先运行 popost render --dir ${dir} --page ${page}`,
      ),
    );
  }
  const pictures: SheetPicture[] = [];
  for (const pid of pids) {
    const path = paths.get(pid)!;
    pictures.push(picture(pid, relPosix(rt, project.root, path), await rt.fs.readFile(path)));
  }
  return pictures;
};

/** The project's layout references (`reference --role layout`), in the order they were added: `ref 1`, `ref 2`… */
const layoutReferences = async (project: Project, dir: string): Promise<SheetPicture[]> => {
  const { rt } = project;
  const paths = project.manifest.sources
    .filter((source) => source.kind === 'local-reference' && source.role === 'layout' && typeof source.path === 'string')
    .map((source) => String(source.path));
  if (!paths.length)
    throw new ValueError(
      msg(
        `the project has no layout references to compare with; add them with popost reference --dir ${dir} --file … --role layout`,
        `项目没有可对照的 layout 参考图；用 popost reference --dir ${dir} --file … --role layout 添加`,
      ),
    );
  const pictures: SheetPicture[] = [];
  for (const [index, path] of paths.entries()) {
    if (!(await isFile(rt, project.abs(path)))) throw new ValueError(msg(`reference file is missing: ${path}`, `参考图文件缺失：${path}`));
    pictures.push(picture(`ref ${index + 1}`, path, await rt.fs.readFile(project.abs(path))));
  }
  return pictures;
};

/** `--files`: any pictures, labelled with `--labels` or their file names. */
const fileBands = async (args: ParsedArgs, rt: Runtime): Promise<SheetPicture[][]> => {
  const files = args.list('files');
  const labels = labelList(args);
  const pictures: SheetPicture[] = [];
  for (const [index, file] of files.entries())
    pictures.push(picture(labels?.[index] ?? rt.path.basename(file), file, await readUserBytes(rt, file)));
  return [pictures];
};

const projectBands = async (project: Project, args: ParsedArgs): Promise<SheetPicture[][]> => {
  const dir = args.req('dir');
  const pids = selectedPages(project, args.string('page') ?? 'all');
  if (!pids.length) throw new ValueError(msg('the project has no pages to show', '项目没有可展示的页面'));
  const pages = await renderedPages(project, pids, dir);
  return args.flag('compare') ? [await layoutReferences(project, dir), pages] : [pages];
};

const sheet = (): Subcommand => ({
  spec: {
    description: msg(
      'one JPEG overview of the rendered pages (--dir P, with --compare the layout references above them) or of any pictures (--files …)',
      '把渲染好的页面（--dir P，加 --compare 时上方是 layout 参考图）或任意图片（--files …）拼成一张 JPEG 总览图',
    ),
    options: [
      { flag: '--dir', help: msg('project whose exports/<page>.png renders are shown', '要展示其 exports/<page>.png 渲染图的项目') },
      { flag: '--page', help: msg('all (default) or a comma list such as p1,p3', 'all（默认）或逗号分隔的列表，如 p1,p3') },
      {
        flag: '--compare',
        kind: 'flag',
        help: msg('row 1: the layout references (ref 1, ref 2…); row 2: the rendered pages', '第 1 行：layout 参考图（ref 1、ref 2…）；第 2 行：渲染好的页面'),
      },
      { flag: '--files', kind: 'list', help: msg('pictures to put on the sheet instead of a project', '不用项目时，要放进总览图的图片') },
      {
        flag: '--labels',
        help: msg('comma list, one label per --files picture (default: the file names)', '逗号分隔，每张 --files 图片一个标签（默认用文件名）'),
      },
      {
        flag: '--out',
        help: msg('JPEG to write (default <dir>/exports/sheet.jpg; required with --files)', '要写入的 JPEG（默认 <dir>/exports/sheet.jpg；用 --files 时必填）'),
      },
    ],
  },
  run: async (args, rt) => {
    const problem = optionProblem(args);
    if (problem) return fail(rt, problem);
    const project = args.has('dir') ? await Project.load(rt, args.req('dir')) : null;
    try {
      const bands = project ? await projectBands(project, args) : await fileBands(args, rt);
      const layout = layoutSheet(bands);
      const jpeg = await renderSheet(rt, layout);
      const out = args.string('out');
      const target = out ? rt.path.resolve(rt.cwd, out) : rt.path.join(project!.exportsDir, 'sheet.jpg');
      await writeAtomic(rt, target, jpeg);
      printJson(rt, {
        ok: true,
        path: out ?? target,
        width: layout.width,
        height: layout.height,
        bytes: jpeg.byteLength,
        tiles: layout.tiles.map(({ label, source }) => ({ label, source })),
      });
      return 0;
    } catch (error) {
      return fail(rt, isExpectedFailure(error) ? failureText(error) : errorText(error));
    }
  },
});

export const main: CommandMain = (argv, rt) => runSubcommand('popost', { sheet: sheet() }, argv, rt);
