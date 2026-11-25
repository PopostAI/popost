import type { Runtime } from '../../runtime';
import type { Editor } from './edit/editor';
import type { PreviewState } from './protocol';
import { readVersion, saveComment, saveVersion } from './studio-data';

const TYPES: Record<string, string> = { '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.mp3': 'audio', '.m4a': 'audio', '.wav': 'audio', '.ogg': 'audio' };
export const studioAction = async (rt: Runtime, dir: string, editor: Editor, state: PreviewState, path: string, body: Record<string, unknown>): Promise<unknown> => {
  if (path === '/api/studio/version') return saveVersion(rt, dir, JSON.parse(await editor.snapshot()), String(body.name ?? 'Version'));
  if (path === '/api/studio/restore') {
    const source = await readVersion(rt, dir, String(body.id));
    const result = await editor.replace(source, body.base);
    if (!result.ok) throw new Error(result.problems[0]?.message);
    return result;
  }
  if (path === '/api/studio/comment') return saveComment(rt, dir, body, state.resolved?.frames ?? 0);
  if (path === '/api/studio/import') {
    const ext = rt.path.extname(String(body.name ?? '')).toLowerCase(); const kind = TYPES[ext];
    if (!kind || typeof body.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) throw new Error('Choose a PNG, JPEG, WebP, video or audio file.');
    const bytes = Buffer.from(body.data, 'base64');
    if (!bytes.length || bytes.length > 12 * 1024 * 1024) throw new Error('Import a file up to 12 MB. Larger files can be placed in the project assets folder and linked through JSON.');
    const id = 'asset-' + rt.randomUUID(); const file = 'assets/studio/' + id + ext;
    await rt.fs.writeFile(rt.path.join(dir, file), bytes);
    const source = JSON.parse(await editor.snapshot()) as { materials: unknown[] };
    const material = { id, kind, file, note: String(body.name).slice(0, 160) };
    const result = await editor.replace({ ...source, materials: [...source.materials, material] }, source);
    if (!result.ok) { await rt.fs.rm(rt.path.join(dir, file)); throw new Error(result.problems[0]?.message); }
    return material;
  }
  throw new Error('Unknown Studio operation.');
};
