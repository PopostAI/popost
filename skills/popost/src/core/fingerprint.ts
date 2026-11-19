/**
 * The render fingerprint of a page (port of `server.page_fingerprint`): the page HTML, its canvas size and every file
 * under assets/, fonts/ and css/. A PNG and its review stay valid only while this is unchanged. The bytes hashed match
 * the Python Skill exactly, so projects made by it keep their renders and reviews.
 */
import { createHash } from 'node:crypto';
import type { Project } from './project';
import { relPosix, sha256File, walkFiles } from './util';

export const RENDER_SIGNATURE = 'popost-png-v2:scale1:offline:fonts-ready';

export const pageFingerprint = async (project: Project, pid: string): Promise<string> => {
  const { rt } = project;
  const page = project.page(pid);
  const hash = createHash('sha256').update(await project.readPageHtml(pid));
  hash.update(`[${Number(page.width)}, ${Number(page.height)}]`);
  for (const folder of ['assets', 'fonts', 'css']) {
    for (const file of await walkFiles(rt, rt.path.join(project.root, folder))) {
      hash.update(relPosix(rt, project.root, file));
      hash.update(await sha256File(rt, file));
    }
  }
  return hash.digest('hex');
};
