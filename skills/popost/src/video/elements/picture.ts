/**
 * Two more things the reading of a shot lets a fill and a project be held to. (1) The size and place of its main
 * picture: a shot whose main picture fills much of the frame is not built as a designed scene with no picture of the
 * new subject, and what the re-make shows there is about as large and in about the same place. (2) Its motion: a
 * recording that scrolls, zooms, changes page or moves a pointer is not built from a still. Pure.
 */
import { warning } from '../project/check-common';
import type { Box, Problem, Project } from '../types';
import type { ReadingFacts, ShotReadingFacts } from './findings';

/** The reading's main picture covering this share of the frame or more must have a picture of the new subject in the re-make. */
export const NO_PICTURE_AT = 0.4;
/** A main picture smaller than this share of the frame is a detail, not compared. */
export const MAIN_MIN = 0.1;
/** The re-make's main picture covers less than this times, or more than the inverse times, the reference's share. */
export const SIZE_RATIO = 0.5;
/** Its centre is farther than this (a share of the frame) from the reference's. */
export const CENTRE_OFF = 0.25;

const FULL: Box = [0, 0, 1, 1];
const area = (b: Box): number => b[2] * b[3];
const centre = (b: Box): [number, number] => [b[0] + b[2] / 2, b[1] + b[3] / 2];
const pct = (v: number): string => Math.round(v * 100) + '%';
const box4 = (b: Box): string => '[' + b.map((v) => Math.round(v * 100) / 100).join(', ') + ']';
const quote = (t: string, n = 80): string => '"' + (t.length > n ? t.slice(0, n - 1) + '…' : t).replace(/"/g, "'") + '"';
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const largest = (boxes: readonly Box[]): Box | undefined => boxes.reduce<Box | undefined>((a, b) => (!a || area(b) > area(a) ? b : a), undefined);

// ---------------------------------------------------------------------------------------------------------------------
// The scene file: does it use the screen helper, and where

/** The screen helper (lib/popost-screen.js) draws a page, full frame or in a window; a scene that loads it shows a picture. */
export const usesScreenHelper = (html: string): boolean => /popost-screen\.js/.test(html);

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const px = (rule: string, prop: string): number | undefined => {
  const m = new RegExp('(?:^|[;\\s{])' + prop + '\\s*:\\s*(-?[\\d.]+)px').exec(rule);
  return m ? Number(m[1]) : undefined;
};

/** The window the helper is given, read from the scene's own CSS when it is plain pixels (popostScreen('#window', ...)); undefined when not. */
export const screenBox = (html: string): Box | undefined => {
  const sel = /popostScreen\(\s*(['"])([^'"]+)\1/.exec(html)?.[2];
  const rule = sel ? new RegExp(esc(sel) + '\\s*\\{([^}]*)\\}').exec(html)?.[1] : undefined;
  const page = /(?:html\s*,\s*)?body\s*\{([^}]*)\}/.exec(html)?.[1];
  if (!rule || !page) return undefined;
  const [W, H] = [px(page, 'width'), px(page, 'height')];
  const [x, y, w, h] = [px(rule, 'left'), px(rule, 'top'), px(rule, 'width'), px(rule, 'height')];
  if (!W || !H || x === undefined || y === undefined || !w || !h) return undefined;
  return [x / W, y / H, w / W, h / H];
};

/** What a scene's HTML shows of the project's pictures: any, whether one is a clip, and whether every one is a still. */
export interface ScenePictures { any: boolean; video: boolean }

const FONT = /\.(woff2?|ttf|otf|eot)(\?|#|$)/i;
const CLIP = /\.(mp4|webm|mov|m4v)(\?|#|$)/i;
/** A path that is a picture of the project: not a data: URL, an address elsewhere, a fragment or a font. */
const projectPath = (u: string): boolean => u !== '' && !/^(data:|https?:|\/\/|#|about:|blob:)/i.test(u) && !FONT.test(u);
const attr = (html: string, re: RegExp): string[] => [...html.matchAll(re)].map((m) => (m[1] ?? '').trim()).filter(projectPath);

/** The pictures a scene's HTML shows: <img>, <picture> and <source>, <video>, and CSS url(...) of the project (an inline SVG is not one). */
export const scenePictures = (html: string): ScenePictures => {
  const images = [
    ...attr(html, /<img\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)/gi),
    ...attr(html, /<source\b[^>]*?\bsrcset?\s*=\s*["']?([^"'\s>,]+)/gi),
    ...attr(html, /url\(\s*["']?([^"')]+)/gi),
  ];
  const video = /<video\b/i.test(html) || images.some((u) => CLIP.test(u));
  return { any: images.length > 0 || video, video };
};

// ---------------------------------------------------------------------------------------------------------------------
// What a re-make has in a shot

/** box: the re-make's main picture (undefined: none); known: false when it cannot be told (a scene file that was not read). */
interface Made { box?: Box; known: boolean; stills: boolean }

interface Parts {
  /** The shot's own base: full-frame material, nothing (a colour, a card), a scene file, or not known (the reference's own footage). */
  base: 'full' | 'none' | 'unknown' | { scene: string };
  /** The boxes of the clips and pictures drawn over it, and whether every one is a still. */
  items: readonly { box: Box; still: boolean }[];
  /** A base of material that is a still picture. */
  stillBase?: boolean;
}

const madeOf = (p: Parts, scenes: ReadonlyMap<string, string>): Made => {
  const itemBox = largest(p.items.map((i) => i.box));
  const onlyStills = p.items.length > 0 && p.items.every((i) => i.still);
  if (p.base === 'full') return { box: FULL, known: true, stills: Boolean(p.stillBase) };
  if (p.base === 'unknown') return { ...(itemBox ? { box: itemBox } : {}), known: false, stills: false };
  if (p.base === 'none') return { ...(itemBox ? { box: itemBox } : {}), known: true, stills: false };
  const html = scenes.get(p.base.scene);
  if (html === undefined) return { ...(itemBox ? { box: itemBox } : {}), known: itemBox !== undefined, stills: false };
  const helper = usesScreenHelper(html) ? (screenBox(html) ?? FULL) : undefined;
  const box = largest([...(itemBox ? [itemBox] : []), ...(helper ? [helper] : [])]);
  const shown = scenePictures(html);
  // Pictures in the scene's own HTML have a size nobody reads here: the shot has a picture, of unknown size.
  const unsized = !box && shown.any;
  const noClip = !shown.video && p.items.every((i) => i.still);
  return { ...(box ? { box } : {}), known: !unsized, stills: !helper && noClip && (onlyStills || shown.any) };
};

const fillParts = (s: Record<string, unknown>): Parts => {
  const items = (Array.isArray(s.items) ? s.items : []).filter(isObject).flatMap((i) =>
    Array.isArray(i.box) && i.box.length === 4 ? [{ box: i.box as Box, still: 'image' in i }] : []);
  const base: Parts['base'] = typeof s.scene === 'string' ? { scene: s.scene } : 'keep' in s ? 'unknown' : 'footage' in s || 'picture' in s ? 'full' : 'none';
  return { base, items, stillBase: 'picture' in s };
};

const projectParts = (project: Project, k: number): Parts | undefined => {
  const seg = project.segments[k];
  if (!seg) return undefined;
  const items = project.tracks.flatMap((t) => ((t.type === 'video' || t.type === 'image') && t.during.segment === seg.id ? [{ box: t.box, still: t.type === 'image' }] : []));
  const b = seg.base;
  return { base: 'scene' in b ? { scene: b.scene } : 'material' in b ? 'full' : 'none', items };
};

// ---------------------------------------------------------------------------------------------------------------------
// (1) the main picture's size and place

const layoutWords = (s: ShotReadingFacts): string => (s.layout ? quote(s.layout) : 'a shot with a picture');
const placeText = (b: Box): string => 'covers ' + pct(area(b)) + ' of the frame, from ' + pct(b[0]) + ' across and ' + pct(b[1]) + ' down (' + box4(b) + ')';

const SIZE_FIX = 'Put the closest real material of the new subject there, in the same size and place as the reading\'s box: footage, a still shown with the screen helper in a window of that size (video-scenes.md, "The screen helper"), or an item over the scene (video-scenes.md, "Footage inside a scene"); never another layout.';

const sizeProblem = (at: string, k: number, s: ShotReadingFacts, made: Made): Problem[] => {
  const ref = s.main;
  if (!ref || !made.known) return [];
  const share = area(ref.box), head = 'Shot ' + (k + 1) + ' was read as ' + layoutWords(s) + '; its main picture (a ' + ref.kind + ') ' + placeText(ref.box);
  if (!made.box) return share >= NO_PICTURE_AT ? [warning(at, head + '; it is built as a designed scene with no picture of the new subject.', SIZE_FIX)] : [];
  if (share < MAIN_MIN) return [];
  const ratio = area(made.box) / share;
  const [rx, ry] = centre(ref.box), [mx, my] = centre(made.box);
  const off = Math.hypot(rx - mx, ry - my);
  if (ratio >= SIZE_RATIO && ratio <= 1 / SIZE_RATIO && off <= CENTRE_OFF) return [];
  const why = ratio < SIZE_RATIO ? 'much smaller' : ratio > 1 / SIZE_RATIO ? 'much larger' : 'far from that place';
  return [warning(at, head + '; the re-make\'s main picture ' + placeText(made.box) + ': ' + why + '.', SIZE_FIX)];
};

/** The warnings about the main picture of each shot of a fill; scenes: the scene files read (raw HTML). */
export const sizeFillProblems = (rf: ReadingFacts, fill: { shots: unknown[] }, scenes: ReadonlyMap<string, string>): Problem[] =>
  rf.shots.flatMap((s, k) => {
    const shot = fill.shots[k];
    return s.main && isObject(shot) ? sizeProblem('shots[' + k + ']', k, s, madeOf(fillParts(shot), scenes)) : [];
  });

/** The same for a project, from each segment's base and its picture and video tracks. */
export const sizeProjectProblems = (rf: ReadingFacts, project: Project, scenes: ReadonlyMap<string, string>): Problem[] =>
  rf.shots.flatMap((s, k) => {
    const parts = s.main ? projectParts(project, k) : undefined;
    return parts ? sizeProblem('segments[' + k + '].base', k, s, madeOf(parts, scenes)) : [];
  });

// ---------------------------------------------------------------------------------------------------------------------
// (3) motion in a recording

const STILL_FIX = 'Record the new subject directed: popost video capture <url> --plan <plan.json> with scroll, zoom, point and click steps (video.md, step 3), or give a scene the screen helper\'s steps (video-scenes.md, "The screen helper").';

const motionProblem = (at: string, k: number, s: ShotReadingFacts, built: string): Problem[] =>
  s.motion ? [warning(at, 'Shot ' + (k + 1) + ' was read with motion inside its picture: ' + quote(s.motion, 160) + '; it is built from ' + built + ', where nothing scrolls, zooms, changes page or moves a pointer.', STILL_FIX)] : [];

export const motionFillProblems = (rf: ReadingFacts, fill: { shots: unknown[] }, scenes: ReadonlyMap<string, string>): Problem[] =>
  rf.shots.flatMap((s, k) => {
    const shot = fill.shots[k];
    if (!s.motion || !isObject(shot)) return [];
    const stills = 'picture' in shot ? true : madeOf(fillParts(shot), scenes).stills;
    return stills ? motionProblem('shots[' + k + ']', k, s, 'a still picture') : [];
  });

export const motionProjectProblems = (rf: ReadingFacts, project: Project, scenes: ReadonlyMap<string, string>): Problem[] =>
  rf.shots.flatMap((s, k) => {
    const seg = project.segments[k];
    const parts = s.motion && seg ? projectParts(project, k) : undefined;
    if (!parts || !seg) return [];
    const mine = project.tracks.filter((t) => (t.type === 'video' || t.type === 'image') && t.during.segment === seg.id);
    const stills = 'scene' in seg.base ? madeOf(parts, scenes).stills : mine.length > 0 && mine.every((t) => t.type === 'image');
    return stills ? motionProblem('segments[' + k + '].base', k, s, 'still pictures') : [];
  });
