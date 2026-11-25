import { parseDocument, DomUtils } from 'htmlparser2';
import type { Runtime } from '../../runtime';
import { sha256 } from '../../core/util';
import { resolveInside } from './files';
import type { PreviewState } from './protocol';

export interface SceneSlot { segment: string; name: string; kind: 'text' | 'image'; value: string }
export interface StudioVersion { id: string; name: string; created: number; hash: string }
export interface StudioComment { id: string; frame: number; text: string; resolved: boolean; created: number }
const object = (v: unknown): Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const sourceHash = (v: unknown): string => sha256(JSON.stringify(v));
const writeAtomic = async (rt: Runtime, file: string, value: unknown): Promise<void> => {
  const temp = file + '.' + rt.randomUUID() + '.tmp';
  await rt.fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n');
  await rt.fs.rename(temp, file);
};
const read = async <T>(rt: Runtime, file: string, fallback: T): Promise<T> => {
  try { return JSON.parse(await rt.fs.readText(file)) as T; } catch { return fallback; }
};
export const sceneSlots = async (rt: Runtime, dir: string, source: unknown): Promise<SceneSlot[]> => {
  const segments = object(source).segments;
  if (!Array.isArray(segments)) return [];
  const result: SceneSlot[] = [];
  for (const raw of segments) {
    const seg = object(raw); const base = object(seg.base);
    if (typeof base.scene !== 'string') continue;
    const file = await resolveInside(rt, dir, base.scene);
    if (!file) continue;
    const content = await rt.fs.readText(file).catch(() => '');
    const slots = DomUtils.findAll((e) => e.attribs['data-slot'] !== undefined, parseDocument(content).children);
    const used = new Set<string>();
    for (const element of slots) {
      const name = element.attribs['data-slot'] ?? '';
      if (!name || used.has(name)) continue;
      used.add(name);
      const value = object(base.slots)[name];
      result.push({ segment: String(seg.id), name, kind: element.name === 'img' ? 'image' : 'text', value: typeof value === 'string' ? value : element.name === 'img' ? element.attribs.src ?? '' : DomUtils.textContent(element) });
    }
  }
  return result;
};
export const studioMetadata = async (rt: Runtime, dir: string, state: PreviewState) => {
  const folder = rt.path.join(dir, '.studio');
  const versions = await read<StudioVersion[]>(rt, rt.path.join(folder, 'versions.json'), []);
  const comments = await read<StudioComment[]>(rt, rt.path.join(folder, 'comments.json'), []);
  return { hash: sourceHash(state.source), slots: await sceneSlots(rt, dir, state.source), versions, comments };
};
export const saveVersion = async (rt: Runtime, dir: string, source: unknown, name: string): Promise<StudioVersion> => {
  const folder = rt.path.join(dir, '.studio');
  const id = rt.randomUUID(); const created = rt.now().getTime();
  const value = { id, created, name: name.trim().slice(0, 100) || 'Version', hash: sourceHash(source) };
  await rt.fs.mkdir(rt.path.join(folder, 'versions'));
  await writeAtomic(rt, rt.path.join(folder, 'versions', id + '.json'), source);
  const versions = await read<StudioVersion[]>(rt, rt.path.join(folder, 'versions.json'), []);
  await writeAtomic(rt, rt.path.join(folder, 'versions.json'), [value, ...versions]);
  return value;
};
export const readVersion = async (rt: Runtime, dir: string, id: string): Promise<unknown> => {
  if (!/^[\w-]{8,80}$/.test(id)) throw new Error('Invalid version ID.');
  return JSON.parse(await rt.fs.readText(rt.path.join(dir, '.studio', 'versions', id + '.json')));
};
export const saveComment = async (rt: Runtime, dir: string, input: Record<string, unknown>, frames: number): Promise<void> => {
  const folder = rt.path.join(dir, '.studio'); await rt.fs.mkdir(folder);
  const comments = await read<StudioComment[]>(rt, rt.path.join(folder, 'comments.json'), []);
  if (typeof input.id === 'string') {
    const found = comments.some((x) => x.id === input.id);
    if (!found || typeof input.resolved !== 'boolean') throw new Error('Choose an existing comment and its resolved state.');
    await writeAtomic(rt, rt.path.join(folder, 'comments.json'), comments.map((x) => x.id === input.id ? { ...x, resolved: input.resolved } : x));
    return;
  }
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000 || !Number.isInteger(input.frame) || Number(input.frame) < 0 || Number(input.frame) >= frames) throw new Error('A comment needs text and a frame inside the current video.');
  const entry: StudioComment = { id: rt.randomUUID(), frame: Number(input.frame), text: input.text.trim(), resolved: false, created: rt.now().getTime() };
  await writeAtomic(rt, rt.path.join(folder, 'comments.json'), [...comments, entry]);
};
