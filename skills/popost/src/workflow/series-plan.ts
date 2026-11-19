/** Social narrative plan: agent-authored content decisions, never a layout DSL (port of `series_plan.py`). */
import { createHash } from 'node:crypto';
import type { Project } from '../core/project';
import { isFile, readJson, writeJson } from '../core/util';
import { describeGrid, type SheetPlan } from './composition-grid';
import { ValueError } from './errors';
import { isObject, pyJson, pyStr, truthy } from '../core/pyjson';
import { msg } from '../i18n';

export const SCHEMA = 'popost-series.v1';
export const PLAN_FILE = 'series-plan.json';

export type Plan = Record<string, unknown>;

const blank = (value: unknown): boolean => typeof value !== 'string' || !value.trim();
const getOr = (object: Record<string, unknown>, key: string, fallback: unknown): unknown =>
  object[key] === undefined ? fallback : object[key];

const validatePage = (page: unknown, index: number, last: boolean): string[] => {
  if (!isObject(page)) return [msg(`pages[${index}] must be an object`, `pages[${index}] 必须是对象`)];
  const errors = ['id', 'role', 'message', 'visual', 'copy']
    .filter((field) => blank(page[field]))
    .map((field) => msg(`pages[${index}].${field} is required`, `pages[${index}].${field} 必填`));
  if (!last && !truthy(page.swipeReason))
    errors.push(
      msg(
        `pages[${index}].swipeReason must name what the next page adds`,
        `pages[${index}].swipeReason 要写明下一页带来什么新内容`,
      ),
    );
  return errors;
};

/** `orderHint` is appended to the error when the plan's page ids or order differ from the project's. */
const validatePages = (pages: unknown[], pageIds?: readonly string[], orderHint = ''): string[] => {
  const errors: string[] = [];
  const ids = pages.filter(isObject).map((page) => page.id);
  if (ids.length !== pages.length || new Set(ids.map(pyStr)).size !== ids.length)
    errors.push(msg('pages must have unique ids', 'pages 的 id 不能重复'));
  if (pageIds && (ids.length !== pageIds.length || ids.some((id, i) => id !== pageIds[i])))
    errors.push(msg('plan page ids/order differ from project', 'plan 的页 id 或顺序与项目不一致') + orderHint);
  pages.forEach((page, i) => errors.push(...validatePage(page, i, i === pages.length - 1)));
  return errors;
};

const validateHook = (hook: unknown): string[] =>
  !isObject(hook) || !truthy(hook.text) || !truthy(hook.mechanism)
    ? [msg('hook needs text and a mechanism tied to the actual payoff', 'hook 需要 text，以及与实际 payoff 挂钩的 mechanism')]
    : [];

const validateCta = (cta: unknown): string[] => {
  if (!isObject(cta) || typeof cta.enabled !== 'boolean')
    return [msg('cta.enabled must explicitly be true or false', 'cta.enabled 必须明确写 true 或 false')];
  if (cta.enabled && (!truthy(cta.action) || !truthy(cta.reason)))
    return [msg('enabled CTA needs action and audience benefit/reason', '启用的 CTA 需要 action，以及对受众的好处或理由（reason）')];
  return [];
};

const reasonMissing = (): string =>
  msg('concept: a disabled concept needs a reason (concept.reason)', 'concept：停用 concept 时要写明理由（concept.reason）');
const countWrong = (): string =>
  msg(
    'concept.imageCount must be 1 (or 0 when the concept is disabled with a reason)',
    'concept.imageCount 必须为 1（concept 停用且写明理由时可为 0）',
  );

const validateConcept = (concept: unknown): string[] => {
  if (!isObject(concept)) return [msg('concept must be an object', 'concept 必须是对象')];
  const count = getOr(concept, 'imageCount', 1);
  const disabled = concept.enabled === false;
  const reasoned = disabled && truthy(concept.reason);
  if (reasoned ? count === 0 || count === 1 : count === 1) return [];
  // a disabled concept without a reason may have 0 or 1 once the reason is added: say that first, then the count if it is still wrong
  if (disabled && !reasoned) return count === 0 || count === 1 ? [reasonMissing()] : [reasonMissing(), countWrong()];
  return [countWrong()];
};

/**
 * Everything wrong with a plan, in the order the agent should fix it; `pageIds` binds it to the project's pages, and
 * `orderHint` is added to the message when the plan's pages do not match them.
 */
export const validate = (plan: unknown, pageIds?: readonly string[], orderHint?: string): string[] => {
  if (!isObject(plan) || plan.schema !== SCHEMA) return [msg(`schema must be ${SCHEMA}`, `schema 必须为 ${SCHEMA}`)];
  const errors = ['audience', 'promise', 'payoff', 'visualDirection']
    .filter((field) => blank(plan[field]))
    .map((field) => msg(`${field} must describe a concrete decision`, `${field} 要写明一个具体的决定`));
  const pages = plan.pages;
  if (!Array.isArray(pages) || !pages.length)
    return [...errors, msg('pages must be a nonempty ordered array', 'pages 必须是非空的有序数组')];
  return [
    ...errors,
    ...validatePages(pages, pageIds, orderHint),
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
