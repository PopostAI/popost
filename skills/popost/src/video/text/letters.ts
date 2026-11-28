/**
 * The letters of caption lines that have no plate behind them: the colour that fills their strokes, an outline or a
 * shadow around it, or neither; and a second fill colour on a word or two of some lines (a highlighted keyword).
 *
 * The colours that recur inside the lines' boxes are the candidates (the peaks of a Lab histogram of each line,
 * matched from line to line). The pixels of a candidate that lie on thin strokes are followed outwards, in four
 * directions, to the first other colour:
 * - the fill is enclosed: just past its strokes, in all four directions, lies one colour on every line, its outline.
 *   An outline itself has the fill on one side and the picture on the other. This is what tells yellow letters with a
 *   dark blue outline from dark blue letters, which the darkest or the most frequent pixels of the box would give;
 * - a shadow lies only below or to the right of the strokes;
 * - plain letters have the picture around them, which changes from line to line;
 * - a colour that is also around the line, outside its box, is the picture (a light ground between dark letters, a
 *   flat black bar behind white ones): never the fill, and what encloses the fill there is the ground, not an
 *   outline. An outline is a thin layer along the strokes with the picture beyond it; a ground goes on. So is a
 *   colour that covers wide stretches just above or below the line: the picture behind it, seen between the letters
 *   and in their counters, where the letters enclose it as an outline encloses a fill;
 * - unless that colour is still inside the boxes on the lines where the picture is another colour: letters of a
 *   page's colour, kept readable over the page by their outline (white letters over a white page). They are told on
 *   those lines, and their outline also on the lines where the page is around them;
 * - over such a page the fill and its outline enclose each other, and so do the blends at their soft edges: the fill
 *   is the one whose surround hugs its strokes on nearly every line (rings.ts);
 * - a plate fills the box around the letters too, but reaches past them on all four sides to an edge of its own; a
 *   page behind the line goes on.
 * Every part comes with a confidence, and with a colour only from SURE up. A candidate that fills a word or two of
 * some lines and has the fill's surroundings is a highlight (highlight.ts).
 */
import { deltaE } from '../measure/colour';
import { toHex } from '../measure/pixels';
import { farEnd } from './core';
import { area, colourOf, consistency, grow, inside, labMedian, labOf, median, r2, ring, seenAt, type Frame, type Lab, type Rect, type Seen } from './frame';
import { along, hugOf, plateAround } from './rings';
import { coloursOf, groupsOf, NEAR, strokeMax, strokesOf, type Group } from './strokes';
import type { CaptionLook } from './types';

/** A colour around a candidate's strokes this consistent, on all four sides, encloses it: the candidate is the fill. */
const ENCLOSED = 0.4;
/** A part's colour is given only from this confidence up; below it, the part is said to be unsure. */
export const SURE = 0.6;

/**
 * Distance for colours just past a stroke: lightness counts fully, hue and saturation at 0.4. Video keeps colour at
 * half the resolution of lightness (4:2:0), so a thin outline's colour bleeds into its neighbours while its lightness
 * stays sharp: a dark blue outline next to yellow letters is seen anywhere from blue to grey.
 */
export const dEdge = (a: Lab, b: Lab): number => Math.hypot(a[0] - b[0], 0.4 * (a[1] - b[1]), 0.4 * (a[2] - b[2]));
/** Squared ΔE, and squared dEdge, between pixel i of a frame and a colour, without making arrays: these run per pixel. */
const d2At = (f: Frame, i: number, lab: Lab): number => {
  const dl = (f.lab[3 * i] ?? 0) - lab[0], da = (f.lab[3 * i + 1] ?? 0) - lab[1], db = (f.lab[3 * i + 2] ?? 0) - lab[2];
  return dl * dl + da * da + db * db;
};
const edge2At = (f: Frame, i: number, lab: Lab): number => {
  const dl = (f.lab[3 * i] ?? 0) - lab[0], da = (f.lab[3 * i + 1] ?? 0) - lab[1], db = (f.lab[3 * i + 2] ?? 0) - lab[2];
  return dl * dl + 0.16 * (da * da + db * db);
};

/** Share of the colours within 15 (dEdge) of their median; fewer than 20 is 0: too few to tell. */
const alike = (xs: Seen[]): number => {
  if (xs.length < 20) return 0;
  const m = labMedian(xs.map((x) => x.lab));
  return xs.filter((x) => dEdge(x.lab, m) <= 15).length / xs.length;
};

export type Dir = 'up' | 'down' | 'left' | 'right';
const DIRECTIONS = [['up', 0, -1], ['down', 0, 1], ['left', -1, 0], ['right', 1, 0]] as const;
export type Edges = Record<Dir, Seen[]>;
const noEdges = (): Edges => ({ up: [], down: [], left: [], right: [] });

/**
 * Past the edge of some strokes of a colour, in each direction: of the first pixel that is clearly not theirs and
 * the next one, the one farther from them (the first is often half one, half the other; a thin outline may be only
 * one of them), and how far that colour goes on, up and down (thick). pairs: the lightness above minus below, and
 * left minus right, at each stroke pixel that has both: a shadow makes one side darker everywhere.
 */
const edgesFrom = (f: Frame, px: number[], lab: Lab, reach: number, into: Edges, thick?: number[], pairs?: { v: number[]; h: number[] }, beyond?: { v: number[]; h: number[] }): void => {
  for (let j = 0; j < px.length; j += 2) {
    const i = px[j] ?? 0;
    const x0 = i % f.w, y0 = Math.floor(i / f.w);
    const found: Partial<Record<Dir, Seen>> = {}, past: Partial<Record<Dir, number>> = {};
    for (const [name, dx, dy] of DIRECTIONS) {
      for (let k = 1; k < reach; k++) {
        const x = x0 + dx * k, y = y0 + dy * k;
        if (!inside(f, x, y)) break;
        if (d2At(f, y * f.w + x, lab) <= 900) continue;
        const fx = x + dx, fy = y + dy;
        if (!inside(f, fx, fy)) break;
        const a = seenAt(f, y * f.w + x), b = seenAt(f, fy * f.w + fx);
        const seen = dEdge(a.lab, lab) > dEdge(b.lab, lab) ? a : b;
        into[name].push(seen);
        found[name] = seen;
        if (thick || beyond) {
          let t = 1;
          while (t < 3 * reach && inside(f, fx + dx * t, fy + dy * t) && edge2At(f, (fy + dy * t) * f.w + fx + dx * t, seen.lab) <= NEAR * NEAR) t++;
          if (thick && dx === 0) thick.push(t);
          // Two pixels past where that colour ends: darker on one side everywhere under a shadow below an outline.
          const bx = fx + dx * (t + 1), by = fy + dy * (t + 1);
          if (inside(f, bx, by)) past[name] = f.lab[3 * (by * f.w + bx)] ?? 0;
        }
        break;
      }
    }
    if (pairs && found.up && found.down) pairs.v.push(found.up.lab[0] - found.down.lab[0]);
    if (pairs && found.left && found.right) pairs.h.push(found.left.lab[0] - found.right.lab[0]);
    if (beyond && past.up !== undefined && past.down !== undefined) beyond.v.push(past.up - past.down);
    if (beyond && past.left !== undefined && past.right !== undefined) beyond.h.push(past.left - past.right);
  }
};

/** Lightness differences across the strokes (above minus below, left minus right), for a shadow. */
interface Pairs { v: number[]; h: number[] }
/** What lies around a candidate's strokes on one line. */
export interface LineSurround { edges: Edges; thick: number[]; pairs: Pairs; beyond: Pairs; ground: boolean }

/** What surrounds the strokes of one candidate colour, over the lines it is told on (all it was found on, or `told`). */
export interface Surround {
  group: Group;
  /** Stroke pixels per line it is told on. */
  strokes: number[];
  /** The stroke pixels themselves, by line (empty where it was not found). */
  px: number[][];
  edges: Edges;
  cons: Record<Dir, number>;
  /** The colour just past the strokes, all directions together. */
  around: Lab;
  /** 0..1: the same colour on all four sides (how consistent it is, the four sides together), 0 when the sides differ. */
  enclosed: number;
  /** Below or right of the strokes only: a shadow. */
  shadow?: Dir;
  /** How far the colour around goes on, up and down, in pixels (median). */
  thickness: number;
  /**
   * The colour also covers wide stretches just above or below the line on half the lines or more: the picture behind
   * the line, seen between its letters and inside their counters (where the letters enclose it), not a fill.
   */
  ground: boolean;
  /** What lies around the strokes line by line (undefined where the colour was not found), for a look at some lines only. */
  perLine: (LineSurround | undefined)[];
  /** Past the colour around the strokes, the side that is darker everywhere: a shadow under an outline. */
  shadowBeyond?: Dir;
  /** The lines it is told on when its colour is the picture's on the others (letters of a page's colour, outlined). */
  told?: number[];
}

/**
 * Whether a colour covers wide stretches (runs of half a line height or more) in the strips just above and below a
 * line, a tenth of them or more. Letters only cross those strips with thin strokes. Hue counts less (dEdge): what is
 * seen between letters takes on some of their colour.
 */
const groundOn = (f: Frame, box: Rect, lab: Lab): boolean => {
  const h = box.y1 - box.y0, wide = Math.max(4, Math.round(0.5 * h));
  const x0 = Math.max(0, Math.round(box.x0)), x1 = Math.min(f.w, Math.round(box.x1));
  const rows = [...Array.from({ length: Math.round(0.35 * h) }, (_v, j) => Math.round(box.y0 - 0.25 * h) + j), ...Array.from({ length: Math.round(0.35 * h) }, (_v, j) => Math.round(box.y1 - 0.1 * h) + j)]
    .filter((y) => y >= 0 && y < f.h);
  let covered = 0, total = 0;
  for (const y of rows) {
    let run = 0;
    for (let x = x0; x <= x1; x++) {
      const near = x < x1 && edge2At(f, y * f.w + x, lab) <= NEAR * NEAR;
      if (near) run++;
      else { if (run >= wide) covered += run; run = 0; }
    }
    total += x1 - x0;
  }
  return total > 0 && covered >= 0.1 * total;
};

/** A shadow darkens one side of the strokes: the other side lighter at most stroke pixels, by this much in the median. */
const SHADE = 6;
const shadeOf = (d: number[]): number => (d.length >= 20 && d.filter((x) => x > 0).length >= 0.7 * d.length ? median(d) : 0);

/** The surround of a colour from its lines, over the lines given (all it was found on when none are). */
const aggregate = (g: Group, px: number[][], perLine: (LineSurround | undefined)[], lines?: number[]): Omit<Surround, 'ground'> => {
  const used = perLine.flatMap((l, k) => (l && (!lines || lines.includes(k)) ? [{ l, k }] : []));
  const edges = noEdges();
  for (const { l } of used) for (const d of Object.keys(edges) as Dir[]) edges[d].push(...l.edges[d]);
  const of = (pick: (l: LineSurround) => Pairs): Pairs => ({ v: used.flatMap(({ l }) => pick(l).v), h: used.flatMap(({ l }) => pick(l).h) });
  const pairs = of((l) => l.pairs), beyond = of((l) => l.beyond);
  const cons = { up: alike(edges.up), down: alike(edges.down), left: alike(edges.left), right: alike(edges.right) };
  const around = labMedian([...edges.up, ...edges.down, ...edges.left, ...edges.right].map((x) => x.lab));
  const sides = (Object.keys(edges) as Dir[]).map((d) => (edges[d].length ? labMedian(edges[d].map((x) => x.lab)) : undefined));
  const agree = sides.every((s) => s && dEdge(s, around) < 18) && deltaE(around, g.lab) >= 25;
  // Darker below than above (or right than left) at most stroke pixels; a shadow of one colour shows as consistent edges too.
  const consistent = cons.down >= 0.5 && cons.up < 0.4 ? 'down' : cons.right >= 0.5 && cons.left < 0.4 ? 'right' : undefined;
  const shade = shadeOf(pairs.v) >= SHADE ? 'down' : shadeOf(pairs.h) >= SHADE ? 'right' : undefined;
  const shadow = consistent ?? shade;
  const shadowBeyond = shadeOf(beyond.v) >= SHADE ? 'down' as const : shadeOf(beyond.h) >= SHADE ? 'right' as const : undefined;
  return {
    group: g, strokes: used.map(({ k }) => (px[k] ?? []).length), px, edges, cons, around, enclosed: agree ? (cons.up + cons.down + cons.left + cons.right) / 4 : 0,
    ...(shadow ? { shadow } : {}), thickness: median(used.flatMap(({ l }) => l.thick)), perLine, ...(shadowBeyond ? { shadowBeyond } : {}),
  };
};

const surroundOf = (frames: Frame[], boxes: Rect[], g: Group): Surround => {
  const lines = frames.map((f, k) => {
    const lab = g.at[k], box = boxes[k];
    if (!lab || !box) return undefined;
    const mine = strokesOf(f, box, lab, strokeMax(box));
    const own: LineSurround = { edges: noEdges(), thick: [], pairs: { v: [], h: [] }, beyond: { v: [], h: [] }, ground: groundOn(f, box, lab) };
    edgesFrom(f, mine, lab, Math.max(4, Math.round(0.3 * (box.y1 - box.y0))), own.edges, own.thick, own.pairs, own.beyond);
    return { own, mine };
  });
  const perLine = lines.map((l) => l?.own);
  return { ...aggregate(g, lines.map((l) => l?.mine ?? []), perLine), ground: perLine.filter((l) => l?.ground).length >= frames.length / 2 };
};

/** The picture just around each line, outside its box: beside it when there is room (another line may lie above or below), else all round. */
export const pictureAround = (frames: Frame[], boxes: Rect[]): Lab[][] =>
  frames.map((f, k) => {
    const box = boxes[k] as Rect, h = box.y1 - box.y0;
    const side = [...ring(f, { ...box, x0: box.x0 - 0.3 * h, x1: f.w }, { ...box, x0: box.x0 - 2 * h }), ...ring(f, { ...box, x0: 0, x1: box.x1 + 0.3 * h }, { ...box, x1: box.x1 + 2 * h })];
    const idx = side.length >= 4 * h * h ? side : ring(f, grow(box, Math.round(0.3 * h)), grow(box, Math.round(0.8 * h)));
    return idx.filter((_i, j) => j % 3 === 0).map((i) => labOf(f, i));
  });

const nearShare = (px: Lab[], lab: Lab): number => (px.length ? px.filter((l) => (l[0] - lab[0]) ** 2 + (l[1] - lab[1]) ** 2 + (l[2] - lab[2]) ** 2 <= NEAR * NEAR).length / px.length : 0);
/** A colour is the picture's around a line when it covers a tenth or more of the picture there. */
const pictureOn = (px: Lab[], lab: Lab): boolean => px.length > 0 && nearShare(px, lab) >= 0.1;

/** A colour is the picture's when it is the picture's around half the lines or more. */
export const isPicture = (around: Lab[][], lab: Lab): boolean => around.filter((px) => pictureOn(px, lab)).length >= around.length / 2;

/** The picture around the lines a candidate is told on. */
const aroundOf = (s: Surround, around: Lab[][]): Lab[][] => (s.told ? around.filter((_px, k) => s.told?.includes(k)) : around);

/** What surrounds a candidate on some lines only. */
export interface Partial4 { lines: number[]; enclosed: number; thickness: number; edge: Seen[] }

/**
 * A colour that encloses the letters and is also the picture around most lines (a black outline in a dark video) is
 * still an outline when it encloses them on the lines where the picture cannot be what is seen around the strokes:
 * where the picture is another colour, or where it is the letters' own colour (white letters over a white page, kept
 * apart from it by their outline only). Those lines (two or more, a fifth of the lines or more), how enclosed the
 * candidate is on them, and how thick the layer is there; undefined when there are too few such lines.
 */
export const offPicture = (s: Surround, around: Lab[][]): Partial4 | undefined => {
  const lines = s.perLine.flatMap((e, k) => (e && (nearShare(around[k] ?? [], s.around) < 0.1 || (s.told && !s.told.includes(k))) ? [k] : []));
  if (lines.length < Math.max(2, 0.2 * s.perLine.length)) return undefined;
  const of = (d: Dir): Seen[] => lines.flatMap((k) => s.perLine[k]?.edges[d] ?? []);
  const dirs: Dir[] = ['up', 'down', 'left', 'right'];
  // The layer as it is seen on these lines, of the colour around the strokes elsewhere or of a blend of it with the
  // fill: a thin ring between the fill and a page of the fill's colour is softened towards it on both sides.
  const here = labMedian(dirs.flatMap(of).map((x) => x.lab));
  const agree = along(s.group.lab, s.around, here).t >= 0.5 && dirs.every((d) => { const e = of(d); return e.length > 0 && dEdge(labMedian(e.map((x) => x.lab)), here) < 18; });
  const cons = dirs.map((d) => alike(of(d)));
  return { lines, enclosed: agree ? cons.reduce((a, b) => a + b, 0) / 4 : 0, thickness: median(lines.flatMap((k) => s.perLine[k]?.thick ?? [])), edge: dirs.flatMap(of) };
};

/** Candidates followed at most: the colours that cover most of the boxes, over all lines. */
const MAX_CANDIDATES = 12;

/** The colours that recur in the lines' boxes (on `least` lines or more), with what surrounds each. */
export const candidatesOf = (frames: Frame[], boxes: Rect[], least: number): Surround[] => {
  const per = frames.map((f, k) => coloursOf(f, area(f, boxes[k] as Rect)));
  return groupsOf(per).filter((g) => g.lines >= least).slice(0, MAX_CANDIDATES).map((g) => surroundOf(frames, boxes, g));
};

/** 0..1: how alike a candidate's colour is on the lines it was found on, times the share of lines it was found on. */
const sureOf = (s: Surround, n: number): number => {
  const at = s.group.at.flatMap((l) => (l ? [l] : []));
  return r2((at.filter((l) => deltaE(l, s.group.lab) <= 15).length / Math.max(1, at.length)) * (s.group.lines / n));
};

const hexOf = (s: Surround): string => toHex(s.group.rgb);

/** How the letters were told: the fill's surroundings, for the highlight to compare with. */
export interface Letters { look: CaptionLook; fill?: Surround; /** The lines the outline was told on, when it has the picture's colour. */ part?: Partial4 }

/**
 * The colours that can fill the letters: found on three lines in four or more. A colour that is the picture's around
 * half the lines or more, or covers the strips above and below them, is the picture; unless on the lines where the
 * picture around is another colour (two or more, a fifth of the lines or more) it is still there: letters of a page's
 * colour, which an outline keeps readable on the page (white letters over a white page). It is then told on those
 * lines only.
 */
const fillCandidates = (all: Surround[], around: Lab[][], n: number): Surround[] => all.flatMap((s) => {
  if (s.group.lines < 0.75 * n || !s.strokes.length) return [];
  if (!s.ground && !isPicture(around, s.group.lab)) return [s];
  const lines = s.perLine.flatMap((l, k) => (l && !l.ground && !pictureOn(around[k] ?? [], s.group.lab) ? [k] : []));
  return lines.length >= Math.max(2, 0.2 * n) ? [{ ...aggregate(s.group, s.px, s.perLine, lines), ground: false, told: lines }] : [];
});

/** Hugged this nearly as closely as the most hugged, a candidate is as likely the fill: the most stroke pixels decide. */
const HUG_TIE = 0.1;

/**
 * The fill among the first enclosed candidate and its rivals: the candidates enclosed by the same colour (the fill's
 * fringe, blends of it with the outline that the outline encloses too, or the fill itself when the first is its
 * fringe) and those that each enclose it and are enclosed by it (over a page of the fill's colour, its outline has the
 * fill on both sides). The fill is the one its surround hugs on nearly every line (rings.ts); of those hugged nearly as
 * closely, the one with the most stroke pixels.
 */
const fillAmong = (frames: Frame[], boxes: Rect[], first: Surround, own: Surround[], weight: (s: Surround) => number): Surround => {
  const mutual = (s: Surround): boolean => along(first.group.lab, first.around, s.group.lab).t >= 0.5 && along(s.group.lab, s.around, first.group.lab).t >= 0.5;
  // Enclosed by the same colour, or by a blend of it with its own (what lies just past a stroke is often half of each).
  const within = (s: Surround): boolean => s.enclosed >= ENCLOSED && (dEdge(s.around, first.around) <= 15 || (() => { const a = along(s.group.lab, first.around, s.around); return a.t >= 0.5 && a.off <= 15; })());
  const rivals = own.filter((s) => s === first || within(s) || mutual(s));
  if (rivals.length < 2) return first;
  // Where one of them has the picture's colour, the other is hugged by it there too: all are measured on the lines
  // where none has (the lines those told on some lines are told on).
  const told = rivals.flatMap((s) => (s.told ? [s.told] : []));
  const hugs = rivals.map((s) => ({ s, hug: hugOf(frames, boxes, s.px, s.group.at.map((l, k) => (told.every((t) => t.includes(k)) ? l : undefined)), s.around) }));
  const most = Math.max(...hugs.map((h) => h.hug));
  return hugs.filter((h) => h.hug >= most - HUG_TIE).sort((a, b) => weight(b.s) - weight(a.s))[0]?.s ?? first;
};

/** The letters without a plate: outline, shadow or plain, the fill's colour and how sure each part is. */
export const lettersOf = (frames: Frame[], boxes: Rect[], all: Surround[], around: Lab[][]): Letters => {
  const n = frames.length;
  const strokesPerLine = (s: Surround): number => median(s.strokes);
  const candidates = fillCandidates(all, around, n);
  // An outline of the picture's colour (black in a dark video): told on the lines where the picture is another colour.
  const off = new Map<Surround, Partial4>();
  for (const s of candidates) {
    if (!isPicture(aroundOf(s, around), s.around)) continue;
    const o = offPicture(s, around);
    if (o && o.enclosed >= ENCLOSED && o.thickness <= 0.25 * median(boxes.map((b) => b.y1 - b.y0))) off.set(s, o);
  }
  const plainCores = candidates.filter((s) => isPicture(aroundOf(s, around), s.around) && !off.has(s));
  // Anti-aliased fringe pixels can look enclosed by their own letter's core. A larger, more persistent core with
  // the picture beyond it is plain ink, so that fringe cannot be a separate fill with the core as its outline. A
  // fringe is a blend of the core and the picture: its colour lies between theirs, not at or past the picture's.
  const fringeOf = (s: Surround, core: Surround): boolean => { const a = along(core.group.lab, core.around, s.group.lab); return a.t > 0 && a.t < 0.85 && a.off <= 15; };
  const own = candidates.filter((s) => !plainCores.some((core) => core !== s && core.group.lines >= s.group.lines &&
    strokesPerLine(core) > strokesPerLine(s) && dEdge(core.group.lab, s.around) <= 15 && fringeOf(s, core)));
  const lineHeight = median(boxes.map((b) => b.y1 - b.y0));
  // The fill is enclosed by one colour that is not the picture (the ground between dark letters on a light picture
  // encloses them too, but it is the picture): an outline, a thin layer, or a plate that fills the whole box.
  const enclosed = own.filter((s) => (s.enclosed >= ENCLOSED && !isPicture(aroundOf(s, around), s.around)) || off.has(s))
    .sort((a, b) => b.enclosed * b.group.lines - a.enclosed * a.group.lines || strokesPerLine(b) - strokesPerLine(a));
  const fillSure = (s: Surround): Pick<CaptionLook, 'color' | 'confidence'> => {
    const c = sureOf(s, n);
    return c >= SURE ? { color: hexOf(s), confidence: c } : { confidence: c };
  };
  const base = { samples: n };
  const top = enclosed[0];
  const best = top && fillAmong(frames, boxes, top, own, (s) => strokesPerLine(s) * s.group.lines);
  const look = best ? outlineLook(frames, boxes, best, all, n, fillSure(best), lineHeight, off.get(best)) : undefined;
  const part = best ? off.get(best) : undefined;
  if (best && look) return { fill: best, look, ...(part ? { part } : {}) };
  // No outline: the letters are the colour with the most stroke pixels, but never the colour around another
  // candidate's strokes (an outline that was not consistent enough to be sure of, or a shadow).
  const arounds = own.filter((s) => s.enclosed >= ENCLOSED / 2).map((s) => s.around);
  const fill = own.filter((s) => !arounds.some((a) => dEdge(a, s.group.lab) < 15)).sort((a, b) => strokesPerLine(b) * b.group.lines - strokesPerLine(a) * a.group.lines)[0];
  if (!fill) return { look: { kind: 'plain', ...base, confidence: 0, unsure: ['fill: no colour stayed the same inside the lines while the picture changed, so the letters\' colour is not given'] } };
  const sure = fillSure(fill);
  const unsure = sure.color ? {} : { unsure: ['fill: the letters\' colour changed from line to line, so it is not given'] };
  if (fill.shadow && !isPicture(aroundOf(fill, around), labMedian(fill.edges[fill.shadow].map((x) => x.lab)))) {
    const below = fill.edges[fill.shadow];
    const c = r2(fill.cons[fill.shadow] * (fill.group.lines / n));
    return { fill, look: { kind: 'shadow', ...sure, ...base, shadow: c >= SURE ? { color: colourOf(below), confidence: c } : { confidence: c }, ...unsure } };
  }
  return { fill, look: { kind: 'plain', ...sure, ...base, ...unsure } };
};

/** Share of the lines looked at that must show the plate's own edge around the letters. */
const PLATE_SHARE = 0.6;
/** A plate covers this share of a loose box or more; its edge on all four sides is what tells it from a page. */
const PLATE_COVER = 0.3;

/**
 * Letters enclosed by another colour: a plate when that colour covers most of the reader's box and reaches past the
 * letters on all four sides to an edge of its own (rings.ts) on most lines, an outline when it is a thin layer; else
 * undefined. A page behind the line covers the box as a plate does, but goes on past where a plate ends.
 */
const outlineLook = (frames: Frame[], boxes: Rect[], best: Surround, all: Surround[], n: number, fill: Pick<CaptionLook, 'color' | 'confidence'>, lineHeight: number, part?: Partial4): CaptionLook | undefined => {
  const edge = part?.edge ?? [...best.edges.up, ...best.edges.down, ...best.edges.left, ...best.edges.right];
  // A plate that fills the reader's whole box (a loose box hides its sides): the colour around the letters covers
  // much of the box, which an outline never does, and ends past them on all four sides. It is looked for at the far
  // end of what lies just past the strokes from the fill (core.ts), not at their median, which the blends at the
  // strokes' soft edges pull towards the letters; its colour is then read from its margin around the letters.
  const plate = farEnd(edge, best.group.lab)?.lab ?? best.around;
  const lines = part?.lines ?? best.told ?? frames.flatMap((_f, k) => (best.group.at[k] ? [k] : []));
  const boxPixels = lines.flatMap((k) => { const f = frames[k] as Frame; return area(f, boxes[k] as Rect).map((i) => labOf(f, i)); });
  const covered = boxPixels.filter((l) => deltaE(l, plate) <= 15).length / Math.max(1, boxPixels.length);
  const margins = (): Seen[][] => lines.flatMap((k) => { const box = boxes[k] as Rect, m = plateAround(frames[k] as Frame, best.px[k] ?? [], plate, box.y1 - box.y0); return m ? [m] : []; });
  const edged = covered >= PLATE_COVER && consistency(edge) >= 0.5 ? margins() : [];
  if (edged.length && edged.length >= PLATE_SHARE * lines.length)
    return { kind: 'plate', ...fill, samples: n, plate: { color: colourOf(edged.flat()), opacity: 1, padding: 0.2, radius: 0.2, confidence: r2(consistency(edge)) }, unsure: ['the plate reaches past the boxes the reader gave, so its padding, corners and opacity were not measured: 0.2, 0.2 and 1 are taken'] };
  if ((part?.thickness ?? best.thickness) > 0.25 * lineHeight) return undefined;
  // The outline's own pixels are one of the box's colours, seen whole rather than bled into its neighbours: of the
  // colours like the one around the letters, the one with the most stroke pixels.
  const whole = all.filter((s) => s.group !== best.group && dEdge(s.group.lab, best.around) <= 15).sort((a, b) => median(b.strokes) * b.group.lines - median(a.strokes) * a.group.lines)[0];
  const lab = whole ? whole.group.lab : best.around;
  const color = whole ? toHex(whole.group.rgb) : colourOf(edge);
  // How sure: the share of what lies just past the letters that is this colour, or a blend of it with the fill nearer
  // to it (a thin, soft outline is mostly such blends; core.ts takes its colour from their far end), on the lines the
  // letters were found on.
  const outlined = (x: Seen): boolean => { const a = along(best.group.lab, lab, x.lab); return dEdge(x.lab, lab) <= 20 || (a.t >= 0.5 && a.off <= 15); };
  const c = r2((edge.filter(outlined).length / Math.max(1, edge.length)) * (best.group.lines / n));
  return { kind: 'outline', ...fill, samples: n, outline: c >= SURE ? { color, confidence: c } : { confidence: c } };
};
