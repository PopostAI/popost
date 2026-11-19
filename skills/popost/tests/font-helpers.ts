/** A small font library built from nothing (no real font files), for the tests of `font install` and `setup`. */
import { sha256 } from '../src/core/util';
import { SKILL_ROOT, type TestRuntime } from '../src/testing/memory';

const encoder = new TextEncoder();
const FONTS = `${SKILL_ROOT}/assets/fonts`;

export interface DemoRole {
  readonly id: string;
  readonly files: Record<string, Uint8Array>;
  readonly license: string;
}

export const demoRole = (id: string, count = 2): DemoRole => ({
  id,
  license: `SIL OPEN FONT LICENSE Version 1.1 (${id})`,
  files: Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`${id}-${i}.woff2`, encoder.encode(`wOF2 ${id} file ${i}`)]),
  ),
});

const paletteOf = (roles: readonly DemoRole[]) => ({
  version: '2.0.0',
  source: 'test',
  roles: roles.map((role) => ({
    id: role.id,
    label: `Label ${role.id}`,
    family: `Family ${role.id}`,
    cssPath: `css/${role.id}.css`,
    licensePath: `${role.id}/LICENSE`,
    fileCount: Object.keys(role.files).length,
    totalBytes: Object.values(role.files).reduce((sum, data) => sum + data.byteLength, 0),
    package: `@fontsource/${role.id}`,
    packageVersion: '1.0.0',
    license: { spdx: 'OFL-1.1', path: `${role.id}/LICENSE`, sha256: sha256(role.license) },
    assetSha256: Object.fromEntries(Object.entries(role.files).map(([name, data]) => [name, sha256(data)])),
  })),
});

const cssOf = (role: DemoRole): string =>
  Object.keys(role.files)
    .map((name) => `@font-face { font-family: 'Family ${role.id}'; src: url('../${role.id}/${name}') format('woff2'); }`)
    .join('\n');

/** Palette, CSS and licences always ship with the package; the font files only when `withFiles`. */
export const mountLibrary = async (rt: TestRuntime, roles: readonly DemoRole[], withFiles: boolean): Promise<string> => {
  const palette = JSON.stringify(paletteOf(roles), null, 2);
  await rt.fs.writeFile(`${FONTS}/palette.json`, palette);
  for (const role of roles) {
    await rt.fs.writeFile(`${FONTS}/css/${role.id}.css`, cssOf(role));
    await rt.fs.writeFile(`${FONTS}/${role.id}/LICENSE`, role.license);
    if (withFiles) for (const [name, data] of Object.entries(role.files)) await rt.fs.writeFile(`${FONTS}/${role.id}/${name}`, data);
  }
  return sha256(palette).slice(0, 12);
};

