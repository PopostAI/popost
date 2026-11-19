/**
 * Review evidence (port of `workflow_cli.review_page` and the `review --page series` branch). A review is bound to the
 * exact render the agent looked at: the PNG's hash and the page fingerprint at that time. Editing the page or its assets
 * afterwards makes the review stale.
 */
import type { Project } from '../core/project';
import { pageFingerprint } from '../core/fingerprint';
import { isFile, readJson, sha256File } from '../core/util';
import { KeyError, ValueError } from './errors';
import * as seriesPlan from './series-plan';

const need = (data: Record<string, unknown>, key: string): unknown => {
  if (!(key in data)) throw new KeyError(key);
  return data[key];
};

/** Record the agent's visual findings for one page; the page has to have a current render and receipt. */
export const reviewPage = async (project: Project, pid: string, note: string) => {
  const { rt } = project;
  project.page(pid);
  const png = rt.path.join(project.exportsDir, `${pid}.png`);
  const receipt = rt.path.join(project.exportsDir, `${pid}.render.json`);
  if (!(await isFile(rt, png)) || !(await isFile(rt, receipt))) throw new ValueError('render this page before reviewing it');
  const data = await readJson<Record<string, unknown>>(rt, receipt);
  if (need(data, 'fingerprint') !== (await pageFingerprint(project, pid)) || need(data, 'pngHash') !== (await sha256File(rt, png)))
    throw new ValueError('render is stale; rerender before actual visual review');
  const result = { reviewer: 'agent', note, fingerprint: data.fingerprint, pngHash: data.pngHash };
  project.manifest.reviews[pid] = result;
  await project.saveManifest();
  return result;
};

/** Record the findings of the whole sequence, bound to the plan and to every page's current fingerprint. */
export const reviewSeries = async (project: Project, note: string) => {
  const plan = await seriesPlan.load(project);
  if (!plan || !Object.keys(plan).length) throw new ValueError('attach a series plan before reviewing the sequence');
  const pages: Record<string, string> = {};
  for (const { id } of project.manifest.pages) pages[id] = await pageFingerprint(project, id);
  const review = { reviewer: 'agent', note, planHash: seriesPlan.digest(plan), pages };
  project.manifest.seriesReview = review;
  await project.saveManifest();
  return review;
};
