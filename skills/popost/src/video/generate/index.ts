/**
 * Materials that are made, not found: a picture or a clip generated from a prompt. Generation needs a model, which
 * does not live in this package: a Generator is the interface, and POPOST_GEN_CMD names a command that implements it,
 * called as
 *   <command> video|image <request.json> <out-file>
 * with request.json = { "prompt", "seconds"?, "aspect"?, "images"? }; on success it prints one JSON line,
 * { "credits"?: number }. Set POPOST_GEN_CMD to a tool of yours; skills/popost/tools/video/ has examples. Which model runs, at what resolution and under
 * what spending limit is the command's business (and its environment's), never the request's.
 *
 * makeMaterials turns a list of requests into files of a project and writes what each one shows into materials.json,
 * where the plan step reads it. A file that exists is never made again: asking twice costs once.
 */
import type { Runtime } from '../../runtime';
import { programsOf, toolCommand, withTempDir } from '../host';
import { toolEnv } from '../tool';
import { probe, runFfmpegOk } from '../media/ffmpeg';
import { error } from '../project/check-common';
import type { Problem } from '../types';

export type GenerateKind = 'video' | 'image';

export interface GenerateRequest {
  prompt: string;
  /** Video: whole seconds. */
  seconds?: number;
  aspect?: '16:9' | '9:16' | '1:1';
  /** Reference pictures, as paths the command can read. */
  images?: string[];
}

export interface Generator {
  /** Makes one file at out. Resolves with what it cost, when the command says. */
  make(kind: GenerateKind, request: GenerateRequest, out: string): Promise<{ credits?: number }>;
}

/** Runs the generator's words with the arguments of its contract; standard error is kept, as before, to its last 4000 characters. */
const run = async (rt: Runtime, words: string[], args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
  const r = await programsOf(rt).run([...words, ...args], { env: toolEnv(rt), lowPriority: true }).catch((e: unknown) => {
    throw new Error('The generator could not be started (' + (e instanceof Error ? e.message : String(e)) + '). Check POPOST_GEN_CMD.');
  });
  return { code: r.code, stdout: new TextDecoder().decode(r.stdout).slice(-8000), stderr: r.stderr.slice(-4000) };
};

/** The generator behind POPOST_GEN_CMD, or undefined when it is not set. It runs its command through `rt`. */
export const commandGenerator = (rt: Runtime): Generator | undefined => {
  const words = toolCommand(rt, 'POPOST_GEN_CMD');
  if (!words) return undefined;
  return {
    make: (kind, request, out) =>
      withTempDir(rt, 'popost-video-gen-', async (dir) => {
        const file = rt.path.join(dir, 'request.json');
        await rt.fs.writeFile(file, JSON.stringify(request));
        const r = await run(rt, words, [kind, file, out]);
        if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').slice(-2).join(' | ') || 'The generator exited with ' + r.code + '.');
        const last = r.stdout.trim().split('\n').pop() ?? '';
        const said = await Promise.resolve(last).then((t) => JSON.parse(t) as { credits?: unknown }, () => ({} as { credits?: unknown }));
        return typeof said.credits === 'number' ? { credits: said.credits } : {};
      }),
  };
};

/** One material to make: where it goes in the project, and what it should show. */
export interface MaterialRequest extends GenerateRequest {
  /** Path in the project, for example "assets/desk.mp4". Its extension says what it is. */
  file: string;
  /** What the material shows, for whoever chooses materials later. Default: the prompt. */
  note?: string;
}

export interface MadeMaterial { file: string; kind: GenerateKind; made: boolean; credits?: number; seconds?: number; error?: string; anchor?: true }
export interface MaterialsReport { materials: MadeMaterial[]; credits: number; problems: Problem[] }

const VIDEOS = ['.mp4', '.mov', '.webm'];
const PICTURES = ['.png', '.jpg', '.jpeg', '.webp'];
export const NOTES = 'materials.json';

/** The extension of a path as node:path's extname gives it ("" for none, and for a name that starts with its only dot). */
const extOf = (file: string): string => {
  const base = file.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
};

const kindOf = (file: string): GenerateKind | undefined => {
  const ext = extOf(file).toLowerCase();
  return VIDEOS.includes(ext) ? 'video' : PICTURES.includes(ext) ? 'image' : undefined;
};

/** What is wrong with a list of requests, before anything is paid for. */
export const checkRequests = async (rt: Runtime, requests: unknown, dir: string): Promise<Problem[]> => {
  if (!Array.isArray(requests)) return [error('(root)', 'The requests are a JSON list: one entry per material to make.', 'Write [{ "file": "assets/desk.mp4", "prompt": "...", "seconds": 5 }].')];
  const seen = new Set<string>();
  // The reference pictures that exist, looked up first: the checks below stay one pass over the list.
  const pictures = requests.flatMap((r: Partial<MaterialRequest> | null) => (r && typeof r === 'object' && Array.isArray(r.images) ? r.images.filter((p): p is string => typeof p === 'string') : []));
  const found = new Set<string>();
  for (const p of pictures) if ((await rt.fs.stat(rt.path.resolve(dir, p))) !== null) found.add(p);
  return requests.flatMap((r: Partial<MaterialRequest> | null, i): Problem[] => {
    const at = '[' + i + ']';
    if (!r || typeof r !== 'object') return [error(at, 'A request is an object with "file" and "prompt".', 'Write { "file": "assets/desk.mp4", "prompt": "..." }.')];
    const out: Problem[] = [];
    const file = r.file;
    if (typeof file !== 'string' || !file.trim()) out.push(error(at + '.file', 'A request names the file it makes, inside the project.', 'Write "file": "assets/desk.mp4" (a clip) or "assets/desk.png" (a picture).'));
    else {
      const inside = rt.path.relative(rt.path.resolve(dir), rt.path.resolve(dir, file));
      if (rt.path.isAbsolute(file) || inside.startsWith('..')) out.push(error(at + '.file', '"' + file + '" lies outside the project directory.', 'Write a path under assets/.'));
      else if (!kindOf(file)) out.push(error(at + '.file', '"' + file + '" is neither a clip nor a picture by its extension.', 'End it with .mp4 for a clip, or .png, .webp or .jpg for a picture.', [...VIDEOS, ...PICTURES]));
      if (seen.has(file)) out.push(error(at + '.file', '"' + file + '" is asked for twice.', 'Give every request its own file.'));
      seen.add(file);
    }
    if (typeof r.prompt !== 'string' || !r.prompt.trim()) out.push(error(at + '.prompt', 'A request says what the material should show.', 'Write "prompt": "a tidy desk by a window, slow push-in".'));
    if (r.seconds !== undefined && !(Number.isInteger(r.seconds) && r.seconds >= 1 && r.seconds <= 30)) out.push(error(at + '.seconds', '"seconds" is a whole number from 1 to 30; it is ' + JSON.stringify(r.seconds) + '.', 'Write "seconds": 5.'));
    if (r.aspect !== undefined && !['16:9', '9:16', '1:1'].includes(r.aspect)) out.push(error(at + '.aspect', '"aspect" is "16:9", "9:16" or "1:1"; it is ' + JSON.stringify(r.aspect) + '.', 'Write "aspect": "16:9".', ['16:9', '9:16', '1:1']));
    for (const [j, p] of (Array.isArray(r.images) ? r.images : []).entries()) {
      if (typeof p !== 'string' || !found.has(p)) out.push(error(at + '.images[' + j + ']', 'The reference picture ' + JSON.stringify(p) + ' does not exist in ' + dir + '.', 'Put the file there, or remove it from "images".'));
    }
    return out;
  });
};

/** The picture that carries a person and a place from one clip to the others, beside the clips. */
export const ANCHOR_FILE = 'anchor.jpg';
const CLOSE = /close-?up|macro|detail shot|特写/i;

/**
 * Which clip the others should look like: the first one that is not a close-up (a close-up shows a hand or a
 * fabric, not who is in the video), else the first clip.
 */
export const anchorIndex = (requests: MaterialRequest[]): number => {
  const clips = requests.map((r, i) => ({ r, i })).filter((x) => kindOf(x.r.file) === 'video');
  return (clips.find((x) => !CLOSE.test(x.r.prompt)) ?? clips[0])?.i ?? -1;
};

/** A frame from the middle of a clip, as a picture a generator can take as a reference. */
const grabAnchor = async (rt: Runtime, clip: string, out: string): Promise<void> => {
  const p = await probe(rt, clip);
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-ss', ((p.frames / p.fps) / 2).toFixed(3), '-i', clip, '-frames:v', '1', '-q:v', '2', out]);
};

/** A request with the anchor picture as its last reference, and a sentence that points at it. */
const anchored = (r: MaterialRequest, picture: string): MaterialRequest => {
  const images = [...(r.images ?? []), picture];
  return { ...r, images, prompt: r.prompt.trim() + ' Keep the same person, clothes and place as in @image' + images.length + '.' };
};

const readNotes = (rt: Runtime, dir: string): Promise<Record<string, string>> =>
  rt.fs.readText(rt.path.join(dir, NOTES)).then((t) => JSON.parse(t) as Record<string, string>, () => ({}));

/**
 * Makes every requested material that does not exist yet, one after another, and records what each shows. A request
 * that fails is reported and the others go on: what was made stays made.
 * With anchor, the clips keep one person and one place: one clip is made first (anchorIndex), a frame of it is saved
 * beside the clips (ANCHOR_FILE), and every other clip gets that picture as a reference with a sentence that points
 * at it. Text alone does not do this: "the same young woman" gave a different woman in every clip.
 */
export const makeMaterials = async (rt: Runtime, o: { requests: MaterialRequest[]; dir: string; generator: Generator; anchor?: boolean; onStep?: (file: string, done: number, total: number) => void }): Promise<MaterialsReport> => {
  const problems = await checkRequests(rt, o.requests, o.dir);
  if (problems.length) return { materials: [], credits: 0, problems };
  const notes = await readNotes(rt, o.dir);
  const exists = async (p: string): Promise<boolean> => (await rt.fs.stat(p)) !== null;
  const materials: MadeMaterial[] = [];
  const first = o.anchor ? anchorIndex(o.requests) : -1;
  const order = first > 0 ? [o.requests[first] as MaterialRequest, ...o.requests.filter((_r, i) => i !== first)] : o.requests;
  let picture: string | undefined;
  for (const [i, asked] of order.entries()) {
    const r = picture && kindOf(asked.file) === 'video' ? anchored(asked, picture) : asked;
    const kind = kindOf(r.file) as GenerateKind;
    const target = rt.path.resolve(o.dir, r.file);
    o.onStep?.(r.file, i, o.requests.length);
    let entry: MadeMaterial = { file: r.file, kind, made: false };
    if (!(await exists(target))) {
      await rt.fs.mkdir(rt.path.dirname(target));
      const partial = target + '.partial' + rt.path.extname(target);
      try {
        const request: GenerateRequest = { prompt: r.prompt, ...(r.seconds ? { seconds: r.seconds } : {}), ...(r.aspect ? { aspect: r.aspect } : {}), ...(r.images?.length ? { images: r.images.map((p) => rt.path.resolve(o.dir, p)) } : {}) };
        const made = await o.generator.make(kind, request, partial);
        if (!(await exists(partial))) throw new Error('The generator finished without writing the file.');
        await rt.fs.rename(partial, target);
        entry = { ...entry, made: true, ...(made.credits !== undefined ? { credits: made.credits } : {}) };
      } catch (e) {
        await rt.fs.rm(partial);
        materials.push({ ...entry, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
    }
    if (kind === 'video') {
      const p = await probe(rt, target).catch(() => undefined);
      if (p) entry = { ...entry, seconds: Math.round((p.frames / p.fps) * 100) / 100 };
    }
    if (first >= 0 && i === 0 && kind === 'video') {
      // The anchor's frame is taken once and kept: a second run uses the same picture.
      const rel = rt.path.join(rt.path.dirname(r.file), ANCHOR_FILE);
      if (!(await exists(rt.path.resolve(o.dir, rel)))) await grabAnchor(rt, target, rt.path.resolve(o.dir, rel));
      picture = rel;
      entry = { ...entry, anchor: true };
    }
    notes[r.file] = asked.note ?? asked.prompt;
    await rt.fs.writeFile(rt.path.join(o.dir, NOTES), JSON.stringify(notes, null, 1) + '\n');
    materials.push(entry);
  }
  const failed = materials.filter((m) => m.error).map((m) => error(m.file, 'It could not be made: ' + m.error, 'Read the message; a request that was refused cost nothing. Run the command again to make only what is missing.'));
  return { materials, credits: materials.reduce((n, m) => n + (m.credits ?? 0), 0), problems: failed };
};
