/** Baseline of the keyword search on the labelled set: it must not get worse (it is only an optional shortcut). */
import { describe, expect, it } from 'vitest';
import { loadCatalog, loadEvalQueries, runEval } from './template-search-eval';

describe('template search evaluation set', () => {
  const catalog = loadCatalog();
  const queries = loadEvalQueries();

  it('is well formed: ids exist, both languages and all kinds are covered', () => {
    const ids = new Set(catalog.map((entry) => entry.id));
    expect(queries.length).toBeGreaterThanOrEqual(80);
    expect(queries.every((q) => q.expected.length >= 1 && q.expected.length <= 3 && q.expected.every((id) => ids.has(id)))).toBe(true);
    expect(queries.filter((q) => q.lang === 'zh').length).toBe(queries.filter((q) => q.lang === 'en').length);
    expect(new Set(queries.map((q) => q.kind))).toEqual(new Set(['keyword', 'paraphrase', 'cross']));
    const covered = new Set(queries.flatMap((q) => q.expected.flatMap((id) => catalog.find((entry) => entry.id === id)?.categories ?? [])));
    expect([...new Set(catalog.flatMap((entry) => entry.categories))].filter((category) => !covered.has(category))).toEqual([]);
  });

  it('does not fall below the recorded baseline (61/122 top-1, 77/122 top-3)', () => {
    const report = runEval(catalog, queries);
    expect(report.overall.total).toBe(122);
    expect(report.overall.top1).toBeGreaterThanOrEqual(61);
    expect(report.overall.top3).toBeGreaterThanOrEqual(77);
    expect(report.byKind.keyword.top1).toBeGreaterThanOrEqual(45);
    expect(report.byKind.paraphrase.top1).toBeGreaterThanOrEqual(10);
    expect(report.byKind.cross.top1).toBeGreaterThanOrEqual(6);
  });
});
