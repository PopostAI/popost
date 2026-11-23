/**
 * What a plan may use: the footage and the pictures of a directory, each with what a model needs to choose it (its
 * length, its size, and a note about what it shows). Notes come from "materials.json" in that directory, an object
 * from path to note, written by a person or by whatever produced the files.
 */
import type { Runtime } from '../../runtime';
import { probe } from '../media/ffmpeg';

export interface PlanMaterial {
  /** Path relative to the directory, with forward slashes: what a fill writes. */
  file: string;
  kind: 'footage' | 'picture';
  seconds?: number;
  frames?: number;
  fps?: number;
  width?: number;
  height?: number;
  note?: string;
}

const VIDEOS = ['.mp4', '.mov', '.webm', '.m4v'];
const PICTURES = ['.png', '.jpg', '.jpeg', '.webp'];
export const NOTES_FILE = 'materials.json';

const walk = async (rt: Runtime, root: string, rel: string, depth: number): Promise<string[]> => {
  const names = await rt.fs.readdir(rt.path.join(root, rel)).catch(() => [] as string[]);
  const out: string[] = [];
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith('.')) continue;
    const next = rel ? rel + '/' + name : name;
    if ((await rt.fs.stat(rt.path.join(root, next)))?.isDirectory) { if (depth > 0) out.push(...(await walk(rt, root, next, depth - 1))); } else out.push(next);
  }
  return out;
};

/** The materials of dir (three levels deep), in path order. A video that cannot be read is listed without a length. */
export const listMaterials = async (rt: Runtime, dir: string): Promise<PlanMaterial[]> => {
  const notes = await rt.fs.readText(rt.path.join(dir, NOTES_FILE)).then((t) => JSON.parse(t) as Record<string, unknown>, () => ({} as Record<string, unknown>));
  const out: PlanMaterial[] = [];
  for (const file of await walk(rt, dir, '', 3)) {
    const ext = rt.path.extname(file).toLowerCase();
    const note = typeof notes[file] === 'string' ? { note: notes[file] } : {};
    if (PICTURES.includes(ext)) out.push({ file, kind: 'picture', ...note });
    if (!VIDEOS.includes(ext)) continue;
    const p = await probe(rt, rt.path.join(dir, file)).catch(() => undefined);
    out.push({ file, kind: 'footage', ...(p ? { seconds: Math.round((p.frames / p.fps) * 100) / 100, frames: p.frames, fps: Math.round(p.fps * 1000) / 1000, width: p.width, height: p.height } : {}), ...note });
  }
  return out;
};

/** One line per material, as the prompt shows them. */
export const materialLines = (materials: PlanMaterial[]): string[] =>
  materials.map((m) => '- ' + m.file + ': ' + m.kind +
    (m.seconds !== undefined ? ', ' + m.seconds + ' s (' + m.frames + ' frames at ' + m.fps + ' fps; "in" counts these frames)' : '') +
    (m.width && m.height ? ', ' + m.width + 'x' + m.height : '') + (m.note ? '. Shows: ' + m.note : ''));
