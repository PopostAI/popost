/** The grid and picture ratio of the composition sheet: pure geometry, no project and no model. */
import { describe, expect, it } from 'vitest';
import { describeGrid, parseAspect, planSheet, STANDARD_ASPECTS, typicalPage } from '../src/workflow/composition-grid';

const pages = (count: number, width: number, height: number) => Array.from({ length: count }, () => ({ width, height }));

describe('planSheet', () => {
  it.each([
    // pages, page size, columns, rows, aspect, share of the sheet that shows pages
    [3, 1080, 1920, 3, 1, '16:9', 0.95],
    [4, 1080, 1920, 2, 2, '9:16', 1],
    [4, 1080, 1440, 2, 2, '3:4', 1],
    [2, 1080, 1080, 2, 1, '16:9', 0.89],
    [1, 1080, 1350, 1, 1, '3:4', 0.94],
    [6, 1080, 1440, 3, 2, '1:1', 0.89],
  ])('puts %i pages of %ix%i in %i columns x %i rows on a %s sheet', (count, width, height, columns, rows, aspect, fill) => {
    expect(planSheet(pages(count, width, height))).toMatchObject({ columns, rows, aspect, fill });
  });

  it('never squeezes a 9:16 page into a square sheet when a better one exists, and names the page ratio', () => {
    const plan = planSheet(pages(3, 1080, 1920));
    expect(plan.aspect).not.toBe('1:1');
    expect(plan.pageAspect).toBe('9:16');
    expect(describeGrid(plan)).toBe('3 columns and 1 row');
    expect(describeGrid({ columns: 1, rows: 2 })).toBe('1 column and 2 rows');
  });

  it('keeps the pages as large as a restricted model allows, even if that means another grid', () => {
    const limited = ['1:1', '3:4', '9:16'];
    expect(planSheet(pages(3, 1080, 1920), { aspects: limited })).toMatchObject({ columns: 2, rows: 2, aspect: '9:16', fill: 0.75 });
    // a grid the prompt already states is kept; only the ratio is the closest the model makes
    expect(planSheet(pages(3, 1080, 1920), { aspects: limited, grid: { columns: 3, rows: 1 } })).toMatchObject({ columns: 3, rows: 1, aspect: '1:1' });
  });

  it('takes the page count from the plan when it is not the number of pages in the project', () => {
    expect(planSheet(pages(1, 1080, 1920), { count: 3 })).toMatchObject({ columns: 3, rows: 1, aspect: '16:9' });
    expect(planSheet([], { count: 0 })).toMatchObject({ columns: 1, rows: 1 });
  });

  it('uses the common ratios when the given ones are not ratios, and the page ratio most pages have', () => {
    expect(planSheet(pages(1, 1080, 1920), { aspects: ['wide', ''] }).aspect).toBe('9:16');
    expect(typicalPage([{ width: 1080, height: 1350 }, { width: 1080, height: 1920 }, { width: 540, height: 960 }])).toEqual({ width: 1080, height: 1920 });
    expect(typicalPage([])).toEqual({ width: 3, height: 4 });
    expect(STANDARD_ASPECTS.every((aspect) => parseAspect(aspect) !== null)).toBe(true);
  });

  it('breaks a tie towards fewer empty cells, then towards one row', () => {
    // two square pages: a 2x1 landscape sheet and a 1x2 portrait sheet fill the same share; pages read left to right
    expect(planSheet(pages(2, 1000, 1000))).toMatchObject({ columns: 2, rows: 1 });
  });
});

describe('parseAspect', () => {
  it('reads W:H of up to three digits and nothing else', () => {
    expect(parseAspect('16:9')).toBeCloseTo(16 / 9);
    for (const bad of ['wide', '16/9', '0:9', '1000:9', '16:9 ', '-1:2', '']) expect(parseAspect(bad), bad).toBeNull();
  });
});
