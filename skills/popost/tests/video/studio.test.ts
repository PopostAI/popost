import { describe, expect, it, afterAll } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import { createEditor } from '../../src/video/preview/edit/editor';
import { readExportSettings, exportScale } from '../../src/video/preview/export-settings';
import { encodeArgs } from '../../src/video/render/encode';

const rt = await createDiskRuntime();
afterAll(() => rt.cleanup());
const project = { version: 1, canvas: { width: 320, height: 180, fps: 30 }, materials: [], segments: [{ id: 'a', frames: 30, base: { color: '#123456' } }], tracks: [] };

describe('Studio draft JSON', () => {
 it('validates a whole draft before saving and includes it in undo/redo', async () => {
  const dir = rt.path.join(rt.cwd, 'studio-json'); await rt.fs.writeFile(rt.path.join(dir, 'video.json'), JSON.stringify(project));
  const editor = await createEditor(rt, dir); const next = { ...project, segments: [{ ...project.segments[0], frames: 60 }] };
  expect((await editor.replace(next, project)).ok).toBe(true);
  expect(JSON.parse(await editor.snapshot()).segments[0].frames).toBe(60);
  await editor.undo(); expect(JSON.parse(await editor.snapshot()).segments[0].frames).toBe(30);
  await editor.redo(); expect(JSON.parse(await editor.snapshot()).segments[0].frames).toBe(60);
 });
 it('rejects invalid projects and stale edits without overwriting the draft', async () => {
  const dir = rt.path.join(rt.cwd, 'studio-conflict'); await rt.fs.writeFile(rt.path.join(dir, 'video.json'), JSON.stringify(project));
  const editor = await createEditor(rt, dir); const before = await editor.snapshot();
  const bad = await editor.replace({ ...project, canvas: { width: -1, height: 180, fps: 30 } });
  expect(bad.ok).toBe(false); expect(await editor.snapshot()).toBe(before);
  const stale = await editor.replace(project, { ...project, note: 'stale' });
  expect(stale.ok).toBe(false); if (!stale.ok) expect(stale.status).toBe(409);
  expect(await editor.snapshot()).toBe(before);
 });
});
describe('Studio video export', () => {
 const free = { premium: false, verified: true }; const paid = { premium: true, verified: true };
 it('enforces paid resolution on explicit presets and original high resolution', () => {
  for (const resolution of ['1440', '2160']) expect(() => readExportSettings({ resolution }, project.canvas, free)).toThrow('PAID_RESOLUTION');
  expect(() => readExportSettings({ resolution: 'original' }, { width: 3840, height: 2160 }, free)).toThrow('PAID_RESOLUTION');
  expect(exportScale(readExportSettings({ resolution: '1440' }, project.canvas, paid), project.canvas)).toBe(8);
  expect(() => readExportSettings({ dynamicRange: 'hdr' }, project.canvas, paid)).toThrow('HDR');
 });
 it('preserves the aspect ratio and maps selected frame rate and bitrate to encoding', () => {
  const settings = readExportSettings({ resolution: '1080', fps: 24, bitrate: 8, name: '../movie.mp4' }, project.canvas, free);
  expect(settings.name).not.toContain('/'); expect(exportScale(settings, project.canvas)).toBe(6);
  const args = encodeArgs({ out: 'movie.mp4', fps: 30, outputFps: 24, bitrate: 8, from: 0, to: 30, image: 'png', crf: 18, audio: [] });
  expect(args).toContain('8M'); expect(args[args.indexOf('-frames:v') + 1]).toBe('24');
  expect(args[args.indexOf('-vf') + 1]).toContain('fps=24');
 });
});
