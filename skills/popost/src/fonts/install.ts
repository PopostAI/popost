/**
 * Install font roles into a project directory (port of `font_palette.install_project`): the role's WOFF2 files and
 * licence go to `fonts/<role>/`, its CSS to `css/<role>.css`, all installed roles are merged in `fonts-manifest.json` and
 * aggregated in `css/chosen.css`. Re-installing a role replaces it; other roles stay.
 */
import { isFile, readJson, writeAtomic, writeJson } from '../core/util';
import { msg } from '../i18n';
import type { Runtime } from '../runtime';
import { FontError, loadLibrary, UnknownRoleError, type FontLibrary, type FontRole } from './palette';
import { mapLimit, readFontAsset } from './source';

export interface InstalledRole {
  id: string;
  family: string;
  cssPath: string;
  licensePath: string;
  fileCount: number;
  totalBytes: number;
  label: string;
  license: Record<string, unknown>;
  package: string;
  packageVersion: string;
}

export interface InstallResult {
  installed: InstalledRole[];
  manifestPath: string;
  cssAggregatePath: string;
  totalBytes: number;
  totalInstalled: number;
}

const DOWNLOADS_AT_ONCE = 6;

/** Copy one role's files into the project; throws when the files do not add up to what the palette promises. */
const installFiles = async (rt: Runtime, lib: FontLibrary, role: FontRole, project: string): Promise<void> => {
  const names = Object.keys(role.assetSha256);
  const target = rt.path.join(project, 'fonts', role.id);
  await rt.fs.rm(target);
  await rt.fs.mkdir(target);
  const sizes = await mapLimit(names, DOWNLOADS_AT_ONCE, async (name) => {
    const data = await readFontAsset(rt, lib, `${role.id}/${name}`, role.assetSha256[name]);
    await rt.fs.writeFile(rt.path.join(target, name), data);
    return data.byteLength;
  });
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (names.length !== role.fileCount || total !== role.totalBytes)
    throw new FontError(msg(`font role ${role.id} is incomplete: ${names.length} files, ${total} bytes`, `字体角色 ${role.id} 不完整：${names.length} 个文件，${total} 字节`));
  const license = await readFontAsset(rt, lib, `${role.id}/LICENSE`, role.license.sha256);
  await rt.fs.writeFile(rt.path.join(target, 'LICENSE'), license);
  const css = new TextDecoder().decode(await readFontAsset(rt, lib, role.cssPath));
  await rt.fs.writeFile(
    rt.path.join(project, 'css', `${role.id}.css`),
    css.replaceAll(`../${role.id}/`, `../fonts/${role.id}/`),
  );
};

const entryOf = (role: FontRole): InstalledRole => ({
  id: role.id,
  family: role.family,
  cssPath: `css/${role.id}.css`,
  licensePath: `fonts/${role.id}/LICENSE`,
  fileCount: role.fileCount,
  totalBytes: role.totalBytes,
  label: role.label,
  license: { ...role.license, path: `fonts/${role.id}/LICENSE` },
  package: role.package,
  packageVersion: role.packageVersion,
});

const previousRoles = async (rt: Runtime, manifestPath: string): Promise<Map<string, InstalledRole>> => {
  const previous = new Map<string, InstalledRole>();
  if (!(await isFile(rt, manifestPath))) return previous;
  try {
    const old = await readJson<{ installed_roles?: InstalledRole[] }>(rt, manifestPath);
    for (const role of old.installed_roles ?? []) previous.set(role.id, role);
  } catch {
    // an unreadable manifest is rebuilt from what is installed now
  }
  return previous;
};

const chosenCss = async (rt: Runtime, project: string, roles: readonly InstalledRole[]): Promise<string> => {
  const parts = ['/* chosen.css — aggregated self-hosted font roles, auto-generated */'];
  for (const role of roles) {
    const css = await rt.fs.readText(rt.path.join(project, 'css', `${role.id}.css`));
    parts.push(`\n/* === ${role.id} · ${role.family} === */`, css.trimEnd());
  }
  return parts.join('\n') + '\n';
};

/** Install the comma-separated role ids into `projectPath` (created when missing). */
export const installProject = async (rt: Runtime, rolesCsv: string, projectPath: string): Promise<InstallResult> => {
  const lib = await loadLibrary(rt);
  const valid = new Map(lib.palette.roles.map((role) => [role.id, role]));
  const requested = rolesCsv.split(',').map((id) => id.trim());
  const unknown = requested.filter((id) => !valid.has(id));
  if (unknown.length)
    throw new UnknownRoleError(
      msg(
        `unknown font roles: ${unknown.join(', ')}; available: ${[...valid.keys()].join(', ')}`,
        `未知的字体角色：${unknown.join(', ')}；可用的有：${[...valid.keys()].join(', ')}`,
      ),
    );

  const project = rt.path.resolve(rt.cwd, projectPath);
  await rt.fs.mkdir(rt.path.join(project, 'fonts'));
  await rt.fs.mkdir(rt.path.join(project, 'css'));
  const manifestPath = rt.path.join(project, 'fonts-manifest.json');
  const all = await previousRoles(rt, manifestPath);
  const installed: InstalledRole[] = [];
  for (const id of requested) {
    const role = valid.get(id)!;
    await installFiles(rt, lib, role, project);
    const entry = entryOf(role);
    all.set(id, entry);
    installed.push(entry);
  }
  const roles = [...all.values()];
  await writeJson(rt, manifestPath, { version: lib.palette.version, installed_roles: roles });
  const cssAggregatePath = rt.path.join(project, 'css', 'chosen.css');
  await writeAtomic(rt, cssAggregatePath, await chosenCss(rt, project, roles));
  return {
    installed,
    manifestPath,
    cssAggregatePath,
    totalBytes: roles.reduce((sum, role) => sum + role.totalBytes, 0),
    totalInstalled: roles.length,
  };
};
