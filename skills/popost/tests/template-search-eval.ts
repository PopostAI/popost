/** Accuracy helper for the labelled template-search set (`fixtures/template-search-eval.json`). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { searchTemplateIndex, type SearchableTemplate } from '../src/workflow/community-search';

export type EvalKind = 'keyword' | 'paraphrase' | 'cross';
export interface EvalQuery { readonly query: string; readonly lang: 'zh' | 'en'; readonly kind: EvalKind; readonly expected: readonly string[] }
export interface Accuracy { readonly total: number; readonly top1: number; readonly top3: number }
export interface EvalReport {
  readonly overall: Accuracy;
  readonly byKind: Record<EvalKind, Accuracy>;
  readonly byLang: Record<'zh' | 'en', Accuracy>;
  readonly failures: readonly { query: EvalQuery; top3: string[] }[];
}

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
export const loadCatalog = (): SearchableTemplate[] => (JSON.parse(readFileSync(here('../templates/community/index.json'), 'utf8')) as { templates: SearchableTemplate[] }).templates;
export const loadEvalQueries = (): EvalQuery[] => (JSON.parse(readFileSync(here('./fixtures/template-search-eval.json'), 'utf8')) as { queries: EvalQuery[] }).queries;

const tally = (rows: readonly { top1: boolean; top3: boolean }[]): Accuracy => ({ total: rows.length, top1: rows.filter((r) => r.top1).length, top3: rows.filter((r) => r.top3).length });

export const runEval = (catalog: readonly SearchableTemplate[] = loadCatalog(), queries: readonly EvalQuery[] = loadEvalQueries()): EvalReport => {
  const rows = queries.map((query) => {
    const ids = searchTemplateIndex(catalog, { q: query.query, limit: 3 }).map((r) => r.template.id);
    return { query, ids, top1: ids.length > 0 && query.expected.includes(ids[0]!), top3: ids.some((id) => query.expected.includes(id)) };
  });
  const group = <K extends string>(keys: readonly K[], pick: (q: EvalQuery) => K) => Object.fromEntries(keys.map((key) => [key, tally(rows.filter((r) => pick(r.query) === key))])) as Record<K, Accuracy>;
  return {
    overall: tally(rows),
    byKind: group(['keyword', 'paraphrase', 'cross'], (q) => q.kind),
    byLang: group(['zh', 'en'], (q) => q.lang),
    failures: rows.filter((r) => !r.top1).map((r) => ({ query: r.query, top3: r.ids })),
  };
};

export const formatReport = (report: EvalReport): string => {
  const line = (name: string, a: Accuracy) => `${name.padEnd(11)} n=${a.total} top1=${a.top1} (${((100 * a.top1) / a.total).toFixed(1)}%) top3=${a.top3} (${((100 * a.top3) / a.total).toFixed(1)}%)`;
  const failures = report.failures.map((f) => `  [${f.query.kind}] ${f.query.query} -> expected ${f.query.expected.join('|')}; got ${f.top3.join(', ') || '(nothing)'}`);
  return [line('overall', report.overall), ...Object.entries(report.byKind).map(([k, a]) => line(k, a)), ...Object.entries(report.byLang).map(([k, a]) => line(k, a)), 'not top-1:', ...failures].join('\n');
};
