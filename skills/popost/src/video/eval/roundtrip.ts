/**
 * The synthetic round trip: random project -> render -> measure -> compare with the truth the project implies.
 * It answers one question: how well does the measurement read what the renderer drew?
 */
import type { Runtime } from '../../runtime';
import { buildPage } from '../compile/index';
import { measureVideo } from '../measure/index';
import { renderVideo } from '../render/index';
import { scoreMeasures } from '../score/index';
import { synthCase, type SynthOptions } from '../synth/generate';
import { truthMeasure } from '../synth/truth';
import { writeCase } from '../synth/write';
import type { Boundary, Measure, MotionEvent, Score } from '../types';

/**
 * Threads of the encoder of every render, whatever the CPU budget: x264 writes other bytes for another count, and the
 * scores of the same release moved with them (eval-r5, seeds 1-40: 0.869 / 0.8162 at a budget of 3, 0.8682 / 0.8176
 * at 4). Fixed, ledger lines compare across machines and budgets.
 */
export const ENCODER_THREADS = 4;

export interface RoundTripOptions {
  seeds: number[];
  workDir: string;
  /** Render scale. The measurement works on thumbnails, so a small render is enough. Default 0.25. */
  scale?: number;
  synth?: Omit<SynthOptions, 'seed'>;
  keep?: boolean;
  onCase?: (done: number, total: number, seed: number) => void;
}

export interface KindStat { truth: number; found: number; kindRight: number; startError: number; endError: number; directionRight: number; directed: number }
export interface EventStat { truth: number; found: number; howRight: number; startError: number; directionRight: number; directed: number; easeRight: number }

export interface RoundTripCase { seed: number; frames: number; score: Score; falseBoundaries: number; falseEvents: number; renderMs: number; measureMs: number }
export interface RoundTripResult {
  cases: RoundTripCase[];
  /** By the true transition kind. */
  boundaries: Record<string, KindStat>;
  /** By the true entrance / exit ('appear:pop', 'disappear:fade' ...). */
  events: Record<string, EventStat>;
  camera: { shots: number; kindRight: number; zoomError: number; panError: number };
  falseBoundaries: number;
  falseEvents: number;
}

const TOLERANCE = 3;

/** Pairs each true boundary with the nearest measured one within the tolerance; each measured one is used once. */
const pairBoundaries = (truth: Boundary[], found: Boundary[]): [Boundary, Boundary | undefined][] => {
  const used = new Set<number>();
  return truth.map((t) => {
    let best = -1;
    let bestDistance = Infinity;
    found.forEach((f, i) => {
      // A measured boundary matches when its takeover frame, or any frame of its span, is near the true span.
      const d = f.end < t.start ? t.start - f.end : f.start > t.end ? f.start - t.end : 0;
      const distance = d + Math.abs(f.frame - t.frame) / 100;
      if (!used.has(i) && d <= TOLERANCE && distance < bestDistance) { best = i; bestDistance = distance; }
    });
    if (best >= 0) used.add(best);
    return [t, best >= 0 ? found[best] : undefined];
  });
};

const boxOverlap = (a: MotionEvent['box'], b: MotionEvent['box']): number => {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return w <= 0 || h <= 0 ? 0 : (w * h) / Math.min(a[2] * a[3], b[2] * b[3]);
};

const pairEvents = (truth: MotionEvent[], found: MotionEvent[]): [MotionEvent, MotionEvent | undefined][] => {
  const used = new Set<number>();
  return truth.map((t) => {
    const i = found.findIndex((f, k) => !used.has(k) && f.kind === t.kind && f.start < t.end + 4 && f.end > t.start - 4 && boxOverlap(f.box, t.box) > 0.3);
    if (i >= 0) used.add(i);
    return [t, i >= 0 ? found[i] : undefined];
  });
};

const bump = <T extends object>(table: Record<string, T>, key: string, empty: T): T => (table[key] ??= { ...empty });

const tally = (truth: Measure, found: Measure, result: RoundTripResult): { falseBoundaries: number; falseEvents: number } => {
  const pairs = pairBoundaries(truth.boundaries, found.boundaries);
  for (const [t, f] of pairs) {
    const s = bump(result.boundaries, t.kind, { truth: 0, found: 0, kindRight: 0, startError: 0, endError: 0, directionRight: 0, directed: 0 });
    s.truth++;
    if (!f) continue;
    s.found++;
    if (f.kind === t.kind) s.kindRight++;
    s.startError += Math.abs(f.start - t.start);
    s.endError += Math.abs(f.end - t.end);
    if (t.direction) { s.directed++; if (f.direction === t.direction && (t.mode === undefined || f.mode === t.mode)) s.directionRight++; }
  }
  const falseBoundaries = found.boundaries.length - pairs.filter(([, f]) => f).length;
  let falseEvents = 0;
  truth.shots.forEach((shot, k) => {
    const other = found.shots.filter((s) => s.start < shot.end && s.end > shot.start).flatMap((s) => s.events);
    const eventPairs = pairEvents(shot.events, other);
    for (const [t, f] of eventPairs) {
      const s = bump(result.events, t.kind + ':' + (t.how ?? '?'), { truth: 0, found: 0, howRight: 0, startError: 0, directionRight: 0, directed: 0, easeRight: 0 });
      s.truth++;
      if (!f) continue;
      s.found++;
      if (f.how === t.how) s.howRight++;
      s.startError += Math.abs(f.start - t.start);
      if (f.ease === t.ease) s.easeRight++;
      if (t.direction) { s.directed++; if (f.direction === t.direction) s.directionRight++; }
    }
    falseEvents += other.filter((e) => e.start >= shot.start && e.start < shot.end).length - eventPairs.filter(([, f]) => f).length;
    const measured = found.shots.find((s) => s.start <= (shot.start + shot.end) / 2 && s.end > (shot.start + shot.end) / 2);
    if (measured && k < truth.shots.length) {
      result.camera.shots++;
      const moving = (c: typeof shot.camera): boolean => c.kind === 'move';
      if (moving(measured.camera) === moving(shot.camera)) result.camera.kindRight++;
      result.camera.zoomError += Math.abs(measured.camera.zoomPerS - shot.camera.zoomPerS);
      result.camera.panError += Math.hypot(measured.camera.panPerS[0] - shot.camera.panPerS[0], measured.camera.panPerS[1] - shot.camera.panPerS[1]);
    }
  });
  return { falseBoundaries, falseEvents: Math.max(0, falseEvents) };
};

export const runRoundTrip = async (rt: Runtime, o: RoundTripOptions): Promise<RoundTripResult> => {
  const scale = o.scale ?? 0.25;
  const result: RoundTripResult = { cases: [], boundaries: {}, events: {}, camera: { shots: 0, kindRight: 0, zoomError: 0, panError: 0 }, falseBoundaries: 0, falseEvents: 0 };
  await rt.fs.mkdir(o.workDir);
  let done = 0;
  for (const seed of o.seeds) {
    const dir = rt.path.join(o.workDir, 'case-' + seed);
    const c = synthCase({ ...o.synth, seed });
    await writeCase(rt, c, dir, Math.min(1, scale * 2));
    const page = await buildPage(rt, dir);
    if (!page.resolved) throw new Error('Synthetic case ' + seed + ' does not pass check: ' + JSON.stringify(page.problems.filter((p) => p.level === 'error').slice(0, 3)));
    const truth = truthMeasure(page.resolved);
    const out = rt.path.join(dir, 'render.mp4');
    const t0 = Date.now();
    await renderVideo(rt, { projectDir: dir, out, scale, encoderThreads: ENCODER_THREADS });
    const t1 = Date.now();
    const found = await measureVideo(rt, out);
    const t2 = Date.now();
    const counts = tally(truth, found, result);
    result.falseBoundaries += counts.falseBoundaries;
    result.falseEvents += counts.falseEvents;
    const score = scoreMeasures(truth, found);
    result.cases.push({ seed, frames: page.resolved.frames, score, ...counts, renderMs: t1 - t0, measureMs: t2 - t1 });
    await rt.fs.writeFile(rt.path.join(dir, 'truth.json'), JSON.stringify(truth, null, 2));
    await rt.fs.writeFile(rt.path.join(dir, 'measure.json'), JSON.stringify(found, null, 2));
    if (!o.keep) await rt.fs.rm(out);
    o.onCase?.(++done, o.seeds.length, seed);
  }
  return result;
};

const pct = (a: number, b: number): string => (b ? ((100 * a) / b).toFixed(0) + '%' : '-');
const avg = (a: number, b: number): string => (b ? (a / b).toFixed(2) : '-');

/** The result as plain-text tables for the terminal and for PROGRESS notes. */
export const formatRoundTrip = (r: RoundTripResult): string => {
  const lines: string[] = [];
  lines.push('cases ' + r.cases.length + ', false boundaries ' + r.falseBoundaries + ', false events ' + r.falseEvents);
  lines.push('', 'boundary kind      truth  found  kind-right  start-err  end-err  direction');
  for (const [k, s] of Object.entries(r.boundaries).sort()) {
    lines.push(k.padEnd(18) + String(s.truth).padStart(5) + pct(s.found, s.truth).padStart(7) + pct(s.kindRight, s.found).padStart(12) + avg(s.startError, s.found).padStart(11) + avg(s.endError, s.found).padStart(9) + pct(s.directionRight, s.directed).padStart(11));
  }
  lines.push('', 'element event      truth  found  how-right  start-err  ease-right  direction');
  for (const [k, s] of Object.entries(r.events).sort()) {
    lines.push(k.padEnd(18) + String(s.truth).padStart(5) + pct(s.found, s.truth).padStart(7) + pct(s.howRight, s.found).padStart(11) + avg(s.startError, s.found).padStart(11) + pct(s.easeRight, s.found).padStart(12) + pct(s.directionRight, s.directed).padStart(11));
  }
  const c = r.camera;
  lines.push('', 'camera: ' + c.shots + ' shots, moving-or-not right ' + pct(c.kindRight, c.shots) + ', mean zoom error ' + avg(c.zoomError, c.shots) + ' /s, mean pan error ' + avg(c.panError, c.shots) + ' /s');
  return lines.join('\n');
};

/** Mean of each score dimension over the cases where it had something to compare. */
export const meanScores = (cases: { score: Score }[]): Record<string, number> => {
  const out: Record<string, number> = {};
  const dims = new Set(cases.flatMap((c) => Object.keys(c.score.dimensions)));
  for (const d of dims) {
    const xs = cases.map((c) => c.score.dimensions[d as keyof Score['dimensions']]).filter((x) => x && x.n > 0);
    if (xs.length) out[d] = Number((xs.reduce((s, x) => s + x.score, 0) / xs.length).toFixed(4));
  }
  out.composite = Number((cases.reduce((s, c) => s + c.score.composite, 0) / Math.max(1, cases.length)).toFixed(4));
  return out;
};
