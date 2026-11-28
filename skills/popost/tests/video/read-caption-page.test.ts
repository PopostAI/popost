/**
 * Outlined letters, plates and plain letters told apart by the shapes around the glyphs (text/rings.ts,
 * text/letters.ts, text/look.ts), on caption lines drawn into pixel buffers (caption-synth.ts):
 * - heavy white letters with a dark outline (7 or 10 % of their height) and a soft shadow, over a white page behind six
 *   lines of eight (with a dark picture beside them) and a busy picture behind the others: white letters, a dark
 *   outline and no plate. Over the page each colour encloses the other; the outline hugs the letters on every line,
 *   the letters hug the outline only where the picture is white, and the page goes on past where a plate would end.
 *   The orange word on one line in four is found, with its share;
 * - the same letters over a busy picture on every line: the same reading;
 * - dark letters on a white rounded plate over a busy picture, read through boxes around the letters and through
 *   boxes that hold the whole plate: a white plate with dark letters, never an outline;
 * - plain white letters over a busy picture: plain, no outline, no plate.
 */
import { describe, expect, it } from 'vitest';
import { deltaE, hexToRgb, toLab } from '../../src/video/measure/colour';
import { lookOf } from '../../src/video/text/look';
import type { CaptionLook } from '../../src/video/text/index';
import type { Rect, Rgb } from '../../src/video/text/frame';
import { drawLine, movingGround, type SynthStyle } from './caption-synth';

const LINES = ['THE FIRST LINE HERE', 'ANOTHER ONE COMES', 'AND THEN A THIRD', 'MORE WORDS FOLLOW', 'STILL ONE MORE', 'THE LAST OF THEM', 'BUT ONE CAME AFTER', 'AND THIS ONE'];
const WHITE: Rgb = [250, 250, 250], DARK: Rgb = [30, 34, 38], ORANGE: Rgb = [255, 140, 0];
const GLYPH = 36, WIDTH = 900;
type Ground = (x: number, y: number) => Rgb;

const outlined = (width: number): SynthStyle => ({ fill: [255, 255, 255], outline: { color: [0, 0, 0], width: GLYPH * width }, shadow: { color: [0, 0, 0], dx: 1, dy: 3, blur: 3 } });
const plated: SynthStyle = { fill: [26, 26, 26], plate: { color: [245, 245, 245], padding: 0.3, radius: 0.25 } };

/** A white page with a dark picture beside the line (an inset next to the captions). */
const page = (box: Rect): Ground => {
  const h = box.y1 - box.y0;
  return (x) => (x > box.x0 - 1.8 * h && x < box.x0 - 0.6 * h ? DARK : WHITE);
};
/** The page behind six lines of eight, a busy picture behind the others. */
const pageMostly = (k: number) => (box: Rect): Ground => ([0, 5].includes(k) ? movingGround(k) : page(box));
const busy = (k: number) => (): Ground => movingGround(k);

/** The lines drawn over their grounds, an orange first word on one line in four when lit, read with boxes grown by `grow` line heights. */
const read = (o: { style: SynthStyle; ground: (k: number) => (box: Rect) => Ground; lit?: boolean; grow?: number }): CaptionLook | undefined => {
  const made = LINES.map((text, k) => {
    const line = { text, glyph: GLYPH, style: o.style, width: WIDTH, soften: 1, ...(o.lit && k % 4 === 1 ? { lit: { from: 0, to: text.indexOf(' '), color: ORANGE } } : {}) };
    const { box } = drawLine({ ...line, ground: () => WHITE });
    const drawn = drawLine({ ...line, ground: o.ground(k)(box) });
    const g = (o.grow ?? 0) * (box.y1 - box.y0);
    return { frame: drawn.frame, box: { x0: box.x0 - g, y0: box.y0 - g, x1: box.x1 + g, y1: box.y1 + g } };
  });
  return lookOf(made.map((m) => m.frame), made.map((m) => m.box), LINES);
};
const dE = (hex: string | undefined, rgb: Rgb): number => (hex ? deltaE(toLab(hexToRgb(hex)), toLab(rgb)) : Infinity);
const show = (l: unknown): string => JSON.stringify(l);

describe('outlined letters, plates and plain letters told apart by their shapes', () => {
  for (const [name, ground] of [['a white page behind most lines', pageMostly], ['a busy picture behind every line', busy]] as const) for (const width of [0.07, 0.1]) {
    it('reads white letters with a dark outline of ' + width + ' over ' + name + ' as outlined, not as a plate, and finds the highlighted word', () => {
      const l = read({ style: outlined(width), ground, lit: true });
      expect(l?.kind, show(l)).toBe('outline');
      expect(dE(l?.color, [255, 255, 255]), show(l)).toBeLessThan(6);
      expect(l?.plate, show(l)).toBeUndefined();
      expect(l?.outline?.color, show(l)).toBeDefined();
      expect(toLab(hexToRgb(l?.outline?.color ?? '#ffffff'))[0], show(l)).toBeLessThan(25);
      expect(l?.weight, show(l)).toBe('heavy');
      expect(dE(l?.highlight?.color, ORANGE), show(l)).toBeLessThan(12);
      expect(l?.highlight?.lines, show(l)).toBe(2);
      expect(l?.highlight?.share, show(l)).toBe(0.25);
    });
  }

  it('reads dark letters on a white rounded plate as a plate, through tight boxes and through boxes that hold the whole plate', () => {
    for (const grow of [0, 0.5]) {
      const l = read({ style: plated, ground: busy, grow });
      expect(l?.kind, grow + ' ' + show(l)).toBe('plate');
      expect(dE(l?.plate?.color, [245, 245, 245]), grow + ' ' + show(l)).toBeLessThan(8);
      expect(dE(l?.color, [26, 26, 26]), grow + ' ' + show(l)).toBeLessThan(15);
      expect(l?.outline, grow + ' ' + show(l)).toBeUndefined();
    }
  });

  it('reads plain white letters over a busy picture as plain: no outline, no plate', () => {
    const l = read({ style: { fill: [255, 255, 255] }, ground: busy });
    expect(l?.kind, show(l)).toBe('plain');
    expect(dE(l?.color, [255, 255, 255]), show(l)).toBeLessThan(6);
    expect([l?.outline, l?.plate], show(l)).toEqual([undefined, undefined]);
  });
});
