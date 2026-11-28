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
 *   outline. An outline is a thin layer along the strokes with the picture beyond it; a ground goes on. So is a colour that covers wide
 *   stretches just above or below the line: the picture behind it, seen between the letters and in their counters,
 *   where the letters enclose it as an outline encloses a fill.
 * Every part comes with a confidence, and with a colour only from SURE up. A candidate that fills a word or two of
 * some lines and has the fill's surroundings is a highlight (highlight.ts).
 */
import { deltaE } from '../measure/colour';
import { toHex } from '../measure/pixels';
import { area, colourOf, consistency, grow, inside, labMedian, labOf, median, r2, ring, rgbMedian, seenAt, type Frame, type Lab, type Rect, type Rgb, type Seen } from './frame';
import type { CaptionLook } from './types';

/** ΔE within which a pixel is of a colour. */
const NEAR = 16;
/** ΔE within which two clusters, or one cluster on two lines, are one colour. */
const SAME = 14;
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

interface Cluster { lab: Lab; rgb: Rgb; share: number }
/** A colour that recurs from line to line: where it was found (its colour on each line, undefined elsewhere). */
export interface Group { lab: Lab; rgb: Rgb; at: (Lab | undefined)[]; lines: number }

/** Bins of the coarse Lab histogram: lightness in steps of 6, a and b in steps of 8. */
const BINS = 18 * 64 * 64;

/** The main colours of some pixels: the peaks of a coarse Lab histogram, merged within SAME, with their shares. */
const coloursOf = (f: Frame, idx: number[]): Cluster[] => {
  // Count, then the sums of L, a, b, R, G, B, per bin.
  const sums = new Float64Array(BINS * 7);
  for (const i of idx) {
    const L = f.lab[3 * i] ?? 0, a = f.lab[3 * i + 1] ?? 0, b = f.lab[3 * i + 2] ?? 0;
    const key = (Math.min(17, Math.max(0, Math.floor(L / 6))) * 64 + Math.min(63, Math.max(0, Math.floor((a + 128) / 8)))) * 64 + Math.min(63, Math.max(0, Math.floor((b + 128) / 8)));
    const o = key * 7;
    sums[o] = (sums[o] ?? 0) + 1;
    sums[o + 1] = (sums[o + 1] ?? 0) + L; sums[o + 2] = (sums[o + 2] ?? 0) + a; sums[o + 3] = (sums[o + 3] ?? 0) + b;
    sums[o + 4] = (sums[o + 4] ?? 0) + (f.rgb[3 * i] ?? 0); sums[o + 5] = (sums[o + 5] ?? 0) + (f.rgb[3 * i + 1] ?? 0); sums[o + 6] = (sums[o + 6] ?? 0) + (f.rgb[3 * i + 2] ?? 0);
  }
  const bins: number[][] = [];
  for (let k = 0; k < BINS; k++) if (sums[k * 7]) bins.push(Array.from(sums.subarray(k * 7, k * 7 + 7)));
  const mean = (s: number[], from: number): Lab => [(s[from] ?? 0) / (s[0] || 1), (s[from + 1] ?? 0) / (s[0] || 1), (s[from + 2] ?? 0) / (s[0] || 1)];
  const clusters: number[][] = [];
  // The fullest bins first; ties keep the bins' order, so the result does not depend on anything else.
  for (const bin of bins.map((b, k) => ({ b, k })).sort((x, y) => (y.b[0] ?? 0) - (x.b[0] ?? 0) || x.k - y.k).map((x) => x.b)) {
    const lab = mean(bin, 1);
    const near = clusters.map((c, j) => ({ j, d: deltaE(mean(c, 1), lab) })).filter((x) => x.d <= SAME).sort((x, y) => x.d - y.d)[0];
    if (near) clusters[near.j] = (clusters[near.j] ?? []).map((v, j) => v + (bin[j] ?? 0));
    else clusters.push(bin);
  }
  return clusters.filter((c) => (c[0] ?? 0) >= 0.02 * idx.length).map((c) => ({ lab: mean(c, 1), rgb: mean(c, 4), share: (c[0] ?? 0) / idx.length }));
};

/** The colours of each line's box, matched from line to line, the most common over all lines first. */
const groupsOf = (per: Cluster[][]): Group[] => {
  const groups: { first: Lab; at: (Cluster | undefined)[] }[] = [];
  const all = per.flatMap((cs, k) => cs.map((c) => ({ c, k }))).sort((a, b) => b.c.share - a.c.share);
  for (const { c, k } of all) {
    const near = groups.map((g) => ({ g, d: deltaE(g.first, c.lab) })).filter((x) => x.d <= SAME).sort((a, b) => a.d - b.d);
    // A second cluster of one colour on a line is part of the first.
    if (near.some((x) => x.g.at[k])) continue;
    const g = near[0]?.g;
    if (g) g.at[k] = c;
    else groups.push({ first: c.lab, at: per.map((_c, j) => (j === k ? c : undefined)) });
  }
  const total = (g: { at: (Cluster | undefined)[] }): number => g.at.reduce((s, c) => s + (c?.share ?? 0), 0);
  return [...groups].sort((a, b) => total(b) - total(a)).map((g) => {
    const seen = g.at.flatMap((c) => (c ? [c] : []));
    return { lab: labMedian(seen.map((c) => c.lab)), rgb: rgbMedian(seen.map((c) => c.rgb)), at: g.at.map((c) => c?.lab), lines: seen.length };
  });
};

/** For each set cell, the length of the run of set cells it lies on: `lines` lines of `len` cells, cells `step` apart, lines `next` apart. */
const runLengths = (m: Uint8Array, len: number, lines: number, step: number, next: number): Uint16Array => {
  const out = new Uint16Array(m.length);
  for (let l = 0; l < lines; l++) {
    for (let s = 0; s < len;) {
      if (!m[l * next + s * step]) { s++; continue; }
      let e = s;
      while (e < len && m[l * next + e * step]) e++;
      for (let j = s; j < e; j++) out[l * next + j * step] = e - s;
      s = e;
    }
  }
  return out;
};

/**
 * The pixels of a box near a colour that lie on thin strokes: on runs of that colour at most `max` long, across or
 * down. Runs are followed past the box, so the picture above and below the letters, which goes on outside the box,
 * is not taken for strokes.
 */
export const strokesOf = (f: Frame, box: Rect, lab: Lab, max: number): number[] => {
  // Half a box height past the box is enough: a run that reaches that far is longer than any stroke (strokeMax).
  const pad = Math.round(0.5 * (box.y1 - box.y0));
  const x0 = Math.max(0, Math.round(box.x0) - pad), x1 = Math.min(f.w, Math.round(box.x1) + pad);
  const y0 = Math.max(0, Math.round(box.y0) - pad), y1 = Math.min(f.h, Math.round(box.y1) + pad);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return [];
  const near = new Uint8Array(w * h), L = f.lab, near2 = NEAR * NEAR;
  // ΔE within NEAR, written out: this runs over every pixel around every line for every candidate.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 3 * ((y + y0) * f.w + x + x0);
      const dl = (L[i] ?? 0) - lab[0], da = (L[i + 1] ?? 0) - lab[1], db = (L[i + 2] ?? 0) - lab[2];
      near[y * w + x] = dl * dl + da * da + db * db <= near2 ? 1 : 0;
    }
  }
  const across = runLengths(near, w, h, 1, w), down = runLengths(near, h, w, w, 1);
  const out: number[] = [];
  for (let y = Math.max(y0, Math.round(box.y0)); y < Math.min(y1, Math.round(box.y1)); y++)
    for (let x = Math.max(x0, Math.round(box.x0)); x < Math.min(x1, Math.round(box.x1)); x++) {
      const j = (y - y0) * w + x - x0;
      if (near[j] && Math.min(across[j] ?? 0, down[j] ?? 0) <= max) out.push(y * f.w + x);
    }
  return out;
};

/** The longest run of one colour, across or down, that is still a stroke of a letter: about a third of the line's box. */
export const strokeMax = (box: Rect): number => Math.max(3, Math.round(0.35 * (box.y1 - box.y0)));

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

/** What surrounds the strokes of one candidate colour, over all lines. */
export interface Surround {
  group: Group;
  /** Stroke pixels per line where it was found. */
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
  /** The edges and the thickness line by line (undefined where the colour was not found), for a look at some lines only. */
  perLine: ({ edges: Edges; thick: number[] } | undefined)[];
  /** Past the colour around the strokes, the side that is darker everywhere: a shadow under an outline. */
  shadowBeyond?: Dir;
}

/**
 * Whether a colour covers wide stretches (runs of half a line height or more) in the strips just above and below a
 * line, a tenth of them or more, on half the lines or more. Letters only cross those strips with thin strokes. Hue
 * counts less (dEdge): what is seen between letters takes on some of their colour.
 */
const groundOf = (frames: Frame[], boxes: Rect[], g: Group): boolean =>
  frames.filter((f, k) => {
    const lab = g.at[k], box = boxes[k];
    if (!lab || !box) return false;
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
  }).length >= frames.length / 2;

/** A shadow darkens one side of the strokes: the other side lighter at most stroke pixels, by this much in the median. */
const SHADE = 6;
const shadeOf = (d: number[]): number => (d.length >= 20 && d.filter((x) => x > 0).length >= 0.7 * d.length ? median(d) : 0);

const surroundOf = (frames: Frame[], boxes: Rect[], g: Group): Surround => {
  const edges = noEdges(), thick: number[] = [], pairs = { v: [] as number[], h: [] as number[] }, beyond = { v: [] as number[], h: [] as number[] };
  const perLine: Surround['perLine'] = [];
  const px = frames.map((f, k) => {
    const lab = g.at[k], box = boxes[k];
    if (!lab || !box) { perLine.push(undefined); return []; }
    const h = box.y1 - box.y0;
    const mine = strokesOf(f, box, lab, strokeMax(box));
    const own = { edges: noEdges(), thick: [] as number[] };
    edgesFrom(f, mine, lab, Math.max(4, Math.round(0.3 * h)), own.edges, own.thick, pairs, beyond);
    for (const d of Object.keys(edges) as Dir[]) for (const x of own.edges[d]) edges[d].push(x);
    for (const t of own.thick) thick.push(t);
    perLine.push(own);
    return mine;
  });
  const strokes = px.flatMap((p, k) => (g.at[k] ? [p.length] : []));
  const cons = { up: alike(edges.up), down: alike(edges.down), left: alike(edges.left), right: alike(edges.right) };
  const all = [...edges.up, ...edges.down, ...edges.left, ...edges.right];
  const around = labMedian(all.map((x) => x.lab));
  const sides = (Object.keys(edges) as Dir[]).map((d) => (edges[d].length ? labMedian(edges[d].map((x) => x.lab)) : undefined));
  const agree = sides.every((s) => s && dEdge(s, around) < 18) && deltaE(around, g.lab) >= 25;
  // Darker below than above (or right than left) at most stroke pixels; a shadow of one colour shows as consistent edges too.
  const consistent = cons.down >= 0.5 && cons.up < 0.4 ? 'down' : cons.right >= 0.5 && cons.left < 0.4 ? 'right' : undefined;
  const shade = shadeOf(pairs.v) >= SHADE ? 'down' : shadeOf(pairs.h) >= SHADE ? 'right' : undefined;
  const shadow = consistent ?? shade;
  const shadowBeyond = shadeOf(beyond.v) >= SHADE ? 'down' as const : shadeOf(beyond.h) >= SHADE ? 'right' as const : undefined;
  return { group: g, strokes, px, edges, cons, around, enclosed: agree ? (cons.up + cons.down + cons.left + cons.right) / 4 : 0, ...(shadow ? { shadow } : {}), thickness: median(thick), ground: groundOf(frames, boxes, g), perLine, ...(shadowBeyond ? { shadowBeyond } : {}) };
};

/** The picture just around each line, outside its box: beside it when there is room (another line may lie above or below), else all round. */
export const pictureAround = (frames: Frame[], boxes: Rect[]): Lab[][] =>
  frames.map((f, k) => {
    const box = boxes[k] as Rect, h = box.y1 - box.y0;
    const side = [...ring(f, { ...box, x0: box.x0 - 0.3 * h, x1: f.w }, { ...box, x0: box.x0 - 2 * h }), ...ring(f, { ...box, x0: 0, x1: box.x1 + 0.3 * h }, { ...box, x1: box.x1 + 2 * h })];
    const idx = side.length >= 4 * h * h ? side : ring(f, grow(box, Math.round(0.3 * h)), grow(box, Math.round(0.8 * h)));
    return idx.filter((_i, j) => j % 3 === 0).map((i) => labOf(f, i));
  });

/** A colour is the picture's when it covers a tenth or more of the picture around the line, on half the lines or more. */
export const isPicture = (around: Lab[][], lab: Lab): boolean =>
  around.filter((px) => px.length > 0 && px.filter((l) => (l[0] - lab[0]) ** 2 + (l[1] - lab[1]) ** 2 + (l[2] - lab[2]) ** 2 <= NEAR * NEAR).length >= 0.1 * px.length).length >= around.length / 2;

const nearShare = (px: Lab[], lab: Lab): number => (px.length ? px.filter((l) => (l[0] - lab[0]) ** 2 + (l[1] - lab[1]) ** 2 + (l[2] - lab[2]) ** 2 <= NEAR * NEAR).length / px.length : 0);

/** What surrounds a candidate on some lines only. */
export interface Partial4 { lines: number[]; enclosed: number; thickness: number; edge: Seen[] }

/**
 * A colour that encloses the letters and is also the picture around most lines (a black outline in a dark video) is
 * still an outline when it encloses them on the lines where the picture is another colour: there the picture cannot
 * be what is seen around the strokes. Those lines (two or more, a fifth of the lines or more), how enclosed the
 * candidate is on them, and how thick the layer is there; undefined when there are too few such lines.
 */
export const offPicture = (s: Surround, around: Lab[][]): Partial4 | undefined => {
  const lines = s.perLine.flatMap((e, k) => (e && nearShare(around[k] ?? [], s.around) < 0.1 ? [k] : []));
  if (lines.length < Math.max(2, 0.2 * s.perLine.length)) return undefined;
  const of = (d: Dir): Seen[] => lines.flatMap((k) => s.perLine[k]?.edges[d] ?? []);
  const dirs: Dir[] = ['up', 'down', 'left', 'right'];
  const agree = dirs.every((d) => { const e = of(d); return e.length > 0 && dEdge(labMedian(e.map((x) => x.lab)), s.around) < 18; });
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

/** The letters without a plate: outline, shadow or plain, the fill's colour and how sure each part is. */
export const lettersOf = (frames: Frame[], boxes: Rect[], all: Surround[], around: Lab[][]): Letters => {
  const n = frames.length;
  const strokesPerLine = (s: Surround): number => median(s.strokes);
  const candidates = all.filter((s) => s.group.lines >= 0.75 * n && !s.ground && !isPicture(around, s.group.lab) && s.strokes.length > 0);
  // An outline of the picture's colour (black in a dark video): told on the lines where the picture is another colour.
  const off = new Map<Surround, Partial4>();
  for (const s of candidates) {
    if (!isPicture(around, s.around)) continue;
    const o = offPicture(s, around);
    if (o && o.enclosed >= ENCLOSED && o.thickness <= 0.25 * median(boxes.map((b) => b.y1 - b.y0))) off.set(s, o);
  }
  const plainCores = candidates.filter((s) => isPicture(around, s.around) && !off.has(s));
  // Anti-aliased fringe pixels can look enclosed by their own letter's core. A larger, more persistent core with
  // the picture beyond it is plain ink, so that fringe cannot be a separate fill with the core as its outline.
  const own = candidates.filter((s) => !plainCores.some((core) => core !== s && core.group.lines >= s.group.lines &&
    strokesPerLine(core) > strokesPerLine(s) && dEdge(core.group.lab, s.around) <= 15));
  const lineHeight = median(boxes.map((b) => b.y1 - b.y0));
  // The fill is enclosed by one colour that is not the picture (the ground between dark letters on a light picture
  // encloses them too, but it is the picture): an outline, a thin layer, or a plate that fills the whole box.
  const enclosed = own.filter((s) => (s.enclosed >= ENCLOSED && !isPicture(around, s.around)) || off.has(s))
    .sort((a, b) => b.enclosed * b.group.lines - a.enclosed * a.group.lines || strokesPerLine(b) - strokesPerLine(a));
  const fillSure = (s: Surround): Pick<CaptionLook, 'color' | 'confidence'> => {
    const c = sureOf(s, n);
    return c >= SURE ? { color: hexOf(s), confidence: c } : { confidence: c };
  };
  const base = { samples: n };
  // Of the candidates of nearly the best's colour inside the same outline (the fill and its fringe, bled into by the
  // outline's colour), the fill is the one with the most stroke pixels.
  const top = enclosed[0];
  const best = top && enclosed.filter((s) => dEdge(s.group.lab, top.group.lab) <= 15 && dEdge(s.around, top.around) <= 15).sort((a, b) => strokesPerLine(b) * b.group.lines - strokesPerLine(a) * a.group.lines)[0];
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
  if (fill.shadow && !isPicture(around, labMedian(fill.edges[fill.shadow].map((x) => x.lab)))) {
    const below = fill.edges[fill.shadow];
    const c = r2(fill.cons[fill.shadow] * (fill.group.lines / n));
    return { fill, look: { kind: 'shadow', ...sure, ...base, shadow: c >= SURE ? { color: colourOf(below), confidence: c } : { confidence: c }, ...unsure } };
  }
  return { fill, look: { kind: 'plain', ...sure, ...base, ...unsure } };
};

/** Letters enclosed by another colour: a plate that fills the reader's whole box, or an outline when it is a thin layer; else undefined. */
const outlineLook = (frames: Frame[], boxes: Rect[], best: Surround, all: Surround[], n: number, fill: Pick<CaptionLook, 'color' | 'confidence'>, lineHeight: number, part?: Partial4): CaptionLook | undefined => {
  const edge = part?.edge ?? [...best.edges.up, ...best.edges.down, ...best.edges.left, ...best.edges.right];
  // A plate that fills the reader's whole box (a loose box hides its sides): the colour around the letters covers
  // most of the box, which an outline never does.
  const boxPixels = frames.flatMap((f, k) => (part && !part.lines.includes(k) ? [] : area(f, boxes[k] as Rect).map((i) => labOf(f, i))));
  const covered = boxPixels.filter((l) => deltaE(l, best.around) <= 15).length / Math.max(1, boxPixels.length);
  if (covered >= 0.45 && consistency(edge) >= 0.5)
    return { kind: 'plate', ...fill, samples: n, plate: { color: colourOf(edge), opacity: 1, padding: 0.2, radius: 0.2, confidence: r2(consistency(edge)) }, unsure: ['the plate reaches past the boxes the reader gave, so its padding, corners and opacity were not measured: 0.2, 0.2 and 1 are taken'] };
  if ((part?.thickness ?? best.thickness) > 0.25 * lineHeight) return undefined;
  // The outline's own pixels are one of the box's colours, seen whole rather than bled into its neighbours: of the
  // colours like the one around the letters, the one with the most stroke pixels.
  const whole = all.filter((s) => s !== best && dEdge(s.group.lab, best.around) <= 15).sort((a, b) => median(b.strokes) * b.group.lines - median(a.strokes) * a.group.lines)[0];
  const lab = whole ? whole.group.lab : best.around;
  const color = whole ? toHex(whole.group.rgb) : colourOf(edge);
  // How sure: the share of what lies just past the letters that is this colour, on the lines the letters were found on.
  const c = r2((edge.filter((x) => dEdge(x.lab, lab) <= 20).length / Math.max(1, edge.length)) * (best.group.lines / n));
  return { kind: 'outline', ...fill, samples: n, outline: c >= SURE ? { color, confidence: c } : { confidence: c } };
};
