/**
 * A project against the template it was filled from, for what a hand edit of video.json can change that the template
 * measured: the size of the captions. A model that sets the caption track's style by hand (a named style, a smaller
 * size) can make its captions half as tall as the reference's, and nothing else says so. It runs where both are known:
 * template check with --assets <project>, and popost video check on a project whose record of its template
 * (facts.ts) holds the same sizes.
 */
import { warning } from '../project/check-common';
import { textStyle } from '../presets/text-styles';
import type { Problem, Project } from '../types';

/** What the comparison needs of a template: the canvas height and the measured captions (a Template, or a project's record of one). */
export interface CaptionSizes { canvas: { height: number }; captions?: { style: { size?: number }; line: { size: number } } }

/** Captions this many times smaller or larger than the template's are worth a warning: more than a quarter off. */
export const CAPTION_RATIO = 4 / 3;

/** The font size of a style in pixels of a canvas this tall; undefined for a style name that does not exist (check says so). */
const sizePx = (style: Parameters<typeof textStyle>[0], height: number): number | undefined => {
  try {
    return textStyle(style).size * height;
  } catch {
    return undefined;
  }
};

/** Caption tracks whose text is much smaller or larger than the template's measured captions, with both sizes in pixels. */
export const captionSizeProblems = (pkg: { template: CaptionSizes }, project: Project): Problem[] => {
  const c = pkg.template.captions;
  if (!c || !(c.style.size && c.style.size > 0) || !Array.isArray(project.tracks)) return [];
  const height = project.canvas?.height ?? pkg.template.canvas.height;
  const want = c.style.size * height;
  return project.tracks.flatMap((t, i) => {
    if (t.type !== 'caption') return [];
    const got = sizePx(t.style, height);
    if (got === undefined || (got >= want / CAPTION_RATIO && got <= want * CAPTION_RATIO)) return [];
    const at = 'tracks[' + i + '].style' + (typeof t.style === 'object' ? '.size' : '');
    const times = got < want ? (want / got).toFixed(1) + ' times smaller' : (got / want).toFixed(1) + ' times larger';
    return [warning(at,
      'The captions of track "' + t.id + '" are ' + Math.round(got) + ' px (font size) on the ' + height + ' px tall canvas; the template\'s are ' + Math.round(want) + ' px, set from the reference\'s caption lines, which were ' + Math.round(c.line.size * height) + ' px tall: ' + times + ' than the reference\'s.',
      'Give the caption track "style": { ..., "size": ' + c.style.size + ' } (a fraction of the canvas height), as template fill wrote it, or run template fill again.')];
  });
};
