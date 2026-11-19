/**
 * The geometry of an overview sheet (`popost sheet`): which tiles go in which row and column, and how big everything is.
 * Pure arithmetic with no browser and no file system, so the layout is testable on its own.
 *
 * A sheet is for a vision model that downsizes every picture to about a thousand tokens, so it stays modest: at most
 * 2048 px wide, every tile in a cell of the same size (the picture contained in it, never cropped or stretched), and
 * above each cell a dark label bar whose text is large enough to survive that downsizing.
 */
import { ValueError } from '../core/errors';

export interface SheetImage {
  /** What the label bar says. */
  readonly label: string;
  /** Where the picture came from, reported back to the caller. */
  readonly source: string;
  /** The picture's own pixel size. */
  readonly width: number;
  readonly height: number;
}

export type PlacedTile<T extends SheetImage = SheetImage> = T & {
  /** The label as it is drawn: shortened in the middle when it would not fit the label bar. */
  readonly text: string;
  /** Which band (group of tiles that starts on a new row) the tile belongs to. */
  readonly band: number;
  readonly row: number;
  readonly column: number;
  /** The cell's top-left corner on the sheet. */
  readonly x: number;
  readonly y: number;
};

export interface SheetCell {
  readonly width: number;
  /** Label bar plus picture box. */
  readonly height: number;
  readonly barHeight: number;
  readonly boxHeight: number;
  readonly fontSize: number;
}

export interface SheetLayout<T extends SheetImage = SheetImage> {
  readonly width: number;
  readonly height: number;
  readonly columns: number;
  readonly rows: number;
  readonly cell: SheetCell;
  readonly tiles: PlacedTile<T>[];
}

export const MAX_SHEET_WIDTH = 2048;
/** A lone picture is not blown up to the full sheet width. */
export const MAX_CELL_WIDTH = 640;
/** Below this a tile shows nothing worth looking at, so the column count stops here. */
export const MIN_CELL_WIDTH = 220;
/** Outer margin and the space between cells. */
export const GAP = 16;
/** A sheet that holds more than this is too tall to be an overview: split it. */
export const MAX_SHEET_IMAGES = 40;
/** With two or more bands (`--compare`) a band wraps after this many tiles. */
export const COMPARE_MAX_COLUMNS = 6;

/** The sheet's own shape the column count aims for: a little wider than tall. */
const TARGET_ASPECT = 1.2;
/** How much a missing tile in the last row counts against a column count, next to the shape of the sheet. */
const EMPTY_CELL_PENALTY = 1.5;
/** The picture box is as tall as the typical picture (height / width), within these limits. */
const MIN_BOX_ASPECT = 0.56;
const MAX_BOX_ASPECT = 1.8;
const MIN_FONT = 22;
const MAX_FONT = 44;
/** Average advance of a Latin letter in the bold label font, in em; a CJK character is 1 em. */
const LATIN_EM = 0.62;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** Height / width of the picture box every cell shares: the median picture, so one odd one out is letterboxed. */
export const boxAspect = (images: readonly SheetImage[]): number =>
  clamp(median(images.map((image) => image.height / image.width)), MIN_BOX_ASPECT, MAX_BOX_ASPECT);

/** The size of one cell when the sheet has `columns` columns. */
export const cellFor = (columns: number, aspect: number): SheetCell => {
  const width = Math.min(MAX_CELL_WIDTH, Math.floor((MAX_SHEET_WIDTH - GAP * (columns + 1)) / columns));
  const fontSize = clamp(Math.round(width / 11), MIN_FONT, MAX_FONT);
  const barHeight = Math.round(fontSize * 1.7);
  const boxHeight = Math.round(width * aspect);
  return { width, height: barHeight + boxHeight, barHeight, boxHeight, fontSize };
};

const sheetSize = (columns: number, rows: number, cell: SheetCell) => ({
  width: columns * cell.width + GAP * (columns + 1),
  height: rows * cell.height + GAP * (rows + 1),
});

/**
 * The column count for `count` pictures in one group: the one whose sheet is closest to a slightly wide rectangle,
 * counting empty cells in the last row against it. Fewer columns win a tie.
 */
export const chooseColumns = (count: number, aspect: number): number => {
  const widest = Math.max(1, Math.floor((MAX_SHEET_WIDTH - GAP) / (MIN_CELL_WIDTH + GAP)));
  let best = 1;
  let bestCost = Infinity;
  for (let columns = 1; columns <= Math.min(count, widest); columns++) {
    const rows = Math.ceil(count / columns);
    const size = sheetSize(columns, rows, cellFor(columns, aspect));
    const empty = (rows * columns - count) / (rows * columns);
    const cost = Math.abs(Math.log(size.width / size.height / TARGET_ASPECT)) + EMPTY_CELL_PENALTY * empty;
    if (cost < bestCost - 1e-9) {
      best = columns;
      bestCost = cost;
    }
  }
  return best;
};

/** Width of a character in em: a CJK or full-width one is 1, anything else about 0.62. */
const emWidth = (char: string): number => ((char.codePointAt(0) ?? 0) >= 0x2e80 ? 1 : LATIN_EM);

const emSum = (chars: readonly string[]): number => chars.reduce((sum, char) => sum + emWidth(char), 0);

/**
 * `label` as it fits in `widthPx` at `fontPx`. A label that is too long keeps its start and its end and loses the
 * middle (`generated-hero-…-v3.png`), because the end of a file name is the part that tells files apart.
 */
export const fitLabel = (label: string, widthPx: number, fontPx: number): string => {
  const chars = Array.from(label);
  const budget = (widthPx - fontPx * 1.2) / fontPx;
  if (emSum(chars) <= budget) return label;
  const room = Math.max(1, budget - 1); // the ellipsis takes one em
  const take = (source: readonly string[], limit: number): string[] => {
    const taken: string[] = [];
    let used = 0;
    for (const char of source) {
      used += emWidth(char);
      if (used > limit) break;
      taken.push(char);
    }
    return taken;
  };
  const head = take(chars, room * 0.6);
  const tail = take([...chars].reverse(), room * 0.4).reverse();
  return `${head.join('')}…${tail.join('')}`;
};

/**
 * Place the pictures. `bands` are groups that each start on a new row (`--compare`: the references, then the pages);
 * one band gets the column count that suits its size, several share the widest band's count up to
 * `COMPARE_MAX_COLUMNS`, so the shorter band simply has empty cells and picture N of one sits above picture N of the other.
 */
export const layoutSheet = <T extends SheetImage>(bands: readonly (readonly T[])[]): SheetLayout<T> => {
  const groups = bands.filter((band) => band.length > 0);
  const all = groups.flat();
  if (!all.length) throw new ValueError('there is nothing to put on the sheet');
  if (all.length > MAX_SHEET_IMAGES)
    throw new ValueError(`a sheet holds at most ${MAX_SHEET_IMAGES} pictures (got ${all.length}); split them over several sheets`);
  const aspect = boxAspect(all);
  const columns =
    groups.length > 1
      ? Math.min(Math.max(...groups.map((band) => band.length)), COMPARE_MAX_COLUMNS)
      : chooseColumns(all.length, aspect);
  const cell = cellFor(columns, aspect);
  const tiles: PlacedTile<T>[] = [];
  let rows = 0;
  groups.forEach((band, bandIndex) => {
    band.forEach((image, index) => {
      const row = rows + Math.floor(index / columns);
      const column = index % columns;
      tiles.push({
        ...image,
        text: fitLabel(image.label, cell.width, cell.fontSize),
        band: bandIndex,
        row,
        column,
        x: GAP + column * (cell.width + GAP),
        y: GAP + row * (cell.height + GAP),
      });
    });
    rows += Math.ceil(band.length / columns);
  });
  return { ...sheetSize(columns, rows, cell), columns, rows, cell, tiles };
};
