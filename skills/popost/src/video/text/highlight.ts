/**
 * Words of caption lines filled with another colour than the rest of the line: a highlighted keyword. Given the fill
 * (letters.ts, or the letters on a plate) and what surrounds it, a highlight is a colour that recurs inside the
 * lines' boxes on two lines or more (a quarter of them or more) and:
 * - is neither the fill, nor what surrounds it, nor the picture around the lines;
 * - has the fill's surroundings: the same outline or plate around its strokes; on plain letters, around it is not the
 *   fill (the picture seen between two letters is enclosed by the fill, and is no highlight);
 * - covers one stretch of a line, a word or a few, with no fill inside that stretch, on the lines it is found on.
 * Which words: the line's ink is cut at the gaps between words when there are as many pieces as the reader's text has
 * words; otherwise the characters are laid out over the ink by their usual widths (a full-width character one em,
 * others about half). The words come back marked the way a fill marks them: "Then comes the *third*".
 */
import { deltaE } from '../measure/colour';
import { toHex } from '../measure/pixels';
import { r2, type Frame, type Lab, type Rect } from './frame';
import { dEdge, isPicture, strokeMax, strokesOf, SURE, type Surround } from './letters';
import type { CaptionHighlight } from './types';

/**
 * What a highlight is compared with: the fill's colour on each line, its stroke pixels when they are known already,
 * and what surrounds the fill (undefined for plain letters).
 */
export interface FillContext { fill: (Lab | undefined)[]; px?: number[][]; around?: Lab }

/** Examples kept in a look, at most. */
const MAX_EXAMPLES = 4;
const WIDE = /[\u{1100}-\u{115f}\u{2e80}-\u{a4cf}\u{ac00}-\u{d7af}\u{f900}-\u{faff}\u{fe30}-\u{fe4f}\u{ff00}-\u{ff60}\u{ffe0}-\u{ffe6}\u{1f300}-\u{1faff}\u{20000}-\u{3134f}]/u;
const NOT_LATIN = /[^\u{0}-\u{24f}]/u;

/** How wide a character usually is, in ems. */
const widthOf = (ch: string): number =>
  WIDE.test(ch) ? 1 : /\s/.test(ch) ? 0.3 : /[iljtfr.,:;'!|()[\]]/.test(ch) ? 0.32 : /[mwMW]/.test(ch) ? 0.9 : /[A-Z0-9]/.test(ch) ? 0.68 : 0.56;

/** Runs of true flags as [from, to) pairs. */
const runsOf = (flags: boolean[]): [number, number][] => {
  const out: [number, number][] = [];
  flags.forEach((on, i) => {
    const last = out[out.length - 1];
    if (on && last && last[1] === i) last[1] = i + 1;
    else if (on) out.push([i, i + 1]);
  });
  return out;
};

/** The text with the characters of each run wrapped in asterisks. */
const marked = (chars: string[], runs: [number, number][]): string =>
  chars.map((c, i) => (runs.some(([a]) => a === i) ? '*' : '') + c + (runs.some(([, b]) => b === i + 1) ? '*' : '')).join('');

const isSpace = (w: string): boolean => /^\s+$/.test(w);

/**
 * Which characters of a line the highlight covers. ink: the columns of the line's letters (fill and highlight);
 * lit: the columns of the highlight; gap: the least gap between two words, in pixels.
 */
export const litChars = (text: string, ink: number[], lit: number[], gap: number): boolean[] => {
  const chars = Array.from(text);
  const cols = [...new Set(ink)].sort((a, b) => a - b);
  const on = new Set(lit);
  if (!cols.length || !lit.length) return chars.map(() => false);
  const words = text.split(/(\s+)/).filter((w) => w.length > 0);
  // The ink cut where it stops for a word gap or more.
  const parts: [number, number][] = [];
  for (const c of cols) {
    const last = parts[parts.length - 1];
    if (last && c - last[1] <= gap) last[1] = c;
    else parts.push([c, c]);
  }
  const real = words.filter((w) => !isSpace(w));
  if (real.length > 1 && parts.length === real.length) {
    let k = 0;
    return words.flatMap((w) => {
      const n = Array.from(w).length;
      if (isSpace(w)) return Array.from({ length: n }, () => false);
      const [a, b] = parts[k++] ?? [0, -1];
      const mine = cols.filter((c) => c >= a && c <= b);
      const lit = mine.filter((c) => on.has(c)).length >= 0.5 * mine.length;
      return Array.from({ length: n }, () => lit);
    });
  }
  // Characters laid out by their usual widths over the ink; a character is lit when most of its columns are.
  const x0 = cols[0] ?? 0, x1 = cols[cols.length - 1] ?? 0;
  const widths = chars.map(widthOf), total = widths.reduce((s, w) => s + w, 0) || 1;
  let at = 0;
  const flags = widths.map((w, i) => {
    const a = Math.round(x0 + (at / total) * (x1 - x0)), b = Math.round(x0 + ((at + w) / total) * (x1 - x0));
    at += w;
    const mine = Array.from({ length: Math.max(1, b - a) }, (_v, j) => a + j);
    return !/\s/.test(chars[i] ?? '') && mine.filter((c) => on.has(c)).length >= 0.5 * mine.length;
  });
  // A Latin word is lit whole when most of it is.
  let k = 0;
  return words.flatMap((w) => {
    const n = Array.from(w).length, mine = flags.slice(k, k + n);
    k += n;
    return NOT_LATIN.test(w) ? mine : Array.from({ length: n }, () => !isSpace(w) && mine.filter(Boolean).length >= n / 2);
  });
};

/**
 * On one line: the columns the highlight fills, when they make a stretch or a few with no fill in them and hold most of
 * the highlight colour's strokes (the picture seen between letters can be of any colour, but it lies among the fill).
 * ink: the columns of all the letters.
 */
const stretchOn = (f: Frame, box: Rect, fs: number[], hs: number[]): { lit: number[]; ink: number[] } | undefined => {
  const h = box.y1 - box.y0;
  if (hs.length < 20 || fs.length < 20) return undefined;
  const x0 = Math.max(0, Math.round(box.x0)), w = Math.max(1, Math.min(f.w, Math.round(box.x1)) - x0);
  const count = (px: number[]): number[] => {
    const c = new Array<number>(w).fill(0);
    for (const i of px) { const x = (i % f.w) - x0; if (x >= 0 && x < w) c[x] = (c[x] ?? 0) + 1; }
    return c;
  };
  // Counts over about a quarter of the line height, so that a letter's own gaps do not split a word.
  const r = Math.max(2, Math.round(0.12 * h));
  const smooth = (c: number[]): number[] => {
    const sum = [0];
    for (const v of c) sum.push((sum[sum.length - 1] ?? 0) + v);
    return c.map((_v, x) => (sum[Math.min(c.length, x + r + 1)] ?? 0) - (sum[Math.max(0, x - r)] ?? 0));
  };
  const hc = smooth(count(hs)), fc = smooth(count(fs));
  const peak = Math.max(...hc);
  const lit = hc.flatMap((v, x) => (v >= 2 * (fc[x] ?? 0) && v >= 0.25 * peak ? [x] : []));
  const raw = count(hs);
  const held = lit.reduce((s, x) => s + (raw[x] ?? 0), 0);
  // The letters' columns: the fill's, and the highlight's where it holds a stretch (elsewhere it may be the picture between letters).
  const ink = [...fs.map((i) => (i % f.w) - x0).filter((x) => x >= 0 && x < w), ...lit];
  const span = ink.reduce((m, x) => Math.max(m, x), -Infinity) - ink.reduce((m, x) => Math.min(m, x), Infinity);
  const sameRow = (() => {
    const rows = fs.map((i) => Math.floor(i / f.w)).sort((a, b) => a - b), hy = hs.map((i) => Math.floor(i / f.w)).sort((a, b) => a - b)[Math.floor(hs.length / 2)] ?? 0;
    return hy >= (rows[Math.floor(0.05 * rows.length)] ?? 0) && hy <= (rows[Math.floor(0.95 * rows.length)] ?? 0);
  })();
  return sameRow && lit.length >= 0.3 * h && lit.length <= 0.7 * span && held >= 0.5 * hs.length ? { lit, ink } : undefined;
};

/** The highlight of the lines, when one is found; texts[k] is what the reader read on line k. */
export const highlightOf = (frames: Frame[], boxes: Rect[], texts: string[], ctx: FillContext, candidates: Surround[], around: Lab[][]): CaptionHighlight | undefined => {
  const n = frames.length, least = Math.max(2, Math.ceil(0.25 * n));
  const fillLab = ctx.fill.find((l) => l) ?? [0, 0, 0];
  const found = candidates.filter((s) => {
    const lab = s.group.lab;
    if (s.group.lines < least || s.ground || deltaE(lab, fillLab) < 20 || isPicture(around, lab)) return false;
    if (ctx.around) return deltaE(lab, ctx.around) >= 20 && dEdge(s.around, ctx.around) < 18;
    return deltaE(s.around, fillLab) >= 25;
  }).map((s) => {
    const lines = frames.map((f, k) => {
      const fill = ctx.fill[k], box = boxes[k];
      return s.group.at[k] && fill && box ? stretchOn(f, box, ctx.px?.[k] ?? strokesOf(f, box, fill, strokeMax(box)), s.px[k] ?? []) : undefined;
    });
    return { s, lines, count: lines.filter(Boolean).length };
  }).filter((x) => x.count >= least).sort((a, b) => b.count - a.count || b.s.group.lines - a.s.group.lines)[0];
  if (!found) return undefined;
  const at = found.s.group.at.flatMap((l, k) => (l && found.lines[k] ? [l] : []));
  const alike = at.filter((l) => deltaE(l, found.s.group.lab) <= 15).length / Math.max(1, at.length);
  const confidence = r2(alike * (found.count / Math.max(1, found.s.group.lines)));
  const examples = found.lines.flatMap((x, k) => {
    const text = texts[k], box = boxes[k];
    if (!x || !text || !box) return [];
    const runs = runsOf(litChars(text, x.ink, x.lit, Math.max(3, Math.round(0.12 * (box.y1 - box.y0)))));
    return runs.length ? [marked(Array.from(text), runs)] : [];
  }).slice(0, MAX_EXAMPLES);
  return { ...(confidence >= SURE ? { color: toHex(found.s.group.rgb) } : {}), confidence, lines: found.count, ...(examples.length ? { examples } : {}) };
};
