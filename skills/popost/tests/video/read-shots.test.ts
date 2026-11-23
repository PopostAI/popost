/**
 * compare shot by shot (score/shots.ts): a reference of five shots made with ffmpeg, against a copy 4% longer whose
 * third shot shows something else, and against the same copy whose measurement misses a cut. The changed shot must
 * come first in worst, with the dimension that makes it so; the other shots must be found where they are, by their
 * cuts or, around the missed cut, by share of the length. The whole-video scores are scoreMeasures', unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { measureVideo } from '../../src/video/measure/index';
import { scoreMeasures } from '../../src/video/score/index';
import { compareShots } from '../../src/video/score/shots';
import type { TextCue, TextTrack } from '../../src/video/text/types';
import type { Measure } from '../../src/video/types';

const rt = await createDiskRuntime();
const ffmpeg = await hasFfmpeg(rt);
afterAll(async () => { await rt.cleanup(); });

const S = 's=320x180:r=30';
/** Five shots: a moving test picture, a card that enters on orange, a still fractal, a gradient, a box on blue. */
const shotsOf = (third: string, stretch: number): [string, number][] => [
  ['testsrc2=' + S, 2], ['color=c=0xe07020:' + S + ",drawbox=x=80:y=50:w=160:h=80:color=0xfafafa:t=fill:enable='gte(t,0.5)'", 1.5],
  [third, 2], ['gradients=' + S + ':c0=0x203060:c1=0xe0a040:seed=1:speed=0.02', 1.5], ['color=c=0x2050c0:' + S + ',drawbox=x=40:y=40:w=60:h=60:color=0xffd040:t=fill', 2],
].map(([src, d]) => [src as string, Math.round((d as number) * stretch * 30) / 30]);

const make = async (file: string, shots: [string, number][]): Promise<string> => {
  const out = rt.path.join(rt.dir, file);
  const inputs = shots.flatMap(([src, d]) => ['-f', 'lavfi', '-t', String(d), '-i', src]);
  const chain = shots.map((_s, k) => '[' + k + ':v]').join('') + 'concat=n=' + shots.length + ':v=1:a=0,format=yuv420p[v]';
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', chain, '-map', '[v]', '-c:v', 'libx264', '-crf', '18', out]);
  return out;
};

/** The other's measurement with the cut between its shots k and k+1 missed: the two are read as one shot. */
const missCut = (m: Measure, k: number): Measure => {
  const a = m.shots[k] as Measure['shots'][number], b = m.shots[k + 1] as Measure['shots'][number];
  const merged = { ...a, end: b.end, events: [...a.events, ...b.events] };
  return { ...m, boundaries: m.boundaries.filter((_b, j) => j !== k), shots: [...m.shots.slice(0, k), merged, ...m.shots.slice(k + 2)].map((s, i) => ({ ...s, index: i })) };
};

let ref: Measure, other: Measure;
beforeAll(async () => {
  if (!ffmpeg) return;
  await make('ref.mp4', shotsOf('mandelbrot=' + S, 1));
  await make('other.mp4', shotsOf('color=c=0x30a050:' + S + ',drawbox=x=100:y=30:w=40:h=120:color=0x101010:t=fill', 1.04));
  ref = await measureVideo(rt, rt.path.join(rt.dir, 'ref.mp4'));
  other = await measureVideo(rt, rt.path.join(rt.dir, 'other.mp4'));
}, 120_000);

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

describe.skipIf(!ffmpeg)('compare, shot by shot', () => {
  it('reads the five shots of both videos', () => {
    expect(ref.shots).toHaveLength(5);
    expect(other.shots).toHaveLength(5);
  });

  it('finds each shot in a copy 4% longer by its cuts, and puts the changed shot first in worst', () => {
    const c = compareShots(ref, other);
    expect(c.shots.map((s) => s.paired)).toEqual(['cuts', 'cuts', 'cuts', 'cuts', 'cuts']);
    for (const s of c.shots) expect(near(s.other.from, s.reference.from * 1.04, 0.1) && near(s.other.to, s.reference.to * 1.04, 0.1), JSON.stringify(s)).toBe(true);
    expect(c.worst).toHaveLength(3);
    const first = c.worst[0];
    expect(first?.shot, JSON.stringify(c.shots)).toBe(3);
    expect(['picture', 'colour']).toContain(first?.by);
    // The moment to look at lies inside the shot in both videos.
    expect(first && first.at.reference >= first.reference.from && first.at.reference <= first.reference.to && first.at.other >= first.other.from && first.at.other <= first.other.to).toBe(true);
    // The unchanged shots are alike on every dimension they have; the changed one is not.
    for (const s of c.shots.filter((x) => x.shot !== 3)) expect(s.score, JSON.stringify(s)).toBeGreaterThan(0.75);
    expect(c.shots[2]?.score).toBeLessThan(0.5);
  });

  it('finds the shots around a missed cut by share of the length', () => {
    const c = compareShots(ref, missCut(other, 3));
    expect(c.shots.map((s) => s.paired)).toEqual(['cuts', 'cuts', 'cuts', 'share', 'share']);
    for (const s of c.shots) expect(near(s.other.from, s.reference.from * 1.04, 0.15) && near(s.other.to, s.reference.to * 1.04, 0.15), JSON.stringify(s)).toBe(true);
    expect(c.worst[0]?.shot).toBe(3);
  });

  it('a video against itself is alike everywhere, and compares text when both were read', () => {
    const self = compareShots(ref, ref);
    for (const s of self.shots) expect(s.score, JSON.stringify(s)).toBeGreaterThan(0.95);
    const line = (start: number, y: number, size: number): TextCue => ({ text: 'x', start, end: start + 40, box: [0.2, y, 0.6, size], role: 'title', size, samples: 5, confidence: 0.9 });
    const a: TextTrack = { step: 6, sampled: 50, cues: [line(70, 0.2, 0.1)] };
    const moved: TextTrack = { step: 6, sampled: 50, cues: [line(70, 0.75, 0.04), line(75, 0.85, 0.04)] };
    expect(compareShots(ref, ref, { text: { reference: a, other: a } }).shots[1]?.scores.text).toBe(1);
    const t = compareShots(ref, ref, { text: { reference: a, other: moved } }).shots[1];
    expect(t?.scores.text).toBeLessThan(0.5);
    expect(t?.by).toBe('text');
    // Shots where neither shows text are not scored on it.
    expect(compareShots(ref, ref, { text: { reference: a, other: a } }).shots[0]?.scores.text).toBeUndefined();
  });

  it('popost video compare prints the same scores as before, then shots and worst with a look command that shows each', async () => {
    expect((await runCli(rt, ['video', 'compare', 'ref.mp4', 'other.mp4'])).code).toBe(0);
    const out = rt.json() as { composite: number; dimensions: unknown; shots: unknown[]; worst: { shot: number; by: string; reference: { at: number }; other: { at: number }; look: string }[] };
    const score = scoreMeasures(ref, other);
    expect(out.composite).toBe(score.composite);
    expect(out.dimensions).toEqual(score.dimensions);
    expect(out.shots).toHaveLength(5);
    const w = out.worst[0];
    expect(w?.shot).toBe(3);
    expect(w?.look).toBe('popost video look other.mp4 --at ' + w?.other.at + ' --against ref.mp4 --against-at ' + w?.reference.at + ' --width 320 --out review/shot-03');
    const args = (w?.look ?? '').split(' ').slice(1);
    expect((await runCli(rt, args)).code).toBe(0);
    const look = rt.json() as { pictures: { file: string; second: number; against: { second: number } }[] };
    expect(look.pictures).toHaveLength(1);
    expect(near(look.pictures[0]?.second ?? -1, w?.other.at ?? 0, 0.04) && near(look.pictures[0]?.against.second ?? -1, w?.reference.at ?? 0, 0.04)).toBe(true);
    expect((await runCli(rt, ['video', 'look', 'other.mp4', '--at', '1,2', '--against', 'ref.mp4', '--against-at', '1', '--out', 'x'])).code).toBe(2);
  });
});
