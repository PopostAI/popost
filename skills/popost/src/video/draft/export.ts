import type { Runtime } from '../../runtime';
import { sha256 } from '../../core/util';
import { renderVideo } from '../render/index';
import { runFfmpegOk } from '../media/ffmpeg';
import { buildPage } from '../compile/index';
import { duckFilter } from '../render/encode';
import type { Project } from '../types';
import { draftContentId, type DraftCaption, type DraftMedia } from './schema';

export interface PreparedDraft {
  directory: string;
  sourceHash: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  videos: DraftMedia[];
  audio: DraftMedia[];
  captions: DraftCaption[];
  cover: string;
}
/** Include scene source and local dependencies, so editing HTML or CSS cannot reuse a stale baked scene. */
export const draftSourceHash = async (rt: Runtime, dir: string, source: Project): Promise<string> => {
  const pending = [...source.materials.flatMap(m => [m.file, m.words].filter((s): s is string => !!s)),
    ...source.segments.flatMap(s => 'scene' in s.base ? [s.base.scene] : [])];
  const found = new Map<string, string>();
  while (pending.length) {
    const name = pending.pop()!, file = rt.path.resolve(dir, name), relative = rt.path.relative(rt.path.resolve(dir), file);
    if (relative.startsWith('..') || rt.path.isAbsolute(relative) || found.has(relative)) continue;
    const bytes = await rt.fs.readFile(file); found.set(relative, sha256(bytes));
    if (!/\.(?:html?|css|svg|m?js)$/i.test(file)) continue;
    const content = new TextDecoder().decode(bytes);
    const links = [...content.matchAll(/(?:\b(?:src|href|poster)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^"')\s]+)|(?:\bfrom|\bimport)\s*["']([^"']+)["'])/g)];
    for (const match of links) {
      const raw = (match[1] ?? match[2] ?? match[3] ?? '').split(/[?#]/)[0]!;
      if (!raw || /^(?:[a-z]+:|\/)/i.test(raw)) continue;
      const dependency = rt.path.resolve(rt.path.dirname(file), decodeURIComponent(raw));
      if ((await rt.fs.stat(dependency))?.isFile) pending.push(rt.path.relative(dir, dependency));
    }
  }
  return sha256(JSON.stringify({ source, assets: [...found].sort(([a], [b]) => a.localeCompare(b)), renderer: 'draft-visual-3' }));
};
const tempo = (speed: number): string => {
  const factors: number[] = []; let left = speed;
  while (left > 2) { factors.push(2); left /= 2; }
  while (left < .5) { factors.push(.5); left *= 2; }
  return [...factors, left].map(n => 'atempo=' + n).join(',');
};
const cached = async (rt: Runtime, file: string, make: (temporary: string) => Promise<unknown>): Promise<void> => {
  if ((await rt.fs.stat(file))?.isFile) return;
  const temporary = file + '.partial' + rt.path.extname(file);
  await rt.fs.mkdir(rt.path.dirname(file));
  try { await make(temporary); await rt.fs.rename(temporary, file); }
  finally { await rt.fs.rm(temporary); }
};

/** Render reusable segments locally; the native installer copies them into the editor's permanent draft folder. */
export const prepareDraft = async (rt: Runtime, dir: string, source: Project): Promise<PreparedDraft> => {
  const built = await buildPage(rt, dir, { source }), r = built.resolved;
  if (!r || built.problems.some(p => p.level === 'error')) throw new Error(built.problems.map(p => p.message).join('\n'));
  const hash = await draftSourceHash(rt, dir, source), directory = rt.path.join(dir, '.studio', 'drafts', hash.slice(0, 16));
  const visual = rt.path.join(directory, 'visual.mp4');
  await cached(rt, visual, out => renderVideo(rt, { projectDir: dir, out, audioEnabled: false, source: { ...source, tracks: source.tracks.filter(t => t.type !== 'caption') } }));
  const videos: DraftMedia[] = [], audio: DraftMedia[] = [];
  const us = (n: number): number => Math.round(n / r.canvas.fps * 1e6);
  for (const segment of r.segments) {
    const file = 'media/video-' + String(segment.index + 1).padStart(3, '0') + '.mp4';
    await cached(rt, rt.path.join(directory, file), out => runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-ss', String(segment.start / r.canvas.fps), '-i', visual, '-t', String((segment.end - segment.start) / r.canvas.fps), '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-movflags', '+faststart', out]));
    videos.push({ id: draftContentId(rt), file, start: us(segment.start), duration: us(segment.end - segment.start), width: r.canvas.width, height: r.canvas.height });
  }
  for (const [index, item] of r.audio.entries()) {
    const file = 'media/audio-' + String(index + 1).padStart(3, '0') + '.wav', length = (item.end ?? r.frames) - item.start;
    if (length <= 0) continue;
    await cached(rt, rt.path.join(directory, file), out => runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-ss', String(item.from ? item.from.frame / item.from.fps : 0), '-i', rt.path.resolve(dir, item.src), '-t', String(length / r.canvas.fps), '-vn', '-af', tempo(item.speed ?? 1) + duckFilter(item.duck, r.canvas.fps, item.start) + ',apad', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', out]));
    audio.push({ id: draftContentId(rt), file, start: us(item.start), duration: us(length), gain: 10 ** (item.gain / 20) });
  }
  const cover = rt.path.join(directory, 'cover.jpg');
  await cached(rt, cover, out => runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-i', visual, '-frames:v', '1', '-vf', 'scale=320:-2', out]));
  return { directory, sourceHash: hash, ...r.canvas, duration: us(r.frames), videos, audio,
    captions: r.items.filter(item => item.cue && item.text).map(item => ({ text: item.text!, start: us(item.start), duration: us(item.end - item.start) })), cover };
};
