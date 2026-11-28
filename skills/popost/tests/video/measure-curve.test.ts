/**
 * The curve of one moving thing (measure/move.ts, measure/easing.ts): a dot drawn into pixel buffers moves on a known
 * easing, and the measurement gives the easing back with its start, length, distance, overshoot, bounces and squash.
 * The command is run on a clip made of such frames with ffmpeg (skipped without it).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { curvesOfShot, curveLines } from '../../src/video/describe/curves';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { bounceOut, easeNamed, EASES, fitEase, spring } from '../../src/video/measure/easing';
import { curvesOf, movePaste, moveSentence } from '../../src/video/measure/move';

const W = 240, H = 136, FPS = 30;
type Ease = (u: number) => number;

/** A frame: a dot of w x h at (x, y) on a flat ground. */
const frame = (x: number, y: number, w = 14, h = 14, ground: [number, number, number] = [18, 22, 40]): Uint8Array => {
  const f = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) f.set(ground, 3 * i);
  for (let py = Math.round(y - h / 2); py < Math.round(y + h / 2); py++) for (let px = Math.round(x - w / 2); px < Math.round(x + w / 2); px++)
    if (px >= 0 && py >= 0 && px < W && py < H) f.set([250, 210, 60], 3 * (py * W + px));
  return f;
};

/** Still for 6 frames, then from (30, 68) to (200, 68) on the ease over `frames`, then still for 14. */
const slide = (ease: Ease, frames = 30): Uint8Array[] =>
  [...Array.from({ length: 6 }, () => frame(30, 68)), ...Array.from({ length: frames + 1 }, (_v, i) => frame(30 + 170 * ease(i / frames), 68)), ...Array.from({ length: 14 }, () => frame(200, 68))];
const measured = (frames: Uint8Array[]) => curvesOf({ width: W, height: H, fps: FPS, frames }, { x: 0, y: 0, w: W, h: H });
const power = (k: number): Ease => (u) => 1 - (1 - u) ** (k + 1);

describe('the closest easing of a progress', () => {
  it('gives each curve of the named set back from its own samples', () => {
    const table: string[] = [];
    for (const e of EASES.filter((x) => !x.name.startsWith('spring(') || ['spring(0.5,130)', 'spring(0.3,250)', 'spring(0.8,90)'].includes(x.name))) {
      const fit = fitEase(Array.from({ length: 31 }, (_v, i) => e.f(i / 30)));
      table.push(e.name + ' -> ' + fit.ease + ' ' + fit.error);
      expect(fit.error, e.name).toBeLessThan(0.01);
      // Neighbours of one family may be nearly the same curve; the family is always right.
      expect(fit.ease.replace(/\(.*/, ''), e.name).toBe(e.name.replace(/\(.*/, ''));
    }
    console.log(table.join('\n'));
  });

  it('names springs by damping and gives the nearest GSAP ease beside the helper\'s', () => {
    const fit = fitEase(Array.from({ length: 41 }, (_v, i) => spring(0.5, 130)(i / 40)));
    expect(fit).toMatchObject({ ease: 'spring(0.5,130)', gsapExact: false });
    expect(fit.gsap).toMatch(/^back\.out\(/);
    expect(easeNamed('spring(0.45, 200)')?.(1)).toBeCloseTo(1, 1);
    expect(easeNamed('back.out(2.2)')?.(1)).toBeCloseTo(1, 6);
    expect(easeNamed('wobble')).toBeUndefined();
    // An ordinary ease-out is not called a spring.
    expect(fitEase(Array.from({ length: 31 }, (_v, i) => power(2)(i / 30))).ease).toBe('power2.out');
  });
});

describe('the curve of a moving dot', () => {
  it('recovers the easing, the start, the length and the distance of a slide', () => {
    for (const [name, ease] of [['power1.out', power(1)], ['power3.out', power(3)], ['linear', (u: number) => u], ['power2.inOut', (u: number) => (u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2)]] as [string, Ease][]) {
      const c = measured(slide(ease));
      const m = c.moves[0];
      expect(m, name).toBeDefined();
      expect(m?.prop).toBe('path');
      // The last fifth of a long ease-out moves the dot by a pixel or two, which the frames cannot show: the move is
      // then measured a little shorter and one power lower (power3.out over 1 s is power2.out over 0.8 s, to a pixel).
      const near = (a: string, b: string): boolean => a === b || (a.replace(/\d/, '') === b.replace(/\d/, '') && Math.abs(Number(/\d/.exec(a)?.[0]) - Number(/\d/.exec(b)?.[0])) <= 1);
      expect(near(m?.fit.ease ?? '', name), name + ' ' + JSON.stringify(m?.fit)).toBe(true);
      expect(m?.fit.error).toBeLessThan(0.03);
      expect(Math.abs((m?.start ?? 0) - 0.2), name).toBeLessThanOrEqual(0.07);
      expect(Math.abs((m?.duration ?? 0) - 1), name).toBeLessThanOrEqual(0.25);
      expect(m?.distance).toBeCloseTo(170 / W, 1);
      expect(m?.from[0]).toBeCloseTo(30 / W, 1);
      expect(m?.to[0]).toBeCloseTo(200 / W, 1);
      expect(m?.overshoot).toBeLessThan(1);
      expect(m?.turns).toBe(0);
    }
  });

  it('measures an overshoot and names the back ease or the spring that makes it', () => {
    const back = measured(slide(easeNamed('back.out(1.7)') as Ease)).moves[0];
    expect(back?.fit.ease).toMatch(/^back\.out\(1\.[5-9]\)$/);
    expect(back?.overshoot).toBeGreaterThan(7);
    expect(back?.overshoot).toBeLessThan(13);
    const sp = measured(slide(spring(0.4, 250), 45)).moves[0];
    expect(sp?.fit.ease, JSON.stringify(sp?.fit)).toMatch(/^spring\(0\.[345],/);
    expect(sp?.overshoot).toBeGreaterThan(18);
    expect(sp?.turns).toBeGreaterThanOrEqual(2);
    expect(movePaste(sp as NonNullable<typeof sp>).gsap).toContain('nearest GSAP ease');
  });

  it('counts the bounces of a ball that drops, with its squash on contact and its stretch in flight', () => {
    // Drops from y 20 to y 110 on bounce.out over 40 frames; flatter on the frames it touches, taller at speed.
    const frames = [...Array.from({ length: 5 }, () => frame(120, 20)), ...Array.from({ length: 41 }, (_v, i) => {
      const u = i / 40, p = bounceOut(u), speed = Math.abs(bounceOut(Math.min(1, u + 0.01)) - bounceOut(Math.max(0, u - 0.01)));
      const touching = p > 0.985 && i < 40, fast = speed > 0.04;
      return frame(120, 20 + 90 * p + (touching ? 2 : 0), touching ? 18 : fast ? 12 : 14, touching ? 10 : fast ? 18 : 14);
    }), ...Array.from({ length: 14 }, () => frame(120, 110))];
    const m = measured(frames).moves[0];
    expect(m?.fit.ease, JSON.stringify(m?.fit)).toBe('bounce.out');
    expect(m?.bounces).toBeGreaterThanOrEqual(2);
    expect(m?.turns).toBeGreaterThanOrEqual(4);
    expect(m?.squash?.squash).toBeLessThan(0.75);
    expect(m?.squash?.stretch).toBeGreaterThan(1.2);
    expect(moveSentence(m as NonNullable<typeof m>)).toMatch(/turns back \d+ times \(\d+ bounces\).*stretched to .* squashed to .*closest ease bounce\.out/);
  });

  it('follows a thing over a ground that is not flat, and says when nothing moves', () => {
    const striped = (f: Uint8Array): Uint8Array => { const g = Uint8Array.from(f); for (let i = 0; i < W * H; i++) if (g[3 * i] === 18 && (i % W) % 16 < 8) g.set([90, 30, 30], 3 * i); return g; };
    const m = measured(slide(power(2)).map(striped)).moves[0];
    expect(m?.fit.ease).toMatch(/^power[123]\.out$/);
    expect(measured(Array.from({ length: 30 }, () => frame(60, 60))).moves).toEqual([]);
  });

  it('writes a shot\'s main move under its motion events, or why none could be followed', () => {
    const c = curvesOfShot({ width: W, height: H, fps: FPS, frames: slide(power(3)) }, 2, 90);
    expect(c.shot).toBe(2);
    const lines = curveLines(c).join('\n');
    expect(lines).toMatch(/^- Main moving element \(measured curve\): From 3\.\d+ s it moves 71% of the canvas width/);
    expect(lines).toMatch(/paste: helper popostMotion\.ease\('power[23]\.out'\)/);
    expect(lines).toContain("GSAP { duration: ");
    expect(curveLines({ shot: 1, moves: [], note: 'no single moving element could be followed' })[0]).toContain('popost video measure curve <video> --from S --to S --roi x,y,w,h');
  });
});

const rt = await createDiskRuntime();
afterAll(() => rt.cleanup());

describe.skipIf(!(await hasFfmpeg(rt)))('popost video measure curve', () => {
  it('measures a region of a clip between two moments and prints the move, a sentence and what to paste', async () => {
    const frames = slide(easeNamed('back.out(1.7)') as Ease);
    await rt.fs.writeFile(rt.path.join(rt.dir, 'dot.rgb'), Buffer.concat(frames.map((f) => Buffer.from(f))));
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', W + 'x' + H, '-r', String(FPS), '-i', rt.path.join(rt.dir, 'dot.rgb'), '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv444p', rt.path.join(rt.dir, 'dot.mp4')]);
    expect((await runCli(rt, ['video', 'measure', 'curve', 'dot.mp4', '--from', '0', '--to', '1.6', '--roi', '0,0.2,1,0.6'])).code).toBe(0);
    const out = rt.json() as { ok: boolean; moves: { fit: { ease: string }; overshoot: number; sentence: string; paste: { helper: string; gsap: string } }[]; sentence: string };
    expect(out.ok).toBe(true);
    expect(out.moves[0]?.fit.ease).toMatch(/^back\.out\(/);
    expect(out.moves[0]?.overshoot).toBeGreaterThan(6);
    expect(out.sentence).toContain('closest ease back.out(');
    expect(out.moves[0]?.paste.gsap).toMatch(/ease: 'back\.out\(/);
    expect((await runCli(rt, ['video', 'measure', 'curve', 'dot.mp4', '--from', '1', '--to', '0.5'])).code).toBe(2);
    expect((await runCli(rt, ['video', 'measure', 'curve', 'dot.mp4', '--roi', '1,2'])).code).toBe(2);
  }, 60_000);
});
