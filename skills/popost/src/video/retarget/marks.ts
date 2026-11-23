/**
 * Words a fill marks in a caption line, *like this*, are drawn in the highlight colour: the colour the reference gave
 * a word or two of its lines when describe found one (text/highlight.ts), else a colour that stands out from the
 * letters. The asterisks are neither drawn nor spoken. A run of asterisks marks like one (**this** too); they pair
 * up in order, and one left without a pair is an ordinary character.
 */
import { deltaE, hexToRgb, toLab } from '../measure/colour';
import type { CaptionLook } from '../text/types';
import type { TextSpanStyle } from '../types';

/** A caption line without its marks; marks: the marked characters, from .. to-1 by code point, as text spans count. */
export interface MarkedLine { text: string; marks: [number, number][] }

/** Marked words when the reference showed none: a warm yellow, or white or red when the letters are close to it. */
const STAND_OUT = ['#ffd84a', '#ffffff', '#ff4d4d'];

export const unmark = (line: string): MarkedLine => {
  const chars = Array.from(line.trim());
  // Each run of asterisks: where it starts and ends.
  const runs: [number, number][] = [];
  chars.forEach((c, i) => {
    const last = runs[runs.length - 1];
    if (c !== '*') return;
    if (last && last[1] === i) last[1] = i + 1;
    else runs.push([i, i + 1]);
  });
  const paired = runs.slice(0, runs.length - (runs.length % 2));
  if (!paired.length) return { text: chars.join(''), marks: [] };
  const drop = new Set(paired.flatMap(([a, b]) => Array.from({ length: b - a }, (_v, j) => a + j)));
  const kept = chars.filter((_c, i) => !drop.has(i));
  // Where character i of the line lands once the marks are gone.
  const at = (i: number): number => chars.slice(0, i).filter((_c, j) => !drop.has(j)).length;
  // Spaces just inside a mark, or left at the ends of the line, are not part of it.
  const lead = kept.findIndex((c) => !/\s/.test(c));
  const text = kept.join('').trim();
  const length = Array.from(text).length;
  const marks = paired.flatMap((open, k): [number, number][] => {
    const close = paired[k + 1];
    if (k % 2 || !close) return [];
    let s = at(open[1]), e = at(close[0]);
    while (s < e && /\s/.test(kept[s] ?? '')) s++;
    while (e > s && /\s/.test(kept[e - 1] ?? '')) e--;
    const from = Math.max(0, s - Math.max(0, lead)), to = Math.min(length, e - Math.max(0, lead));
    return to > from ? [[from, to]] : [];
  });
  return { text, marks };
};

/** The colour of marked words on letters of `letters` colour: the reference's highlight, or one that stands out. */
export const highlightColour = (look: CaptionLook | undefined, letters: string | undefined): string => {
  if (look?.highlight?.color) return look.highlight.color;
  const own = toLab(hexToRgb(letters ?? '#ffffff'));
  return STAND_OUT.find((c) => deltaE(toLab(hexToRgb(c)), own) >= 30) ?? (STAND_OUT[0] as string);
};

/** The spans that draw a line's marked characters in a colour. */
export const markSpans = (marks: [number, number][], color: string): TextSpanStyle[] => marks.map(([from, to]) => ({ from, to, color }));
