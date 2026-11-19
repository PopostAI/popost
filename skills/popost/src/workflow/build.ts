/**
 * Structural readiness and artifact-bound delivery checks (port of `build.py`). Visual judgment stays with the agent:
 * `build` only checks that the files, the plan and the recorded reviews are there and still match the current render.
 */
import { Parser } from 'htmlparser2';
import type { Project } from '../core/project';
import { pageFingerprint } from '../core/fingerprint';
import { isObject, deepEqual, truthy } from '../core/pyjson';
import { isFile, sha256File, writeJson } from '../core/util';
import { fromCwd, readUserJson, splitLines } from './io';
import * as postBundle from './post-bundle';
import * as seriesPlan from './series-plan';
import { locateSkill } from './template-plugins';

export interface BuildReport {
  structureReady: boolean;
  visualQa: 'pending' | 'reviewed-by-agent';
  readyToDeliver: boolean;
  mode: string;
  blockers: string[];
  reviewGaps: string[];
  warnings: string[];
  concept: Record<string, unknown>;
}

interface Canvas {
  found: boolean;
  layers: string[];
}

/** Does the page have a `post`/`page` root class, and which `data-layer-id`s does it declare. */
export const scanCanvas = (html: string): Canvas => {
  const canvas: Canvas = { found: false, layers: [] };
  let attrs: Record<string, string> = {};
  const parser = new Parser({
    onopentagname: () => {
      attrs = {}; // a repeated attribute keeps its last value, as Python's dict(attrs) does
    },
    onattribute: (name, value) => {
      attrs[name] = value;
    },
    onopentag: () => {
      if ((attrs.class ?? '').split(/\s+/).some((token) => token === 'post' || token === 'page')) canvas.found = true;
      if ('data-layer-id' in attrs) canvas.layers.push(attrs['data-layer-id']!);
    },
  });
  parser.write(html);
  parser.end();
  return canvas;
};

const notesBlockers = async (project: Project): Promise<string[]> => {
  const { rt } = project;
  const notes = (await isFile(rt, project.designMd)) ? await rt.fs.readText(project.designMd) : '';
  const authored = !notes.includes('## Observation log') && [...notes.trim()].length >= 80;
  const observed = splitLines(notes.split('## Observation log').at(-1)!).some(
    (line) => line.startsWith('- ') && !line.includes('init:'),
  );
  return authored || observed ? [] : ['starter 未完成：缺实际设计观察'];
};

const conceptBlockers = (project: Project, plan: seriesPlan.Plan | null, conceptOff: boolean): string[] => {
  const { mode, concept } = project.manifest;
  const planConcept = plan && isObject(plan.concept) ? plan.concept : {};
  const native = conceptOff || (plan !== null && planConcept.enabled === false && truthy(planConcept.reason));
  const blockers: string[] = [];
  if (mode === 'original' && !['reviewed', 'done', 'manual'].includes(String(concept.status)) && !native)
    blockers.push('concept pending：需要唯一整组构图参考，或记录关闭参考的原因');
  if (mode === 'strict' && !truthy(concept.fixture)) blockers.push('strict 缺本地参考素材');
  return blockers;
};

const pageBlockers = async (project: Project): Promise<string[]> => {
  const blockers: string[] = [];
  for (const { id } of project.manifest.pages) {
    const html = await project.readPageHtml(id);
    const canvas = scanCanvas(html);
    if (!canvas.found) blockers.push(`页 ${id} 缺 class=post/page 根`);
    if (html.toLowerCase().includes('<script')) blockers.push(`页 ${id} 含 <script>`);
    if (!canvas.layers.length) blockers.push(`页 ${id} 缺可编辑语义图层`);
    if (canvas.layers.length !== new Set(canvas.layers).size) blockers.push(`页 ${id} 图层 id 重复`);
    if (html.includes('Edit this live text layer.') || html.includes('>Page 1<'))
      blockers.push(`页 ${id} 仍含未替换骨架文字`);
  }
  return blockers;
};

type Source = Record<string, unknown>;

const referenceBlockers = async (project: Project, source: Source): Promise<string[]> => {
  const { rt } = project;
  const path = typeof source.path === 'string' ? rt.path.resolve(project.root, source.path) : null;
  const intact = path !== null && (await isFile(rt, path)) && (await sha256File(rt, path)) === source.sha256;
  return intact ? [] : ['reference 文件缺失或已变更，请重新观察并登记'];
};

const templateBlockers = async (project: Project, source: Source, warnings: string[]): Promise<string[]> => {
  const { rt } = project;
  const blockers: string[] = [];
  const loc = await locateSkill(rt, typeof source.path === 'string' ? source.path : '');
  if (!loc.ok || !loc.resourcesPresent) blockers.push('template 资源缺失');
  if (truthy(source.sha256) && (loc.ok ? loc.sha256 : undefined) !== source.sha256)
    blockers.push('template 来源已变更，请重读并更新规则');
  const profile = source.profilePath;
  if (typeof profile !== 'string' || !profile || !(await isFile(rt, rt.path.resolve(project.root, profile))))
    warnings.push('template 尚未绑定设计规则 profile');
  return blockers;
};

const bundleBlockers = async (project: Project, source: Source): Promise<string[]> => {
  const { rt } = project;
  const bundlePath = typeof source.bundlePath === 'string' ? source.bundlePath : '';
  if (!bundlePath || !(await isFile(rt, fromCwd(rt, bundlePath)))) return ['post_bundle 文件缺失'];
  const bundle = (await readUserJson(rt, bundlePath)) as postBundle.Bundle;
  // An intentionally pending URL must not block a ready local reference source.
  if (project.manifest.sources.some((s) => s.kind === 'local-reference')) return [];
  const [ok, errors] = postBundle.validateBundle(bundle);
  if (!ok) return errors;
  const baseDir = rt.path.dirname(fromCwd(rt, bundlePath));
  return (await postBundle.evaluateBuildable(rt, bundle, baseDir)).blockers;
};

const sourceBlockers = async (project: Project, warnings: string[]): Promise<string[]> => {
  const blockers: string[] = [];
  for (const source of project.manifest.sources) {
    if (source.kind === 'local-reference' || source.kind === 'composition')
      blockers.push(...(await referenceBlockers(project, source)));
    if (source.kind === 'template') blockers.push(...(await templateBlockers(project, source, warnings)));
    if (source.kind === 'bundle-url') blockers.push(...(await bundleBlockers(project, source)));
  }
  return blockers;
};

/** Pages whose PNG has no real-image review of the current version, plus the series review when a plan exists. */
const reviewGaps = async (project: Project, plan: seriesPlan.Plan | null, warnings: string[]): Promise<string[]> => {
  const { rt, manifest } = project;
  const gaps: string[] = [];
  const fingerprints: Record<string, string> = {};
  for (const { id } of manifest.pages) {
    fingerprints[id] = await pageFingerprint(project, id);
    const review = (manifest.reviews[id] ?? {}) as Record<string, unknown>;
    const png = rt.path.join(project.exportsDir, `${id}.png`);
    if (!(await isFile(rt, png)) || review.fingerprint !== fingerprints[id] || review.pngHash !== (await sha256File(rt, png)))
      gaps.push(
        `${id}: no review of the current version: look at its current render (popost render --dir ${project.root} --page ${id} first if the PNG is missing or stale), ` +
          `then record it with popost review --dir ${project.root} --page ${id} --note "what you checked and improved"`,
      );
  }
  if (plan) {
    const series = (isObject(manifest.seriesReview) ? manifest.seriesReview : {}) as Record<string, unknown>;
    if (series.planHash !== seriesPlan.digest(plan) || !deepEqual(series.pages, fingerprints))
      gaps.push(
        'series: no review of the current plan and pages: check the hook, progression, payoff and CTA across the whole set (popost sheet --dir ' +
          `${project.root} shows it), then record it with popost review --dir ${project.root} --page series --note "hook, progression, payoff, CTA and shared look"`,
      );
  }
  if (warnings.some((warning) => warning.includes('profile'))) gaps.push('template: 设计规则尚未绑定');
  return gaps;
};

const planBlockers = (project: Project, plan: seriesPlan.Plan | null): string[] => {
  if (plan) return seriesPlan.validate(plan, project.manifest.pages.map((p) => p.id));
  return (project.manifest.workflowVersion ?? 0) >= 3
    ? ['缺 series-plan.json：先确定钩子、逐页增量、翻页理由、兑现与 CTA']
    : [];
};

/** Run every structural check, write `build-report.json` next to the manifest and return the report. */
export const buildProject = async (project: Project, conceptOff = false): Promise<BuildReport> => {
  const loaded = await seriesPlan.load(project);
  const plan = truthy(loaded) ? loaded : null; // an empty plan file counts as no plan, as in Python
  const warnings: string[] = [];
  const blockers = [
    ...(await notesBlockers(project)),
    ...planBlockers(project, plan),
    ...conceptBlockers(project, plan, conceptOff),
    ...(await pageBlockers(project)),
    ...(await sourceBlockers(project, warnings)),
  ];
  const gaps = await reviewGaps(project, plan, warnings);
  const report: BuildReport = {
    structureReady: blockers.length === 0,
    visualQa: gaps.length ? 'pending' : 'reviewed-by-agent',
    readyToDeliver: blockers.length === 0 && gaps.length === 0,
    mode: project.manifest.mode,
    blockers,
    reviewGaps: gaps,
    warnings,
    concept: project.manifest.concept,
  };
  await writeJson(project.rt, project.abs('build-report.json'), report);
  return report;
};

/**
 * Environment report. Python probed its modules (`playwright`, `PIL`); here nothing is imported dynamically, so only
 * what is knowable without launching a browser is reported: the renderer ships with the package, and whether this host
 * can start a local editor server or hands the project to its own editor.
 */
export const doctor = async (project: Project) => {
  const { rt, manifest } = project;
  return {
    project: project.root,
    mode: manifest.mode,
    pages: manifest.pages.map((page) => page.id),
    assets: manifest.assets.length,
    fonts: await project.fonts(),
    concept: manifest.concept,
    deps: { playwright: true, localProcesses: Boolean(rt.processes) },
    editorHost: rt.editorHost?.id ?? null,
    planAttached: truthy(await seriesPlan.load(project)),
  };
};
