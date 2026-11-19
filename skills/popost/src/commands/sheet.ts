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

const picture = (label: string, source: string, bytes: Uint8Array): SheetPicture => {
  const info = sniffImage(bytes, source);
  return { label, source, width: info.width, height: info.height, mime: info.mime, data: bytes };
};

const labelList = (args: ParsedArgs): string[] | null =>
  args.has('labels') ? args.req('labels').split(',').map((label) => label.trim()) : null;

/** Why the options do not add up, or `null`. Checked before any project is loaded or any file is read. */
const optionProblem = (args: ParsedArgs): string | null => {
  const files = args.has('files');
  if (files && args.has('dir')) return 'use --dir (the rendered pages of a project) or --files, not both';
  if (!files && !args.has('dir')) return 'give --dir P (the rendered pages of a project) or --files a.png b.png … --out sheet.jpg';
  const out = args.string('out');
  if (out !== undefined && !/\.jpe?g$/i.test(out)) return '--out must end in .jpg or .jpeg: the sheet is a JPEG';
  if (files) {
    if (args.has('page') || args.flag('compare')) return '--page and --compare only go with --dir';
    if (out === undefined) return '--files needs --out (where to write the sheet)';
    const labels = labelList(args);
    if (labels && labels.length !== args.list('files').length)
      return `--labels has ${labels.length} labels for ${args.list('files').length} files`;
    return null;
  }
  return args.has('labels') ? '--labels only goes with --files' : null;
};

/** The pages the sheet shows, in the project's page order (`--page` only filters). */
const selectedPages = (project: Project, spec: string): string[] => {
  const all = project.manifest.pages.map((page) => page.id);
  if (spec === 'all') return all;
  const wanted = spec.split(',').map((id) => id.trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !all.includes(id));
  if (unknown.length) throw new ValueError(`unknown page: ${unknown.join(', ')} (the project has ${all.join(', ')})`);
  return all.filter((id) => wanted.includes(id));
};

/** The current render of each page (`render` leaves `exports/<page>.png` and its receipt), or an error that says what to run. */
const renderedPages = async (project: Project, pids: readonly string[], dir: string): Promise<SheetPicture[]> => {
  const { rt } = project;
  const paths = new Map<string, string>();
  const problems: string[] = [];
  for (const pid of pids) {
    const png = rt.path.join(project.exportsDir, `${pid}.png`);
    if (!(await isFile(rt, png))) problems.push(`${pid} (not rendered)`);
    else if (await cachedPng(project, pid)) paths.set(pid, png);
    else problems.push(`${pid} (changed since it was rendered)`);
  }
  if (problems.length) {
    const page = pids.length === 1 ? pids[0] : 'all';
    throw new ValueError(`no current render for ${problems.join(', ')}; run popost render --dir ${dir} --page ${page} first`);
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
    throw new ValueError(`the project has no layout references to compare with; add them with popost reference --dir ${dir} --file … --role layout`);
  const pictures: SheetPicture[] = [];
  for (const [index, path] of paths.entries()) {
    if (!(await isFile(rt, project.abs(path)))) throw new ValueError(`reference file is missing: ${path}`);
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
  if (!pids.length) throw new ValueError('the project has no pages to show');
  const pages = await renderedPages(project, pids, dir);
  return args.flag('compare') ? [await layoutReferences(project, dir), pages] : [pages];
};

const sheet: Subcommand = {
  spec: {
    description:
      'one JPEG overview of the rendered pages (--dir P, with --compare the layout references above them) or of any pictures (--files …)',
    options: [
      { flag: '--dir', help: 'project whose exports/<page>.png renders are shown' },
      { flag: '--page', help: 'all (default) or a comma list such as p1,p3' },
      { flag: '--compare', kind: 'flag', help: 'row 1: the layout references (ref 1, ref 2…); row 2: the rendered pages' },
      { flag: '--files', kind: 'list', help: 'pictures to put on the sheet instead of a project' },
      { flag: '--labels', help: 'comma list, one label per --files picture (default: the file names)' },
      { flag: '--out', help: 'JPEG to write (default <dir>/exports/sheet.jpg; required with --files)' },
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
};

export const main: CommandMain = (argv, rt) => runSubcommand('popost', { sheet }, argv, rt);
