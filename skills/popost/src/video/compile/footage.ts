/**
 * The build step of video footage. Before check and resolve: read every video material's file with probe() (rate,
 * exact frame count, size, sound, colour tags). After resolve: extract the frames the timeline shows into
 * <project>/.cache/video/<key>/ and record that directory in the resolved timeline, so the page finds them.
 * The key hashes the file's path, size and modification time and the extraction size: a second build reuses the
 * pictures, and a changed file or size gets a new directory.
 */
import { sha256 } from '../../core/util';
import type { Runtime } from '../../runtime';
import type { FootageFacts, FootageInfo, Project, Resolved } from '../types';
import { heavyJobs, mapLimit } from '../host';
import { isOutside } from '../project/check';
import { cameraPeak } from '../timeline/frame';
import { usedFrames } from '../timeline/footage';
import { EXTRACT_VERSION, extractFrames, readFootage, type FootageColour } from '../media/footage';

/** Where frame pictures go, relative to the project directory. */
export const FOOTAGE_CACHE = '.cache/video';

export interface FootageProbe {
  /** For check and resolve. */
  info: Record<string, FootageInfo>;
  colour: Record<string, FootageColour>;
}

export interface FootageStats {
  /** Pictures written by this build, and pictures found in the cache. */
  extracted: number;
  reused: number;
  ms: number;
}

/** Reads every video material whose file lies inside the project and exists (check reports the others). */
export const probeFootage = async (rt: Runtime, project: Project, projectDir: string): Promise<FootageProbe> => {
  const root = rt.path.resolve(rt.cwd, projectDir);
  const strictSpeechRoot = await rt.fs.stat(rt.path.join(root, 'replication.json')) ? root : undefined;
  const named = project.materials.filter((m) => m.kind === 'video' && m.file && !isOutside(m.file));
  const videos = (await Promise.all(named.map(async (m) => ((await rt.fs.stat(rt.path.resolve(root, m.file ?? ''))) === null ? [] : [m])))).flat();
  const read = await mapLimit(videos, heavyJobs(rt), async (m) => {
    try {
      return { id: m.id, ...(await readFootage(rt, rt.path.resolve(root, m.file ?? ''), { strictSpeechRoot })) };
    } catch (e) {
      return { id: m.id, error: (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? 'unreadable' };
    }
  });
  return {
    info: Object.fromEntries(read.map((x) => [x.id, 'facts' in x ? x.facts : { error: x.error ?? 'unreadable' }] as const)),
    colour: Object.fromEntries(read.flatMap((x) => ('colour' in x ? [[x.id, x.colour] as const] : []))),
  };
};

/**
 * The size to extract a material's frames at: as large as its largest use needs on the canvas times the render scale
 * (a base fills the canvas, grown by its camera; an item fills its box), never larger than the source.
 */
export const extractSize = (r: Resolved, id: string, src: Pick<FootageFacts, 'width' | 'height'>, scale = 1): { width: number; height: number } => {
  const W = r.canvas.width * scale;
  const H = r.canvas.height * scale;
  const need = (w: number, h: number, fit: 'cover' | 'contain'): number => (fit === 'cover' ? Math.max(w / src.width, h / src.height) : Math.min(w / src.width, h / src.height));
  const factors = [
    ...r.segments.flatMap((s, k) => (s.base.kind === 'video' && s.base.play.material === id ? [need(W, H, s.base.fit) * cameraPeak(r, k)] : [])),
    ...r.items.flatMap((it) => (it.play?.material === id ? [need(it.box[2] * W, it.box[3] * H, it.fit ?? 'contain')] : [])),
  ];
  const f = Math.min(1, Math.max(0, ...factors));
  return { width: Math.max(2, Math.round(src.width * f)), height: Math.max(2, Math.round(src.height * f)) };
};

/**
 * The cache directory of a key, made one level at a time. Each level must resolve inside the project before anything
 * is made in it, so a .cache that links out of the project is refused and nothing is written there. A file system
 * without realpath has no links, so there is nothing to resolve.
 */
const cacheDir = async (rt: Runtime, projectDir: string, rel: string): Promise<string> => {
  const realpath = rt.fs.realpath?.bind(rt.fs);
  const start = rt.path.resolve(rt.cwd, projectDir);
  const root = realpath ? await realpath(start) : start;
  let dir = start;
  for (const part of rel.split('/')) {
    dir = rt.path.join(dir, part);
    await rt.fs.mkdir(dir);
    if (!realpath) continue;
    const real = await realpath(dir);
    const inside = rt.path.relative(root, real);
    if (inside === '' || inside.startsWith('..') || rt.path.isAbsolute(inside))
      throw new Error('The frame cache ' + dir + ' resolves to ' + real + ', outside the project directory. Remove the link so that the cache stays inside the project.');
  }
  return dir;
};

const keyOf = async (rt: Runtime, projectDir: string, src: string, size: { width: number; height: number }): Promise<string> => {
  const file = rt.path.resolve(rt.cwd, projectDir, src);
  const info = await rt.fs.stat(file);
  if (!info) throw new Error('The video material ' + src + ' disappeared while the page was built. Build it again.');
  return sha256(JSON.stringify([EXTRACT_VERSION, src, info.size, info.mtimeMs, size.width, size.height])).slice(0, 16);
};

/**
 * Extracts the frames the timeline shows (missing ones only) and returns the timeline with each footage's dir set.
 * opts.scale: the render scale, so a half-size render extracts half-size pictures.
 */
export const extractFootage = async (rt: Runtime, r: Resolved, projectDir: string, probed: FootageProbe, opts: { scale?: number } = {}): Promise<{ resolved: Resolved; stats: FootageStats }> => {
  const t0 = performance.now();
  const used = usedFrames(r);
  const stats = { extracted: 0, reused: 0 };
  const footage: Resolved['footage'] = {};
  // One material at a time: each ffmpeg run already uses every core.
  for (const [id, f] of Object.entries(r.footage ?? {})) {
    const facts = probed.info[id];
    const colour = probed.colour[id];
    if (!facts || 'error' in facts || !colour) throw new Error('extractFootage: video material "' + id + '" was not probed. Pass the result of probeFootage for this project.');
    const size = extractSize(r, id, facts, opts.scale);
    const rel = FOOTAGE_CACHE + '/' + (await keyOf(rt, projectDir, f.src, size));
    const res = await extractFrames(rt, { file: rt.path.resolve(rt.cwd, projectDir, f.src), dir: await cacheDir(rt, projectDir, rel), frames: used.get(id) ?? [], ...size, colour });
    stats.extracted += res.extracted;
    stats.reused += res.reused;
    footage[id] = { ...f, dir: rel };
  }
  return { resolved: { ...r, footage }, stats: { ...stats, ms: Math.round(performance.now() - t0) } };
};
