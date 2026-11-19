/** Shared fixtures for the core / workflow / template / post-bundle tests (not a test file itself). */
import { readFileSync } from 'node:fs';
import { createTestRuntime, mountPackageFiles, PACKAGE_ROOT, SKILL_ROOT, type TestRuntime } from '../src/testing/memory';
import { pageFingerprint, RENDER_SIGNATURE } from '../src/core/fingerprint';
import { Project } from '../src/core/project';
import { sha256 } from '../src/core/util';

export const FIXTURES = `${SKILL_ROOT}/tests/fixtures`;

/** A runtime whose package root has the starter page and the test fixtures mounted. */
export const newRuntime = async (): Promise<TestRuntime> => {
  const rt = createTestRuntime();
  await mountPackageFiles(rt.fs, ['assets/project-starter', 'tests/fixtures']);
  return rt;
};

export const fixtureBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(`${PACKAGE_ROOT}/tests/fixtures/${name}`));

/** A real 1x1 PNG (the checked-in sample-asset.png is only a placeholder file). */
export const PNG_1X1 = new Uint8Array(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
);

export type Plan = Record<string, unknown> & { pages: Record<string, unknown>[] };

export const examplePlan = (): Plan => JSON.parse(readFileSync(`${PACKAGE_ROOT}/assets/series-plan.example.json`, 'utf8')) as Plan;

export const newProject = async (rt: TestRuntime, dir = 'project', brief = '本地验证', width = 1080, height = 1440) =>
  Project.create(rt, dir, brief, 'original', width, height);

/** The page of the Python workflow tests: one text layer, optionally one local image. */
export const pageHtml = (text = '真的内容', image = false): string =>
  '<!doctype html><html><head><meta charset="utf-8"><style>' +
  '*{box-sizing:border-box;margin:0}.post{position:relative;width:1080px;height:1440px;background:#f8f4e8}' +
  '</style></head><body><div class="post" data-canvas-width="1080" data-canvas-height="1440">' +
  '<div data-layer-id="title" style="position:absolute;left:80px;top:100px;width:880px;font:700 64px sans-serif">' +
  `<span data-slot>${text}</span></div>` +
  (image
    ? '<div data-layer-id="photo" style="position:absolute;left:80px;top:400px;width:300px;height:300px">' +
      '<img src="../assets/local.png" style="width:100%;height:100%;object-fit:cover"></div>'
    : '') +
  '</div></body></html>';

/** A project of `n` pages (p1…pn) at 1080x1440, the shape the example series plan needs for n = 4. */
export const newProjectWithPages = async (rt: TestRuntime, n = 4, dir = 'project', width = 1080, height = 1440) => {
  const project = await newProject(rt, dir, '本地验证', width, height);
  for (let i = 2; i <= n; i++) await project.addPage(`p${i}`, `Page ${i}`, width, height);
  return project;
};

/** Stand in for `render`: write the page's PNG and the receipt that binds it to the page's current fingerprint. */
export const forgeRender = async (rt: TestRuntime, project: Project, pid: string): Promise<void> => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(pid)]);
  await rt.fs.writeFile(`${project.exportsDir}/${pid}.png`, png);
  const receipt = { fingerprint: await pageFingerprint(project, pid), pngHash: sha256(png), renderer: RENDER_SIGNATURE };
  await rt.fs.writeFile(`${project.exportsDir}/${pid}.render.json`, JSON.stringify(receipt, null, 2));
};
