/**
 * Review evidence (port of `workflow_cli.review_page` and the `review --page series` branch). A review is bound to the
 * exact render the agent looked at: the PNG's hash and the page fingerprint at that time. Editing the page or its assets
 * afterwards makes the review stale.
 */
import type { Project } from '../core/project';
import { pageFingerprint } from '../core/fingerprint';
import { isFile, readJson, sha256File } from '../core/util';
import { msg } from '../i18n';
import { KeyError, ValueError } from './errors';
import * as seriesPlan from './series-plan';

const need = (data: Record<string, unknown>, key: string, file: string): unknown => {
  if (!(key in data)) throw new KeyError(key, file);
  return data[key];
};

/** Record the agent's visual findings for one page; the page has to have a current render and receipt. */
export const reviewPage = async (project: Project, pid: string, note: string) => {
  const { rt } = project;
  project.page(pid);
  const png = rt.path.join(project.exportsDir, `${pid}.png`);
  const receipt = rt.path.join(project.exportsDir, `${pid}.render.json`);
  if (!(await isFile(rt, png)) || !(await isFile(rt, receipt))) throw new ValueError(msg('render this page before reviewing it', '请先渲染这一页再评审'));
  const data = await readJson<Record<string, unknown>>(rt, receipt);
  const file = `exports/${pid}.render.json`;
  if (need(data, 'fingerprint', file) !== (await pageFingerprint(project, pid)) || need(data, 'pngHash', file) !== (await sha256File(rt, png)))
    throw new ValueError(msg('render is stale; rerender before actual visual review', '渲染结果已过期；请重新渲染后再做实际的视觉评审'));
  const result = { reviewer: 'agent', note, fingerprint: data.fingerprint, pngHash: data.pngHash };
  project.manifest.reviews[pid] = result;
  await project.saveManifest();
  return result;
};

/** Record the findings of the whole sequence, bound to the plan and to every page's current fingerprint. */
export const reviewSeries = async (project: Project, note: string) => {
  const plan = await seriesPlan.load(project);
  if (!plan || !Object.keys(plan).length) throw new ValueError(msg('attach a series plan before reviewing the sequence', '请先登记整组规划，再评审整组'));
  const pages: Record<string, string> = {};
  for (const { id } of project.manifest.pages) pages[id] = await pageFingerprint(project, id);
  const review = { reviewer: 'agent', note, planHash: seriesPlan.digest(plan), pages };
  project.manifest.seriesReview = review;
  await project.saveManifest();
  return review;
};
