/**
 * Materials that are made, not found: a picture or a clip generated from a prompt. Generation needs a model, which
 * does not live in this package: a Generator is the interface, and POPOST_GEN_CMD names a command that implements it,
 * called as
 *   <command> video|image <request.json> <out-file>
 * with request.json = { "prompt", "seconds"?, "aspect"?, "images"?, "videos"?, "audios"?, "firstFrame"?, "lastFrame"? }
 * (references and frames as paths; frames never together with references); on
 * success it prints one JSON line, { "credits"?: number }. A command that wants the user to agree to a price first
 * makes nothing, charges nothing, prints { "confirm": { "credits": n, ... } } and exits with 3 (ConfirmNeeded). Such a
 * command answers a request with "priceOnly": true the same way whatever budget it has: only the price is wanted.
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
import { extractFrame } from '../media/decode';
import { probe, runFfmpegOk } from '../media/ffmpeg';
import { clipAmount } from '../measure/index';
import { error, warning } from '../project/check-common';
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
  /**
   * The picture the clip starts from, and the one it ends on (a path; lastFrame only with firstFrame). A clip made from
   * frames takes no references: a generator refuses a request that has both, and one whose model takes no frames.
   */
  firstFrame?: string;
  lastFrame?: string;
  /**
   * Only the price is wanted: a generator that asks before it charges answers with the price (ConfirmNeeded) and makes
   * nothing, whatever budget it has. Sent only to a generator that has just asked for another clip of the same list.
   */
  priceOnly?: true;
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
  /** false: this clip shares nothing with the others, so it neither gives nor takes the anchor picture. */
  anchor?: boolean;
  /** The file of another clip (of this list, or of the project): this clip starts from its last frame, as its firstFrame. */
  continues?: string;
}

/** motionAmount: how much a clip's picture moves (measure/amount.ts), to hold against the reference shot it is for. */
export interface MadeMaterial { file: string; kind: GenerateKind; made: boolean; credits?: number; seconds?: number; motionAmount?: number; error?: string; anchor?: true; waiting?: true; waitsFor?: string; unanchored?: true; confirm?: PriceToConfirm }
/**
 * toConfirm: the prices the user has to agree to before the files that wait for them are made. anchor: the picture the
 * clips got as a reference, and where it came from. A material with waiting was not made because the anchor clip is
 * not there yet: priced only (confirm) when the anchor clip's price waits for the user, not sent at all when it failed.
 */
export interface MaterialsReport { materials: MadeMaterial[]; credits: number; problems: Problem[]; anchor?: { picture: string; from: AnchorSource }; toConfirm?: { credits: number; materials: number } }

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

const FRAME_FIX = 'Use frames for a shot that goes on from another clip or needs an exact first picture, and reference pictures ("images") for who or what is in the clip.';

/** What is wrong with the frames of a request: firstFrame, lastFrame and continues. found: the files that exist; clips: the list's clips by file. */
const frameProblems = (r: Partial<MaterialRequest>, at: string, found: ReadonlySet<string>, clips: ReadonlyMap<string, Partial<MaterialRequest>>): Problem[] => {
  if (!usesFrames(r)) return [];
  const out: Problem[] = [];
  const key = r.continues !== undefined ? 'continues' : r.firstFrame !== undefined ? 'firstFrame' : 'lastFrame';
  if (typeof r.file === 'string' && kindOf(r.file) === 'image') return [error(at + '.' + key, 'Only a clip starts from a frame or continues another clip; "' + r.file + '" is a picture.', 'Remove "' + key + '"; a picture takes reference pictures in "images".')];
  if (LISTS.some((k) => Array.isArray(r[k]) && (r[k] as unknown[]).length > 0))
    out.push(error(at + '.' + key, '"firstFrame", "lastFrame" and "continues" cannot be combined with "images", "videos" or "audios": a model starts from a frame or follows references, not both.', FRAME_FIX));
  if (r.continues !== undefined && r.firstFrame !== undefined) out.push(error(at + '.firstFrame', 'A clip that continues another starts from that clip\'s last frame; it cannot name a "firstFrame" too.', 'Remove "firstFrame" or "continues".'));
  if (r.lastFrame !== undefined && r.firstFrame === undefined && r.continues === undefined) out.push(error(at + '.lastFrame', '"lastFrame" is where a clip ends; it needs the picture the clip starts from.', 'Add "firstFrame" (or "continues"), or remove "lastFrame".'));
  for (const k of ['firstFrame', 'lastFrame'] as const) {
    const p = r[k];
    if (p === undefined) continue;
    if (typeof p !== 'string' || !found.has(p) || !PICTURES.includes(extOf(p).toLowerCase())) out.push(error(at + '.' + k, '"' + k + '" is a picture of the project (.png, .jpg or .webp) that exists; ' + JSON.stringify(p) + ' is not.', 'Put the picture into the project and write its path, or remove "' + k + '".'));
  }
  const c = r.continues;
  if (c === undefined) return out;
  const fix = 'Write the "file" of the clip this one goes on from: another clip of this list, or a clip that is already in the project.';
  if (typeof c !== 'string' || kindOf(c) !== 'video' || !(clips.has(c) || found.has(c))) return [...out, error(at + '.continues', '"continues" names a clip of this list or of the project; ' + JSON.stringify(c) + ' is neither.', fix)];
  // Followed back through the list, a chain must end: a clip cannot go on from itself.
  let seen = 0;
  for (let from: string | undefined = c; from !== undefined && seen <= clips.size; seen++) {
    if (from === r.file) return [...out, error(at + '.continues', '"' + r.file + '" would continue itself' + (c === r.file ? '' : ' (through ' + c + ')') + '.', fix)];
    from = clips.get(from)?.continues;
  }
  return out;
};

/** A clip this short is near the shortest a model makes. */
export const SHORT_CLIP = 5;
/** From this many short clips on, a list is asked whether they could be one call. */
export const MANY_SHORT = 3;

/**
 * Advice on how a list is cut into calls: several short clips that could be made in one call. Each call has a sound
 * of its own, so shots made one by one do not sound like one film. Clips that need a call of their own are left out:
 * one with frames, with reference clips or sounds, or that says "anchor": false (another world than the rest).
 */
export const groupingAdvice = (requests: unknown): Problem[] => {
  if (!Array.isArray(requests)) return [];
  const short = requests.flatMap((r: Partial<MaterialRequest> | null, i) =>
    r && typeof r === 'object' && typeof r.file === 'string' && kindOf(r.file) === 'video' && (r.seconds ?? SHORT_CLIP) <= SHORT_CLIP && !usesFrames(r) && r.anchor !== false && !r.videos?.length && !r.audios?.length ? [i] : []);
  if (short.length < MANY_SHORT) return [];
  const seconds = short.reduce((n, i) => n + ((requests[i] as MaterialRequest).seconds ?? SHORT_CLIP), 0);
  return [warning('[' + short[0] + ']', short.length + ' clips of ' + SHORT_CLIP + ' s or less are asked for one by one (' + seconds + ' s in all). Every call has a sound of its own, so shots made one by one do not sound like one film, and a shot shorter than the shortest clip is paid for at the shortest.',
    'When they are consecutive shots of one look, ask for them in one clip up to the model\'s longest: one prompt that lists the shots in order with their lengths and "hard cuts" and asks for one continuous soundtrack; then popost video shots finds the cuts. Keep a clip on its own only for lip-synced speech, an exact first frame, or other reference pictures (video-tools.md, "How many calls").')];
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
  const named = requests.flatMap((r: Partial<MaterialRequest> | null) => (r && typeof r === 'object' ? [...LISTS.flatMap((k) => listed(r, k)), r.firstFrame, r.lastFrame, r.continues].filter((p): p is string => typeof p === 'string') : []));
  const clips = new Map(requests.flatMap((r: Partial<MaterialRequest> | null) => (r && typeof r === 'object' && typeof r.file === 'string' && kindOf(r.file) === 'video' ? [[r.file, r] as const] : [])));
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
    if (r.anchor !== undefined && typeof r.anchor !== 'boolean') out.push(error(at + '.anchor', '"anchor" is false for a clip that shares nothing with the others; it is ' + JSON.stringify(r.anchor) + '.', 'Write "anchor": false, or remove it.'));
    if (r.aspect !== undefined && !(typeof r.aspect === 'string' && ASPECT.test(r.aspect))) out.push(error(at + '.aspect', '"aspect" is a ratio such as "16:9", "9:16" or "1:1", or "adaptive"; it is ' + JSON.stringify(r.aspect) + '.', 'Write "aspect": "16:9".', ['16:9', '9:16', '1:1', 'adaptive']));
    out.push(...frameProblems(r, at, found, clips));
    for (const k of LISTS) {
      for (const [j, p] of listed(r, k).entries()) {
        if (typeof p !== 'string' || !found.has(p)) out.push(error(at + '.' + k + '[' + j + ']', 'The reference ' + REFERENCES[k] + ' ' + JSON.stringify(p) + ' does not exist in ' + dir + '.', 'Put the file there, or remove it from "' + k + '".'));
      }
    }
    return out;
  });
};

/** The picture that carries what the clips share (a person, a product, a place) from one clip to the others, beside the clips. */
export const ANCHOR_FILE = 'anchor.jpg';
const CLOSE = /close-?up|macro|detail shot|特写/i;

/** A clip made from frames: it starts from a picture (its own, or the last frame of the clip it continues). */
const usesFrames = (r: Partial<MaterialRequest>): boolean => r.firstFrame !== undefined || r.lastFrame !== undefined || r.continues !== undefined;

/**
 * A clip that may give or take the anchor picture: any clip whose request does not say "anchor": false and that is not
 * made from frames (a model starts from a frame or follows references, not both).
 */
const takesAnchor = (r: MaterialRequest): boolean => kindOf(r.file) === 'video' && r.anchor !== false && !usesFrames(r);

/**
 * Which clip the others should look like: the first one that is not a close-up (a close-up shows a hand or a
 * fabric, not who is in the video), else the first clip. Clips that opted out are passed over.
 */
export const anchorIndex = (requests: MaterialRequest[]): number => {
  const clips = requests.map((r, i) => ({ r, i })).filter((x) => takesAnchor(x.r));
  return (clips.find((x) => !CLOSE.test(x.r.prompt)) ?? clips[0])?.i ?? -1;
};

/** A frame from the middle of a clip, as a picture a generator can take as a reference. */
const grabAnchor = async (rt: Runtime, clip: string, out: string): Promise<void> => {
  const p = await probe(rt, clip);
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-ss', ((p.frames / p.fps) / 2).toFixed(3), '-i', clip, '-frames:v', '1', '-q:v', '2', out]);
};

/**
 * A picture the caller gives as the anchor of every clip (a path in the project): no clip is made first for it.
 * person: the picture is one person (a character of the user's library), with what is known of them.
 */
export interface AnchorPicture { file: string; person?: { name?: string; description?: string } }

/** Where the anchor picture of a run came from. */
export type AnchorSource = 'clip' | 'image' | 'character';

const NOTHING_ADDED = 'add nothing from it that the description above does not ask for.';

/**
 * The sentence that points a clip at the anchor picture. It asks only for what the clip shares with the picture to
 * look the same, so it holds for a clip of a product alone as for one of a person: it never asks for a person.
 */
export const anchorSentence = (n: number, source: AnchorSource, person?: AnchorPicture['person']): string => {
  if (source === 'character') {
    const who = [person?.name, person?.description].map((s) => s?.replace(/\s+/g, ' ').trim()).filter(Boolean).join(': ').slice(0, 400);
    return '@image' + n + ' is the person of this video' + (who ? ' (' + who + ')' : '') + '. When a person appears in this clip it is that person, with the same face, hair and build; add no person the description above does not ask for.';
  }
  const what = source === 'clip' ? '@image' + n + ' is a frame of another clip of the same video.' : '@image' + n + ' shows who or what stays the same through the clips of this video.';
  return what + ' Whatever this clip shares with it (a person and their clothes, a product, a place) looks exactly as it does there; ' + NOTHING_ADDED;
};

/** A request with the anchor picture as its last reference, and the sentence that points at it. */
const anchored = (r: MaterialRequest, picture: string, source: AnchorSource, person?: AnchorPicture['person']): MaterialRequest => {
  const images = [...(r.images ?? []), picture];
  return { ...r, images, prompt: r.prompt.trim() + ' ' + anchorSentence(images.length, source, person) };
};

const readNotes = (rt: Runtime, dir: string): Promise<Record<string, string>> =>
  rt.fs.readText(rt.path.join(dir, NOTES)).then((t) => JSON.parse(t) as Record<string, string>, () => ({}));

/** The requests in the order they are made: the anchor clip first, and a clip after the one it continues. */
const inOrder = (requests: MaterialRequest[], first: number): MaterialRequest[] => {
  const out = first >= 0 ? [requests[first] as MaterialRequest] : [];
  const listed = new Set(requests.map((r) => r.file));
  const placed = new Set(out.map((r) => r.file));
  let left = requests.filter((_r, i) => i !== first);
  while (left.length) {
    const ready = left.filter((r) => !r.continues || placed.has(r.continues) || !listed.has(r.continues));
    // checkRequests refuses a circle; should one get here, the rest goes in the order written.
    for (const r of ready.length ? ready : left) {
      out.push(r);
      placed.add(r.file);
    }
    left = left.filter((r) => !placed.has(r.file));
  }
  return out;
};

/** Where the last frame of a clip is kept, beside it: "assets/walk.mp4" -> "assets/walk.last.png". */
export const lastFrameFile = (clip: string): string => clip.slice(0, clip.length - extOf(clip).length) + '.last.png';

/** The last frame of a clip of the project as a picture beside it, taken again when the clip is newer than the picture. */
const lastFrameOf = async (rt: Runtime, dir: string, clip: string): Promise<string> => {
  const from = rt.path.resolve(dir, clip), to = rt.path.resolve(dir, lastFrameFile(clip));
  const [a, b] = [await rt.fs.stat(from), await rt.fs.stat(to)];
  if (!b || (a && a.mtimeMs > b.mtimeMs)) {
    const p = await probe(rt, from);
    await extractFrame(rt, from, Math.max(0, p.frames - 1), to);
  }
  return to;
};

/**
 * Makes every requested material that does not exist yet, one after another, and records what each shows. A request
 * that fails is reported and the others go on: what was made stays made.
 *
 * The anchor keeps what the clips share the same (text alone does not: "the same young woman" gave a different woman
 * in every clip). Every clip that does not say "anchor": false gets one picture as a reference, with a sentence that
 * points at it (anchorSentence). The picture is o.picture when the caller gives one. Otherwise one of the requested
 * clips is made first (anchorIndex) and a frame of it is saved beside the clips (ANCHOR_FILE): no clip is made that
 * was not asked for. That is the default for two or more such clips (o.anchor undefined), off with o.anchor false,
 * and on for a single clip too with o.anchor true (a later run then finds the picture).
 *
 * A clip that continues another starts from that clip's last frame (lastFrameOf), so it is made after it. A clip
 * with frames takes no anchor: a model starts from a frame or follows references, never both.
 *
 * While a clip another one needs is not there (the anchor clip, the clip it continues), the one that needs it is
 * not made: without it, it would be paid for and not match. When the needed clip failed it is not sent at all; when
 * the needed clip's price waits for the user it is sent for its price only (GenerateRequest.priceOnly, without the
 * frames or the anchor, which do not change a price), so that the user is shown the total of the whole list at once.
 */
export const makeMaterials = async (rt: Runtime, o: { requests: MaterialRequest[]; dir: string; generator: Generator; anchor?: boolean; picture?: AnchorPicture; onStep?: (file: string, done: number, total: number) => void }): Promise<MaterialsReport> => {
  const problems = await checkRequests(rt, o.requests, o.dir);
  if (problems.length) return { materials: [], credits: 0, problems };
  const notes = await readNotes(rt, o.dir);
  const exists = async (p: string): Promise<boolean> => (await rt.fs.stat(p)) !== null;
  const materials: MadeMaterial[] = [];
  const takers = o.requests.filter(takesAnchor).length;
  const fromClip = !o.picture && o.anchor !== false && takers >= (o.anchor ? 1 : 2);
  const first = fromClip ? anchorIndex(o.requests) : -1;
  const order = inOrder(o.requests, first);
  const anchorFile = first >= 0 ? (o.requests[first] as MaterialRequest).file : undefined;
  const source: AnchorSource | undefined = o.picture ? (o.picture.person ? 'character' : 'image') : fromClip ? 'clip' : undefined;
  let picture: string | undefined = o.picture?.file;
  /** The clips that were asked for and are not there: failed (or waiting themselves), or priced and waiting for the user. */
  const absent = new Map<string, 'failed' | 'priced'>();
  for (const [i, asked] of order.entries()) {
    const isAnchor = first >= 0 && i === 0;
    const takes = source !== undefined && takesAnchor(asked) && !isAnchor;
    const needs = [...(takes && anchorFile ? [anchorFile] : []), ...(asked.continues ? [asked.continues] : [])];
    const kind = kindOf(asked.file) as GenerateKind;
    const target = rt.path.resolve(o.dir, asked.file);
    o.onStep?.(asked.file, i, o.requests.length);
    let entry: MadeMaterial = { file: asked.file, kind, made: false };
    if (!(await exists(target))) {
      const failed = needs.find((f) => absent.get(f) === 'failed');
      if (failed) {
        absent.set(asked.file, 'failed');
        materials.push({ ...entry, waiting: true, waitsFor: failed });
        continue;
      }
      const priced = needs.find((f) => absent.get(f) === 'priced');
      const priceOnly = priced !== undefined;
      await rt.fs.mkdir(rt.path.dirname(target));
      const partial = target + '.partial' + rt.path.extname(target);
      try {
        const r = takes && picture && !priceOnly ? anchored(asked, picture, source, o.picture?.person) : asked;
        const at = (p: string): string => rt.path.resolve(o.dir, p);
        const references = Object.fromEntries(LISTS.flatMap((k) => (r[k]?.length ? [[k, (r[k] ?? []).map(at)]] : [])));
        const start = priceOnly ? undefined : asked.continues ? await lastFrameOf(rt, o.dir, asked.continues) : asked.firstFrame ? at(asked.firstFrame) : undefined;
        const frames = { ...(start ? { firstFrame: start } : {}), ...(start && asked.lastFrame ? { lastFrame: at(asked.lastFrame) } : {}) };
        const request: GenerateRequest = { prompt: r.prompt, ...(r.seconds ? { seconds: r.seconds } : {}), ...(r.aspect ? { aspect: r.aspect } : {}), ...references, ...frames, ...(priceOnly ? { priceOnly: true as const } : {}) };
        const made = await o.generator.make(kind, request, partial);
        if (!(await exists(partial))) throw new Error('The generator finished without writing the file.');
        await rt.fs.rename(partial, target);
        // A generator that does not know "priceOnly" and had the budget made the clip: it is there, without what it waited for.
        entry = { ...entry, made: true, ...(made.credits !== undefined ? { credits: made.credits } : {}), ...(priceOnly ? { unanchored: true as const, waitsFor: priced } : {}) };
      } catch (e) {
        await rt.fs.rm(partial);
        absent.set(asked.file, e instanceof ConfirmNeeded ? 'priced' : 'failed');
        materials.push({ ...entry, error: e instanceof Error ? e.message : String(e), ...(e instanceof ConfirmNeeded ? { confirm: e.confirm } : {}), ...(priceOnly ? { waiting: true as const, waitsFor: priced } : {}) });
        continue;
      }
    }
    if (kind === 'video') {
      const p = await probe(rt, target).catch(() => undefined);
      if (p) entry = { ...entry, seconds: Math.round((p.frames / p.fps) * 100) / 100 };
      const amount = p ? await clipAmount(rt, target).catch(() => undefined) : undefined;
      if (amount !== undefined) entry = { ...entry, motionAmount: amount };
    }
    if (isAnchor && kind === 'video') {
      // The anchor's frame is taken once and kept: a second run uses the same picture.
      const rel = rt.path.join(rt.path.dirname(asked.file), ANCHOR_FILE);
      // A clip no frame can be taken from (a damaged file) leaves the others waiting, like a clip that was not made.
      const got = (await exists(rt.path.resolve(o.dir, rel))) || (await grabAnchor(rt, target, rt.path.resolve(o.dir, rel)).then(() => true, () => false));
      if (got) picture = rel;
      else absent.set(asked.file, 'failed');
      entry = { ...entry, anchor: true };
    }
    notes[asked.file] = asked.note ?? asked.prompt;
    await rt.fs.writeFile(rt.path.join(o.dir, NOTES), JSON.stringify(notes, null, 1) + '\n');
    materials.push(entry);
  }
  const why = (m: MadeMaterial): string => (m.waitsFor === anchorFile && !o.requests.some((r) => r.file === m.file && r.continues === m.waitsFor) ? 'a frame of it goes to this clip as a reference picture, so that the clips show the same person, product and place' : 'this clip starts from its last frame');
  const failed = materials.filter((m) => m.error).map((m) =>
    m.confirm
      ? error(m.file, 'It was not made: it costs ' + m.confirm.credits + ' credits, and the user has not agreed to that price. Nothing was charged.', 'Show the user the price (toConfirm has the total). Only after they agree, run again with POPOST_GEN_MAX_CREDITS set to the highest price they approved for one file, or with --yes added to POPOST_GEN_CMD.')
      : error(m.file, 'It could not be made: ' + m.error, 'Read the message; a request that was refused cost nothing. Run the command again to make only what is missing.' + (source && m.file !== anchorFile && takesAnchor(o.requests.find((r) => r.file === m.file) as MaterialRequest) ? ' It was sent with the anchor picture as a reference picture: a generator that takes none needs --no-anchor.' : '')),
  );
  const held = materials.filter((m) => m.waiting && !m.confirm).map((m) =>
    error(m.file, 'It was not sent: it waits for ' + m.waitsFor + ' (' + why(m) + '), and that clip is not there' + (materials.some((x) => x.file === m.waitsFor && !x.error && !x.waiting) ? ' as a file a frame can be read from' : '') + '. Nothing was charged for it.',
      'Get ' + m.waitsFor + ' made first (its own problem says how; a file no frame can be read from is deleted and made again), then run the command again.' + (m.waitsFor === anchorFile ? ' --no-anchor makes the clips now, without a shared picture.' : '')));
  const loose = materials.filter((m) => m.unanchored).map((m) => warning(m.file, 'It was made without ' + (o.requests.some((r) => r.file === m.file && r.continues) ? 'the frame it should start from' : 'the anchor picture') + ': the generator was asked for its price only ("priceOnly": true in the request) while ' + m.waitsFor + ' waited for the user\'s agreement, and made the clip.', 'Look at it beside the other clips; when it does not match them, delete the file and run the command again once ' + m.waitsFor + ' exists.'));
  const asked = materials.filter((m) => m.confirm);
  const toConfirm = asked.length ? { toConfirm: { credits: asked.reduce((n, m) => n + (m.confirm?.credits ?? 0), 0), materials: asked.length } } : {};
  return { materials, credits: materials.reduce((n, m) => n + (m.credits ?? 0), 0), problems: [...failed, ...held, ...loose], ...(source && picture ? { anchor: { picture, from: source } } : {}), ...toConfirm };
};
