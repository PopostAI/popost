/**
 * What the reading of a shot says that the checks of a fill and a project compare a re-make with, apart from its
 * layout: its main picture (where it is and how big), whether it moves (a page that scrolls, a zoom, a pointer),
 * the style of the caption words drawn differently (a highlight) and how a caption line appears (its reveal). Pure.
 */
import type { Box } from '../types';

/** The kinds of layer that can be a shot's main picture. */
export const MAIN_KINDS: readonly string[] = ['screen', 'footage', 'picture', 'person', 'product'];

/** The part of a layer these facts use. */
export interface LayerLike { id: string; kind: string; box: Box; moves?: string; enters?: string }

export interface MainPicture { box: Box; kind: string }

/** What a shot's reading gives the checks; kept in reference.facts.json so that the check of a project has it too. */
export interface ReadingExtras {
  /** The largest layer of kind screen, footage, picture, person or product that a re-make keeps or fills (not the platform's or the author's). */
  main?: MainPicture;
  /** What the reading says moves in the main picture, or that a pointer moves: the words, as the reader wrote them. */
  motion?: string;
  /** The reading's words for the caption words drawn differently; absent when it says none. */
  highlight?: string;
  /** The reading's words for how a caption line appears. */
  reveal?: string;
}

/**
 * Words that say a recording moves, in English and in Chinese (the reader may write either): scrolling, zooming,
 * panning, typing, clicking or tapping, swiping, going to another page.
 */
export const MOTION_WORDS = /scroll|zoom|\bpan(s|ned|ning)?\b|\btyp(e|es|ed|ing)\b|click|\btap(s|ped|ping)?\b|swipe|navigat|(page|tab|screen)\s+(change|switch|turn|flip)|(change|switch|turn|flip)\w*\s+(the\s+|to\s+(a\s+|the\s+)?)?(page|tab)|滚动|滑动|缩放|放大|缩小|平移|输入|打字|点击|单击|翻页|换页|切换页|跳转/i;
/** Words that say words or letters appear one at a time, in English and in Chinese. */
export const ONE_BY_ONE_WORDS = /word[- ]by[- ]word|letter[- ]by[- ]letter|char(acter)?[- ]by[- ]char|one by one|one at a time|each (word|letter)|every (word|letter)|typewriter|\btyped\b|逐字|逐词|逐个|一个一个|打字/i;

const isNone = (t: string | undefined): boolean => t === undefined || t.trim() === '' || /^(none|no|n\/a|无|没有)\b/i.test(t.trim());
const area = (b: Box): number => b[2] * b[3];

/** The main picture of some layers: the largest of the picture kinds. */
export const mainPicture = (layers: readonly LayerLike[]): MainPicture | undefined => {
  const pictures = layers.filter((l) => MAIN_KINDS.includes(l.kind));
  const best = pictures.reduce<LayerLike | undefined>((a, l) => (!a || area(l.box) > area(a.box) ? l : a), undefined);
  return best ? { box: best.box, kind: best.kind } : undefined;
};

/** What the layers say moves: the main picture's "moves" and "enters" that name a motion, and any pointer's "moves". */
export const motionOf = (layers: readonly LayerLike[]): string | undefined => {
  const main = mainPicture(layers);
  const said = layers.flatMap((l) => {
    const isMain = main !== undefined && l.box === main.box && l.kind === main.kind;
    const words = [l.moves, l.enters].filter((t): t is string => typeof t === 'string' && t.trim() !== '');
    const own = l.kind === 'pointer' ? (l.moves ? [l.moves] : []) : isMain ? words.filter((t) => MOTION_WORDS.test(t)) : [];
    return own.map((t) => l.id + ': ' + t.trim());
  });
  return said.length ? said.join('; ') : undefined;
};

/** The extras of a shot's reading as the template keeps it (design and content layers, the captions' style). */
export const extrasOf = (e: { design: readonly LayerLike[]; content: readonly LayerLike[]; captions?: { base?: string; highlight?: string; reveal?: string } }): ReadingExtras => {
  const layers = [...e.design, ...e.content];
  const main = mainPicture(layers), motion = motionOf(layers);
  const highlight = e.captions?.highlight, reveal = e.captions?.reveal;
  return {
    ...(main ? { main } : {}), ...(motion ? { motion } : {}),
    ...(highlight && !isNone(highlight) ? { highlight } : {}), ...(reveal && reveal.trim() ? { reveal } : {}),
  };
};

/** The extras of a shot of reference.facts.json, whatever the file holds. */
export const extrasOfFacts = (s: unknown): ReadingExtras => {
  const o = (typeof s === 'object' && s !== null ? s : {}) as Record<string, unknown>;
  const m = o.main as { box?: unknown; kind?: unknown } | undefined;
  const box = m && Array.isArray(m.box) && m.box.length === 4 && m.box.every((v) => typeof v === 'number') ? (m.box as Box) : undefined;
  return {
    ...(box && typeof m?.kind === 'string' ? { main: { box, kind: m.kind } } : {}),
    ...(typeof o.motion === 'string' ? { motion: o.motion } : {}), ...(typeof o.highlight === 'string' ? { highlight: o.highlight } : {}),
    ...(typeof o.reveal === 'string' ? { reveal: o.reveal } : {}),
  };
};
