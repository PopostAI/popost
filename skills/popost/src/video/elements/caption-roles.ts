/** Visual caption corrections reuse OCR geometry and timing; they never invent a cue or alter a measured shot. */
import type { Measure, Problem } from '../types';
import type { TextCue, TextTrack } from '../text/types';
import { warning } from '../project/check-common';
import { covered } from './check';
import { isDropped, type Elements, type ShotReading } from './types';

const fold = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
const numbers = (s: string): string[] => s.normalize('NFKC').match(/\p{N}+(?:[.,]\p{N}+)*/gu) ?? [];
const matches = (a: string, b: string): boolean => {
  const x = Array.from(fold(a)), y = Array.from(fold(b));
  const na = numbers(a), nb = numbers(b), sameNumbers = na.join('|') === nb.join('|');
  if (x.join('') === y.join('') && sameNumbers) return true;
  // OCR sometimes joins nearby page text before the subtitle. A confirmed complete suffix identifies the caption.
  // Check whole numeric tokens, so 100 cannot match the tail of 1100; unrelated numeric UI prefixes are allowed.
  if (x.length >= 4 && y.join('').endsWith(x.join('')) && (!na.length || nb.slice(-na.length).join('|') === na.join('|'))) return true;
  // Small OCR mistakes may be corrected, but a different number is a different claim.
  if (Math.min(x.length, y.length) < 6 || !sameNumbers) return false;
  let row = Array.from({ length: y.length + 1 }, (_, k) => k);
  for (let i = 0; i < x.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < y.length; j++) next.push(Math.min((next[j] ?? 0) + 1, (row[j + 1] ?? 0) + 1, (row[j] ?? 0) + (x[i] === y[j] ? 0 : 1)));
    row = next;
  }
  return (row[y.length] ?? Infinity) <= 0.28 * Math.max(x.length, y.length);
};

const captionOf = (s: ShotReading, c: TextCue): string | undefined => {
  if (c.role === 'watermark' || s.layers.some((l) => isDropped(l.role) && covered(c.box, l.box) >= 0.5)) return undefined;
  const bands = s.layers.filter((l) => l.kind === 'caption' && !isDropped(l.role));
  if (bands.length && !bands.some((l) => covered(c.box, l.box) >= 0.5)) return undefined;
  return s.captions?.lines?.find((line) => matches(line, c.text));
};

export const captionHintProblems = (e: Elements, m: Measure, text?: TextTrack): Problem[] => e.shots.flatMap((s, k) => {
  const shot = m.shots[s.shot - 1];
  return (s.captions?.lines ?? []).flatMap((line, i) => shot && text?.cues.some((c) => c.end > shot.start && c.start < shot.end && captionOf({ ...s, captions: { ...s.captions!, lines: [line] } }, c)) ? [] : [warning('shots[' + k + '].captions.lines[' + i + ']', 'No timed OCR line in this shot matches the confirmed caption "' + line + '".', 'Check the caption band and the spelling against the pictures and OCR. Run describe with a text reader when none was used; no caption timing is invented.')]);
});

export const withCaptionRoles = (text: TextTrack, e: Elements, m: Measure): TextTrack => {
  if (!e.shots.some((s) => s.captions?.lines !== undefined)) return text;
  const cues = text.cues.flatMap((c): TextCue[] => {
    const pieces = m.shots.flatMap((ms): TextCue[] => {
    const start = Math.max(c.start, ms.start), end = Math.min(c.end, ms.end);
    if (end <= start) return [];
    const s = e.shots.find((s) => s.shot === ms.index + 1);
    if (!s || s.captions?.lines === undefined) return [{ ...c, start, end }];
    const line = captionOf(s, c);
    return [{ ...c, start, end, ...(line ? { role: 'caption' as const, text: line } : c.role === 'caption' ? { role: 'in-picture' as const } : {}) }];
    });
    return pieces.reduce<TextCue[]>((out, next) => {
      const prev = out[out.length - 1];
      if (prev && prev.end === next.start && prev.role === next.role && prev.text === next.text) prev.end = next.end;
      else out.push(next);
      return out;
    }, []);
  });
  // A look measured from the old caption population no longer describes the corrected lines.
  const { captionLook: _oldLook, ...rest } = text;
  return { ...rest, cues };
};
