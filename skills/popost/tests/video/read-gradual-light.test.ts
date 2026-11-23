import { describe, expect, it } from 'vitest';
import { sameScene } from '../../src/video/measure/gradual';
import { thumbsOf } from '../../src/video/measure/pixels';
import { computeSignals } from '../../src/video/measure/signals';

const W = 72, H = 128;
const picture = (pixel: (x: number, y: number) => number[]): Uint8Array => {
  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgb.set(pixel(x, y), (y * W + x) * 3);
  return rgb;
};
const light = (a: Uint8Array, b: Uint8Array): boolean => {
  const t = thumbsOf({ width: W, height: H, fps: 30, frames: [a, b] });
  return sameScene(t, computeSignals(t), 0, 1);
};

describe('lighting changes and captioned colour cards', () => {
  it('does not use a stationary caption as evidence that two different colour cards are the same scene', () => {
    const card = (color: number[]) => picture((x, y) => y >= 92 && y < 123 && x >= 12 && x < 60 ? ((x + y) % 4 < 2 ? [255, 255, 255] : [0, 0, 0]) : color);
    expect(light(card([244, 162, 97]), card([42, 157, 143]))).toBe(false);
  });
  it('still recognises a lighting change over a detailed picture', () => {
    const a = picture((x, y) => { const v = 40 + ((x * 19 + y * 31) % 150); return [v, v + 10, v + 20]; });
    const b = a.map((v) => Math.round(0.7 * v + 20));
    expect(light(a, b)).toBe(true);
  });
  it('recognises a lighting change over a smooth gradient as well as fine texture', () => {
    const a = picture((x, y) => { const v = Math.round(30 + 150 * (x / W + y / H) / 2); return [v, v, v]; });
    expect(light(a, a.map((v) => Math.round(v * 0.55)))).toBe(true);
  });
});
