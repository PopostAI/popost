import type { Runtime } from '../../runtime';
import { sha256 } from '../../core/util';
import { sniffImageMime } from '../../providers/api';
import { readReplication } from '../replication/io';

export interface CastVisualEvidence {
  kind: 'observed' | 'measured' | 'user' | 'unknown';
  detail: string;
  source?: string;
  file?: string;
  sha256?: string;
  media?: 'frame' | 'audio' | 'video' | 'data';
  frame?: number;
  /** Seconds on the evidence file, consistent with the replication contract. */
  at?: [number, number];
}
export interface CastVisual {
  /** Open vocabulary: live action, cel animation, ink illustration, clay 3D, and other media are all valid. */
  medium?: string;
  style?: string[];
  /** Observed presentation traits, kept separately from a real person's identity. */
  archetype?: { ageFeel?: string; build?: string; wardrobe?: string; presence?: string };
  evidence?: CastVisualEvidence[];
}
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
  /** Omitted in legacy manifests; their photographic reference preparation remains unchanged. */
  visual?: CastVisual;
}
export interface CastManifest { version: 1; roles: CastRole[] }
export const CAST_FILE = 'cast.json';
/** Bound content keeps its identity when a portable copy changes only its local path. */
const evidenceIdentity = (e: CastVisualEvidence, verified: ReadonlySet<string>): string => {
  if (!e.sha256 || !e.file || !verified.has(e.sha256.toLowerCase())) return JSON.stringify(e);
  return JSON.stringify(Object.fromEntries(Object.entries(e).filter(([key]) => key !== 'file').sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, key === 'sha256' ? e.sha256!.toLowerCase() : value])));
};
const uniqueEvidence = (items: CastVisualEvidence[], verified: ReadonlySet<string>): CastVisualEvidence[] => {
  const result = new Map<string, CastVisualEvidence>();
  for (const item of items) { const key = evidenceIdentity(item, verified); if (!result.has(key)) result.set(key, item); }
  return [...result.values()];
};
export const personPrompt = /\b(?:person|people|woman|women|man|men|presenter|speaker|host|actor|actress|talking|speaking)\b|人物|出镜|口播|说话|主持人|男性|女性/i;
const inside = (rt: Runtime, dir: string, file: string): string => {
  const p = rt.path.resolve(dir, file), rel = rt.path.relative(rt.path.resolve(dir), p);
  if (rt.path.isAbsolute(file) || !rel || rel.startsWith('..')) throw new Error('Cast images must be files inside the project assets directory.');
  return p;
};
export const castVisualInstruction = (role: CastRole): string => {
  const v = role.visual;
  if (!v) return '';
  const traits = v.archetype;
  const known = (v.evidence ?? []).filter((e) => e.kind !== 'unknown');
  return (v.medium ? ' Visual medium: ' + v.medium + '.' : ' Keep the evidenced visual medium; do not convert illustration, animation or 3D to photography.') +
    (v.style?.length ? ' Visual style: ' + v.style.join('; ') + '.' : '') +
    (traits ? ' Presentation archetype: ' + [traits.ageFeel && 'age impression: ' + traits.ageFeel, traits.build && 'body proportions: ' + traits.build,
      traits.wardrobe && 'wardrobe category: ' + traits.wardrobe, traits.presence && 'presentation and energy: ' + traits.presence].filter(Boolean).join('; ') + '.' : '') +
    (known.length ? ' Visual evidence: ' + known.map((e) => e.detail).join('; ') + '.' : '') +
    (role.identity === 'user' || role.identity === 'reference' ? ' Preserve the selected character and any explicit user changes.' :
      ' Unless the user requests a change, retain the observed age impression, body proportions, wardrobe category and presentation energy. A new identity changes facial identity, not these traits. Do not invent a younger, older, thinner or heavier archetype.') +
    (v.evidence?.some((e) => e.kind === 'unknown') ? ' Unresolved visual evidence is not a fact; resolve it before claiming a reference match.' : '');
};
export const castPrompt = (role: CastRole): string =>
  (role.visual ? 'Create a single clean character identity reference in the specified visual medium and style, full body and a clearly readable face, on a plain background. ' :
    'Create a single clean photographic character identity reference, full body and a clearly readable face, neutral lighting and plain background. ') + role.description + castVisualInstruction(role) +
  (role.identity === 'reference' ? ' Keep only the identity the user explicitly requested.' : role.identity === 'user' ? ' Preserve the user-supplied character.' :
    ' Invent a distinct fictional individual with their own facial geometry and features. The description specifies an archetype, never the identity of a reference creator. Do not reproduce a real reference person.') +
  ' No text, watermark, collage, or additional ' + (role.visual ? 'character' : 'person') + '. Keep this identity and wardrobe for all subsequent shots.';

const readCastVersion = async (rt: Runtime, dir: string, legacyPaths = false): Promise<CastManifest> => {
  const raw: unknown = JSON.parse(await rt.fs.readText(rt.path.join(dir, CAST_FILE)));
  if (!raw || typeof raw !== 'object' || !('roles' in raw) || !Array.isArray(raw.roles)) throw new Error('cast.json needs {"version":1,"roles":[{"id":"host","description":"...","identity":"new"}]}.');
  const roles = raw.roles as CastRole[], ids = new Set<string>();
  for (const r of roles) {
    if (!/^[a-zA-Z0-9_-]+$/.test(r.id) || ids.has(r.id) || typeof r.description !== 'string' || !r.description.trim()) throw new Error('Every cast role needs a unique id and a visual description.');
    ids.add(r.id);
    if (r.identity && !['new','user','reference'].includes(r.identity)) throw new Error('Cast identity is new (default), user, or reference.');
    if (r.identity === 'reference' && (r.referenceSelection !== 'same-person' || !r.permission?.trim())) throw new Error('Keeping a reference identity requires an explicit instruction to use that same person: set referenceSelection to "same-person" and quote the actual identity instruction in permission. Keeping a presenter, avatar window, placement, wardrobe style or mood is not identity selection; use identity "new" with different facial features. Legacy permission text alone is insufficient.');
    if (r.identity !== 'reference' && r.referenceSelection !== undefined) throw new Error('referenceSelection belongs only to identity "reference". Remove it for a new or user-supplied character.');
    if (r.visual !== undefined) {
      const v = r.visual;
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Cast visual must be an object with optional medium, style, archetype and evidence.');
      if (v.medium !== undefined && (typeof v.medium !== 'string' || !v.medium.trim())) throw new Error('Cast visual.medium must name the observed or requested visual medium.');
      if (v.style !== undefined && (!Array.isArray(v.style) || v.style.some((s) => typeof s !== 'string' || !s.trim()))) throw new Error('Cast visual.style must be a list of nonempty style descriptions.');
      if (v.archetype !== undefined && (!v.archetype || typeof v.archetype !== 'object' || Array.isArray(v.archetype) || Object.entries(v.archetype).some(([k, s]) =>
        !['ageFeel', 'build', 'wardrobe', 'presence'].includes(k) || typeof s !== 'string' || !s.trim()))) throw new Error('Cast visual.archetype supports ageFeel, build, wardrobe and presence, each a nonempty observed or requested description.');
      if (v.evidence !== undefined && (!Array.isArray(v.evidence) || v.evidence.some((e) => !e || typeof e !== 'object' ||
        !['observed', 'measured', 'user', 'unknown'].includes(e.kind) || typeof e.detail !== 'string' || !e.detail.trim() ||
        (e.source !== undefined && (typeof e.source !== 'string' || !e.source.trim())) ||
        (e.file !== undefined && (typeof e.file !== 'string' || !e.file.trim())) ||
        (e.sha256 !== undefined && (typeof e.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(e.sha256))) ||
        (e.media !== undefined && !['frame', 'audio', 'video', 'data'].includes(e.media)) ||
        (e.frame !== undefined && (!Number.isSafeInteger(e.frame) || e.frame < 0)) ||
        (e.at !== undefined && (!Array.isArray(e.at) || e.at.length !== 2 || !e.at.every(Number.isFinite) || e.at[0] < 0 || e.at[1] < e.at[0]))))) throw new Error('Cast visual.evidence needs a kind, detail and optional media source, hash and source-time interval.');
    }
  }
  const replication = await readReplication(rt, dir);
  if (replication.problems.some(p => p.level === 'error')) throw new Error('Invalid replication.json for cast: ' + replication.problems.map(p => p.message).join(' '));
  if (replication.contract) {
    const source = replication.contract.visual;
    const verified = new Set(source.evidence.filter(e => e.file && e.sha256).map(e => e.sha256!.toLowerCase()));
    for (const role of roles) {
      const visual = role.visual;
      role.visual = {
        ...visual,
        medium: visual?.medium ?? source.medium,
        style: visual?.style?.length ? visual.style : [...source.style],
        evidence: uniqueEvidence([...source.evidence.map(e => ({ ...e })), ...(visual?.evidence ?? [])], legacyPaths ? new Set() : verified),
      };
    }
  }
  return { version: 1, roles };
};
export const readCast = (rt: Runtime, dir: string): Promise<CastManifest> => readCastVersion(rt, dir);

export const castImages = async (rt: Runtime, dir: string, ids: string[], uses: ReadonlyMap<string, number> = new Map()): Promise<{ images: string[]; instruction: string; legacyInstructions?: string[] }> => {
  const cast = await readCast(rt, dir);
  const render = async (manifest: CastManifest): Promise<{ images: string[]; instruction: string }> => {
  const images: string[] = [], lines: string[] = [];
  for (const id of ids) {
    const role = manifest.roles.find(r => r.id === id);
    if (!role) throw new Error('No cast role named "' + id + '". Define its archetype in cast.json.');
    const recurring = uses.has(id) ? (uses.get(id) ?? 0) > 1 : (role.shots?.length ?? 0) > 1;
    if (!role.image && !recurring && (!role.identity || role.identity === 'new')) {
      const subject = role.visual ? 'character' : 'person';
      lines.push(id + ': create one distinct fictional ' + subject + ' described as ' + role.description + '. Match only the requested archetype and mood, with original facial proportions and features. No reference identity is being supplied. Keep this one ' + subject + ' consistent throughout this generated clip.' + castVisualInstruction(role));
      continue;
    }
    if (!role.image || !role.sha256 || !role.provenance) throw new Error('Recurring or user-selected cast role "' + id + '" has no completed identity image. Run video cast prepare, generate/import the real image, then video cast complete.');
    const bytes = await rt.fs.readFile(inside(rt, dir, role.image));
    if (sha256(bytes) !== role.sha256) throw new Error('Cast image for "' + id + '" changed. Complete the new image before generating clips.');
    images.push(role.image); lines.push(id + ': ' + role.description + castVisualInstruction(role));
  }
  return { images, instruction: (images.length ? 'The final ' + images.length + ' reference image(s) are the locked cast. ' : 'This is a single-appearance cast, defined directly for video generation. ') + lines.join('; ') + '. Preserve the described identity, face, build, hair and wardrobe. Do not introduce a reference creator or a different actor.' };
  };
  const current = await render(cast);
  const legacy = await readCastVersion(rt, dir, true);
  const alternatives = [legacy];
  const raw = JSON.parse(await rt.fs.readText(rt.path.join(dir, CAST_FILE))) as CastManifest;
  const replication = await readReplication(rt, dir);
  const verified = new Set(replication.contract?.visual.evidence.filter(e => e.file && e.sha256).map(e => e.sha256!.toLowerCase()) ?? []);
  // A stored list can preserve an earlier duplicate count. It is eligible only if it contains the exact same
  // evidence identities as the current verified context, so new source facts cannot be silently dropped.
  const stored: CastManifest = { version: 1, roles: cast.roles.map(role => {
    const prior = raw.roles.find(r => r.id === role.id)?.visual?.evidence;
    const actual = role.visual?.evidence;
    const keys = (items: CastVisualEvidence[]) => [...new Set(items.map(e => evidenceIdentity(e, verified)))].sort();
    return prior && actual && JSON.stringify(keys(prior)) === JSON.stringify(keys(actual))
      ? { ...role, visual: { ...role.visual, evidence: prior } } : role;
  }) };
  alternatives.push(stored);
  const legacyInstructions = [...new Set(await Promise.all(alternatives.map(async m => (await render(m)).instruction)))].filter(s => s !== current.instruction);
  return { ...current, ...(legacyInstructions.length ? { legacyInstructions } : {}) };
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
