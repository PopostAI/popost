/** `package` and `unpack`: the portable editable project ZIP (ports of the bundle cases of test_popost_workflow.py). */
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import { Project } from '../src/core/project';
import { sha256 } from '../src/core/util';
import { exportProject, importProject } from '../src/workflow/project-bundle';
import { runCli, type TestRuntime } from '../src/testing/memory';
import { newProject, newRuntime, pageHtml, PNG_1X1 } from './workflow-helpers';

const read = async (rt: TestRuntime, path: string) => unzipSync(await rt.fs.readFile(path));
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const encode = (data: string) => new TextEncoder().encode(data);

/** Mark one entry of an existing archive as a symbolic link (the Unix mode sits in the central directory). */
const asSymlink = (zip: Uint8Array, name: string): Uint8Array => {
  const copy = zip.slice();
  const view = new DataView(copy.buffer);
  for (let o = 0; o + 46 < copy.length; o++) {
    if (view.getUint32(o, true) !== 0x02014b50) continue;
    const length = view.getUint16(o + 28, true);
    if (new TextDecoder().decode(copy.subarray(o + 46, o + 46 + length)) === name) view.setUint32(o + 38, 0o120777 << 16, true);
  }
  return copy;
};

/** Compression method of each entry (0 = stored, 8 = deflate), from the central directory. */
const methods = (zip: Uint8Array): Record<string, number> => {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const out: Record<string, number> = {};
  for (let o = 0; o + 46 < zip.length; o++) {
    if (view.getUint32(o, true) !== 0x02014b50) continue;
    const length = view.getUint16(o + 28, true);
    out[new TextDecoder().decode(zip.subarray(o + 46, o + 46 + length))] = view.getUint16(o + 10, true);
  }
  return out;
};

const withAssets = async (rt: TestRuntime) => {
  const project = await newProject(rt);
  await project.addAssetBytes(PNG_1X1, 'local.png');
  await project.writePageHtml('p1', pageHtml('真的内容', true));
  await rt.fs.writeFile('/work/project/assets/private.json', '{"secret":"must-not-travel"}');
  await rt.fs.writeFile('/work/project/production/config.json', 'PRIVATE');
  await rt.fs.writeFile('/work/project/reference/ref.png', PNG_1X1);
  return project;
};

describe('package', () => {
  it('ships the pages, what they link to and the manifest; nothing private', async () => {
    const rt = await newRuntime();
    const project = await withAssets(rt);
    project.manifest.provider.model = 'secret-model';
    project.manifest.sources.push({ kind: 'bundle-url', note: 'internal' });
    project.manifest.reviews.p1 = { note: 'x' };
    project.manifest.seriesReview = { note: 'x' };
    await project.saveManifest();
    expect((await runCli(rt, ['package', '--dir', 'project'])).code).toBe(0);
    expect(rt.json()).toEqual({ ok: true, zip: '/work/project/exports/project.popost.zip' });
    const files = await read(rt, '/work/project/exports/project.popost.zip');
    expect(Object.keys(files).sort()).toEqual(['OPEN.txt', 'assets/local.png', 'pages/p1.html', 'social-studio-project.json']);
    expect(files['assets/local.png']).toEqual(PNG_1X1);
    const manifest = JSON.parse(text(files['social-studio-project.json']));
    expect(manifest).toMatchObject({
      sources: [],
      concept: { status: 'manual', prompt: null, fixture: null },
      delivery: { kind: 'editable-project', reviewStatus: 'draft-after-import' },
      assets: [{ id: 'local', path: 'assets/local.png' }],
    });
    for (const key of ['provider', 'seriesPlan', 'seriesReview', 'templateProfile', 'reviews']) expect(manifest).not.toHaveProperty(key);
    expect(text(files['OPEN.txt'])).toContain('popost unpack');
  });

  it('writes where --out says, creating the folder', async () => {
    const rt = await newRuntime();
    await newProject(rt);
    expect((await runCli(rt, ['package', '--dir', 'project', '--out', 'out/sub/p.zip'])).code).toBe(0);
    expect(rt.json().zip).toBe('/work/out/sub/p.zip');
    expect(Object.keys(await read(rt, '/work/out/sub/p.zip'))).toContain('pages/p1.html');
  });

  it('follows links through stylesheets, percent-encoding and url(), and keeps the licence beside a font', async () => {
    const rt = await newRuntime();
    const project = await newProject(rt);
    const name = '本地 图片.png';
    await rt.fs.writeFile(`/work/project/assets/${name}`, PNG_1X1);
    await rt.fs.writeFile('/work/project/css/chosen.css', '@font-face{font-family:X;src:url("../fonts/x/x.woff2?v=1#f")}');
    await rt.fs.writeFile('/work/project/fonts/x/x.woff2', 'wOF2');
    await rt.fs.writeFile('/work/project/fonts/x/LICENSE.txt', 'OFL');
    await rt.fs.writeFile('/work/project/fonts/x/OTHER.txt', 'not a licence');
    await project.writePageHtml(
      'p1',
      `<link rel="stylesheet" href="../css/chosen.css"><img src="../assets/${encodeURIComponent(name)}">` +
        '<i style="background:url(data:image/png;base64,AAAA)"></i><a href="#top">t</a>',
    );
    const zip = await exportProject(project);
    const files = unzipSync(await rt.fs.readFile(zip));
    expect(Object.keys(files).sort()).toEqual([
      'OPEN.txt',
      `assets/${name}`,
      'css/chosen.css',
      'fonts/x/LICENSE.txt',
      'fonts/x/x.woff2',
      'pages/p1.html',
      'social-studio-project.json',
    ]);
    // restoring it in a new place finds the unicode path again
    const restored = await importProject(rt, await rt.fs.readFile(zip), '/work/restored');
    expect(await rt.fs.readFile(`${restored.assetsDir}/${name}`)).toEqual(PNG_1X1);
  });

  it('refuses external, missing, outside and internal-reference links', async () => {
    const rt = await newRuntime();
    const project = await withAssets(rt);
    const attempt = async (html: string) => {
      await project.writePageHtml('p1', html);
      return [(await runCli(rt, ['package', '--dir', 'project'])).code, rt.json().error];
    };
    expect(await attempt('<img src="https://example.com/x.png">')).toEqual([2, 'external dependency in project: https://example.com/x.png']);
    expect(await attempt('<img src="//cdn/x.png">')).toEqual([2, 'external dependency in project: //cdn/x.png']);
    expect(await attempt('<img src="../assets/missing.png">')).toEqual([2, 'missing or external local dependency: ../assets/missing.png']);
    expect(await attempt('<img src="../../outside.png">')).toEqual([2, 'missing or external local dependency: ../../outside.png']);
    expect(await attempt('<img src="../reference/ref.png">')).toEqual([
      2,
      'pages/p1.html uses reference/ref.png, a working file that does not ship (reference/ and production/ stay out of the package): copy the picture into assets/, point the page at the copy, then package again',
    ]);
  });

  it('stores fonts as they are and, when this installation has them, ships the editor and the font bank', async () => {
    const rt = await newRuntime();
    const project = await newProject(rt);
    await rt.fs.writeFile('/skill/assets/canvas/index.html', '<html>editor</html>');
    await rt.fs.writeFile('/skill/assets/canvas/assets/app.js', 'js');
    await rt.fs.writeFile('/skill/assets/fonts/palette.json', JSON.stringify({ roles: [{ id: 'inter', cssPath: 'css/inter.css' }, { id: 'ghost', cssPath: 'css/ghost.css' }] }));
    await rt.fs.writeFile('/skill/assets/fonts/NOTICE.txt', 'notice');
    await rt.fs.writeFile('/skill/assets/fonts/css/inter.css', '@font-face{}');
    await rt.fs.writeFile('/skill/assets/fonts/inter/inter.woff2', 'wOF2');
    await rt.fs.writeFile('/skill/assets/fonts/inter/LICENSE', 'OFL');
    await rt.fs.writeFile('/skill/assets/fonts/ghost/LICENSE', 'no font files here');
    const zip = await rt.fs.readFile(await exportProject(project));
    expect(methods(zip)).toMatchObject({ 'runtime/assets/fonts/inter/inter.woff2': 0, 'runtime/assets/canvas/index.html': 8, 'pages/p1.html': 8 });
    const files = unzipSync(zip);
    const runtime = Object.keys(files).filter((n) => n.startsWith('runtime/')).sort();
    expect(runtime).toEqual([
      'runtime/assets/canvas/assets/app.js',
      'runtime/assets/canvas/index.html',
      'runtime/assets/fonts/NOTICE.txt',
      'runtime/assets/fonts/css/inter.css',
      'runtime/assets/fonts/inter/LICENSE',
      'runtime/assets/fonts/inter/inter.woff2',
      'runtime/assets/fonts/palette.json',
    ]);
  });
});

describe('unpack', () => {
  it('restores the project without the original, assets verified by checksum', async () => {
    const rt = await newRuntime();
    const project = await withAssets(rt);
    await runCli(rt, ['package', '--dir', 'project', '--out', 'p.zip']);
    await rt.fs.rm(project.root);
    expect((await runCli(rt, ['unpack', '--file', 'p.zip', '--dir', 'new'])).code).toBe(0);
    expect(rt.json()).toEqual({ ok: true, project: '/work/new' });
    const restored = await Project.load(rt, 'new');
    expect(await rt.fs.readFile(`${restored.assetsDir}/local.png`)).toEqual(PNG_1X1);
    expect(await restored.readPageHtml('p1')).toContain('../assets/local.png');
    expect(await restored.readPageHtml('p1')).not.toContain('/work/project');
    expect(restored.manifest.concept).toEqual({ status: 'manual', prompt: null, fixture: null });
    expect(await rt.fs.stat('/work/new/assets/private.json')).toBeNull();
    expect(await rt.fs.stat('/work/new/production/config.json')).toBeNull();
    expect(await rt.fs.stat('/work/new/reference')).toBeNull();
  });

  const refuses = async (zip: Zippable | Uint8Array, message: string) => {
    const rt = await newRuntime();
    await rt.fs.writeFile('/work/x.zip', zip instanceof Uint8Array ? zip : zipSync(zip));
    const { code } = await runCli(rt, ['unpack', '--file', 'x.zip', '--dir', 'out']);
    expect([code, rt.json().error]).toEqual([2, message]);
    expect(await rt.fs.stat('/work/out')).toBeNull();
    expect(await rt.fs.stat('/oops')).toBeNull();
    expect(await rt.fs.stat('/work/oops')).toBeNull();
  };

  it('rejects traversal, absolute and backslash paths before writing anything', async () => {
    await refuses({ 'social-studio-project.json': encode('{}'), '../oops': encode('x') }, 'unsafe archive path');
    await refuses({ 'social-studio-project.json': encode('{}'), '/etc/x': encode('x') }, 'unsafe archive path');
    await refuses({ 'social-studio-project.json': encode('{}'), 'a\\b': encode('x') }, 'unsafe archive path');
    await refuses({ 'social-studio-project.json': encode('{}'), 'a/../../oops': encode('x') }, 'unsafe archive path');
  });

  it('rejects symbolic links and archives without a manifest', async () => {
    const zip = zipSync({ 'social-studio-project.json': encode('{}'), link: encode('target') });
    await refuses(asSymlink(zip, 'link'), 'unsafe archive path');
    await refuses({ 'a.txt': encode('x') }, 'invalid project archive');
  });

  it('removes what it unpacked when the project inside is not valid', async () => {
    const rt = await newRuntime();
    const project = await newProject(rt);
    const manifest = { ...project.manifest, assets: [{ id: 'a', path: 'assets/a.png', kind: 'image', sha256: sha256('other') }] };
    const base = { 'social-studio-project.json': encode(JSON.stringify(manifest)), 'pages/p1.html': encode(pageHtml()), 'assets/a.png': encode('data') };
    await rt.fs.writeFile('/work/bad.zip', zipSync(base));
    expect((await runCli(rt, ['unpack', '--file', 'bad.zip', '--dir', 'out'])).code).toBe(2);
    expect(rt.json().error).toBe('asset checksum mismatch');
    expect(await rt.fs.stat('/work/out')).toBeNull();
    await rt.fs.writeFile('/work/nopage.zip', zipSync({ 'social-studio-project.json': base['social-studio-project.json'] }));
    expect((await runCli(rt, ['unpack', '--file', 'nopage.zip', '--dir', 'out2'])).code).toBe(2);
    expect(rt.json().error).toBe('missing page p1');
    await rt.fs.writeFile('/work/empty.zip', zipSync({ 'social-studio-project.json': encode('{}') }));
    expect((await runCli(rt, ['unpack', '--file', 'empty.zip', '--dir', 'out3'])).code).toBe(1); // not a v2 project: a broken archive
    expect(await rt.fs.stat('/work/out3')).toBeNull();
  });

  it('refuses an existing destination, a missing archive and a file that is not an archive', async () => {
    const rt = await newRuntime();
    await newProject(rt);
    await runCli(rt, ['package', '--dir', 'project', '--out', 'p.zip']);
    expect((await runCli(rt, ['unpack', '--file', 'p.zip', '--dir', 'project'])).code).toBe(2);
    expect(rt.json().error).toBe('destination already exists; choose a new project directory');
    expect((await runCli(rt, ['unpack', '--file', 'nope.zip', '--dir', 'new'])).code).toBe(2);
    expect(rt.json().error).toBe('file not found: nope.zip');
    await rt.fs.writeFile('/work/text.zip', 'hello');
    expect((await runCli(rt, ['unpack', '--file', 'text.zip', '--dir', 'new'])).code).toBe(1);
    expect(await rt.fs.stat('/work/new')).toBeNull();
  });
});
