/** The render fingerprint: pinned to the Python Skill's bytes, since stored renders and reviews depend on it. */
import { describe, expect, it } from 'vitest';
import { pageFingerprint } from '../src/core/fingerprint';
import { newProject, newRuntime, pageHtml } from './workflow-helpers';

describe('render fingerprint', () => {
  it('matches the Python Skill byte for byte, including the order of nested files', async () => {
    const rt = await newRuntime();
    const project = await newProject(rt);
    expect(await pageFingerprint(project, 'p1')).toBe('8bae1fbd872e2edc86187cd0f61ff0de143553d694c90a1b8a759828046b2858');
    const files: Record<string, string> = {
      'assets/a-b.png': 'AB',
      'assets/a/b.png': 'A/B',
      'fonts/inter.css': 'css',
      'fonts/inter/f.woff2': 'font',
      'css/chosen.css': 'body{}',
      'assets/本地 图片.png': 'U',
    };
    for (const [path, data] of Object.entries(files)) await rt.fs.writeFile(`/work/project/${path}`, data);
    // Python walks path component by component (`a/b.png` before `a-b.png`); a plain string sort would swap them.
    expect(await pageFingerprint(project, 'p1')).toBe('34432b9f1903b1508ca37fecde4f7109b61cfdfa14b697053a7da6257ce6939a');
  });

  it('changes with the page, its size and any asset', async () => {
    const rt = await newRuntime();
    const project = await newProject(rt);
    const before = await pageFingerprint(project, 'p1');
    await rt.fs.writeFile('/work/project/assets/x.png', 'x');
    const withAsset = await pageFingerprint(project, 'p1');
    await project.writePageHtml('p1', pageHtml());
    const edited = await pageFingerprint(project, 'p1');
    project.page('p1').height = 1350;
    expect(new Set([before, withAsset, edited, await pageFingerprint(project, 'p1')]).size).toBe(4);
  });
});
