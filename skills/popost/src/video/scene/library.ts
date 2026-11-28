/**
 * Script files a scene may load: an animation library, or a helper of the Skill. A scene is a page of the project and
 * may load a script file of the project; this puts such a file there. The engine itself knows no library: it pauses
 * and seeks whatever timeline a scene hands over and calls a scene's render(seconds) (page/scene.ts). A file comes
 * from what is installed with the Skill, never from the network, and keeps its own licence: the copy in a project is
 * the unchanged file.
 */
import type { Runtime } from '../../runtime';

/** Where a library's file comes from: an npm package installed with the Skill, or a file of the Skill itself. */
export type LibrarySource = { readonly package: string; readonly source: string } | { readonly skillFile: string };

export interface SceneLibrary {
  readonly from: LibrarySource;
  /** Where it goes in a project, and how a scene (a file in scenes/) names it. */
  readonly file: string;
  readonly tag: string;
  /** How a scene uses it. */
  readonly use: string;
  readonly licence: string;
}

export const LIBRARIES: Readonly<Record<string, SceneLibrary>> = {
  gsap: {
    from: { package: 'gsap', source: 'dist/gsap.min.js' },
    file: 'lib/gsap.min.js',
    tag: '<script src="../lib/gsap.min.js"></script>',
    use: 'var tl = gsap.timeline({ paused: true }); /* tl.from(...), tl.to(...) */ window.__timelines = { main: tl };',
    licence: 'GSAP is a product of Webflow, used under the GSAP Standard License (https://gsap.com/standard-license). It is free to use, it is not open source, and its notices must stay in the file.',
  },
  screen: {
    from: { skillFile: 'assets/video/screen.js' },
    file: 'lib/popost-screen.js',
    tag: '<script src="../lib/popost-screen.js"></script>',
    use: "popostScreen('#window', { still: '../assets/page-01.png', scale: 1, top: 0, steps: [{ at: 0.3, zoom: [x, y, w, h], fill: 0.5 }, { at: 1.2, highlight: [x, y, w, h] }, { at: 1.5, pointer: [x, y, w, h] }, { at: 2.2, click: true }] });  // boxes as --outline prints them; scale and top as --still printed them (stillScale, y)",
    licence: 'Part of the popost Skill (CLIPCAT AI LTD), under the Skill\'s licence.',
  },
  motion: {
    from: { skillFile: 'assets/video/motion.js' },
    file: 'lib/popost-motion.js',
    tag: '<script src="../lib/popost-motion.js"></script>',
    use: "var M = popostMotion; M.bounce('#ball', { at: 0.2, for: 1.6, from: [640, 120], floor: 560, bounces: 3, trail: 4, shadow: true }); M.slam('#title', { at: 1.9 });  // times in seconds of the shot; every effect is a function of the time and adds its sound cues to window.__popostScene.cues (references/video-motion.md)",
    licence: 'Part of the popost Skill (CLIPCAT AI LTD), under the Skill\'s licence.',
  },
};

export class LibraryError extends Error {
  override name = 'LibraryError';
}

/** Where an installed package may sit, seen from the Skill's directory: its own dependencies, a workspace root, or beside it. */
const roots = (rt: Runtime, name: string): string[] => [
  rt.path.join(rt.skillRoot, 'node_modules', name),
  rt.path.join(rt.skillRoot, '..', '..', 'node_modules', name),
  rt.path.join(rt.skillRoot, '..', name),
];

const versionIn = (rt: Runtime, dir: string): Promise<string> =>
  rt.fs.readText(rt.path.join(dir, 'package.json')).then((t) => String((JSON.parse(t) as { version?: unknown }).version ?? 'unknown'), () => 'unknown');

/** The file to copy and the version it belongs to; undefined when it is not installed. */
const located = async (rt: Runtime, from: LibrarySource): Promise<{ path: string; version: string } | undefined> => {
  if ('skillFile' in from) {
    const path = rt.path.join(rt.skillRoot, from.skillFile);
    return (await rt.fs.stat(path)) === null ? undefined : { path, version: await versionIn(rt, rt.skillRoot) };
  }
  for (const root of roots(rt, from.package)) {
    const path = rt.path.join(root, from.source);
    if ((await rt.fs.stat(path)) !== null) return { path, version: await versionIn(rt, root) };
  }
  return undefined;
};

export interface AddedLibrary { name: string; version: string; file: string; bytes: number; tag: string; use: string; licence: string }

/** Copies a library's file into the project (dir: absolute). The same bytes as the installed file. */
export const addLibrary = async (rt: Runtime, dir: string, name: string): Promise<AddedLibrary> => {
  const lib = LIBRARIES[name];
  if (!lib) throw new LibraryError('There is no library named "' + name + '". Known: ' + Object.keys(LIBRARIES).join(', ') + '.');
  const found = await located(rt, lib.from);
  if (!found) {
    const what = 'skillFile' in lib.from ? 'The file ' + lib.from.skillFile + ' of the popost Skill is missing' : 'The package "' + lib.from.package + '" is not installed beside the popost Skill';
    throw new LibraryError(what + ', so it cannot be copied. Reinstall popost (npm install -g popost), or write the scene with CSS animations, which need no library.');
  }
  const bytes = await rt.fs.readFile(found.path);
  await rt.fs.writeFile(rt.path.join(dir, lib.file), bytes);
  return { name, version: found.version, file: lib.file, bytes: bytes.length, tag: lib.tag, use: lib.use, licence: lib.licence };
};

/** The library a missing script file of a scene belongs to, by the name of the file. */
export const libraryOfFile = (src: string): string | undefined =>
  Object.keys(LIBRARIES).find((name) => src.split(/[?#]/)[0]?.endsWith('/' + (LIBRARIES[name]?.file.split('/').pop() ?? '')) || src === LIBRARIES[name]?.file.split('/').pop());
