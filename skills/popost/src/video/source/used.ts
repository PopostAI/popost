/**
 * Whether a project uses the pictures its sources gave (collect.ts): a warning of `video check` and `scene check` when
 * <project>/source/ holds collected pictures and no scene, picture or footage of the project shows one of them. A
 * picture counts as used when video.json or a scene names its file (under any directory: a copy in assets/ keeps the
 * name) or when a picture material of the project has the same bytes.
 */
import { sha256 } from '../../core/util';
import type { Runtime } from '../../runtime';
import { warning } from '../project/check-common';
import type { Problem, Project } from '../types';
import { INVENTORY_FILE, type Inventory } from './collect';

export const SOURCE_DIR = 'source';

export const sourcePictureProblems = async (rt: Runtime, root: string, project: Project): Promise<Problem[]> => {
  const dir = rt.path.join(root, SOURCE_DIR);
  const inventory = await rt.fs.readText(rt.path.join(dir, INVENTORY_FILE)).then((t) => JSON.parse(t) as Inventory, () => undefined);
  const pictures = (Array.isArray(inventory?.sources) ? inventory.sources : []).flatMap((s) => (Array.isArray(s.pictures) ? s.pictures : [])).filter((p) => typeof p?.file === 'string');
  if (!pictures.length) return [];
  const scenes = [...new Set(project.segments.flatMap((s) => ('scene' in s.base ? [s.base.scene] : [])))];
  const texts = [JSON.stringify(project), ...(await Promise.all(scenes.map((f) => rt.fs.readText(rt.path.resolve(root, f)).catch(() => ''))))].join('\n');
  const name = (file: string): string => file.split('/').pop() ?? file;
  if (pictures.some((p) => texts.includes(name(p.file)))) return [];
  const hashes = new Set(await Promise.all(project.materials.filter((m) => m.kind === 'image' && m.file).map((m) => rt.fs.readFile(rt.path.resolve(root, m.file ?? '')).then(sha256, () => ''))));
  for (const p of pictures) if (hashes.has(await rt.fs.readFile(rt.path.join(dir, p.file)).then(sha256, () => '-'))) return [];
  const few = pictures.slice(0, 3).map((p) => SOURCE_DIR + '/' + p.file).join(', ');
  return [warning(SOURCE_DIR, 'The sources gave ' + pictures.length + ' picture' + (pictures.length === 1 ? '' : 's') + ' (' + few + (pictures.length > 3 ? ', ...' : '') + ') and no scene, picture or footage of the project uses any of them.',
    'Show the product with its real pictures: a "picture" shot, an "image" item, or an <img> in a scene ("../' + SOURCE_DIR + '/' + (pictures[0]?.file ?? '') + '"). Never draw an imitation of its interface. When recordings of the product\'s own pages show it instead, say so in the delivery notes.')];
};
