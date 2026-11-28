import type { Runtime } from '../../runtime';
import { sha256 } from '../../core/util';
import { probe } from '../media/ffmpeg';
import type { Problem } from '../types';

export const PAIRS_FILE = 'replication.pairs.json';
export interface PairTrim { in: number; out: number; unit: 'frames' | 'seconds' }
export interface PairSide {
  file: string;
  sha256: string;
  source: string;
  product?: string;
  character?: string;
  stage?: string;
  sourceFps: number;
  /** End is exclusive. Frame values always use this side's sourceFps, never the project clock. */
  trim: PairTrim;
}
export interface PairEvidence {
  kind: 'observed' | 'measured' | 'user' | 'unknown';
  source: string;
  sourcePairId: string;
  referenceSha256: string;
  remakeSha256: string;
  detail: string;
}
export interface VideoPair {
  id: string;
  sourcePairId?: string;
  relationship?: string;
  reference: PairSide;
  remake: PairSide;
  evidence?: PairEvidence[];
}
export interface PairManifest { version: 1; pairs: VideoPair[] }
export interface PairUse {
  pairId: string;
  side: 'reference' | 'remake';
  file: string;
  sourceFps: number;
  trim: PairTrim;
}
export interface PairFileFacts { sha256: string; fps: number; frames: number }
export interface PairValidationOptions { uses?: readonly PairUse[]; files?: Readonly<Record<string, PairFileFacts>> }
export interface PairAudit {
  status: 'verified' | 'pending' | 'invalid';
  problems: Problem[];
  pairs: VideoPair[];
}
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f\d]{64}$/i.test(v);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const relativeFile = (v: unknown): v is string => text(v) && !/^(?:\/|[a-z]:|[a-z][\w+.-]*:)/i.test(v.replace(/\\/g, '/')) && !v.replace(/\\/g, '/').split('/').includes('..');
const sameHash = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const sameFps = (a: number, b: number): boolean => Math.abs(a - b) < 0.01;
const seconds = (t: PairTrim, fps: number): [number, number] => t.unit === 'frames' ? [t.in / fps, t.out / fps] : [t.in, t.out];
const issue = (problems: Problem[], at: string, message: string, pending = false): void => {
  problems.push({ level: pending ? 'warning' : 'error', at, message, fix: pending ? 'Supply observed or user-provided pairing evidence; leave the semantic decision pending until it is known.' : 'Correct the pairing manifest or source-clock mapping before using the comparison.' });
};
const validTrim = (value: unknown, at: string, ps: Problem[]): value is PairTrim => {
  if (!object(value) || (value.unit !== 'frames' && value.unit !== 'seconds') || typeof value.in !== 'number' || typeof value.out !== 'number' ||
      !Number.isFinite(value.in) || !Number.isFinite(value.out) || value.in < 0 || value.out <= value.in ||
      (value.unit === 'frames' && (!Number.isInteger(value.in) || !Number.isInteger(value.out)))) {
    issue(ps, at, 'A trim needs increasing nonnegative in/out and an explicit unit: frames (whole source frames) or seconds.');
    return false;
  }
  return true;
};
const validSide = (value: unknown, at: string, ps: Problem[]): value is PairSide => {
  if (!object(value)) { issue(ps, at, 'A pair side must describe its real local source file.'); return false; }
  let valid = true;
  if (!relativeFile(value.file)) { issue(ps, at + '.file', 'Use a nonempty project-relative source file inside the project.'); valid = false; }
  if (!hash(value.sha256)) { issue(ps, at + '.sha256', 'Record the real source file SHA256.'); valid = false; }
  if (!text(value.source)) { issue(ps, at + '.source', 'The original URL, attachment or captured-file provenance is unknown.', true); }
  if (!positive(value.sourceFps)) { issue(ps, at + '.sourceFps', 'Record this file\'s actual source FPS, not the project FPS.'); valid = false; }
  if (!validTrim(value.trim, at + '.trim', ps)) valid = false;
  for (const field of ['product', 'character', 'stage'] as const) {
    if (!text(value[field])) issue(ps, at + '.' + field, 'The ' + field + ' of this side has not been identified. Use an explicit description, or "none" if it is genuinely absent.', true);
  }
  return valid;
};

/** Checks evidence and known file facts, never guesses a product, actor or relationship from a filename or hash. */
export const validatePairs = (value: unknown, o: PairValidationOptions = {}): PairAudit => {
  const ps: Problem[] = [], pairs: VideoPair[] = [];
  if (!object(value) || value.version !== 1 || !Array.isArray(value.pairs)) {
    issue(ps, 'pairs', 'A pairing manifest needs {"version":1,"pairs":[...]}.');
    return { status: 'invalid', problems: ps, pairs };
  }
  const ids = new Set<string>();
  value.pairs.forEach((raw: unknown, index: number) => {
    const at = 'pairs[' + index + ']';
    if (!object(raw) || !text(raw.id) || !/^[\w-]+$/.test(raw.id) || ids.has(raw.id)) { issue(ps, at + '.id', 'Each comparison needs a unique pair id.'); return; }
    ids.add(raw.id);
    const referenceOK = validSide(raw.reference, at + '.reference', ps), remakeOK = validSide(raw.remake, at + '.remake', ps);
    if (!referenceOK || !remakeOK) return;
    const p = raw as unknown as VideoPair;
    pairs.push(p);
    if (p.reference.file === p.remake.file || sameHash(p.reference.sha256, p.remake.sha256)) issue(ps, at, 'The same source file or identical bytes are presented as both the reference and its remake. Different labels or crops do not establish a new video.');
    if (!text(p.sourcePairId)) issue(ps, at + '.sourcePairId', 'The original declared pair id is unknown.', true);
    if (!text(p.relationship)) issue(ps, at + '.relationship', 'The semantic relationship between the two sides is unknown.', true);
    if (raw.evidence !== undefined && !Array.isArray(raw.evidence)) issue(ps, at + '.evidence', 'Pair evidence must be a list.');
    const ev = Array.isArray(raw.evidence) ? raw.evidence : [];
    if (!ev.length) issue(ps, at + '.evidence', 'Different SHA256 values alone do not verify a semantic pairing.', true);
    if (ev.length && !ev.some((e: unknown) => object(e) && (e.kind === 'observed' || e.kind === 'user'))) issue(ps, at + '.relationship', 'Measurements alone do not establish a product, character or narrative relationship; an observed or user-declared pairing is still pending.', true);
    ev.forEach((e: unknown, j: number) => {
      const here = at + '.evidence[' + j + ']';
      if (!object(e) || !['observed', 'measured', 'user', 'unknown'].includes(String(e.kind)) || !text(e.source) || !text(e.detail)) { issue(ps, here, 'Evidence needs its kind, real source and a description of what was established.'); return; }
      if (e.kind === 'unknown') issue(ps, here, 'Pair semantics remain unknown; no automatic content recognition has verified them.', true);
      if (!text(e.sourcePairId) || !hash(e.referenceSha256) || !hash(e.remakeSha256)) { issue(ps, here, 'The evidence has not bound a sourcePairId to both exact source hashes.', true); return; }
      if (e.sourcePairId !== p.sourcePairId || !sameHash(e.referenceSha256, p.reference.sha256) || !sameHash(e.remakeSha256, p.remake.sha256)) issue(ps, here, 'This evidence belongs to a different declared pair or different reference/remake bytes.');
    });
    for (const side of ['reference', 'remake'] as const) {
      const s = p[side], f = o.files?.[s.file], here = at + '.' + side;
      if (!f) { issue(ps, here + '.file', 'The actual bytes and source clock have not yet been checked.', true); continue; }
      if (!hash(f.sha256) || !positive(f.fps) || !Number.isInteger(f.frames) || f.frames <= 0) { issue(ps, here + '.file', 'Actual file facts need a SHA256, source FPS and positive whole frame count.'); continue; }
      if (!sameHash(s.sha256, f.sha256)) issue(ps, here + '.sha256', 'The actual file bytes differ from the declared source SHA256.');
      if (!sameFps(s.sourceFps, f.fps)) issue(ps, here + '.sourceFps', 'Declared source FPS ' + s.sourceFps + ' differs from actual source FPS ' + f.fps + '; source frames cannot use the project clock.');
      if (seconds(s.trim, s.sourceFps)[1] > f.frames / f.fps + 1 / f.fps) issue(ps, here + '.trim', 'The declared source interval extends beyond the real file.');
    }
  });
  for (const [index, rawUse] of (o.uses ?? []).entries()) {
    const at = 'uses[' + index + ']';
    if (!object(rawUse)) { issue(ps, at, 'A paired use must be an object describing its pair, side and source-clock interval.'); continue; }
    const use = rawUse as unknown as PairUse, p = pairs.find((p) => p.id === use.pairId);
    if (!p) { issue(ps, at + '.pairId', 'The comparison uses an unknown pair id.'); continue; }
    if (use.side !== 'reference' && use.side !== 'remake') { issue(ps, at + '.side', 'A paired use must name reference or remake.'); continue; }
    const s = p[use.side];
    if (use.file !== s.file) issue(ps, at + '.file', 'This file is not the declared ' + use.side + ' of pair "' + p.id + '".');
    if (!positive(use.sourceFps) || !sameFps(use.sourceFps, s.sourceFps)) { issue(ps, at + '.sourceFps', 'This use changes the declared source FPS; convert project frames explicitly before selecting source frames.'); continue; }
    if (!validTrim(use.trim, at + '.trim', ps)) continue;
    const [a, b] = seconds(use.trim, use.sourceFps), [lo, hi] = seconds(s.trim, s.sourceFps), tolerance = 1 / s.sourceFps;
    if (a < lo - tolerance || b > hi + tolerance) issue(ps, at + '.trim', 'This use falls outside the declared narrative-stage interval on the source clock.');
  }
  return { status: ps.some((p) => p.level === 'error') ? 'invalid' : ps.length ? 'pending' : 'verified', problems: ps, pairs };
};

export const readPairs = async (rt: Runtime, dir: string, file = PAIRS_FILE): Promise<PairManifest> => {
  const value: unknown = JSON.parse(await rt.fs.readText(rt.path.join(dir, file)));
  const result = validatePairs(value);
  if (result.status === 'invalid') throw new Error(result.problems.filter((p) => p.level === 'error').map((p) => p.at + ': ' + p.message).join('\n'));
  return value as PairManifest;
};

/** Local-only verification; no parsing, generation, account call or remote media request is made here. */
export const checkPairs = async (rt: Runtime, dir: string, value: unknown, o: { uses?: readonly PairUse[]; probe?: typeof probe } = {}): Promise<PairAudit> => {
  const parsed = validatePairs(value), files: Record<string, PairFileFacts> = {}, failures: Problem[] = [];
  for (const file of new Set(parsed.pairs.flatMap((p) => [p.reference.file, p.remake.file]))) {
    try {
      const path = rt.path.resolve(dir, file), bytes = await rt.fs.readFile(path), measured = await (o.probe ?? probe)(rt, path);
      files[file] = { sha256: sha256(bytes), fps: measured.fps, frames: measured.frames };
    } catch {
      issue(failures, 'files.' + file, 'The declared source file could not be read and measured locally.');
    }
  }
  const result = validatePairs(value, { files, ...(o.uses ? { uses: o.uses } : {}) });
  result.problems.push(...failures);
  if (failures.length) result.status = 'invalid';
  return result;
};
