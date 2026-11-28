// Maintainer tool (not part of the CLI, not shipped in the npm package): draws every entry of the effects catalogue
// in the renderer, each as the scene of a later shot (so that it loads in a layer that is not displayed, as the scenes
// of a real video do), and writes which entries fail and why:
//   - a lint error, a script that throws, a file that does not load;
//   - the same picture at five moments of its length (nothing moves, or nothing is drawn), or pictures that hardly
//     differ: under STILL_SHARE of the pixels change between any two of them (a shader that blends two empty textures,
//     a layout measured while the layer was hidden: a few pixels of noise passed a byte comparison);
//   - a different picture when it loads hidden (as the scene of a later shot) than when it loads shown (as the first
//     shot of a project of its own), at the same moment: it measures or captures its layout while it loads;
//   - a frame that is not the same picture when it is drawn again after later frames (it does not follow from its
//     time alone); a difference in the smoothing of an edge, under 0.4% of the pixels, does not count.
//
//   node_modules/.bin/vite-node skills/popost/tools/video/verify-examples.ts "" skills/popost/tools/video/hyperframes-unverified.json
//   node_modules/.bin/vite-node skills/popost/tools/video/verify-examples.ts badge-pop,glitch /tmp/out.json
//
// The second argument is where the failures go, as { "name": "reason" }. port-hyperframes.mjs reads
// hyperframes-unverified.json and leaves those items out of the catalogue with that reason: run the port, this
// check, and the port again. Run it under the machine's lock for heavy jobs; it takes about half an hour.
import { writeFile } from 'node:fs/promises';
import { createDiskRuntime } from '../../src/testing/disk';
import { runFfmpegOk } from '../../src/video/media/ffmpeg';
import { openSession } from '../../src/video/render/session';
import { librariesOf, readCatalogue, readExample, setExample } from '../../src/video/scene/examples';
import { addLibrary } from '../../src/video/scene/library';
import { lintScene } from '../../src/video/scene/lint';

const rt = await createDiskRuntime();

/** The share of the pixels of two pictures of one size that differ by more than level grey levels. */
const differing = async (a: Buffer, b: Buffer, level = 32): Promise<number> => {
  await rt.fs.writeFile(rt.path.join(rt.dir, 'a.png'), a);
  await rt.fs.writeFile(rt.path.join(rt.dir, 'b.png'), b);
  const raw = (await runFfmpegOk(rt, ['-loglevel', 'error', '-i', rt.path.join(rt.dir, 'a.png'), '-i', rt.path.join(rt.dir, 'b.png'), '-lavfi', 'blend=all_mode=difference,format=gray', '-f', 'rawvideo', '-'])).stdout;
  let n = 0;
  for (const v of raw) if (v > level) n++;
  return n / Math.max(1, raw.length);
};
const cat = await readCatalogue(rt);
const only = process.argv[2] ? process.argv[2].split(',') : undefined;
const entries = cat.entries.filter((e) => !only || only.includes(e.name));
const BATCH = 8, FPS = 30;
/** Moments that differ in fewer pixels than this (by more than 6 grey levels; 23 pixels of the 640x360 drawing) are one picture. */
const STILL_SHARE = 0.0001;
/** A scene drawn after loading hidden that differs from itself loaded shown in more than this share of its pixels. */
const HIDDEN_SHARE = 0.02;
/** The local frames both drawings are compared at, and the later-shot pictures of them, by entry. */
const probes = new Map<string, { frames: number[]; pictures: Buffer[]; html: string; libs: string[] }>();
const out: Record<string, { ok: boolean; why?: string }> = {};
for (let b = 0; b < entries.length; b += BATCH) {
  const batch = entries.slice(b, b + BATCH);
  const dir = rt.path.join(rt.dir, 'p' + b);
  await rt.fs.mkdir(rt.path.join(dir, 'scenes'));
  const libs = new Set<string>();
  const segs: { id: string; frames: number; base: { scene: string } | { color: string } }[] = [{ id: 'lead', frames: 6, base: { color: '#000000' } }];
  for (const e of batch) {
    const ex = await readExample(rt, e.name);
    const html = setExample(ex, [], [1280, 720]).html;
    const lint = lintScene(html, e.name).filter((p) => p.level === 'error');
    if (lint.length) { out[e.name] = { ok: false, why: 'lint: ' + lint[0]?.message.slice(0, 120) }; continue; }
    librariesOf(html).forEach((l) => libs.add(l));
    await rt.fs.writeFile(rt.path.join(dir, 'scenes', e.name + '.html'), html);
    segs.push({ id: e.name, frames: Math.max(30, Math.round(Math.min(8, e.seconds || 3) * FPS)), base: { scene: 'scenes/' + e.name + '.html' } });
  }
  for (const l of libs) await addLibrary(rt, dir, l);
  await rt.fs.writeFile(rt.path.join(dir, 'video.json'), JSON.stringify({ version: 1, canvas: { width: 1280, height: 720, fps: FPS }, materials: [], segments: segs, tracks: [] }));
  try {
    const session = await openSession(rt, dir, { reuse: false, scale: 0.5 });
    try {
      let start = 0;
      for (const s of segs) {
        if (s.id === 'lead') { start += s.frames; continue; }
        const before = session.errors().length;
        const frames = [...new Set([3, 15, 36, Math.floor(s.frames * 0.6), Math.floor(s.frames * 0.9)].map((f) => start + Math.min(s.frames - 1, f)))];
        const first: Buffer[] = [];
        for (const f of frames) first.push(await session.frame(f));
        const again: Buffer[] = [];
        for (const f of [...frames].reverse()) again.unshift(await session.frame(f));
        const errs = [...new Set(session.errors().slice(before))];
        // Not byte for byte: Chrome keeps a layer drawn at the size it last had, so a scaled or turned element can
        // differ by the smoothing of its edge after another frame. A picture that really differs does so over an area.
        let same = true;
        for (const [i, x] of first.entries()) if (!x.equals(again[i] as Buffer) && (await differing(x, again[i] as Buffer)) > 0.004) same = false;
        const still = first.every((x) => x.equals(first[0] as Buffer));
        let most = 0;
        if (!still) for (const [i, x] of first.entries()) for (const y of first.slice(i + 1)) if (!x.equals(y)) most = Math.max(most, await differing(x, y, 6));
        const source = await rt.fs.readText(rt.path.join(dir, 'scenes', s.id + '.html'));
        probes.set(s.id, { frames: frames.map((f) => f - start), pictures: first, html: source, libs: librariesOf(source) });
        out[s.id] = errs.length ? { ok: false, why: 'error: ' + errs[0]?.slice(0, 140) } : !same ? { ok: false, why: 'not the same picture when drawn again' } : still ? { ok: false, why: 'the same picture at three times' } : most < STILL_SHARE ? { ok: false, why: 'hardly changes: ' + (most * 100).toFixed(4) + '% of the pixels at most between its moments' } : { ok: true };
        start += s.frames;
      }
    } finally { await session.close(); }
  } catch (e) {
    for (const s of segs) if (!out[s.id]) out[s.id] = { ok: false, why: 'batch: ' + String((e as Error).message).split('\n')[0]?.slice(0, 160) };
  }
  process.stderr.write(b + ' ');
}
/** Each entry that passed, drawn as the first shot of a project of its own, against its later-shot picture. */
for (const [name, p] of probes) {
  if (!out[name]?.ok) continue;
  const dir = rt.path.join(rt.dir, 'alone-' + name);
  await rt.fs.mkdir(rt.path.join(dir, 'scenes'));
  await rt.fs.writeFile(rt.path.join(dir, 'scenes', name + '.html'), p.html);
  for (const l of p.libs) await addLibrary(rt, dir, l);
  await rt.fs.writeFile(rt.path.join(dir, 'video.json'), JSON.stringify({ version: 1, canvas: { width: 1280, height: 720, fps: FPS }, materials: [], segments: [{ id: name, frames: Math.max(...p.frames) + 1, base: { scene: 'scenes/' + name + '.html' } }], tracks: [] }));
  try {
    const session = await openSession(rt, dir, { reuse: false, scale: 0.5 });
    try {
      let share = 0;
      for (const [i, f] of p.frames.entries()) {
        const shown = await session.frame(f), hidden = p.pictures[i] as Buffer;
        if (!shown.equals(hidden)) share = Math.max(share, await differing(shown, hidden));
      }
      if (share > HIDDEN_SHARE) out[name] = { ok: false, why: 'the same picture only when it loads shown: ' + (share * 100).toFixed(1) + '% of the pixels differ when it loads hidden' };
    } finally { await session.close(); }
  } catch { /* drawn as a later shot it passed; a failure here is not its own */ }
}

const bad = Object.entries(out).filter(([, v]) => !v.ok);
if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(Object.fromEntries(bad.map(([k, v]) => [k, v.why ?? 'failed'])), null, 1) + '\n');
console.log(JSON.stringify({ total: Object.keys(out).length, ok: Object.keys(out).length - bad.length, bad: bad.length }));
await rt.cleanup();
