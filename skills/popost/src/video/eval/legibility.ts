/**
 * How large the text of a render is, shot by shot. The text reader's boxes give every line it read; the size of a
 * line is estimated from its width (a full-width character is about one em wide, any other character about 0.48 em),
 * because the height of a reader's box has a floor of its own: a line of 6 px came back in a box of 16 px. A line
 * that stays a second or more and is smaller than SMALL_TEXT of the frame's height is reported.
 *
 * The reader is not where reading ends: on synthetic renders it read dark text from 7 to 9 px of font size (1.0% to
 * 1.2% of a 720 px frame, 0.5% to 0.6% of a 1280 px one), grey thin text a step later. A person on a phone needs more,
 * so the floor is a viewer's, and everything under it that the reader saw is measured; text under the reader's own
 * floor is not seen at all.
 */
import type { TextCue, TextTrack } from '../text/types';
import type { Problem, Resolved } from '../types';

/** A line smaller than this share of the frame's height (font size, about one em) is hard to read on a phone. */
export const SMALL_TEXT = 0.018;
/** A line with fewer characters than this is not measured: a width says little about the size of one or two. */
const MEASURED_FROM = 4;
/** Ems of a character that is not full-width (Latin letters, digits, spaces), fitted on Noto Sans renders. */
const NARROW_EM = 0.48;
const WIDE = /[\u{3040}-\u{30ff}\u{3400}-\u{9fff}\u{ac00}-\u{d7af}\u{ff00}-\u{ffef}]/u;

export interface ShotText {
  at: string;
  id: string;
  /** Seconds of the render the shot covers. */
  seconds: [number, number];
  /** Lines measured: read, on screen a second or more inside the shot, MEASURED_FROM characters or more. */
  lines: number;
  /** The smallest and the median size of those lines, as a share of the frame's height. */
  smallest?: number;
  median?: number;
}

/** The font size of a line as a share of the frame's height: from its width, never above the height of its box. */
export const lineSize = (cue: Pick<TextCue, 'text' | 'box' | 'size'>, width: number, height: number): number | undefined => {
  const chars = Array.from(cue.text.trim());
  if (chars.filter((c) => c.trim()).length < MEASURED_FROM) return undefined;
  const ems = chars.reduce((n, c) => n + (WIDE.test(c) ? 1 : NARROW_EM), 0);
  return Math.min(cue.size, (cue.box[2] * width) / ems / height);
};

const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const pct = (v: number): string => (v * 100).toFixed(1) + '%';
const sec = (frames: number, fps: number): string => (frames / fps).toFixed(1);
const clip = (t: string): string => (Array.from(t).length > 30 ? Array.from(t).slice(0, 30).join('') + '…' : t);

/** Per shot, the sizes of the lines the reader read in it; a warning for each shot whose lasting text is small. */
export const shotTextSizes = (resolved: Resolved, text: TextTrack): { shots: ShotText[]; problems: Problem[] } => {
  const { width, height, fps } = resolved.canvas;
  const measured = text.cues.filter((c) => c.role !== 'watermark').map((c) => ({ c, size: lineSize(c, width, height) }));
  const shots = resolved.segments.map((s) => {
    const lasting = measured.filter((m): m is { c: TextCue; size: number } => m.size !== undefined && Math.min(s.end, m.c.end) - Math.max(s.start, m.c.start) >= fps);
    const sizes = lasting.map((m) => m.size).sort((a, b) => a - b);
    const shot: ShotText = { at: 'segments[' + s.index + ']', id: s.id, seconds: [Number(sec(s.start, fps)), Number(sec(s.end, fps))], lines: sizes.length,
      ...(sizes.length ? { smallest: r4(sizes[0] ?? 0), median: r4(sizes[Math.floor((sizes.length - 1) / 2)] ?? 0) } : {}) };
    return { shot, small: lasting.filter((m) => m.size < SMALL_TEXT).sort((a, b) => a.size - b.size) };
  });
  const problems = shots.flatMap(({ shot, small }): Problem[] => {
    const least = small[0];
    if (!least) return [];
    const examples = [...new Set(small.map((m) => m.c.text.trim()))].slice(0, 2).map((t) => '"' + clip(t) + '"').join(', ');
    return [{
      level: 'warning', at: shot.at,
      message: 'Shot ' + shot.id + ' (' + shot.seconds[0] + '-' + shot.seconds[1] + ' s): ' + small.length + ' line(s) of text that stay a second or more are smaller than the ' + pct(SMALL_TEXT) +
        ' of the height a phone needs, the smallest ' + pct(least.size) + ' (' + Math.round(least.size * height) + ' px of ' + height + '): ' + examples + '.',
      fix: 'Zoom to the element the line is about (a capture plan\'s zoom, or the screen helper\'s zoom), take the still at --scale 2 and show less of the page, or put fewer words on screen in larger type.',
    }];
  });
  return { shots: shots.map((x) => x.shot), problems };
};
