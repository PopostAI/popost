/**
 * The grid of the one composition contact sheet, and the picture ratio it is generated at.
 *
 * `series prompt` asks the model for "all pages as separate panels in C columns and R rows"; the job that generates it
 * needs an aspect ratio that suits that grid. Both come from here, so the prompt and the job agree: a panel gets the
 * pages' own proportion instead of being squeezed (three 9:16 pages in a 1:1 sheet) or letterboxed.
 *
 * With `columns x rows` cells on a sheet of ratio `A`, a panel has ratio `A * rows / columns`. A page scaled to fit its
 * panel fills `min(q, 1/q)` of it, where `q` is panel ratio over page ratio, so the share of the sheet that shows page
 * content is `pages / cells * min(q, 1/q)`. The plan with the largest share wins: the pages stay as big as the sheet allows.
 */
export const STANDARD_ASPECTS: readonly string[] = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'];

const MAX_COLUMNS = 8;
const ASPECT = /^([1-9][0-9]{0,2}):([1-9][0-9]{0,2})$/;

export interface PageSize {
  readonly width: number;
  readonly height: number;
}

export interface Grid {
  readonly columns: number;
  readonly rows: number;
}

export interface SheetPlan extends Grid {
  /** The sheet's picture ratio, one of the candidates (`16:9`). */
  readonly aspect: string;
  /** The ratio of one page, reduced (`9:16`). */
  readonly pageAspect: string;
  /** The share of the sheet that shows page content, 0..1. */
  readonly fill: number;
}

/** `W:H` as a number, or `null` when it is not a ratio of two positive integers of up to three digits. */
export const parseAspect = (text: string): number | null => {
  const match = ASPECT.exec(text);
  return match ? Number(match[1]) / Number(match[2]) : null;
};

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

const reduced = ({ width, height }: PageSize): string => {
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
};

/** The ratio most pages have (ties go to the earlier page); a project always has at least one page. */
export const typicalPage = (pages: readonly PageSize[]): PageSize => {
  const counts = new Map<string, { page: PageSize; count: number }>();
  for (const page of pages) {
    const key = reduced(page);
    counts.set(key, { page: counts.get(key)?.page ?? page, count: (counts.get(key)?.count ?? 0) + 1 });
  }
  let best: { page: PageSize; count: number } | undefined;
  for (const entry of counts.values()) if (!best || entry.count > best.count) best = entry;
  return best?.page ?? { width: 3, height: 4 };
};

const fillOf = (pages: number, grid: Grid, sheet: number, page: number): number => {
  const q = (sheet * grid.rows) / (grid.columns * page);
  return (pages / (grid.columns * grid.rows)) * Math.min(q, 1 / q);
};

const gridsFor = (pages: number): Grid[] =>
  Array.from({ length: Math.min(pages, MAX_COLUMNS) }, (_, i) => ({ columns: i + 1, rows: Math.ceil(pages / (i + 1)) }));

export interface PlanOptions {
  /** The ratios the picture model can make; defaults to the common ones. */
  readonly aspects?: readonly string[];
  /** Keep this grid (what the prompt already says) and only pick the ratio. */
  readonly grid?: Grid;
  /** How many pages the sheet holds, when that is not `pages.length` (the plan's pages). */
  readonly count?: number;
}

interface Candidate {
  readonly grid: Grid;
  readonly aspect: string;
  readonly fill: number;
}

const EPSILON = 1e-9;

/** Larger fill wins; at equal fill fewer empty cells, then fewer rows (pages read left to right). */
const beats = (a: Candidate, b: Candidate): boolean => {
  if (Math.abs(a.fill - b.fill) > EPSILON) return a.fill > b.fill;
  const [cellsA, cellsB] = [a.grid.columns * a.grid.rows, b.grid.columns * b.grid.rows];
  return cellsA !== cellsB ? cellsA < cellsB : a.grid.rows < b.grid.rows;
};

/** The grid and the picture ratio that keep the pages largest (see the top of this file for the measure). */
export const planSheet = (pages: readonly PageSize[], options: PlanOptions = {}): SheetPlan => {
  const page = typicalPage(pages);
  const pageRatio = page.width / page.height;
  const count = Math.max(1, options.count ?? pages.length);
  const given = (options.aspects ?? []).filter((aspect) => parseAspect(aspect) !== null);
  const aspects = given.length ? given : STANDARD_ASPECTS;
  let best: Candidate | undefined;
  for (const grid of options.grid ? [options.grid] : gridsFor(count))
    for (const aspect of aspects) {
      const candidate = { grid, aspect, fill: fillOf(count, grid, parseAspect(aspect)!, pageRatio) };
      if (!best || beats(candidate, best)) best = candidate;
    }
  const chosen = best!;
  return { ...chosen.grid, aspect: chosen.aspect, pageAspect: reduced(page), fill: Math.round(chosen.fill * 100) / 100 };
};

/** `3 columns and 1 row`, the way the composition prompt says it. */
export const describeGrid = ({ columns, rows }: Grid): string => `${columns} column${columns === 1 ? '' : 's'} and ${rows} row${rows === 1 ? '' : 's'}`;
