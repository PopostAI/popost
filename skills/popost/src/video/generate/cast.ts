import type { Runtime } from '../../runtime';
import { sha256 } from '../../core/util';
import { sniffImageMime } from '../../providers/api';

export interface CastRole {
  id: string;
  description: string;
  identity?: 'new' | 'user' | 'reference';
  /** Required only when the user explicitly requests the reference person's identity. */
  permission?: string;
  /** A layout/presenter instruction alone never selects the reference person's face. */
  referenceSelection?: 'same-person';
  image?: string;
  sha256?: string;
  provenance?: string;
  /** Shot ids when one generated file contains several shots of this role. */
  shots?: string[];
}
export interface CastManifest { version: 1; roles: CastRole[] }
export const CAST_FILE = 'cast.json';
export const personPrompt = /\b(?:person|people|woman|women|man|men|presenter|speaker|host|actor|actress|talking|speaking)\b|人物|出镜|口播|说话|主持人|男性|女性/i;
const inside = (rt: Runtime, dir: string, file: string): string => {
  const p = rt.path.resolve(dir, file), rel = rt.path.relative(rt.path.resolve(dir), p);
  if (rt.path.isAbsolute(file) || !rel || rel.startsWith('..')) throw new Error('Cast images must be files inside the project assets directory.');
  return p;
};
export const castPrompt = (role: CastRole): string =>
  'Create a single clean photographic character identity reference, full body and a clearly readable face, neutral lighting and plain background. ' + role.description +
  (role.identity === 'reference' ? ' Keep only the identity the user explicitly requested.' : role.identity === 'user' ? ' Preserve the user-supplied character.' :
    ' Invent a distinct fictional individual with their own facial geometry and features. The description specifies an archetype, never the identity of a reference creator. Do not reproduce a real reference person.') +
  ' No text, watermark, collage, or additional person. Keep this identity and wardrobe for all subsequent shots.';

export const readCast = async (rt: Runtime, dir: string): Promise<CastManifest> => {
  const raw: unknown = JSON.parse(await rt.fs.readText(rt.path.join(dir, CAST_FILE)));
  if (!raw || typeof raw !== 'object' || !('roles' in raw) || !Array.isArray(raw.roles)) throw new Error('cast.json needs {"version":1,"roles":[{"id":"host","description":"...","identity":"new"}]}.');
  const roles = raw.roles as CastRole[], ids = new Set<string>();
  for (const r of roles) {
    if (!/^[a-zA-Z0-9_-]+$/.test(r.id) || ids.has(r.id) || typeof r.description !== 'string' || !r.description.trim()) throw new Error('Every cast role needs a unique id and a visual description.');
    ids.add(r.id);
    if (r.identity && !['new','user','reference'].includes(r.identity)) throw new Error('Cast identity is new (default), user, or reference.');
    if (r.identity === 'reference' && (r.referenceSelection !== 'same-person' || !r.permission?.trim())) throw new Error('Keeping a reference identity requires an explicit instruction to use that same person: set referenceSelection to "same-person" and quote the actual identity instruction in permission. Keeping a presenter, avatar window, placement, wardrobe style or mood is not identity selection; use identity "new" with different facial features. Legacy permission text alone is insufficient.');
    if (r.identity !== 'reference' && r.referenceSelection !== undefined) throw new Error('referenceSelection belongs only to identity "reference". Remove it for a new or user-supplied character.');
  }
  return { version: 1, roles };
};

export const castImages = async (rt: Runtime, dir: string, ids: string[], uses: ReadonlyMap<string, number> = new Map()): Promise<{ images: string[]; instruction: string }> => {
  const cast = await readCast(rt, dir), images: string[] = [], lines: string[] = [];
  for (const id of ids) {
    const role = cast.roles.find(r => r.id === id);
    if (!role) throw new Error('No cast role named "' + id + '". Define its archetype in cast.json.');
    const recurring = uses.has(id) ? (uses.get(id) ?? 0) > 1 : (role.shots?.length ?? 0) > 1;
    if (!role.image && !recurring && (!role.identity || role.identity === 'new')) {
      lines.push(id + ': create one distinct fictional person described as ' + role.description + '. Match only the requested archetype and mood, with original facial proportions and features. No reference identity is being supplied. Keep this one person consistent throughout this generated clip.');
      continue;
    }
    if (!role.image || !role.sha256 || !role.provenance) throw new Error('Recurring or user-selected cast role "' + id + '" has no completed identity image. Run video cast prepare, generate/import the real image, then video cast complete.');
    const bytes = await rt.fs.readFile(inside(rt, dir, role.image));
    if (sha256(bytes) !== role.sha256) throw new Error('Cast image for "' + id + '" changed. Complete the new image before generating clips.');
    images.push(role.image); lines.push(id + ': ' + role.description);
  }
  return { images, instruction: (images.length ? 'The final ' + images.length + ' reference image(s) are the locked cast. ' : 'This is a single-appearance cast, defined directly for video generation. ') + lines.join('; ') + '. Preserve the described identity, face, build, hair and wardrobe. Do not introduce a reference creator or a different actor.' };
};

export const completeCast = async (rt: Runtime, dir: string, id: string, from: string, provenance: string): Promise<CastRole> => {
  const cast = await readCast(rt, dir), role = cast.roles.find(r => r.id === id);
  if (!role) throw new Error('No cast role named "' + id + '".');
  if (!provenance.trim()) throw new Error('Name the actual image tool or user-supplied material in --tool.');
  const ext = rt.path.extname(from).toLowerCase();
  if (!['.png','.jpg','.jpeg','.webp'].includes(ext)) throw new Error('Import a real PNG, JPEG or WebP identity image.');
  const bytes = await rt.fs.readFile(from);
  if (!sniffImageMime(bytes.subarray(0,16))) throw new Error('The identity file is not a real PNG, JPEG or WebP image.');
  const file = 'assets/cast/' + id + ext;
  await rt.fs.writeFile(inside(rt, dir, file), bytes);
  Object.assign(role, { identity: role.identity ?? 'new', image: file, sha256: sha256(bytes), provenance });
  await rt.fs.writeFile(rt.path.join(dir, CAST_FILE), JSON.stringify(cast, null, 2));
  return role;
};
