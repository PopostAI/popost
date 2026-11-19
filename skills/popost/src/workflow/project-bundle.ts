/**
 * Portable editable project ZIP (port of `project_bundle.py`). No credentials, generator history or absolute paths.
 * `exportProject` ships an explicit allowlist: the manifest, the pages and what they link to, the licenses of those
 * fonts, plus the editor build and the licensed font bank when this installation has them. `importProject` validates
 * the archive first, then unpacks it into a directory that did not exist.
 */
import { unzipSync, zipSync, type ZipOptions, type Zippable } from 'fflate';
import { Project, MANIFEST_NAME } from '../core/project';
import { pyUnquote } from '../core/pyjson';
import { isFile, isInside, relPosix, sha256, walkFiles, writeAtomic } from '../core/util';
import type { Runtime } from '../runtime';
import { ValueError } from './errors';
import { fromCwd } from './io';
import { assertSafeArchive, MAX_EXPANDED } from './zip-inspect';

const FONT_EXTENSIONS = new Set(['.woff2', '.woff', '.ttf', '.otf']);
const INTERNAL = ['reference/', 'production/'];
const OPEN_TXT = [
  'This is an editable Popost project.',
  '',
  'To keep editing it, install Node.js 20.19 or newer, then run in a terminal:',
  '  npx popost unpack --file <this-zip-file> --dir <new-project-directory>',
  '  npx popost present --dir <new-project-directory>',
  '',
  'Agents: add --host codex (or the name of your host) to `present` and open the returned URL in a side panel.',
  'The project is plain files: pages/*.html are the layout, assets/ holds the images.',
  'PNG export needs a local Chrome or Chromium (see `npx popost doctor --dir <new-project-directory>`).',
  '',
].join('\n');

const links = (text: string): string[] => [
  ...[...text.matchAll(/(?:src|href)=['"]([^'"]+)/gi)].map((m) => m[1]!),
  ...[...text.matchAll(/url\(\s*['"]?([^)'"]+)/gi)].map((m) => m[1]!),
];

/** Local files a page or stylesheet pulls in; anything external, missing or outside the project is an error. */
const resolveLink = async (rt: Runtime, root: string, source: string, raw: string): Promise<string | null> => {
  const link = raw.trim();
  if (link.startsWith('data:') || link.startsWith('#')) return null;
  if (link.includes('://') || link.startsWith('//')) throw new ValueError(`external dependency in project: ${link}`);
  const target = pyUnquote(link.split('?')[0]!.split('#')[0]!);
  const resource = rt.path.resolve(rt.path.dirname(source), target);
  if (!isInside(rt, root, resource) || !(await isFile(rt, resource)))
    throw new ValueError(`missing or external local dependency: ${link}`);
  return resource;
};

/** Project-relative path → absolute file, for everything the pages reach (depth first, like the Python walk). */
const collectEntries = async (project: Project): Promise<Map<string, string>> => {
  const { rt, root } = project;
  const entries = new Map<string, string>([[MANIFEST_NAME, project.manifestPath]]);
  for (const page of project.manifest.pages) {
    const path = rt.path.resolve(project.pageHtmlPath(page.id));
    if (!isInside(rt, root, path)) throw new ValueError('page outside project');
    entries.set(page.htmlPath, path);
  }
  const pending = [...entries].filter(([rel]) => rel.endsWith('.html')).map(([, path]) => path);
  const visited = new Set<string>();
  for (let source = pending.pop(); source !== undefined; source = pending.pop()) {
    if (visited.has(source)) continue;
    visited.add(source);
    for (const raw of links(await rt.fs.readText(source))) {
      const resource = await resolveLink(rt, root, source, raw);
      if (!resource) continue;
      const rel = relPosix(rt, root, resource);
      if (INTERNAL.some((prefix) => rel.startsWith(prefix)))
        throw new ValueError(
          `${relPosix(rt, root, source)} uses ${rel}, a working file that does not ship (${INTERNAL.join(' and ')} stay out of the package): copy the picture into assets/, point the page at the copy, then package again`,
        );
      entries.set(rel, resource);
      if (['.css', '.html'].includes(rt.path.extname(resource))) pending.push(resource);
    }
  }
  return entries;
};

/** The license files next to every font file the project ships. */
const addLicenses = async (project: Project, entries: Map<string, string>): Promise<void> => {
  const { rt, root } = project;
  for (const file of [...entries.values()].filter((f) => FONT_EXTENSIONS.has(rt.path.extname(f)))) {
    const dir = rt.path.dirname(file);
    for (const name of (await rt.fs.readdir(dir)).filter((n) => n.includes('LICENSE'))) {
      const license = rt.path.join(dir, name);
      if (await isFile(rt, license)) entries.set(relPosix(rt, root, license), license);
    }
  }
};

/** Only safe metadata travels: no provider settings, plans, reviews or sources, and the concept is closed. */
const portableManifest = (project: Project, shipped: ReadonlySet<string>) => {
  const manifest = JSON.parse(JSON.stringify(project.manifest)) as Record<string, unknown>;
  const assets = Array.isArray(manifest.assets) ? (manifest.assets as { path?: string }[]) : [];
  manifest.assets = assets.filter((asset) => asset.path !== undefined && shipped.has(asset.path));
  manifest.sources = [];
  manifest.concept = { status: 'manual', prompt: null, fixture: null };
  for (const key of ['provider', 'seriesPlan', 'seriesReview', 'templateProfile', 'reviews']) delete manifest[key];
  manifest.delivery = { kind: 'editable-project', reviewStatus: 'draft-after-import' };
  return manifest;
};

/** The editor build and the font bank of this installation, under `runtime/assets/`; only what is present is shipped. */
const runtimeFiles = async (rt: Runtime): Promise<Map<string, string>> => {
  const files = new Map<string, string>();
  const assets = rt.path.join(rt.skillRoot, 'assets');
  const add = (file: string) => files.set(`runtime/assets/${relPosix(rt, assets, file)}`, file);
  for (const file of await walkFiles(rt, rt.path.join(assets, 'canvas'))) add(file);
  const fontRoot = rt.path.join(assets, 'fonts');
  const palette = rt.path.join(fontRoot, 'palette.json');
  if (!(await isFile(rt, palette))) return files;
  add(palette);
  const notice = rt.path.join(fontRoot, 'NOTICE.txt');
  if (await isFile(rt, notice)) add(notice);
  const roles = (JSON.parse(await rt.fs.readText(palette)) as { roles?: { id: string; cssPath: string }[] }).roles ?? [];
  for (const role of roles) {
    const dir = rt.path.join(fontRoot, role.id);
    const present = (await walkFiles(rt, dir)).filter((f) => rt.path.dirname(f) === dir);
    if (!present.some((f) => f.endsWith('.woff2'))) continue; // a role without its font files would only ship dead CSS
    for (const file of [rt.path.join(fontRoot, role.cssPath), ...present])
      if (await isFile(rt, file)) add(file);
  }
  return files;
};

/** Fonts are already compressed: store `.woff2` as it is, deflate everything else. */
const payload = (rt: Runtime, path: string, data: Uint8Array): [Uint8Array, ZipOptions] => [
  data,
  { level: path.endsWith('.woff2') ? 0 : 6, mtime: rt.now() },
];

/** Writes the delivery ZIP (default `exports/project.popost.zip`) and returns its absolute path. */
export const exportProject = async (project: Project, out?: string): Promise<string> => {
  const { rt } = project;
  const target = out ? fromCwd(rt, out) : rt.path.join(project.exportsDir, 'project.popost.zip');
  const entries = await collectEntries(project);
  await addLicenses(project, entries);
  const zippable: Zippable = {};
  const manifest = portableManifest(project, new Set(entries.keys()));
  zippable[MANIFEST_NAME] = payload(rt, MANIFEST_NAME, new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
  for (const [rel, path] of entries) {
    if (rel === MANIFEST_NAME) continue;
    if (!(await isFile(rt, path))) throw new ValueError(`missing resource: ${rel}`);
    zippable[rel] = payload(rt, rel, await rt.fs.readFile(path));
  }
  for (const [rel, path] of await runtimeFiles(rt)) zippable[rel] = payload(rt, rel, await rt.fs.readFile(path));
  zippable['OPEN.txt'] = payload(rt, 'OPEN.txt', new TextEncoder().encode(OPEN_TXT));
  await writeAtomic(rt, target, zipSync(zippable));
  return target;
};

/** After unpacking: every page file exists and every listed asset is inside the project with a matching checksum. */
const verifyUnpacked = async (project: Project): Promise<void> => {
  const { rt, root } = project;
  for (const page of project.manifest.pages)
    if (!(await isFile(rt, project.pageHtmlPath(page.id)))) throw new ValueError(`missing page ${page.id}`);
  for (const asset of project.manifest.assets) {
    const resource = rt.path.resolve(root, asset.path);
    if (!isInside(rt, root, resource) || !(await isFile(rt, resource))) throw new ValueError('missing or unsafe asset');
    if (asset.sha256 && sha256(await rt.fs.readFile(resource)) !== asset.sha256)
      throw new ValueError('asset checksum mismatch');
  }
};

/**
 * Validate the archive, unpack it into a new directory and load it as a project. Names and sizes are checked before
 * anything is written; the project is then loaded and verified in place, and the directory is removed again if that
 * fails (a virtual disk may not support renaming a directory, so there is no staging directory to swap in).
 */
export const importProject = async (rt: Runtime, data: Uint8Array, destination: string): Promise<Project> => {
  const dest = fromCwd(rt, destination);
  if (await rt.fs.stat(dest)) throw new ValueError('destination already exists; choose a new project directory');
  assertSafeArchive(data, MANIFEST_NAME);
  const files = unzipSync(data, { filter: (file) => !file.name.endsWith('/') });
  // The sizes in the directory are the archive's own claim; check what actually came out as well.
  if (Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0) > MAX_EXPANDED) throw new ValueError('project archive too large');
  try {
    for (const [name, bytes] of Object.entries(files)) {
      const path = rt.path.resolve(dest, name);
      if (!isInside(rt, dest, path)) throw new ValueError('unsafe archive path');
      await rt.fs.writeFile(path, bytes);
    }
    const project = await Project.load(rt, dest);
    await verifyUnpacked(project);
    return project;
  } catch (error) {
    await rt.fs.rm(dest);
    throw error;
  }
};
