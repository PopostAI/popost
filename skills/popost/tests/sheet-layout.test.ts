/** The geometry of `popost sheet`: columns from the count, cell sizes, bands for `--compare`, label fitting. Pure, no browser. */
import { describe, expect, it } from 'vitest';
import {
  chooseColumns,
  COMPARE_MAX_COLUMNS,
  fitLabel,
  GAP,
  layoutSheet,
  MAX_CELL_WIDTH,
  MAX_SHEET_IMAGES,
  MAX_SHEET_WIDTH,
  type SheetImage,
} from '../src/render/sheet-layout';

const image = (label: string, width = 1080, height = 1440): SheetImage => ({ label, source: `${label}.png`, width, height });
const images = (count: number, prefix = 'p', width = 1080, height = 1440): SheetImage[] =>
  Array.from({ length: count }, (_, i) => image(`${prefix}${i + 1}`, width, height));

describe('sheet layout: columns', () => {
  it.each([
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 2],
    [6, 3],
    [10, 5],
  ])('puts %i portrait pictures in %i columns', (count, columns) => {
    expect(layoutSheet([images(count)]).columns).toBe(columns);
    expect(chooseColumns(count, 1440 / 1080)).toBe(columns);
  });

  it('never goes wider than 2048 px, and keeps every tile on the sheet without overlap', () => {
    for (let count = 1; count <= MAX_SHEET_IMAGES; count++) {
      const layout = layoutSheet([images(count)]);
      expect(layout.width, `${count} pictures`).toBeLessThanOrEqual(MAX_SHEET_WIDTH);
      expect(layout.cell.width).toBeLessThanOrEqual(MAX_CELL_WIDTH);
      expect(layout.tiles).toHaveLength(count);
      const corners = new Set<string>();
      layout.tiles.forEach((tile, index) => {
        expect(tile.label).toBe(`p${index + 1}`);
        expect(tile.x + layout.cell.width + GAP).toBeLessThanOrEqual(layout.width);
        expect(tile.y + layout.cell.height + GAP).toBeLessThanOrEqual(layout.height);
        expect(tile.row * layout.columns + tile.column).toBe(index);
        corners.add(`${tile.x},${tile.y}`);
      });
      expect(corners.size).toBe(count);
    }
  });

  it('keeps the label text large: at least 22 px, and a bar taller than the text', () => {
    for (const count of [1, 5, 12, 40]) {
      const { cell } = layoutSheet([images(count)]);
      expect(cell.fontSize).toBeGreaterThanOrEqual(22);
      expect(cell.barHeight).toBeGreaterThan(cell.fontSize);
    }
  });

  it('does not blow a lone picture up to the sheet width', () => {
    const layout = layoutSheet([images(1)]);
    expect(layout.width).toBe(MAX_CELL_WIDTH + 2 * GAP);
  });

  it('sizes the picture box after the typical picture, so an odd one is contained rather than cropped', () => {
    const typical = layoutSheet([[image('a', 1000, 1000), image('b', 1000, 1000), image('c', 2000, 500)]]);
    expect(typical.cell.boxHeight).toBe(typical.cell.width);
    const tall = layoutSheet([[image('a', 100, 5000)]]);
    expect(tall.cell.boxHeight).toBeLessThanOrEqual(Math.round(tall.cell.width * 1.8));
  });

  it('refuses an empty sheet and one with too many pictures', () => {
    expect(() => layoutSheet([[]])).toThrow('nothing to put on the sheet');
    expect(() => layoutSheet([images(MAX_SHEET_IMAGES + 1)])).toThrow(`at most ${MAX_SHEET_IMAGES} pictures`);
  });
});

describe('sheet layout: bands (--compare)', () => {
  it('lines picture N of the first band up with picture N of the second, and leaves the shorter band short', () => {
    const refs = images(3, 'ref ');
    const pages = images(5);
    const layout = layoutSheet([refs, pages]);
    expect(layout.columns).toBe(5);
    expect(layout.rows).toBe(2);
    const row = (band: number) => layout.tiles.filter((tile) => tile.band === band);
    expect(row(0).map((tile) => [tile.label, tile.row, tile.column])).toEqual([
      ['ref 1', 0, 0],
      ['ref 2', 0, 1],
      ['ref 3', 0, 2],
    ]);
    expect(row(1).map((tile) => [tile.label, tile.row])).toEqual([['p1', 1], ['p2', 1], ['p3', 1], ['p4', 1], ['p5', 1]]);
    for (let i = 0; i < 3; i++) expect(row(0)[i]!.x).toBe(row(1)[i]!.x);
  });

  it('works with more references than pages', () => {
    const layout = layoutSheet([images(4, 'ref '), images(2)]);
    expect(layout.columns).toBe(4);
    expect(layout.rows).toBe(2);
    expect(layout.tiles.filter((tile) => tile.band === 1)).toHaveLength(2);
  });

  it('wraps a band that is longer than six tiles, and still starts the next band on a new row', () => {
    const layout = layoutSheet([images(2, 'ref '), images(8)]);
    expect(layout.columns).toBe(COMPARE_MAX_COLUMNS);
    expect(layout.rows).toBe(3);
    const pages = layout.tiles.filter((tile) => tile.band === 1);
    expect(pages.map((tile) => tile.row)).toEqual([1, 1, 1, 1, 1, 1, 2, 2]);
    expect(layout.width).toBeLessThanOrEqual(MAX_SHEET_WIDTH);
  });

  it('ignores an empty band', () => {
    expect(layoutSheet([[], images(2)]).columns).toBe(2);
  });
});

describe('sheet layout: labels', () => {
  it('keeps a label that fits', () => {
    expect(fitLabel('p1', 640, 44)).toBe('p1');
    expect(fitLabel('ref 12', 220, 22)).toBe('ref 12');
  });

  it('shortens a long label in the middle, keeping the start and the end of a file name', () => {
    const fitted = fitLabel('generated-hero-image-variant-3-final.png', 400, 36);
    expect(fitted).toContain('…');
    expect(fitted.startsWith('gener')).toBe(true);
    expect(fitted.endsWith('.png')).toBe(true);
    expect(Array.from(fitted).length).toBeLessThan(40);
  });

  it('counts a CJK character as wider than a letter', () => {
    expect(fitLabel('一二三四五六七八九十', 400, 36)).toContain('…');
    expect(fitLabel('abcdefghij', 400, 36)).toBe('abcdefghij');
  });

  it('puts the fitted label in the tile and leaves the label itself alone', () => {
    const long = 'a-very-long-generated-asset-file-name-final-version.png';
    const [tile] = layoutSheet([[image(long)]]).tiles;
    expect(tile!.label).toBe(long);
    expect(tile!.text).not.toBe(long);
  });
});
