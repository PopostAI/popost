import { describe, expect, it } from 'vitest';
import { applyOp, applySplicesToIndex } from '../edits';
import { fastPathStats, resetFastPathStats } from '../fastpath';
import { createIdSource } from '../ids';
import { parseIndex } from '../source';

/**
 * Regression test for edit latency: a 3-page post with a ~6 MB embedded font (like a real CJK font pick) and
 * large image data URIs. Attribute-local edits and their undo must not re-parse the whole document.
 */
const font = 'A'.repeat(6_000_000);
const page = (i: number) =>
  `<section class="slide" data-popost-page="p${i}" style="width:1080px;height:1440px">\n  <h1 data-layer-id="t${i}" style="font-size:72px">Title ${i}</h1>\n  <p data-slot="body">Body text ${i}</p>\n  <img src="data:image/png;base64,${'B'.repeat(200_000)}">\n</section>`;
const src = `<!doctype html><html><head><meta charset="utf-8"><style data-popost-font="cjk-sans">@font-face{font-family:x;src:url(data:font/woff2;base64,${font})}</style><style>.slide{position:relative}</style></head><body>\n${[1, 2, 3].map(page).join('\n')}\n</body></html>`;

const RUNS = 5;
const LIMIT_MS = 60;

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

describe('perf', () => {
  it('keeps setStyle and its undo under 60 ms on a ~6.6 MB document', () => {
    const ids = createIdSource();
    const ctx = { newId: ids.newId };
    const base = parseIndex(src, ids);
    const h1 = base.order.find((id) => base.elements.get(id)!.tag === 'h1')!;
    expect(src.length).toBeGreaterThan(6_500_000);

    resetFastPathStats();
    const apply: number[] = [];
    const undo: number[] = [];
    const redo: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      let t = performance.now();
      const edited = applyOp(base, { kind: 'setStyle', id: h1, props: { translate: `${10 + i}px 20px` } }, ctx);
      apply.push(performance.now() - t);
      expect(edited.index.source.includes(`translate: ${10 + i}px 20px`)).toBe(true);

      t = performance.now();
      const undone = applySplicesToIndex(edited.index, edited.inverse, ctx);
      undo.push(performance.now() - t);
      expect(undone.index.source === base.source).toBe(true);
      expect(undone.index.elements.get(h1)).toEqual(base.elements.get(h1));

      t = performance.now();
      const redone = applySplicesToIndex(undone.index, edited.splices, ctx);
      redo.push(performance.now() - t);
      expect(redone.index.elements.get(h1)).toEqual(edited.index.elements.get(h1));
    }
    expect(fastPathStats).toEqual({ taken: RUNS * 3, declined: 0 });

    const stats = { bytes: src.length, setStyleMs: median(apply), undoMs: median(undo), redoMs: median(redo) };
    console.log(JSON.stringify(stats, (_k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)));
    expect(stats.setStyleMs).toBeLessThan(LIMIT_MS);
    expect(stats.undoMs).toBeLessThan(LIMIT_MS);
    expect(stats.redoMs).toBeLessThan(LIMIT_MS);
  });
});
