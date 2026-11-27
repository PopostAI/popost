/**
 * The clips the user agreed to pay for, per project: production/approved-clips.json. Generated video is the expensive
 * item, so the built-in generator (cloud.ts) pays for a clip only when it is one of them; any other paid clip (a new
 * one, a regeneration or variant, a changed request: another prompt, length, resolution, model or reference) is
 * "unplanned" and stops with exit code 3 and { confirm: { credits, reason: "unplanned", clip } }, whatever the budget,
 * until the user said yes to that one clip (--approve-unplanned <key>).
 *
 * The record has two lists. `plan`: the clips the first `popost video materials --confirm --max-credits N` of the
 * project was asked for, by file and by a hash of the request as written; each is made once (its key is kept), and a
 * run cut short goes on with the rest. `clips`: every clip paid for under the agreement, by its request key (the
 * idempotency key of the built-in generator), with what it shows and the agreed price. Running an approved key again
 * is not new: it picks up or downloads the clip it already paid for. Pictures and speech are not in it: the budget
 * alone covers them.
 */
import { sha256, writeJson } from '../../core/util';
import { isRecord } from '../../providers/base';
import type { Runtime } from '../../runtime';

export const APPROVED_FILE = 'production/approved-clips.json';

/** A clip paid for under the agreement. */
export interface ApprovedClip {
  /** The request key: the idempotency key of its first attempt (a retry after a failure keeps it). */
  readonly key: string;
  /** Where it goes in the project. */
  readonly file?: string;
  /** What it shows: the start of its prompt. */
  readonly what: string;
  readonly seconds?: number;
  /** The agreed price. */
  readonly credits: number;
  /** plan: one of the clips of the agreed list; user: approved on its own with --approve-unplanned. */
  readonly by: 'plan' | 'user';
  readonly at: string;
}

/** A clip of the agreed list: its file, the hash of its request as written, and its key once it is made. */
export interface PlannedClip {
  readonly file: string;
  readonly request: string;
  readonly key?: string;
}

export interface ClipRecord {
  readonly plan: readonly PlannedClip[];
  readonly clips: readonly ApprovedClip[];
}

/** What a paid clip that was not agreed to says: the confirm.clip of exit code 3. */
export interface UnplannedClip {
  readonly key: string;
  readonly file?: string;
  readonly what: string;
  readonly seconds?: number;
  readonly aspect?: string;
}

/** Where the built-in generator looks for the agreement of a clip, and what the caller says about it. */
export interface ClipGate {
  /** The project directory; its production/approved-clips.json is the agreement. */
  readonly project: string;
  /** The clip's file in the project, as materials names it. */
  readonly file?: string;
  /** Set by materials: the hash of the request as written (requestHash), for a run under the agreed plan. */
  readonly planned?: string;
  /** Keys the user approved one by one (--approve-unplanned). */
  readonly approve: readonly string[];
}

export const recordPath = (rt: Runtime, project: string): string => rt.path.join(project, APPROVED_FILE);

/** The record of a project, or undefined when it has none (no confirmed materials run yet: nothing is gated). */
export const readClipRecord = async (rt: Runtime, project: string): Promise<ClipRecord | undefined> => {
  const file = recordPath(rt, project);
  const text = await rt.fs.readText(file).catch(() => undefined);
  if (text === undefined) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    data = undefined;
  }
  // A record that cannot be read is never taken for "nothing agreed".
  if (!isRecord(data)) throw new Error(file + ' is not the JSON object of the clips the user agreed to; nothing was charged. Restore it before any clip is made.');
  return { plan: Array.isArray(data.plan) ? (data.plan as PlannedClip[]) : [], clips: Array.isArray(data.clips) ? (data.clips as ApprovedClip[]) : [] };
};

const writeClipRecord = async (rt: Runtime, project: string, record: ClipRecord): Promise<void> => {
  await rt.fs.mkdir(rt.path.join(project, 'production'));
  await writeJson(rt, recordPath(rt, project), record);
};

/**
 * The hash of a request of the materials list as written (its note aside: it only describes the clip), with the model
 * and resolution of the environment: another prompt, length, aspect, reference, model or resolution is another request.
 */
export const requestHash = (rt: Runtime, request: { readonly note?: unknown }): string =>
  sha256(JSON.stringify({ request: { ...request, note: undefined }, model: rt.env.POPOST_VIDEO_MODEL?.trim() || null, resolution: rt.env.POPOST_VIDEO_RESOLUTION?.trim() || null }));

/** The first confirmed materials run of a project that asks for clips makes its list the plan; later runs leave it. */
export const startPlan = async (rt: Runtime, project: string, planned: readonly PlannedClip[]): Promise<void> => {
  const record = await readClipRecord(rt, project);
  if (!planned.length || (record && (record.plan.length || record.clips.length))) return;
  await writeClipRecord(rt, project, { plan: [...planned], clips: [] });
};

/**
 * How a paid clip under `key` stands: 'agreed' (paid before: nothing new), 'plan' or 'user' (to be recorded once it is
 * paid), or 'unplanned'. undefined: the project has no agreement, so nothing is gated.
 */
export const clipStanding = async (rt: Runtime, gate: ClipGate, key: string): Promise<'agreed' | 'plan' | 'user' | 'unplanned' | undefined> => {
  const record = await readClipRecord(rt, gate.project);
  if (!record) return undefined;
  if (record.clips.some((c) => c.key === key)) return 'agreed';
  const entry = gate.planned && gate.file ? record.plan.find((p) => p.file === gate.file && p.request === gate.planned) : undefined;
  if (entry && (entry.key === undefined || entry.key === key)) return 'plan';
  return gate.approve.includes(key) ? 'user' : 'unplanned';
};

/** Adds a clip that was just paid for to the record, and gives its plan entry the key. */
export const recordClip = async (rt: Runtime, gate: ClipGate, clip: Omit<ApprovedClip, 'at'>): Promise<void> => {
  const record = (await readClipRecord(rt, gate.project)) ?? { plan: [], clips: [] };
  if (record.clips.some((c) => c.key === clip.key)) return;
  const plan = record.plan.map((p) => (clip.by === 'plan' && p.file === gate.file && p.request === gate.planned && p.key === undefined ? { ...p, key: clip.key } : p));
  await writeClipRecord(rt, gate.project, { plan, clips: [...record.clips, { ...clip, at: rt.now().toISOString() }] });
};

/** The start of a prompt, for the record and for the user. */
export const shortWhat = (prompt: string): string => (prompt.length > 160 ? prompt.slice(0, 157).trimEnd() + '...' : prompt);

/**
 * The project of a clip made outside materials: the nearest folder above `out` that has production/approved-clips.json.
 * A clip written into a project with an agreement is gated even when the generator is called on its own.
 */
export const projectOf = async (rt: Runtime, out: string): Promise<string | undefined> => {
  for (let dir = rt.path.dirname(out); ; dir = rt.path.dirname(dir)) {
    if (await rt.fs.stat(recordPath(rt, dir))) return dir;
    if (rt.path.dirname(dir) === dir) return undefined;
  }
};
