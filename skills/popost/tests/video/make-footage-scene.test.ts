/**
 * The example of "Footage inside a scene" (references/video-scenes.md, "A screen inside a scene"), taken from the page
 * itself: the shot of fill.json must become the material and the track the page shows (retarget/items.ts); its scene
 * and that video.json are written into a project with a 9:16 clip made by ffmpeg, the project is checked, and two
 * frames are drawn. The clip must fill the phone's screen, the scene's ground and the phone's body
 * must show round it, and the title must have risen in by the second frame.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import { PACKAGE_ROOT, runCli } from '../../src/testing/memory';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { renderFrame } from '../../src/video/render/index';
import { itemTracks, type ShotItem } from '../../src/video/retarget/items';
import type { Material } from '../../src/video/types';

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ready = (await hasFfmpeg(rt)) && hasChrome();

/** The code blocks of one language after a heading in a Markdown text. */
const blocksAfter = (md: string, marker: string, lang: string): string[] => {
  const from = md.indexOf(marker);
  if (from < 0) throw new Error('video-scenes.md has no "' + marker + '"');
  const end = md.indexOf('\n## ', from);
  const part = md.slice(from, end < 0 ? undefined : end);
  return [...part.matchAll(new RegExp('\x60\x60\x60' + lang + '\\n([\\s\\S]*?)\x60\x60\x60', 'g'))].map((m) => m[1] ?? '');
};

/** The RGB of a pixel of a PNG, decoded by ffmpeg. */
const pixels = async (png: string): Promise<{ at: (x: number, y: number) => number[] }> => {
  const r = await runFfmpegOk(rt, ['-loglevel', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  return { at: (x, y) => [...r.stdout.subarray((y * 1280 + x) * 3, (y * 1280 + x) * 3 + 3)] };
};

describe.skipIf(!ready)('references: footage inside a scene', () => {
  it('renders as the page says: the clip in the phone\'s screen, the scene round it, the title rising in', async () => {
    const md = await readFile(path.join(PACKAGE_ROOT, 'references', 'video-scenes.md'), 'utf8');
    const [html] = blocksAfter(md, '### Footage inside a scene', 'html');
    const [shotJson, json] = blocksAfter(md, '### Footage inside a scene', 'json');
    expect(html).toContain('class="phone"');
    const project = JSON.parse(json ?? '') as { materials: Material[]; tracks: { box: number[] }[] };
    expect(project.tracks[0]?.box).toEqual([0.6, 0.1, 0.2531, 0.8]);
    // What fill makes of the shot is what the page says it writes.
    const shot = JSON.parse(shotJson ?? '') as { scene: string; items: ShotItem[] };
    const materials: Material[] = [];
    const tracks = itemTracks('shot-02', shot.items, (file, kind) => { const id = kind + '-' + (materials.length + 1); materials.push({ id, kind, file }); return id; });
    expect({ materials, tracks }).toEqual({ materials: project.materials, tracks: project.tracks });
    const dir = rt.path.join(rt.dir, 'project');
    await rt.fs.writeFile(rt.path.join(dir, 'scenes', 'phone.html'), html ?? '');
    await rt.fs.writeFile(rt.path.join(dir, 'video.json'), json ?? '');
    // A portrait screen recording: red, with a white bar near its top, four seconds.
    await rt.fs.mkdir(rt.path.join(dir, 'assets'));
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0xe02020:s=360x640:r=30:d=4,drawbox=x=0:y=40:w=360:h=60:color=white:t=fill',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', rt.path.join(dir, 'assets', 'app.mp4')]);
    expect((await runCli(rt, ['video', 'check', 'project'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, errors: 0 });
    const first = rt.path.join(rt.dir, 'f0.png'), later = rt.path.join(rt.dir, 'f60.png');
    await renderFrame(rt, { projectDir: dir, frame: 0, out: first });
    await renderFrame(rt, { projectDir: dir, frame: 60, out: later });
    for (const png of [first, later]) {
      const p = await pixels(png);
      const screen = p.at(930, 400);
      expect(screen[0], 'the clip fills the screen').toBeGreaterThan(180);
      expect(screen[1]).toBeLessThan(80);
      // The clip's white bar, 40 px from its top: 36 px into the 576 px screen (cover scales 640 to 576).
      expect(Math.min(...p.at(930, 72 + 63)), 'the top of the clip at the top of the screen').toBeGreaterThan(200);
      const body = p.at(760, 360);
      expect(Math.max(...body), 'the phone\'s body round the screen').toBeLessThan(40);
      const ground = p.at(200, 100);
      expect(ground[2], 'the scene\'s ground').toBeGreaterThan(ground[0] ?? 0);
      expect(ground[0]).toBeLessThan(90);
    }
    // The title: not yet at frame 0, white letters at frame 60.
    const white = async (png: string): Promise<number> => {
      const p = await pixels(png);
      let n = 0;
      for (let y = 255; y < 320; y += 3) for (let x = 100; x < 640; x += 3) if (Math.min(...p.at(x, y)) > 220) n++;
      return n;
    };
    expect(await white(first)).toBe(0);
    expect(await white(later)).toBeGreaterThan(50);
  });
});
