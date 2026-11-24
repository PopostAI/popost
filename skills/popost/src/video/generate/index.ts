/**
 * Materials that are made, not found: a picture or a clip generated from a prompt. Generation needs a model, which
 * does not live in this package: a Generator is the interface, and POPOST_GEN_CMD names a command that implements it,
 * called as
 *   <command> video|image <request.json> <out-file>
 * with request.json = { "prompt", "seconds"?, "aspect"?, "images"?, "videos"?, "audios"? } (references as paths); on
 * success it prints one JSON line, { "credits"?: number }. A command that wants the user to agree to a price first
 * makes nothing, charges nothing, prints { "confirm": { "credits": n, ... } } and exits with 3 (ConfirmNeeded).
 * `popost video generate` is such a command on popost.ai (cloud.ts); skills/popost/tools/video/ has examples of tools
 * of your own. Which model runs, at what resolution and under what spending limit is the command's business (and its
 * environment's), never the request's.
 *
 * makeMaterials turns a list of requests into files of a project and writes what each one shows into materials.json,
 * where the plan step reads it. A file that exists is never made again: asking twice costs once.
 */
import type { Runtime } from '../../runtime';
import { programsOf, toolCommand, withTempDir } from '../host';
import { toolEnv } from '../tool';
import { probe, runFfmpegOk } from '../media/ffmpeg';
import { clipAmount } from '../measure/index';
import { error } from '../project/check-common';
import type { Problem } from '../types';

export type GenerateKind = 'video' | 'image';

export interface GenerateRequest {
  prompt: string;
  /** Video: whole seconds. */
  seconds?: number;
  /** "16:9", "9:16", "1:1", another W:H, or "adaptive"; which ones a model takes is the generator's business. */
  aspect?: string;
  /** Reference pictures, as paths the command can read. */
  images?: string[];
  /** Reference clips and sounds, as paths, for a clip; a generator that cannot use them refuses the request. */
  videos?: string[];
  audios?: string[];
}

/** A price the user has not agreed to: what a generator answers instead of charging, with exit code 3. */
export interface PriceToConfirm {
  credits: number;
  model?: string;
  resolution?: string;
  seconds?: number;
  aspectRatio?: string;
  balance?: number | null;
}

/** Nothing was made or charged: the user has to agree to the price first. */
export class ConfirmNeeded extends Error {
  override name = 'ConfirmNeeded';
  constructor(
    readonly confirm: PriceToConfirm,
    message: string,
  ) {
    super(message);
  }
}

/** The exit code of a generator that asks for the user's agreement to a price. */
export const CONFIRM_EXIT = 3;

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

/** The last line of a generator's standard output as the object it should be; {} when it is not one. */
const lastObject = (stdout: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(stdout.trim().split('\n').pop() ?? '');
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const isPrice = (value: unknown): value is PriceToConfirm => value !== null && typeof value === 'object' && typeof (value as { credits?: unknown }).credits === 'number';

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
        const said = lastObject(r.stdout);
        const why = r.stderr.trim().split('\n').slice(-2).join(' | ');
        if (r.code === CONFIRM_EXIT && isPrice(said.confirm)) throw new ConfirmNeeded(said.confirm, why || 'It costs ' + said.confirm.credits + ' credits and needs the user\'s agreement first; nothing was charged.');
        if (r.code !== 0) throw new Error(why || 'The generator exited with ' + r.code + '.');
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

/** motionAmount: how much a clip's picture moves (measure/amount.ts), to hold against the reference shot it is for. */
export interface MadeMaterial { file: string; kind: GenerateKind; made: boolean; credits?: number; seconds?: number; motionAmount?: number; error?: string; anchor?: true; confirm?: PriceToConfirm }
/** toConfirm: the prices the user has to agree to before the files that wait for them are made. */
export interface MaterialsReport { materials: MadeMaterial[]; credits: number; problems: Problem[]; toConfirm?: { credits: number; materials: number } }

const VIDEOS = ['.mp4', '.mov', '.webm'];
const PICTURES = ['.png', '.jpg', '.jpeg', '.webp'];
export const NOTES = 'materials.json';
/** The reference lists of a request, and what one entry of each is called. */
const REFERENCES = { images: 'picture', videos: 'clip', audios: 'sound' } as const;
const LISTS = Object.keys(REFERENCES) as (keyof typeof REFERENCES)[];
const ASPECT = /^(\d{1,2}:\d{1,2}|adaptive)$/;

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
  // The reference files that exist, looked up first: the checks below stay one pass over the list.
  const listed = (r: Partial<MaterialRequest>, k: keyof typeof REFERENCES): unknown[] => {
    const list = r[k];
    return Array.isArray(list) ? list : [];
  };
  const named = requests.flatMap((r: Partial<MaterialRequest> | null) => (r && typeof r === 'object' ? LISTS.flatMap((k) => listed(r, k).filter((p): p is string => typeof p === 'string')) : []));
  const found = new Set<string>();
  for (const p of named) if ((await rt.fs.stat(rt.path.resolve(dir, p))) !== null) found.add(p);
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
    if (r.aspect !== undefined && !(typeof r.aspect === 'string' && ASPECT.test(r.aspect))) out.push(error(at + '.aspect', '"aspect" is a ratio such as "16:9", "9:16" or "1:1", or "adaptive"; it is ' + JSON.stringify(r.aspect) + '.', 'Write "aspect": "16:9".', ['16:9', '9:16', '1:1', 'adaptive']));
    for (const k of LISTS) {
      for (const [j, p] of listed(r, k).entries()) {
        if (typeof p !== 'string' || !found.has(p)) out.push(error(at + '.' + k + '[' + j + ']', 'The reference ' + REFERENCES[k] + ' ' + JSON.stringify(p) + ' does not exist in ' + dir + '.', 'Put the file there, or remove it from "' + k + '".'));
      }
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
        const references = Object.fromEntries(LISTS.flatMap((k) => (r[k]?.length ? [[k, (r[k] ?? []).map((p) => rt.path.resolve(o.dir, p))]] : [])));
        const request: GenerateRequest = { prompt: r.prompt, ...(r.seconds ? { seconds: r.seconds } : {}), ...(r.aspect ? { aspect: r.aspect } : {}), ...references };
        const made = await o.generator.make(kind, request, partial);
        if (!(await exists(partial))) throw new Error('The generator finished without writing the file.');
        await rt.fs.rename(partial, target);
        entry = { ...entry, made: true, ...(made.credits !== undefined ? { credits: made.credits } : {}) };
      } catch (e) {
        await rt.fs.rm(partial);
        materials.push({ ...entry, error: e instanceof Error ? e.message : String(e), ...(e instanceof ConfirmNeeded ? { confirm: e.confirm } : {}) });
        continue;
      }
    }
    if (kind === 'video') {
      const p = await probe(rt, target).catch(() => undefined);
      if (p) entry = { ...entry, seconds: Math.round((p.frames / p.fps) * 100) / 100 };
      const amount = p ? await clipAmount(rt, target).catch(() => undefined) : undefined;
      if (amount !== undefined) entry = { ...entry, motionAmount: amount };
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
  const failed = materials.filter((m) => m.error).map((m) =>
    m.confirm
      ? error(m.file, 'It was not made: it costs ' + m.confirm.credits + ' credits, and the user has not agreed to that price. Nothing was charged.', 'Show the user the price (toConfirm has the total). Only after they agree, run again with POPOST_GEN_MAX_CREDITS set to the highest price they approved for one file, or with --yes added to POPOST_GEN_CMD.')
      : error(m.file, 'It could not be made: ' + m.error, 'Read the message; a request that was refused cost nothing. Run the command again to make only what is missing.'),
  );
  const asked = materials.filter((m) => m.confirm);
  const toConfirm = asked.length ? { toConfirm: { credits: asked.reduce((n, m) => n + (m.confirm?.credits ?? 0), 0), materials: asked.length } } : {};
  return { materials, credits: materials.reduce((n, m) => n + (m.credits ?? 0), 0), problems: failed, ...toConfirm };
};
