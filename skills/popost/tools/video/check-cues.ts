// Maintainer tool (not part of the CLI, not shipped in the npm package): checks that every sound cue of the effects
// catalogue sits on the frame where its picture visibly changes. A whoosh 150 ms before the move is heard as a mistake,
// and sfx placement puts sounds where these cues are.
//
// Every entry is drawn as the scene of a later shot (as verify-examples.ts does), every frame at 30 fps up to a little
// after its last cue, shrunk to grey 320x180, and measured (cue-curve.ts): for each frame, the share of the pixels that
// moved, and the share that moved where nothing moved just before (a new element). A change starts where the curve
// rises out of quiet, jumps inside a running change, or a burst of new pixels appears; pop is judged against its onset
// or a peak, impact against a peak or the frame a move lands on, every other cue against the onset.
//
//   node_modules/.bin/vite-node skills/popost/tools/video/check-cues.ts "" cues.json [--keep dir] [--propose file]
//   node_modules/.bin/vite-node skills/popost/tools/video/check-cues.ts badge-pop,glitch /tmp/cues.json --full
//   node_modules/.bin/vite-node skills/popost/tools/video/check-cues.ts "" cues.json --from-grey dir   # kept frames
//
// Output, as { name: [{ cue, at, frame, offsetFrames, verdict, change, by }] }: offsetFrames is the cue's frame minus
// the change's frame (negative: the sound comes before the picture); verdict ok (|offset| <= OK_FRAMES), early or late
// (the nearest change within NEAR_FRAMES), inside (one of a row of cues inside a running change, for the eye), nothing
// (no change within NEAR_FRAMES).
//
// --cues file: check these cues ({ name: [{ at, cue, gain }] }) instead of the scenes' own. --keep dir: write every
// entry's grey frames as raw video (<name>.gray); --from-grey dir judges them again without drawing. --full: draw every
// entry whole (for a cue on nothing, to find the change it belongs to). --jobs N: N scratch projects side by side
// (default 2: drawing waits on the browser more than it computes). --propose file: for every entry whose cues are not
// all on their change, the cues it should have (proposeCues) as { name: { cues, moved, removed } }; saved as
// tools/video/hyperframes-cues.json, port-hyperframes.mjs writes them into the ported scenes. --curves file: the
// curves. Run it under the machine's lock for heavy jobs.
import { writeFile, readFile } from 'node:fs/promises';
import { createDiskRuntime } from '../../src/testing/disk';
import { runFfmpegOk } from '../../src/video/media/ffmpeg';
import { openSession } from '../../src/video/render/session';
import { librariesOf, readCatalogue, readExample, setExample } from '../../src/video/scene/examples';
import { addLibrary } from '../../src/video/scene/library';
import { curvesOfGrey, judgeCues, proposeCues, type CueVerdict, type Proposal } from './cue-curve';

const FPS = 30, BATCH = 8, SCALE = 0.5, LEAD = 6;
/** The curve is measured on the frames shrunk to this size (by area): a 640x360 drawing, four pixels to one. */
const GREY: [number, number] = [320, 180];
/** Frames drawn after the last cue: room for a change the cue comes before. */
const TAIL = 24;

const rt = await createDiskRuntime();
const arg = (name: string): string | undefined => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const cat = await readCatalogue(rt);
const only = process.argv[2] ? process.argv[2].split(',') : undefined;
const given = arg('--cues') ? (JSON.parse(await readFile(arg('--cues') as string, 'utf8')) as Record<string, { at: number; cue: string; gain: number }[]>) : undefined;
const entries = cat.entries.filter((e) => (!only || only.includes(e.name)) && (given ? given[e.name] : e.cues.length));

/** The curves of the frames drawn as f00000.png...: shrunk to GREY, grey; kept as raw video when keep names a file. */
const curvesOf = async (dir: string, n: number, keep?: string): Promise<{ d: number[]; fresh: number[] }> => {
  const raw = (await runFfmpegOk(rt, ['-loglevel', 'error', '-framerate', String(FPS), '-start_number', '0', '-i', rt.path.join(dir, 'f%05d.png'), '-frames:v', String(n), '-vf', 'scale=' + GREY.join(':') + ':flags=area,format=gray', '-f', 'rawvideo', '-'])).stdout as Buffer;
  if (keep) await writeFile(keep, raw);
  return curvesOfGrey(raw, GREY[0], GREY[1]);
};

const out: Record<string, CueVerdict[]> = {};
const curves: Record<string, number[]> = {};
const proposals: Record<string, Proposal> = {};
const judge = (name: string, d: number[], fresh: number[], declared: { at: number; cue: string; gain: number }[]): void => {
  curves[name] = d.map((v) => Math.round(v * 1e5) / 1e5);
  out[name] = judgeCues(d, declared, FPS, fresh);
  const p = proposeCues(d, declared, out[name], FPS, fresh);
  if (p) proposals[name] = p;
};
const cuesOf = (name: string): { at: number; cue: string; gain: number }[] => given?.[name] ?? cat.entries.find((e) => e.name === name)?.cues ?? [];

/** Judges the frames an earlier run kept (--from-grey dir): no drawing, so a change of the rules is checked in seconds. */
const fromGrey = async (dir: string): Promise<void> => {
  for (const e of entries) {
    const raw = await readFile(rt.path.join(dir, e.name + '.gray')).catch(() => undefined);
    if (!raw) { out[e.name] = [{ cue: 'error', at: 0, frame: 0, offsetFrames: 0, verdict: 'error', note: 'no kept frames' }]; continue; }
    const { d, fresh } = curvesOfGrey(raw, GREY[0], GREY[1]);
    judge(e.name, d, fresh, cuesOf(e.name));
  }
};

/** Draws one batch of entries as the scenes of one scratch project, and judges their cues. */
const drawBatch = async (b: number): Promise<void> => {
  const batch = entries.slice(b, b + BATCH);
  const dir = rt.path.join(rt.dir, 'p' + b);
  await rt.fs.mkdir(rt.path.join(dir, 'scenes'));
  const libs = new Set<string>();
  const segs: { id: string; frames: number; base: { scene: string } | { color: string } }[] = [{ id: 'lead', frames: LEAD, base: { color: '#000000' } }];
  for (const e of batch) {
    const html = setExample(await readExample(rt, e.name), [], [1280, 720]).html;
    librariesOf(html).forEach((l) => libs.add(l));
    await rt.fs.writeFile(rt.path.join(dir, 'scenes', e.name + '.html'), html);
    const last = Math.max(0, ...(given?.[e.name] ?? e.cues).map((c) => c.at));
    const whole = Math.round((e.seconds || 3) * FPS);
    segs.push({ id: e.name, frames: Math.max(30, process.argv.includes('--full') ? whole : Math.min(whole, Math.round(last * FPS) + TAIL)), base: { scene: 'scenes/' + e.name + '.html' } });
  }
  for (const l of libs) await addLibrary(rt, dir, l);
  await rt.fs.writeFile(rt.path.join(dir, 'video.json'), JSON.stringify({ version: 1, canvas: { width: 1280, height: 720, fps: FPS }, materials: [], segments: segs, tracks: [] }));
  try {
    const session = await openSession(rt, dir, { scale: SCALE });
    try {
      let start = 0;
      for (const [k, s] of segs.entries()) {
        if (s.id === 'lead') { start += s.frames; continue; }
        const frames = rt.path.join(dir, 'f-' + s.id);
        await rt.fs.mkdir(frames);
        const declared = given?.[s.id] ?? (await session.scenes({ frame: start, segment: k }))[0]?.cues ?? [];
        for (let f = 0; f < s.frames; f++) await rt.fs.writeFile(rt.path.join(frames, 'f' + String(f).padStart(5, '0') + '.png'), await session.frame(start + f, 'png'));
        const { d, fresh } = await curvesOf(frames, s.frames, arg('--keep') ? rt.path.join(arg('--keep') as string, s.id + '.gray') : undefined);
        judge(s.id, d, fresh, declared.length ? declared.map((c) => ({ at: c.at, cue: c.cue, gain: c.gain })) : cuesOf(s.id));
        await rt.fs.rm(frames);
        start += s.frames;
      }
    } finally { await session.close(); }
  } catch (e) {
    for (const s of segs) if (s.id !== 'lead' && !out[s.id]) out[s.id] = [{ cue: 'error', at: 0, frame: 0, offsetFrames: 0, verdict: 'error', note: String((e as Error).message).split('\n')[0]?.slice(0, 160) }];
  }
  process.stderr.write(Object.keys(out).length + '/' + entries.length + ' ');
};

/** Draws every batch, --jobs of them at a time. */
const draw = async (): Promise<void> => {
  const starts = Array.from({ length: Math.ceil(entries.length / BATCH) }, (_v, i) => i * BATCH);
  const jobs = Math.max(1, Number(arg('--jobs') ?? 2));
  await Promise.all(Array.from({ length: jobs }, async () => { for (let b = starts.shift(); b !== undefined; b = starts.shift()) await drawBatch(b); }));
};

await (arg('--from-grey') ? fromGrey(arg('--from-grey') as string) : draw());
if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(out, null, 1) + '\n');
if (arg('--curves')) await writeFile(arg('--curves') as string, JSON.stringify(curves) + '\n');
if (arg('--propose')) await writeFile(arg('--propose') as string, JSON.stringify(proposals, null, 1) + '\n');
const all = Object.values(out).flat();
const count = (v: string): number => all.filter((c) => c.verdict === v).length;
console.log(JSON.stringify({ entries: Object.keys(out).length, cues: all.length, ok: count('ok'), early: count('early'), late: count('late'), inside: count('inside'), nothing: count('nothing'), error: count('error') }));
await rt.cleanup();
