import { afterAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { createDiskRuntime } from '../../src/testing/disk';
import type { Runtime } from '../../src/runtime';
import { findChromium } from '../../src/render/browser';
import { startPreview } from '../../src/video/preview/index';
import { hasFfmpeg, probe, runFfmpegOk } from '../../src/video/media/ffmpeg';
import type { NativeDraftResult } from '../../src/video/draft/native';
import { serverProcesses } from './make-fixtures';

const rt = await createDiskRuntime({ processes: serverProcesses });
afterAll(() => rt.cleanup());
const chrome = findChromium(process.env), ffmpeg = await hasFfmpeg(rt);
describe.skipIf(!chrome || !ffmpeg)('native draft export in the browser', () => {
  it('saves real tracks directly, defers restart to its button, and opens CapCut without a ZIP or manual installer', async () => {
    const dir = rt.path.join(rt.cwd, 'example'), homeDir = rt.path.join(rt.cwd, 'home');
    const apps = { jianying: rt.path.join(rt.cwd, 'apps/VideoFusion-macOS.app'), capcut: rt.path.join(rt.cwd, 'apps/CapCut.app') };
    await rt.fs.mkdir(apps.jianying); await rt.fs.mkdir(apps.capcut); await rt.fs.mkdir(dir);
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.6', rt.path.join(dir, 'voice.wav')]);
    await rt.fs.writeFile(rt.path.join(dir, 'video.json'), JSON.stringify({ version: 1, canvas: { width: 180, height: 320, fps: 30 }, materials: [{ id: 'voice', kind: 'audio', file: 'voice.wav' }], segments: [{ id: 'a', frames: 9, base: { color: '#bb2200' } }, { id: 'b', frames: 9, base: { color: '#0033bb' } }], tracks: [{ id: 'voiceover', type: 'audio', material: 'voice', during: { segment: 'a', from: 0, to: 18 } }, { id: 'captions', type: 'caption', box: [.1, .8, .8, .1], cues: [{ text: 'Editable caption', during: { segment: 'a', from: 0, to: 18 } }] }] }));
    const running = { jianying: true, capcut: false }, commands: string[][] = [];
    const nativeRt: Runtime = { ...rt, platform: 'darwin', homeDir, sleep: async () => undefined, programs: { ...rt.programs!, run: async (argv, options) => {
      if (!['mdfind', 'plutil', 'ps', 'kill', 'open'].includes(argv[0]!)) return rt.programs!.run(argv, options);
      commands.push([...argv]); let stdout = '';
      if (argv[0] === 'mdfind') stdout = argv[1]?.includes('lvoverseas') ? apps.capcut : apps.jianying;
      if (argv[0] === 'plutil') stdout = argv[2] === 'CFBundleIdentifier' ? argv.at(-1)?.includes('CapCut') ? 'com.lemon.lvoverseas' : 'com.lemon.lvpro' : argv.at(-1)?.includes('CapCut') ? 'CapCut' : 'VideoFusion-macOS';
      if (argv[0] === 'ps') stdout = (running.jianying ? '123 ' + apps.jianying + '/Contents/MacOS/VideoFusion-macOS\n' : '') + (running.capcut ? '456 ' + apps.capcut + '/Contents/MacOS/CapCut\n' : '');
      if (argv[0] === 'kill') running[argv[2] === '123' ? 'jianying' : 'capcut'] = false;
      if (argv[0] === 'open') running[argv[2] === apps.jianying ? 'jianying' : 'capcut'] = true;
      return { code: 0, stdout: new TextEncoder().encode(stdout), stderr: '' };
    } } };
    const preview = await startPreview(nativeRt, { projectDir: dir, edit: true });
    const browser = await chromium.launch({ executablePath: chrome!, headless: true });
    try {
      const page = await browser.newPage({ locale: 'en-US' }), downloads: string[] = [], errors: string[] = [];
      page.on('download', item => downloads.push(item.suggestedFilename())); page.on('pageerror', error => errors.push(error.message));
      const state = await (await page.request.get(preview.url + 'api/state')).json() as { problems: { level: string }[] };
      expect(state.problems.filter(problem => problem.level === 'error'), JSON.stringify(state.problems)).toEqual([]);
      await page.goto(preview.url);
      await page.waitForSelector('body[data-ready="1"]').catch(async () => { throw new Error(JSON.stringify({ errors, text: await page.locator('body').innerText() })); });
      const exportDraft = async (target: 'Jianying Pro' | 'CapCut'): Promise<NativeDraftResult> => {
        await page.click('#studio-export-open');
        const settings = page.getByRole('dialog', { name: 'Export settings' });
        await settings.getByRole('tab', { name: 'Draft', exact: true }).click();
        await settings.getByRole('button', { name: target, exact: true }).click();
        const response = page.waitForResponse(answer => new URL(answer.url()).pathname === '/api/studio/draft');
        await settings.getByRole('button', { name: 'Export', exact: true }).click();
        const result = (await (await response).json() as { result: NativeDraftResult }).result;
        await page.getByRole('dialog', { name: 'Imported into ' + target, exact: true }).waitFor();
        return result;
      };
      const first = await exportDraft('Jianying Pro');
      expect(first).toMatchObject({ clips: 2, audio: 1, captions: 1 });
      expect(commands.some(c => c[0] === 'kill' || c[0] === 'open')).toBe(false);
      const body = JSON.parse(await rt.fs.readText(rt.path.join(first.directory, 'draft_info.json'))) as { tracks: { type: string }[]; materials: { videos: { path: string }[]; audios: { path: string }[] } };
      expect(body.tracks.map(track => track.type)).toEqual(['video', 'audio', 'text']);
      expect((await probe(rt, body.materials.videos[0]!.path)).frames).toBe(9);
      for (const item of [...body.materials.videos, ...body.materials.audios]) expect(item.path.startsWith(first.directory)).toBe(true);
      const retry = await page.evaluate(async ({ id }) => (await (await fetch('/api/studio/draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'jianying', requestId: id }) })).json()) as { result: NativeDraftResult }, { id: first.receiptId });
      expect(retry.result.directory).toBe(first.directory);
      expect((await rt.fs.readdir(first.root)).filter(name => name.startsWith('Popost-'))).toHaveLength(1);
      await page.getByRole('button', { name: 'Later', exact: true }).click();
      expect(commands.some(c => c[0] === 'kill' || c[0] === 'open')).toBe(false);
      await exportDraft('Jianying Pro');
      const restarting = page.waitForResponse(answer => new URL(answer.url()).pathname === '/api/studio/draft-open');
      await page.getByRole('button', { name: 'Restart Jianying Pro', exact: true }).click();
      expect((await (await restarting).json() as { result: { ok: boolean; restarted: boolean } }).result).toEqual({ ok: true, restarted: true });
      await page.waitForSelector('.studio-draft-success', { state: 'detached' });
      expect(commands.filter(c => c[0] === 'kill')).toEqual([['kill', '-TERM', '123']]);
      await exportDraft('CapCut');
      await page.getByRole('button', { name: 'Open CapCut', exact: true }).click();
      await page.waitForSelector('.studio-draft-success', { state: 'detached' });
      expect(commands.filter(c => c[0] === 'open').at(-1)).toEqual(['open', '-a', apps.capcut]);
      expect(downloads).toEqual([]); expect(errors).toEqual([]);
      expect(await page.locator('a[download$=".zip"]').count()).toBe(0);
    } finally { await browser.close(); await preview.close(); }
  });
});
