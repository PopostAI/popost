/**
 * checkLayout: the first check that measures the picture. Opens the project's page in Chrome, asks it for the layout
 * of every text item (runtime/contract.ts layout()) and turns text that does not fit its box into a Problem with one
 * fix: about how many characters fit, or the box that the text needs.
 */
import type { Runtime } from '../../runtime';
import type { Problem, Project, ResolvedItem } from '../types';
import type { LayoutFact } from '../page/contract';
import { DEFAULT_LINE_HEIGHT } from '../presets/text-styles';
import { openSession, SceneLoadError } from './session';

/** Leaves a little room in the box suggested by a fix, so that the text fits at once. */
const MARGIN = 1.04;

const r3 = (v: number): string => String(Math.round(v * 1000) / 1000);

/** JSON paths of an item: where its text is (a track, or the cue of a caption track) and its box (the track's). */
export interface ItemPaths { text: string; box: string }

const pathsOf = (project: Project, item: ResolvedItem): ItemPaths => {
  const track = 'tracks[' + Math.max(0, project.tracks.findIndex((t) => t.id === (item.cue?.track ?? item.id))) + ']';
  return { text: track + (item.cue ? '.cues[' + item.cue.index + ']' : '') + '.text', box: track + '.box' };
};

const describe = (item: ResolvedItem): string => (item.cue ? 'Cue ' + item.cue.index + ' of caption track "' + item.cue.track + '"' : 'Text "' + item.id + '"');

/** The Problem of one text that does not fit; canvas: the canvas size in pixels. */
export const overflowProblem = (item: ResolvedItem, fact: LayoutFact, at: ItemPaths, canvas: { width: number; height: number }): Problem => {
  const [, , w, h] = item.box;
  const needW = fact.block[2];
  const needH = fact.block[3];
  const chars = Array.from(item.text ?? '').length;
  const lineH = ((item.style?.size ?? 0) * (item.style?.lineHeight ?? DEFAULT_LINE_HEIGHT));
  const fitLines = lineH > 0 ? Math.floor((h + 1e-9) / lineH) : 0;
  const tall = needH > h;
  const how = tall
    ? 'it needs ' + fact.lines + ' line' + (fact.lines === 1 ? '' : 's') + ', ' + r3(needH) + ' of the canvas height (' + Math.round(needH * canvas.height) + ' px), but its box is ' + r3(h) + ' high (' + Math.round(h * canvas.height) + ' px): ' + Math.round((needH / h - 1) * 100) + '% too tall'
    : 'its widest line is ' + r3(needW) + ' of the canvas width (' + Math.round(needW * canvas.width) + ' px), but its box is ' + r3(w) + ' wide';
  const size = r3(Math.max(w, needW) * MARGIN) + ' x ' + r3(Math.max(h, needH) * MARGIN);
  const shorten = tall && fitLines >= 1 && fact.lines > fitLines ? Math.max(1, Math.floor((chars * fitLines) / fact.lines)) : 0;
  const box = 'enlarge the box (' + at.box + ') to ' + size + ' (width x height, fractions of the canvas)';
  const fix = shorten > 0
    ? 'Shorten the text (' + at.text + ') to about ' + shorten + ' characters (it has ' + chars + '), or ' + box + '.'
    : box.charAt(0).toUpperCase() + box.slice(1) + ', or use a smaller "size".';
  return { level: 'error', at: shorten > 0 ? at.text : at.box, message: describe(item) + ' does not fit its box: ' + how + '.', fix };
};

/**
 * Problems of text that does not fit its box, one per text item (a caption cue is one item). Builds and opens the page
 * (errors of the project are thrown, as by the renderer); a scene that does not load is a problem at its segment,
 * since nothing can be measured until it does. scale: the page's size; layout does not depend on it.
 */
export const checkLayout = async (rt: Runtime, projectDir: string, opts: { scale?: number } = {}): Promise<Problem[]> => {
  const session = await openSession(rt, projectDir, { scale: opts.scale ?? 0.25 }).catch((e: unknown) => {
    if (e instanceof SceneLoadError) return e.problems;
    throw e;
  });
  if (Array.isArray(session)) return session;
  try {
    const facts = await session.layout();
    const items = new Map(session.resolved.items.map((it) => [it.id, it] as const));
    return facts.flatMap((fact) => {
      const item = items.get(fact.id);
      return item && !fact.fits ? [overflowProblem(item, fact, pathsOf(session.project, item), session.resolved.canvas)] : [];
    });
  } finally {
    await session.close();
  }
};
