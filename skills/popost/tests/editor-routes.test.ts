/** The local editor service's routes, called as plain functions over the in-memory file system. */
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { pageFingerprint, RENDER_SIGNATURE } from '../src/core/fingerprint';
import { Project } from '../src/core/project';
import { sha256 } from '../src/core/util';
import { originAllowed } from '../src/editor/routes-post';
import { receiptPath } from '../src/render/png';
import { createTestRuntime, SKILL_ROOT } from '../src/testing/memory';
import { PNG_1X1 } from './workflow-helpers';
import { bodyJson, bodyText, editorFixture, get, ORIGIN, post, PORT } from './editor-helpers';

describe('GET routes', () => {
  it('answers /api/editor-info with the project identity, for this editor version only', async () => {
    const { rt, state, project } = await editorFixture();
    const response = await get(rt, state, '/api/editor-info');
    expect(response.status).toBe(200);
    expect(response.headers['Access-Control-Allow-Origin']).toBe(`http://127.0.0.1:${PORT}`);
    expect(bodyJson(response)).toMatchObject({
      ok: true,
      schema: 'popost-editor-info.v1',
      version: '4.1.2',
      projectId: project.manifest.projectId,
      projectIdentity: sha256(project.root),
    });
  });

  it('shows layout references on their assigned pages and keeps unrelated images out of comparison', async () => {
    const { rt, state, project } = await editorFixture();
    await project.addPage('p2', 'Page 2', 200, 300);
    await rt.fs.writeFile('/work/layout.png', PNG_1X1);
    const layout = await project.importReference('/work/layout.png', 'layout', 'p2');
    await project.importReference('/work/layout.png', 'identity', 'p1');
    const result = bodyJson(await get(rt, state, '/api/comparison'));
    expect(result.items).toEqual([
      { pageKey: 'p2', src: '/api/comparison/' + layout.path, name: layout.path.split('/').at(-1), width: 1, height: 1 },
    ]);
    const image = await get(rt, state, '/api/comparison/' + layout.path);
    expect(image.headers['Content-Type']).toBe('image/png');
    expect(image.body).toEqual(PNG_1X1);
    expect(bodyText(await get(rt, state, '/editor.html'))).toContain('"comparison":true');
  });

  it('serves the project with every page inline, and a revision that follows its content', async () => {
    const { rt, state, project } = await editorFixture();
    const first = bodyJson(await get(rt, state, '/api/project')) as { manifest: { pages: { id: string; html: string }[] }; canvasRev: string };
    expect(first.manifest.pages[0]!.html).toContain('class="post"');
    expect(first.canvasRev).toMatch(/^[0-9a-f]{64}$/);
    expect(bodyJson(await get(rt, state, '/api/project')).canvasRev).toBe(first.canvasRev);
    await project.writePageHtml('p1', '<div class="post">edited</div>');
    expect(bodyJson(await get(rt, state, '/api/project')).canvasRev).not.toBe(first.canvasRev);
  });

  it('keeps the first-open snapshot even after the project changes', async () => {
    const { rt, state, project } = await editorFixture();
    const initial = bodyJson(await get(rt, state, '/api/canvas-initial')) as { manifest: { pages: { html: string }[] } };
    const original = initial.manifest.pages[0]!.html;
    await project.writePageHtml('p1', '<div class="post">edited</div>');
    const again = bodyJson(await get(rt, state, '/api/canvas-initial')) as { manifest: { pages: { html: string }[] } };
    expect(again.manifest.pages[0]!.html).toBe(original);
  });

  it('serves the editor page with this project injected, and its static files', async () => {
    const { rt, state, project } = await editorFixture();
    for (const path of ['/', '/editor.html', '/index.html']) {
      const response = await get(rt, state, path, { query: 'lang=en&x=1' });
      expect(response.headers['Content-Type']).toBe('text/html; charset=utf-8');
      expect(response.headers['Cache-Control']).toBe('no-store');
      const html = bodyText(response);
      expect(html).toContain('<head><base href="/_editor/"><script>window.__POPOST_LOCAL__=');
      expect(html).toContain(`"projectId":"${project.manifest.projectId}"`);
      expect(html).toContain('"width":300,"height":400');
      expect(html).toContain(`file=pages%2F${project.manifest.projectId}.html&popost=1`);
      expect(html).toContain('lang=en');
    }
    expect(bodyText(await get(rt, state, '/'))).toContain('lang=zh');
    const script = await get(rt, state, '/_editor/assets/app.js');
    expect(script.status).toBe(200);
    expect(script.headers['Content-Type']).toBe('text/javascript; charset=utf-8');
  });

  it('keeps editor and project files inside their own roots', async () => {
    const { rt, state } = await editorFixture();
    await rt.fs.writeFile('/work/outside.txt', 'secret');
    await rt.fs.writeFile(`${SKILL_ROOT}/assets/secret.txt`, 'secret');
    expect((await get(rt, state, '/_editor/%2e%2e/secret.txt')).status).toBe(404);
    expect((await get(rt, state, '/%2e%2e/outside.txt')).status).toBe(404);
    expect((await get(rt, state, '/nope.txt')).status).toBe(404);
    const page = await get(rt, state, '/pages/p1.html');
    expect(page.status).toBe(200);
    expect(page.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(bodyJson(await get(rt, state, '/social-studio-project.json'))).toMatchObject({ schema: 'social-studio-project.v2' });
  });

  it('lists the font palette', async () => {
    const { rt, state } = await editorFixture();
    await rt.fs.writeFile(`${SKILL_ROOT}/assets/fonts/palette.json`, JSON.stringify({ version: '2.0.0', roles: [{ id: 'a' }] }));
    expect(bodyJson(await get(rt, state, '/api/font-palette'))).toEqual({ ok: true, roles: [{ id: 'a' }] });
  });

  it('exports the current PNG, or a ZIP of them, without a browser; a missing page is a 500 with the reason', async () => {
    const { rt, state, project } = await editorFixture();
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(png.buffer).setUint32(16, 300);
    new DataView(png.buffer).setUint32(20, 400);
    const file = rt.path.join(project.exportsDir, 'p1.png');
    await rt.fs.writeFile(file, png);
    await rt.fs.writeFile(
      receiptPath(project, file),
      JSON.stringify({ fingerprint: await pageFingerprint(project, 'p1'), pngHash: sha256(png), renderer: RENDER_SIGNATURE }),
    );
    const single = await get(rt, state, '/api/export', { query: 'page=p1' });
    expect(single.status).toBe(200);
    expect(single.headers).toMatchObject({ 'Content-Type': 'image/png', 'Content-Disposition': 'attachment; filename="p1.png"' });
    expect(single.body).toEqual(png);
    const all = await get(rt, state, '/api/export', { query: 'page=all' });
    expect(all.headers['Content-Type']).toBe('application/zip');
    expect(Object.keys(unzipSync(all.body as Uint8Array))).toEqual(['p1.png']);
    const missing = await get(rt, state, '/api/export', { query: 'page=nope' });
    expect(missing.status).toBe(500);
    expect(bodyJson(missing)).toEqual({ ok: false, error: '页不存在: nope' });
  });

  it('packages the project as a ZIP download', async () => {
    const { rt, state } = await editorFixture();
    const response = await get(rt, state, '/api/project-bundle');
    expect(response.status, bodyText(response)).toBe(200);
    expect(response.headers).toMatchObject({ 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="project.popost.zip"' });
    expect(Object.keys(unzipSync(response.body as Uint8Array))).toContain('pages/p1.html');
  });
});

describe('POST routes', () => {
  it('only accepts requests from the service\'s own origin', async () => {
    const { rt, state } = await editorFixture();
    const foreign: Record<string, string>[] = [{}, { origin: 'http://evil.test' }, { origin: 'null' }, { origin: 'http://127.0.0.1:1' }];
    for (const headers of foreign) {
      const response = await post(rt, state, '/api/canvas-notes', { ops: [] }, headers);
      expect(response.status, JSON.stringify(headers)).toBe(403);
      expect(bodyJson(response).error).toBe('origin/csrf rejected');
    }
    expect(originAllowed({ origin: `http://localhost:${PORT}`, host: `localhost:${PORT}` }, PORT)).toBe(true);
    expect(originAllowed({ origin: 'http://example.test:9', host: 'example.test:9' }, PORT)).toBe(false);
    expect((await post(rt, state, '/api/nope', {})).status).toBe(404);
  });

  it('saves the canvas, keeps the first snapshot and a backup, and refuses a stale revision', async () => {
    const { rt, state, project } = await editorFixture();
    const { canvasRev } = bodyJson(await get(rt, state, '/api/project')) as { canvasRev: string };
    const payload = { pages: [{ id: 'p1', name: 'P1', width: 300, height: 400, html: '<div class="post">saved</div>' }], canvasRev };
    const saved = await post(rt, state, '/api/project', payload);
    expect(saved.status, bodyText(saved)).toBe(200);
    const body = bodyJson(saved) as { saved: { id: string }[]; revision: number; canvasRev: string };
    expect(body.saved.map((s) => s.id)).toEqual(['p1']);
    expect(body.revision).toBe(1);
    expect(body.canvasRev).not.toBe(canvasRev);
    expect(await rt.fs.readText(project.abs('pages/p1.html'))).toBe('<div class="post">saved</div>');
    expect(await rt.fs.stat(project.abs('.popost-editor/initial.json'))).not.toBeNull();
    expect((await rt.fs.readdir(project.abs('.popost-editor/history'))).length).toBe(1);

    const stale = await post(rt, state, '/api/project', payload);
    expect(stale.status).toBe(409);
    expect(bodyJson(stale).error).toContain('工程已被另一窗口或 Agent 修改');
    const forced = await post(rt, state, '/api/project', { ...payload, force: true });
    expect(forced.status).toBe(200);
  });

  it('reports a bad payload as 400 and a stale font install as 409', async () => {
    const { rt, state } = await editorFixture();
    const bad = await post(rt, state, '/api/project', { pages: [{ id: '../x', html: '' }] });
    expect(bad.status).toBe(400);
    expect(bodyJson(bad)).toEqual({ ok: false, error: 'invalid or duplicate page id' });
    const stale = await post(rt, state, '/api/font-install', { roles: 'a', canvasRev: 'old' });
    expect(stale.status).toBe(409);
  });

  it('turns a preview into a short-lived page with a strict policy', async () => {
    const { rt, state } = await editorFixture();
    const nonce = 'b'.repeat(32);
    const made = await post(rt, state, '/api/canvas-preview', { content: `<head></head><script nonce="${nonce}">ok()</script><script>bad()</script>`, nonce });
    expect(made.status).toBe(200);
    const url = String(bodyJson(made).url);
    expect(url).toMatch(/^\/_preview\/[0-9a-f]{32}\.html$/);
    const shown = await get(rt, state, url);
    expect(shown.status).toBe(200);
    expect(bodyText(shown)).toContain('ok()');
    expect(bodyText(shown)).not.toContain('bad()');
    expect(shown.headers['Content-Security-Policy']).toContain(`'nonce-${nonce}'`);

    expect((await post(rt, state, '/api/canvas-preview', { content: 'x', nonce: 'bad nonce' })).status).toBe(400);
    expect((await post(rt, state, '/api/canvas-preview', { nonce: null })).status).toBe(400);
    const empty = await post(rt, state, '/api/canvas-preview', new Uint8Array());
    expect(empty.status).toBe(413);
  });

  it('expires previews after ten minutes and keeps at most sixteen', async () => {
    const { rt, state } = await editorFixture();
    let now = Date.UTC(2026, 10, 5);
    const clock = createTestRuntime({ fs: rt.fs, skillRoot: rt.skillRoot, now: () => new Date(now) });
    const first = bodyJson(await post(clock, state, '/api/canvas-preview', { content: 'one' })).url as string;
    for (let i = 0; i < 16; i++) await post(clock, state, '/api/canvas-preview', { content: `p${i}` });
    expect(state.previews.size).toBe(16);
    expect((await get(clock, state, first)).status).toBe(404);
    const last = [...state.previews.keys()].at(-1)!;
    now += 601_000;
    const expired = await get(clock, state, last);
    expect(expired.status).toBe(404);
    expect(bodyJson(expired).error).toBe('preview expired; reopen the document');
  });

  it('imports an image as a project asset (raw bytes or a data URI)', async () => {
    const { rt, state, project } = await editorFixture();
    const raw = await post(rt, state, '/api/import-image', PNG_1X1);
    expect(bodyJson(raw)).toMatchObject({ ok: true, asset: { id: 'import001', path: 'assets/import001.png' } });
    const dataUri = `data:image/png;base64,${Buffer.from(PNG_1X1).toString('base64')}`;
    const viaJson = await post(rt, state, '/api/import-image', { dataUri }, { origin: ORIGIN, 'content-type': 'application/json' });
    expect(bodyJson(viaJson)).toMatchObject({ ok: true, asset: { id: 'import002' } });
    expect(await rt.fs.readFile(project.abs('assets/import002.png'))).toEqual(PNG_1X1);
    const bad = await post(rt, state, '/api/import-image', { dataUri: 'nope' }, { origin: ORIGIN, 'content-type': 'application/json' });
    expect(bad.status).toBe(500);
    expect(bodyJson(bad).error).toBe('bad dataUri');
    const notImage = await post(rt, state, '/api/import-image', new TextEncoder().encode('not an image'));
    expect(notImage.status).toBe(500);
  });

  it('applies feedback note operations in order', async () => {
    const { rt, state } = await editorFixture();
    const ops = [
      { op: 'add', note: { id: 'n1', text: 'one' } },
      { op: 'add', note: { id: 'n2', text: 'two' } },
      { op: 'update', id: 'n1', patch: { text: 'ONE' } },
      { op: 'delete', id: 'n2' },
    ];
    expect(bodyJson(await post(rt, state, '/api/canvas-notes', { ops })).notes).toEqual([{ id: 'n1', text: 'ONE' }]);
    expect(bodyJson(await get(rt, state, '/api/canvas-notes')).notes).toEqual([{ id: 'n1', text: 'ONE' }]);
    expect((await post(rt, state, '/api/canvas-notes', { ops: 'x' })).status).toBe(400);
    expect((await post(rt, state, '/api/canvas-notes', { ops: [{ op: 'add' }] })).status).toBe(400);
  });

  it('installs fonts through the library and links them unless asked for resources only', async () => {
    const { rt, state, project } = await editorFixture();
    const font = new TextEncoder().encode('wOF2 font');
    const license = 'SIL OPEN FONT LICENSE';
    await rt.fs.writeFile(`${SKILL_ROOT}/assets/fonts/palette.json`, JSON.stringify({
      version: '2.0.0',
      roles: [{
        id: 'demo', label: 'Demo', family: 'Demo Family', cssPath: 'css/demo.css', licensePath: 'demo/LICENSE', fileCount: 1,
        totalBytes: font.byteLength, package: 'p', packageVersion: '1', license: { spdx: 'OFL-1.1', path: 'demo/LICENSE', sha256: sha256(license) },
        assetSha256: { 'demo.woff2': sha256(font) },
      }],
    }));
    await rt.fs.writeFile(`${SKILL_ROOT}/assets/fonts/css/demo.css`, "@font-face{font-family:'Demo Family';src:url('../demo/demo.woff2')}");
    await rt.fs.writeFile(`${SKILL_ROOT}/assets/fonts/demo/LICENSE`, license);
    await rt.fs.writeFile(`${SKILL_ROOT}/assets/fonts/demo/demo.woff2`, font);

    const resourceOnly = await post(rt, state, '/api/font-install', { roles: 'demo', resourceOnly: true });
    expect(bodyJson(resourceOnly)).toMatchObject({ ok: true, cssInjected: false });
    expect(await project.readPageHtml('p1')).not.toContain('css/demo.css');
    expect((await Project.load(rt, project.root)).manifest.fonts.map((f) => f.id)).toEqual(['demo']);

    const linked = await post(rt, state, '/api/font-install', { roles: 'demo' });
    expect(bodyJson(linked)).toMatchObject({ ok: true, cssInjected: true });
    expect(await project.readPageHtml('p1')).toContain('<link rel="stylesheet" href="../css/demo.css"></head>');
    const unknown = await post(rt, state, '/api/font-install', { roles: 'nope' });
    expect(unknown.status).toBe(400);
  });

  it('imports a project ZIP into a new directory and serves that project from then on', async () => {
    const { rt, state } = await editorFixture();
    const zip = (await get(rt, state, '/api/project-bundle')).body as Uint8Array;
    const imported = await post(rt, state, '/api/import-project', zip);
    expect(imported.status, bodyText(imported)).toBe(200);
    const dest = String(bodyJson(imported).project);
    expect(dest).toMatch(/^\/work\/popost-import-[0-9a-f]{10}$/);
    expect(state.root).toBe(dest);
    expect(await rt.fs.stat(`${dest}/pages/p1.html`)).not.toBeNull();
    expect(await mountedCount(rt, '/work/P/.popost-editor')).toBe(0);
    const bad = await post(rt, state, '/api/import-project', new TextEncoder().encode('not a zip'));
    expect(bad.status).toBe(400);
  });
});

/** Files still lying around in `dir` that look like leftover import ZIPs. */
const mountedCount = async (rt: Awaited<ReturnType<typeof editorFixture>>['rt'], dir: string): Promise<number> =>
  (await rt.fs.stat(dir)) ? (await rt.fs.readdir(dir)).filter((name) => name.endsWith('.zip')).length : 0;

