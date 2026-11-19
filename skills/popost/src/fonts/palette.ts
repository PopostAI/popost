/**
 * The font library manifest (`assets/fonts/palette.json`): the one list every font menu, install and licence check is
 * built from. The npm package ships the manifest, the per-role CSS and LICENSE files; the `.woff2` files are found next to
 * it when the Skill comes from a checkout, and downloaded otherwise (`source.ts`).
 */
import type { Runtime } from '../runtime';
import { isFile, sha256 } from '../core/util';

export interface FontRole {
  id: string;
  label: string;
  family: string;
  cssPath: string;
  licensePath: string;
  fileCount: number;
  totalBytes: number;
  package: string;
  packageVersion: string;
  license: { spdx: string; path: string; sha256: string; [key: string]: unknown };
  /** `.woff2` file name -> sha256. */
  assetSha256: Record<string, string>;
  [key: string]: unknown;
}

export interface Palette {
  version: string;
  roles: FontRole[];
  [key: string]: unknown;
}

export interface FontLibrary {
  readonly palette: Palette;
  /** First 12 hex chars of sha256(palette.json): the version segment of the public font bucket. */
  readonly digest: string;
  /** `<skillRoot>/assets/fonts`. */
  readonly dir: string;
}

export class FontError extends Error {
  override name = 'FontError';
}

/** An unknown role id: a caller mistake (HTTP 400), named like the Python `ValueError`. */
export class UnknownRoleError extends FontError {
  override name = 'ValueError';
}

export const loadLibrary = async (rt: Runtime): Promise<FontLibrary> => {
  const dir = rt.path.join(rt.skillRoot, 'assets', 'fonts');
  const file = rt.path.join(dir, 'palette.json');
  if (!(await isFile(rt, file))) throw new FontError(`font palette not found: ${file}`);
  const bytes = await rt.fs.readFile(file);
  const palette = JSON.parse(new TextDecoder().decode(bytes)) as Palette;
  if (!Array.isArray(palette.roles)) throw new FontError(`font palette is malformed: ${file}`);
  return { palette, digest: sha256(bytes).slice(0, 12), dir };
};

export const listRoles = async (rt: Runtime): Promise<FontRole[]> => (await loadLibrary(rt)).palette.roles;
