/** Social narrative plan: agent-authored content decisions, never a layout DSL (port of `series_plan.py`). */
import { createHash } from 'node:crypto';
import type { Project } from '../core/project';
import { isFile, readJson, writeJson } from '../core/util';
import { describeGrid, type SheetPlan } from './composition-grid';
import { ValueError } from './errors';
import { isObject, pyJson, pyStr, truthy } from '../core/pyjson';

export const SCHEMA = 'popost-series.v1';
export const PLAN_FILE = 'series-plan.json';

export type Plan = Record<string, unknown>;

const blank = (value: unknown): boolean => typeof value !== 'string' || !value.trim();
const getOr = (object: Record<string, unknown>, key: string, fallback: unknown): unknown =>
  object[key] === undefined ? fallback : object[key];

const validatePage = (page: unknown, index: number, last: boolean): string[] => {
  if (!isObject(page)) return ['invalid page'];
  const errors = ['id', 'role', 'message', 'visual', 'copy']
    .filter((field) => blank(page[field]))
    .map((field) => `pages[${index}].${field} is required`);
  if (!last && !truthy(page.swipeReason)) errors.push(`pages[${index}].swipeReason must name what the next page adds`);
  return errors;
};

const validatePages = (pages: unknown[], pageIds?: readonly string[]): string[] => {
  const errors: string[] = [];
  const ids = pages.filter(isObject).map((page) => page.id);
  if (ids.length !== pages.length || new Set(ids.map(pyStr)).size !== ids.length) errors.push('pages must have unique ids');
  if (pageIds && (ids.length !== pageIds.length || ids.some((id, i) => id !== pageIds[i])))
    errors.push('plan page ids/order differ from project');
  pages.forEach((page, i) => errors.push(...validatePage(page, i, i === pages.length - 1)));
  return errors;
};

const validateHook = (hook: unknown): string[] =>
  !isObject(hook) || !truthy(hook.text) || !truthy(hook.mechanism)
    ? ['hook needs text and a mechanism tied to the actual payoff']
    : [];

const validateCta = (cta: unknown): string[] => {
  if (!isObject(cta) || typeof cta.enabled !== 'boolean') return ['cta.enabled must explicitly be true or false'];
  if (cta.enabled && (!truthy(cta.action) || !truthy(cta.reason)))
    return ['enabled CTA needs action and audience benefit/reason'];
  return [];
};

const REASON_MISSING = 'concept: a disabled concept needs a reason (concept.reason)';
const COUNT_WRONG = 'concept.imageCount must be 1 (or 0 when the concept is disabled with a reason)';

const validateConcept = (concept: unknown): string[] => {
  if (!isObject(concept)) return ['concept must be an object'];
  const count = getOr(concept, 'imageCount', 1);
  const disabled = concept.enabled === false;
  const reasoned = disabled && truthy(concept.reason);
  if (reasoned ? count === 0 || count === 1 : count === 1) return [];
  // a disabled concept without a reason may have 0 or 1 once the reason is added: say that first, then the count if it is still wrong
  if (disabled && !reasoned) return count === 0 || count === 1 ? [REASON_MISSING] : [REASON_MISSING, COUNT_WRONG];
  return [COUNT_WRONG];
};

/** Everything wrong with a plan, in the order the agent should fix it; `pageIds` binds it to the project's pages. */
export const validate = (plan: unknown, pageIds?: readonly string[]): string[] => {
  if (!isObject(plan) || plan.schema !== SCHEMA) return ['schema must be popost-series.v1'];
  const errors = ['audience', 'promise', 'payoff', 'visualDirection']
    .filter((field) => blank(plan[field]))
    .map((field) => `${field} must describe a concrete decision`);
  const pages = plan.pages;
  if (!Array.isArray(pages) || !pages.length) return [...errors, 'pages must be a nonempty ordered array'];
  return [
    ...errors,
    ...validatePages(pages, pageIds),
    ...validateHook(getOr(plan, 'hook', {})),
    ...validateCta(getOr(plan, 'cta', {})),
    ...validateConcept(getOr(plan, 'concept', {})),
  ];
};

export const load = async (project: Project): Promise<Plan | null> => {
  const path = project.abs(PLAN_FILE);
  return (await isFile(project.rt, path)) ? await readJson<Plan>(project.rt, path) : null;
};

/** Hash of the plan's content: reviews of the sequence are bound to it. Same bytes as Python's sorted `json.dumps`. */
export const digest = (plan: unknown): string => createHash('sha256').update(pyJson(plan, true), 'utf8').digest('hex');

/** Validates, writes `series-plan.json`, records it in the manifest and drops the now outdated series review. */
export const save = async (project: Project, plan: unknown): Promise<string> => {
  const errors = validate(plan, project.manifest.pages.map((page) => page.id));
  if (errors.length) throw new ValueError(errors.join('; '));
  const path = project.abs(PLAN_FILE);
  await writeJson(project.rt, path, plan);
  project.manifest.seriesPlan = { path: PLAN_FILE, sha256: digest(plan) };
  delete project.manifest.seriesReview;
  await project.saveManifest();
  return path;
};

const panelText = (page: Plan, index: number): string => {
  const next = 'swipeReason' in page ? pyStr(page.swipeReason) : 'deliver the payoff and finish';
  return (
    `Panel ${index + 1} / ${pyStr(page.id)} (${pyStr(page.role)}): exact planned copy ${pyJson(page.copy)}; ` +
    `message ${pyStr(page.message)}; visual direction ${pyStr(page.visual)}; next-page motivation ${next}.`
  );
};

/** One call, one image containing ALL page panels; no hidden per-page jobs. `sheet` is the grid and proportion from `planSheet`. */
export const compositionPrompt = (plan: unknown, sheet: SheetPlan): string => {
  const errors = validate(plan);
  if (errors.length) throw new ValueError(errors.join('; '));
  const data = plan as Plan;
  const pages = data.pages as Plan[];
  const hook = data.hook as Plan;
  return (
    `Generate exactly ONE image: a cohesive art-directed contact sheet containing ALL ${pages.length} ` +
    `social carousel pages in reading order, arranged in ${describeGrid(sheet)}. ` +
    `Draw every panel in the pages' own ${sheet.pageAspect} proportion, so no page is squeezed or stretched. ` +
    'Every page must be visible as a separate complete panel. Use compact panel ids outside the page designs. ' +
    "Keep typography and each page's main visual hierarchy legible; unused grid cells stay neutral. " +
    'This is an INTERNAL composition reference, not shipping artwork. Render the planned copy to demonstrate ' +
    'hierarchy. Unify type roles, palette, materials and subject treatment; vary page composition purposefully. ' +
    'Do not invent factual claims, prices, statistics, brands or extra pages. ' +
    `Audience: ${pyStr(data.audience)}. Series promise: ${pyStr(data.promise)}. Payoff: ${pyStr(data.payoff)}. ` +
    `Cover hook: ${pyStr(hook.text)}; hook mechanism: ${pyStr(hook.mechanism)}. ` +
    `CTA decision: ${pyJson(data.cta)}. Do not add a CTA when disabled. ` +
    `Shared art direction: ${pyStr(data.visualDirection)}.\n${pages.map(panelText).join('\n')}`
  );
};
