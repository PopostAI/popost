/**
 * Swap tests (design section 9): a template is filled with several different inputs, and every fill must pass the
 * program checks and keep the template's structure. Each fill is checked, filled, checked as a project and for its
 * layout, rendered small, measured, and its structure is scored against the template's own structure on the clock the
 * fill ends up with (the structure and transitions dimensions of scoreMeasures). The result is evidence.json.
 */
import type { Runtime } from '../../runtime';
import type { RetargetPlan } from '../retarget/index';
import type { Measure, Problem } from '../types';
import { buildPage } from '../compile/index';
import { measureVideo } from '../measure/index';
import { hasErrors } from '../project/check';
import { checkLayout, renderVideo } from '../render/index';
import { ENCODER_THREADS } from '../eval/roundtrip';
import { scoreMeasures } from '../score/index';
import { charsOf, probeText } from './capacity';
import { checkFill, kindsOf } from './check';
import { fillPackage, STRUCTURE_FILE } from './fill';
import { jsonText, loadTemplate } from './save';
import { FILES, type Evidence, type FillEvidence, type SwapStage, type TemplatePackage } from './types';

/** A fill passes when its structure score is at least the best fill's minus this (and every check passed). */
export const SWAP_MARGIN = 0.05;

/** Ground colours for generated fills: neighbours differ strongly in lightness and hue, so every cut shows. */
const PALETTE = ['#1d3557', '#f4a261', '#2a9d8f', '#f1faee', '#6a4c93', '#e9c46a', '#264653', '#e76f51'];

export interface SwapFill { name: string; fill: RetargetPlan; assetsDir?: string }

/**
 * Fills that need no assets: a colour for every shot, and caption lines of three lengths in the template's script:
 * short (30% of the capacity), at the capacity (the probe text the capacity was measured with), and 30% over it, which
 * checkFill must refuse. A template without captions gets one fill of colours.
 */
export const generatedFills = (pkg: TemplatePackage): SwapFill[] => {
  const shots = pkg.template.shots.map((_s, k) => ({ color: PALETTE[k % PALETTE.length] ?? '#000000' }));
  const cap = pkg.slots.captions?.capacity;
  const beats = pkg.template.captions?.beats ?? [];
  if (!cap || !beats.length) return [{ name: 'colours', fill: { shots } }];
  const script = pkg.template.captions?.script ?? 'latin';
  const holds = script === 'cjk' ? cap.cjk : cap.latin;
  const lines = (n: number): string[] => beats.map((_b, i) => probeText(script, i, n));
  return [
    { name: 'short', fill: { shots, captions: lines(Math.max(1, Math.round(holds * 0.3))) } },
    { name: 'at-capacity', fill: { shots, captions: lines(holds) } },
    // Two over at least, because a Latin probe that ends in a space loses it.
    { name: 'over-capacity', fill: { shots, captions: lines(Math.max(holds + 2, Math.ceil(holds * 1.3))) } },
  ];
};

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const firstError = (ps: Problem[]): string => {
  const p = ps.find((x) => x.level === 'error');
  return p ? p.at + ': ' + p.message : 'no error was reported';
};

const triedOf = (fill: RetargetPlan): FillEvidence['tried'] => ({
  shots: (Array.isArray(fill.shots) ? fill.shots : []).map((s) => kindsOf(s).join('+') || '?'),
  captions: (fill.captions ?? []).map((l) => (typeof l === 'string' ? charsOf(l).length : 0)),
});

/** One fill through every step; the first step that fails ends it. */
const runFill = async (rt: Runtime, pkg: TemplatePackage, f: SwapFill, dir: string, scale: number): Promise<FillEvidence> => {
  const t0 = Date.now();
  let stage: SwapStage = 'check';
  const tried = triedOf(f.fill);
  const stop = (reason: string, problems: Problem[] = []): FillEvidence =>
    ({ name: f.name, tried, passed: false, stage, reason, problems: problems.filter((p) => p.level === 'error').slice(0, 5), seconds: r3((Date.now() - t0) / 1000) });
  try {
    await rt.fs.rm(dir);
    const checked = await checkFill(rt, pkg, f.fill, f.assetsDir ? { dir: f.assetsDir } : {});
    if (hasErrors(checked)) return stop('refused by checkFill: ' + firstError(checked), checked);
    stage = 'fill';
    const filled = await fillPackage(rt, pkg, { fill: f.fill, outDir: dir, ...(f.assetsDir ? { assetsDir: f.assetsDir } : {}) });
    if (!filled.project) return stop('the fill made no project: ' + firstError(filled.problems), filled.problems);
    stage = 'project';
    const page = await buildPage(rt, dir);
    if (hasErrors(page.problems)) return stop('the project check failed: ' + firstError(page.problems), page.problems);
    stage = 'layout';
    const layout = await checkLayout(rt, dir);
    if (hasErrors(layout)) return stop('text does not fit: ' + firstError(layout), layout);
    stage = 'render';
    const video = rt.path.join(dir, 'render.mp4');
    // Encoded with a fixed number of threads, as the round trip is: the encoder's output, and so the scores, depend on it.
    await renderVideo(rt, { projectDir: dir, out: video, scale, encoderThreads: ENCODER_THREADS });
    stage = 'measure';
    const measured = await measureVideo(rt, video);
    await rt.fs.writeFile(rt.path.join(dir, 'replica.measure.json'), jsonText(measured));
    const expected = JSON.parse(await rt.fs.readText(rt.path.join(dir, STRUCTURE_FILE))) as Measure;
    const { structure, transitions } = scoreMeasures(expected, measured).dimensions;
    const detail = { ...structure.detail, kind: transitions.detail.kind ?? '-', spanOverlap: transitions.detail.spanOverlap ?? '-' };
    return { name: f.name, tried, passed: true, stage: 'done', reason: '', problems: [], scores: { structure: structure.score, transitions: transitions.score, detail }, frames: expected.source.frames, seconds: r3((Date.now() - t0) / 1000) };
  } catch (e) {
    return stop('failed: ' + (e instanceof Error ? e.message : String(e)).split('\n')[0]);
  }
};

export interface SwapOptions {
  templateDir: string;
  fills: SwapFill[];
  /** Each fill's project, render and measurements go to workDir/<fill name>/. */
  workDir: string;
  /** Render scale; default: the longer side about 320 pixels. */
  scale?: number;
  onFill?: (name: string, done: number, total: number) => void;
}

/** Runs the swap tests and writes evidence.json into the template directory. */
export const swapTest = async (rt: Runtime, o: SwapOptions): Promise<Evidence> => {
  const t0 = Date.now();
  const pkg = await loadTemplate(rt, o.templateDir);
  const { width, height } = pkg.template.canvas;
  const scale = o.scale ?? Math.min(1, 320 / Math.max(width, height));
  const runs: FillEvidence[] = [];
  for (const [i, f] of o.fills.entries()) {
    runs.push(await runFill(rt, pkg, f, rt.path.join(o.workDir, f.name.replace(/[^\w.-]+/g, '-')), scale));
    o.onFill?.(f.name, i + 1, o.fills.length);
  }
  const best = Math.max(0, ...runs.flatMap((r) => (r.scores ? [r.scores.structure] : [])));
  const fills = runs.map((r): FillEvidence => {
    if (!r.scores) return r;
    const passed = r.scores.structure >= best - SWAP_MARGIN - 1e-9;
    return { ...r, passed, reason: 'structure ' + r.scores.structure + (passed ? ' is within ' : ' is more than ') + SWAP_MARGIN + ' of the best fill (' + best + ')' };
  });
  const evidence: Evidence = { template: pkg.template.name, measure: pkg.template.source.measure, margin: SWAP_MARGIN, scale: r3(scale), best, fills, seconds: r3((Date.now() - t0) / 1000) };
  await rt.fs.writeFile(rt.path.join(o.templateDir, FILES.evidence), jsonText(evidence));
  return evidence;
};
