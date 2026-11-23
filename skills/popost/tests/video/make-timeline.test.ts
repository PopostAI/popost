import { describe, expect, it } from 'vitest';
import type { Project, ResolvedItem, TextTrack } from '../../src/video/types';
import { resolve } from '../../src/video/timeline/resolve';
import { cameraAt, expectedBoundaries, itemStateAt, segmentsAt, transitionProgress, visibleRange } from '../../src/video/timeline/frame';
import { TEXT_STYLES } from '../../src/video/presets/text-styles';
import { compilePage } from '../../src/video/compile/page';
import { goodProject, variant } from './make-fixtures';

const item = (items: ResolvedItem[], id: string): ResolvedItem => {
  const found = items.find((i) => i.id === id);
  if (!found) throw new Error('no item ' + id);
  return found;
};
const shown = (r: ReturnType<typeof resolve>, n: number): number[] => segmentsAt(r, n).layers.map((l) => l.index);

describe('resolve: frame conventions of types.ts', () => {
  const r = resolve(goodProject());

  it('starts segments at the sums of the lengths before them; transitions do not change the length', () => {
    expect(r.frames).toBe(120);
    expect(r.segments.map((s) => [s.start, s.end])).toEqual([[0, 30], [30, 60], [60, 90], [90, 120]]);
  });

  it('places a transition of F frames on a .. a+F-1 with a = S_k - floor(F / 2)', () => {
    expect(r.segments[1]?.transition).toBeUndefined();
    expect(r.segments[2]?.transition).toMatchObject({ kind: 'slide', a: 56, frames: 9, boundary: 60 });
    expect(r.segments[3]?.transition).toMatchObject({ kind: 'fade', a: 84, frames: 12, boundary: 90 });
    const slide = r.segments[2]?.transition;
    if (!slide) throw new Error('no slide');
    expect(transitionProgress(slide, 56)).toBeCloseTo(1 / 10, 12);
    expect(transitionProgress(slide, 64)).toBeCloseTo(9 / 10, 12);
  });

  it('gives the measured boundaries { start: a - 1, end: a + F, frame: S_k }, a cut as { S_k - 1, S_k, S_k }', () => {
    expect(expectedBoundaries(r)).toEqual([
      { frame: 30, kind: 'cut', start: 29, end: 30, confidence: 1 },
      { frame: 60, kind: 'slide', start: 55, end: 65, direction: 'left', mode: 'push', confidence: 1 },
      { frame: 90, kind: 'fade', start: 83, end: 96, via: 'black', confidence: 1 },
    ]);
  });

  it('shows one layer outside transitions and both inside, on exactly the F frames', () => {
    expect(shown(r, 29)).toEqual([0]);
    expect(shown(r, 30)).toEqual([1]);
    expect(shown(r, 55)).toEqual([1]);
    expect(shown(r, 56)).toEqual([1, 2]);
    expect(shown(r, 64)).toEqual([1, 2]);
    expect(shown(r, 65)).toEqual([2]);
    expect(shown(r, 83)).toEqual([2]);
    expect(shown(r, 84)).toEqual([2, 3]);
    expect(shown(r, 95)).toEqual([2, 3]);
    expect(shown(r, 96)).toEqual([3]);
    expect(shown(r, -5)).toEqual([0]);
    expect(shown(r, 500)).toEqual([3]);
  });

  it('clamps items to the video and fills in every default', () => {
    const bar = item(r.items, 'bar');
    expect([bar.start, bar.end]).toEqual([30, 120]);
    const claim = item(r.items, 'claim');
    expect([claim.start, claim.end]).toEqual([3, 30]);
    expect(claim.enter).toEqual({ preset: 'pop', frames: 8, ease: 'linear', overshoot: 0.12, direction: 'up', distance: 0 });
    expect(claim.exit).toMatchObject({ preset: 'fade', frames: 6, ease: 'in' });
    expect(claim.style).toEqual(TEXT_STYLES.headline);
    expect(bar.exit).toMatchObject({ preset: 'none', frames: 0 });
    expect(bar.enter).toMatchObject({ preset: 'slide', direction: 'left', distance: 0.25, frames: 10, ease: 'out' });
    expect(item(r.items, 'logo')).toMatchObject({ src: 'assets/logo.png', fit: 'contain', start: 96, end: 120 });
    expect(r.segments[0]?.base).toEqual({ kind: 'image', src: 'assets/desk.png', fit: 'cover', zoom: 0.04, pan: [0, 0] });
    expect(r.segments[2]?.transition).toMatchObject({ direction: 'left', mode: 'push', via: 'black', ease: 'in-out' });
    const early = resolve(variant((p) => { (p.tracks[0] as TextTrack).during = { segment: 'proof', from: -40, to: 5 }; }));
    expect([item(early.items, 'claim').start, item(early.items, 'claim').end]).toEqual([0, 35]);
  });

  it('orders items by z, then by file order, and lists audio with start frames', () => {
    expect(r.items.map((i) => [i.id, i.z])).toEqual([['logo', 0], ['claim', 1], ['bar', 2]]);
    expect(r.audio).toEqual([
      { id: 'bgm', src: 'assets/music.wav', start: 0, gain: -18 },
      { id: 'claim.sound', src: 'assets/pop.wav', start: 3, gain: 0 },
    ]);
  });

  it('plays an entrance on the first enter.frames frames and an exit on the last exit.frames frames', () => {
    const claim = item(r.items, 'claim');
    expect(itemStateAt(claim, 2)).toBeUndefined();
    expect(itemStateAt(claim, 3)?.opacity).toBeCloseTo(0.5, 9);
    expect(itemStateAt(claim, 10)).toMatchObject({ opacity: 1, scale: 1 });
    expect(itemStateAt(claim, 23)).toMatchObject({ opacity: 1 });
    expect(itemStateAt(claim, 24)?.opacity).toBeCloseTo(1, 9);
    expect(itemStateAt(claim, 29)?.opacity).toBeLessThan(0.5);
    expect(itemStateAt(claim, 30)).toBeUndefined();
  });

  it('scales default lengths with the frame rate', () => {
    const r60 = resolve(variant((p: Project) => { p.canvas.fps = 60; p.segments.forEach((s) => { s.frames = 60; }); }));
    expect(item(r60.items, 'claim').enter.frames).toBe(16);
    expect(item(r60.items, 'claim').exit.frames).toBe(12);
  });
});

describe('compilePage', () => {
  it('embeds the timeline so that no text can end its script element', async () => {
    const r = resolve(variant((p) => { (p.tracks[0] as TextTrack).text = 'a </script><b> \u{2028} 视频'; }));
    const html = await compilePage(r, { scale: 0.5 });
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    const json = html.slice(html.indexOf('id="popost-data">') + 17, html.indexOf('</script>'));
    const data = JSON.parse(json) as { resolved: typeof r; scale: number };
    expect(data.scale).toBe(0.5);
    expect(data.resolved).toEqual(r);
    await expect(compilePage(r, { scale: 0 })).rejects.toThrow(/scale/);
  });
});

describe('camera', () => {
  it('runs over the whole visible range, transitions included, and never shows an edge', () => {
    const r = resolve(variant((p) => {
      p.segments[1] = { id: 'proof', frames: 30, base: { material: 'desk', camera: { zoom: -0.1, pan: [0.05, 0] } }, in: { transition: 'wipe', frames: 10 } };
    }));
    expect(visibleRange(r, 0)).toEqual([0, 34]);
    expect(visibleRange(r, 1)).toEqual([25, 64]);
    expect(cameraAt(r, 0, 0).scale).toBeCloseTo(1, 12);
    expect(cameraAt(r, 0, 30).scale).toBeCloseTo(1 + 0.04 * 1, 12);
    expect(cameraAt(r, 0, 34).scale).toBeGreaterThan(cameraAt(r, 0, 29).scale);
    const span = 39 / 30;
    const last = cameraAt(r, 1, 64);
    expect(last.scale).toBeCloseTo(1 + 0.05 * span, 9);
    expect(last.translate[0]).toBeCloseTo(0.05 * span / 2, 9);
    for (let n = 25; n <= 64; n++) {
      const c = cameraAt(r, 1, n);
      expect(c.scale - 1).toBeGreaterThanOrEqual(2 * Math.abs(c.translate[0]) - 1e-9);
    }
    expect(cameraAt(r, 2, 70)).toEqual({ scale: 1, translate: [0, 0] });
  });
});
