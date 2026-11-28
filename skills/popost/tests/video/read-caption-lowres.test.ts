/**
 * The caption look on small, soft letters (text/core.ts, text/letters.ts, text/reveal.ts), on lines drawn into pixel
 * buffers (caption-synth.ts): letters 30 and 40 pixels tall, softened as an enlarged or hard-compressed video is.
 * - heavy white letters with a black outline and a soft shadow come back as white (the strokes' core, not the grey of
 *   their edges), outlined in a dark colour, heavy; also in a dark video, where the outline has the picture's colour;
 * - thin plain letters come back regular;
 * - a word in orange on one line in four is found with its share, and the template card and the fill check say how
 *   many lines to mark;
 * - a line that comes on whole, word by word and character by character is told apart from its first frames, and a
 *   fill follows the measurement.
 */
import { describe, expect, it } from 'vitest';
import { deltaE, hexToRgb, toLab } from '../../src/video/measure/colour';
import { retarget } from '../../src/video/retarget/index';
import { templateCard } from '../../src/video/template/card';
import { captionLookProblems } from '../../src/video/template/check-captions';
import { slotsOf } from '../../src/video/template/slots';
import { retargetInputs, templateFrom } from '../../src/video/template/structure';
import { lookOf } from '../../src/video/text/look';
import { coverageOf, lineReveal, revealOf } from '../../src/video/text/reveal';
import type { CaptionLook, TextTrack } from '../../src/video/text/index';
import type { CaptionTrack, Measure } from '../../src/video/types';
import type { Rgb } from '../../src/video/text/frame';
import { drawLine, movingGround, type SynthStyle } from './caption-synth';

const LINES = ['THE FIRST LINE HERE', 'ANOTHER ONE COMES', 'AND THEN A THIRD', 'MORE WORDS FOLLOW', 'STILL ONE MORE', 'THE LAST OF THEM', 'BUT ONE CAME AFTER', 'AND THIS ONE'];
const ORANGE: Rgb = [255, 140, 0];
/** A dark video: black or near it around most lines, a lighter picture on every fourth. */
const dark = (k: number): ((x: number, y: number) => Rgb) => (x, y) => (k % 4 === 3 ? movingGround(k)(x, y) : movingGround(k, 20, 70)(x, y).map((v) => Math.max(0, v - 30)) as Rgb);
const heavy = (glyph: number): SynthStyle => ({ fill: [255, 255, 255], outline: { color: [0, 0, 0], width: glyph * 0.06 }, shadow: { color: [0, 0, 0], dx: 1, dy: 3, blur: 3 } });

const look = (o: { glyph: number; style: SynthStyle; ground: (k: number) => (x: number, y: number) => Rgb; soften: number; lit?: boolean }): CaptionLook | undefined => {
  const made = LINES.map((text, k) => drawLine({ text, glyph: o.glyph, style: o.style, ground: o.ground(k), width: 640, soften: o.soften, ...(o.lit && k % 4 === 1 ? { lit: { from: 0, to: text.indexOf(' '), color: ORANGE } } : {}) }));
  return lookOf(made.map((m) => m.frame), made.map((m) => m.box), LINES);
};
const dE = (hex: string | undefined, rgb: Rgb): number => (hex ? deltaE(toLab(hexToRgb(hex)), toLab(rgb)) : Infinity);
const show = (l: unknown): string => JSON.stringify(l);

describe('the look of small, soft caption letters', () => {
  const table: string[] = [];
  for (const glyph of [40, 30]) for (const soften of [1, 2]) for (const [name, ground] of [['colour', (k: number) => movingGround(k)], ['dark', dark]] as const) {
    it('reads heavy white letters with a black outline and a shadow, ' + glyph + ' px, softened ' + soften + ', ' + name + ' picture', () => {
      const l = look({ glyph, style: heavy(glyph), ground, soften, lit: true });
      table.push([glyph, soften, name, l?.kind, l?.color, l?.outline?.color, l?.weight, l?.stroke, l?.highlight?.color, l?.highlight?.share].join(' | '));
      expect(l?.kind, show(l)).toBe('outline');
      // White, not the grey of the strokes' edges.
      expect(dE(l?.color, [255, 255, 255]), show(l)).toBeLessThan(6);
      expect(l?.weight, show(l)).toBe('heavy');
      // The outline is dark when its colour is given at all.
      if (l?.outline?.color) expect(toLab(hexToRgb(l.outline.color))[0], show(l)).toBeLessThan(25);
      expect(dE(l?.highlight?.color, ORANGE), show(l)).toBeLessThan(10);
      expect(l?.highlight?.lines).toBe(2);
      expect(l?.highlight?.share).toBe(0.25);
    });
  }
  it('prints what was read', () => { console.log(['glyph | soften | picture | kind | fill | outline | weight | stroke | highlight | share', ...table].join('\n')); });

  it('keeps a shadow under an outline when the letters are sharp enough to show it', () => {
    const l = look({ glyph: 40, style: heavy(40), ground: (k) => movingGround(k), soften: 0 });
    expect(l?.kind).toBe('outline');
    expect(l?.shadow, show(l)).toBeDefined();
    expect(look({ glyph: 40, style: { fill: [255, 255, 255], outline: { color: [0, 0, 0], width: 2.4 } }, ground: (k) => movingGround(k), soften: 0 })?.shadow).toBeUndefined();
  });

  it('reads thin plain letters as regular, and finds no highlight where there is none', () => {
    const l = look({ glyph: 40, style: { fill: [255, 255, 255], stroke: 0.55 }, ground: dark, soften: 0 });
    expect(dE(l?.color, [255, 255, 255]), show(l)).toBeLessThan(6);
    expect(l?.weight, show(l)).toBe('regular');
    expect(l?.highlight, show(l)).toBeUndefined();
  });
});

describe('how a caption line comes on screen', () => {
  const TEXT = 'THE FIRST LINE HERE', WHITE = [toLab([255, 255, 255])];
  const chars = Array.from(TEXT.replace(/\s/g, '')).length;
  /** The line with its first `shown` characters, eleven frames: nothing for two frames, then by the given schedule. */
  const series = (schedule: number[]): ReturnType<typeof lineReveal> => {
    const ground = movingGround(2, 90, 60);
    const draw = (shown: number) => drawLine({ text: TEXT, glyph: 36, style: heavy(36), ground, width: 640, soften: 1, shown });
    const final = draw(TEXT.length);
    const cover = coverageOf(schedule.map((n) => draw(n).frame), final.frame, final.box, WHITE);
    expect(cover).toBeDefined();
    return lineReveal(cover ?? [], chars, 30);
  };
  const N = TEXT.length;

  it('tells whole lines, words and characters apart', () => {
    expect(series([0, 0, N, N, N, N, N, N])).toEqual({ kind: 'whole' });
    // THE | FIRST | LINE | HERE, a word every three frames.
    expect(series([0, 0, 3, 3, 3, 9, 9, 9, 14, 14, 14, N, N, N])).toEqual({ kind: 'words', frames: 9 });
    expect(series([0, 0, ...Array.from({ length: N }, (_v, k) => k + 1), N])?.kind).toBe('chars');
    // Already there on the first frame looked at: nothing to tell.
    expect(series([N, N, N, N])).toBeUndefined();
    // Still building when the frames end.
    expect(series([0, 0, 3, 3, 3, 9, 9, 9, 14, 14])).toEqual({ kind: 'words' });
  });

  it('gives the kind most lines agree on, with its share', () => {
    expect(revealOf([{ kind: 'whole' }, { kind: 'whole' }, undefined, { kind: 'words', frames: 9 }], 30)).toEqual({ kind: 'whole', lines: 2, of: 3, confidence: 0.67 });
    expect(revealOf([{ kind: 'words', frames: 9 }, { kind: 'words', frames: 15 }, { kind: 'words' }], 30)).toEqual({ kind: 'words', lines: 3, of: 3, confidence: 1, seconds: 0.5 });
    expect(revealOf([{ kind: 'whole' }], 30)).toBeUndefined();
  });
});

describe('a fill follows the measured captions', () => {
  const W = 960, H = 720, FRAMES = 240;
  const measure: Measure = {
    version: 1, source: { width: W, height: H, fps: 30, frames: FRAMES, duration: FRAMES / 30, hasAudio: false }, boundaries: [],
    shots: [{ index: 0, start: 0, end: FRAMES, camera: { kind: 'static', zoomPerS: 0, panPerS: [0, 0], confidence: 1 }, background: '#808080', palette: [], events: [] }],
    rhythm: { step: 3, change: [] }, signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
  };
  const track = (captionLook: CaptionLook): TextTrack => ({
    step: 6, sampled: 40, captionLook,
    cues: LINES.map((text, i) => ({ text, start: i * 30, end: (i + 1) * 30, box: [0.2, 0.8, 0.6, 0.06], role: 'caption' as const, size: 0.06, samples: 5, confidence: 0.95 })),
  });
  const base: CaptionLook = { kind: 'outline', color: '#ffffff', confidence: 1, samples: 8, outline: { color: '#000000', confidence: 0.9 }, weight: 'heavy', highlight: { color: '#ff8c00', confidence: 1, lines: 2, share: 0.25 } };
  const fill = (marked: number): string[] => LINES.map((l, i) => (i < marked ? '*' + l.split(' ')[0] + '* ' + l.split(' ').slice(1).join(' ') : l));

  it('says the share on the card and how the lines came on', () => {
    const t = templateFrom({ measure, text: track({ ...base, reveal: { kind: 'whole', lines: 5, of: 6, confidence: 0.83 } }), name: 't', label: 'synthetic', hash: 'sha256:0' });
    const card = templateCard(t, slotsOf(t, { cjk: 12, latin: 24, lines: 1, measured: false, method: 'test' }, {})).text;
    expect(card).toContain('About 1 line in 4 has a highlighted word or two: mark about 2 of your 8 lines');
    expect(card).toContain('The source showed each line whole at once (5 of 6 line starts measured): leave "captionReveal" out.');
  });

  it('warns when the fill marks under half or over double the source\'s share, with the number of lines', () => {
    const none = captionLookProblems(base, { captions: fill(0) });
    expect(none.map((p) => p.message + ' ' + p.fix).join('\n')).toContain('about 1 line in 4');
    expect(none[0]?.fix).toContain('Mark about 2 lines (2 more)');
    expect(captionLookProblems(base, { captions: fill(2) })).toEqual([]);
    expect(captionLookProblems(base, { captions: fill(1) })).toEqual([]);
    const many = captionLookProblems(base, { captions: fill(7) });
    expect(many[0]?.fix).toContain('Keep the marks on about 2 lines (remove them from 5)');
    // Nothing to say of a source without a highlight, or with too few lines measured.
    expect(captionLookProblems({ ...base, highlight: undefined }, { captions: fill(0) })).toEqual([]);
    expect(captionLookProblems({ ...base, samples: 4 }, { captions: fill(0) })).toEqual([]);
  });

  it('warns about a word-by-word reveal the source did not have, and builds lines by default when it had one', () => {
    const whole: CaptionLook = { ...base, reveal: { kind: 'whole', lines: 5, of: 6, confidence: 0.83 } };
    expect(captionLookProblems(whole, { captions: fill(2), captionReveal: 'words' })[0]?.message).toContain('whole at once');
    expect(captionLookProblems(whole, { captions: fill(2) })).toEqual([]);
    const plan = { shots: [{ color: '#202020' }], captions: fill(2), sound: 'assets/voice.wav' };
    const made = (look: CaptionLook, extra: object = {}): CaptionTrack | undefined => {
      const t = templateFrom({ measure, text: track(look), name: 't', label: 'synthetic', hash: 'sha256:0' });
      return retarget({ ...retargetInputs(t), plan: { ...plan, ...extra }, wordsFile: 'voice.words.json' }).project?.tracks.find((x): x is CaptionTrack => x.type === 'caption');
    };
    expect(made(whole)?.reveal).toBeUndefined();
    const words: CaptionLook = { ...base, reveal: { kind: 'words', lines: 5, of: 6, confidence: 0.83, seconds: 0.6 } };
    expect(made(words)?.reveal).toBe('words');
    expect(made(words, { captionReveal: 'whole' })?.reveal).toBeUndefined();
    expect(made(whole, { captionReveal: 'words' })?.reveal).toBe('words');
    expect(made({ ...base, weight: 'regular' })?.style).toMatchObject({ weight: 500 });
    expect(made(base)?.style).toMatchObject({ weight: 800 });
  });
});
