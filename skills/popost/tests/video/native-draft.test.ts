import { describe, expect, it } from 'vitest';
import { createTestRuntime } from '../../src/testing/memory';
import type { Runtime } from '../../src/runtime';
import { detectDraftApplication, unescapeDraftPath } from '../../src/video/draft/targets';
import { draftSourceHash, type PreparedDraft } from '../../src/video/draft/export';
import { exportNativeDraft, installNativeDraft } from '../../src/video/draft/native';
import { openNativeDraft } from '../../src/video/draft/lifecycle';
import type { Project } from '../../src/video/types';

const FIRST = '12345678-1234-4234-8234-123456789abc';
const SECOND = '22345678-1234-4234-8234-123456789abc';
const setup = async (running = true) => {
  const calls: string[][] = [], state = { running, blocked: false, failedLaunch: false };
  const rt = createTestRuntime({ platform: 'darwin', homeDir: '/home/example', sleep: async () => undefined,
    programs: { parallelism: 1, tempDir: async () => '/scratch', run: async argv => {
      calls.push([...argv]); let stdout = '';
      if (argv[0] === 'mdfind') stdout = argv[1]?.includes('lvoverseas') ? '/Applications/CapCut.app' : '/Applications/VideoFusion-macOS.app';
      if (argv[0] === 'plutil') stdout = argv[2] === 'CFBundleIdentifier'
        ? argv.at(-1)?.includes('CapCut') ? 'com.lemon.lvoverseas' : 'com.lemon.lvpro'
        : argv.at(-1)?.includes('CapCut') ? 'CapCut' : 'VideoFusion-macOS';
      if (argv[0] === 'ps') stdout = (state.running ? '123 /Applications/VideoFusion-macOS.app/Contents/MacOS/VideoFusion-macOS\n456 /Applications/CapCut.app/Contents/MacOS/CapCut\n' : '') + '789 /Applications/Other.app/Contents/MacOS/Other\n790 /Applications/VideoFusion-macOS.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper';
      if (argv[0] === 'kill' && !state.blocked) state.running = false;
      if (argv[0] === 'open' && !state.failedLaunch) state.running = true;
      return { code: 0, stdout: new TextEncoder().encode(stdout), stderr: '' };
    } },
  });
  await rt.fs.mkdir('/Applications/VideoFusion-macOS.app'); await rt.fs.mkdir('/Applications/CapCut.app');
  await rt.fs.writeFile('/project/cache/media/video-001.mp4', new Uint8Array([1, 2, 3]));
  await rt.fs.writeFile('/project/cache/media/audio-001.wav', new Uint8Array([4, 5, 6]));
  await rt.fs.writeFile('/project/cache/cover.jpg', new Uint8Array([7, 8, 9]));
  const prepared: PreparedDraft = { directory: '/project/cache', sourceHash: 'snapshot', width: 180, height: 320, fps: 30, duration: 1e6,
    videos: [{ id: 'video', file: 'media/video-001.mp4', start: 0, duration: 1e6, width: 180, height: 320 }],
    audio: [{ id: 'voice', file: 'media/audio-001.wav', start: 0, duration: 1e6 }], captions: [{ text: '可编辑字幕', start: 0, duration: 1e6 }], cover: '/project/cache/cover.jpg' };
  return { rt, calls, state, prepared };
};
describe('direct native draft delivery', () => {
  it.each(['jianying', 'capcut'] as const)('writes a complete %s draft, leaves the native index alone, and keeps media independent of the original project', async target => {
    const { rt, calls, prepared } = await setup(), app = await detectDraftApplication(rt, target);
    const index = rt.path.join(app.root!, 'root_meta_info.json'), original = '{"all_draft_store":[{"draft_id":"keep"}]}';
    await rt.fs.writeFile(index, original);
    const result = await installNativeDraft(rt, '/project', prepared, app, FIRST);
    expect(result).toMatchObject({ target, canOpen: true, productRunning: true, clips: 1, audio: 1, captions: 1 });
    expect(calls.some(c => c[0] === 'kill' || c[0] === 'open')).toBe(false);
    const native = JSON.parse(await rt.fs.readText(rt.path.join(result.directory, 'draft_content.json'))) as { materials: { videos: { path: string }[] }; tracks: { type: string }[] };
    expect(native.tracks.map(t => t.type)).toEqual(['video', 'audio', 'text']);
    expect(native.materials.videos[0]?.path).toBe(rt.path.join(result.directory, 'media/video-001.mp4'));
    expect(await rt.fs.readText(index)).toBe(original);
    const repeated = await installNativeDraft(rt, '/project', prepared, app, FIRST);
    expect(repeated.directory).toBe(result.directory);
    expect((await installNativeDraft(rt, '/project', prepared, app, SECOND)).name).toBe(result.name + ' 2');
    expect((await rt.fs.readdir(app.root!)).filter(n => n.startsWith('Popost-'))).toHaveLength(2);
    await rt.fs.rm('/project');
    expect(await rt.fs.readFile(native.materials.videos[0]!.path)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await rt.fs.readText(index)).toBe(original);
  });
  it('removes an incomplete staging directory after a copy failure and never replaces an existing project', async () => {
    const { rt, prepared } = await setup(), app = await detectDraftApplication(rt, 'jianying');
    await rt.fs.writeFile(rt.path.join(app.root!, 'Existing/draft_info.json'), 'keep');
    const broken: Runtime = { ...rt, fs: { ...rt.fs, copyFile: async () => { throw new Error('disk full'); } } };
    await expect(installNativeDraft(broken, '/project', prepared, app, FIRST)).rejects.toThrow('disk full');
    expect(await rt.fs.readdir(app.root!)).toEqual(['Existing']);
    expect(await rt.fs.readText(rt.path.join(app.root!, 'Existing/draft_info.json'))).toBe('keep');
  });
  it('reconciles a saved receipt without rerendering and refuses to reuse it for a changed timeline', async () => {
    const { rt, prepared } = await setup(), app = await detectDraftApplication(rt, 'jianying');
    const source: Project = { version: 1, canvas: { width: 180, height: 320, fps: 30 }, materials: [], segments: [{ id: 'a', frames: 30, base: { color: '#222222' } }], tracks: [] };
    prepared.sourceHash = await draftSourceHash(rt, '/project', source);
    const saved = await installNativeDraft(rt, '/project', prepared, app, FIRST);
    expect((await exportNativeDraft(rt, '/project', source, 'jianying', FIRST)).directory).toBe(saved.directory);
    await expect(exportNativeDraft(rt, '/project', { ...source, tracks: [{ id: 'title', type: 'text', text: 'New title', box: [0, 0, 1, .1], during: { segment: 'a' } }] }, 'jianying', FIRST)).rejects.toThrow('changed');
    await expect(openNativeDraft(rt, '/project', '../root')).rejects.toThrow('Invalid');
  });
  it('follows configured draft roots and detects scene and linked stylesheet edits in the visual cache key', async () => {
    const { rt } = await setup();
    await rt.fs.writeFile('/home/example/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/root_meta_info.json', JSON.stringify({ root_path: '/custom-drafts' }));
    await expect(detectDraftApplication(rt, 'jianying')).rejects.toThrow('unavailable');
    await rt.fs.mkdir('/custom-drafts');
    expect((await detectDraftApplication(rt, 'jianying')).root).toBe('/custom-drafts');
    await rt.fs.writeFile('/project/scenes/a.html', '<link href="style.css"><p>Hello</p>');
    await rt.fs.writeFile('/project/scenes/style.css', 'p{color:red}');
    const source: Project = { version: 1, canvas: { width: 180, height: 320, fps: 30 }, materials: [], segments: [{ id: 'a', frames: 30, base: { scene: 'scenes/a.html' } }], tracks: [] };
    const before = await draftSourceHash(rt, '/project', source);
    await rt.fs.writeFile('/project/scenes/style.css', 'p{color:blue}');
    expect(await draftSourceHash(rt, '/project', source)).not.toBe(before);
    expect(unescapeDraftPath('D:\\\\Drafts\\x89c6\\x9891')).toBe('D:\\Drafts视频');
  });
});
describe('post-export application lifecycle', () => {
  it('terminates only the matching main process, waits for exit, then opens the installed app', async () => {
    const { rt, calls, prepared } = await setup();
    await installNativeDraft(rt, '/project', prepared, await detectDraftApplication(rt, 'jianying'), FIRST);
    expect(await openNativeDraft(rt, '/project', FIRST)).toEqual({ ok: true, restarted: true });
    expect(calls.filter(c => c[0] === 'kill')).toEqual([['kill', '-TERM', '123']]);
    expect(calls.findIndex(c => c[0] === 'open')).toBeGreaterThan(calls.findIndex(c => c[0] === 'kill'));
    expect(calls.filter(c => c[0] === 'open')).toEqual([['open', '-a', '/Applications/VideoFusion-macOS.app']]);
  });
  it('keeps the saved draft and reports an unfinished quit without force-killing or launching a second instance', async () => {
    const { rt, calls, state, prepared } = await setup(); state.blocked = true;
    const saved = await installNativeDraft(rt, '/project', prepared, await detectDraftApplication(rt, 'capcut'), FIRST);
    expect(await openNativeDraft(rt, '/project', FIRST)).toEqual({ ok: false, restarted: true, quitPending: true });
    expect(calls.some(c => c[0] === 'open' || c.includes('-KILL') || c.includes('/F'))).toBe(false);
    expect(await rt.fs.stat(saved.directory)).not.toBeNull();
  });
  it('opens an app that was not running without sending a termination signal', async () => {
    const { rt, calls, prepared } = await setup(false);
    await installNativeDraft(rt, '/project', prepared, await detectDraftApplication(rt, 'capcut'), FIRST);
    expect(await openNativeDraft(rt, '/project', FIRST)).toEqual({ ok: true, restarted: false });
    expect(calls.some(c => c[0] === 'kill')).toBe(false);
  });
});
