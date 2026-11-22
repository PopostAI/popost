import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { searchTemplateIndex } from '../src/workflow/community-search';
import { loadCatalog } from './template-search-eval';

interface Query { readonly query: string; readonly lang: 'zh' | 'en'; readonly expected: string }
const { queries } = JSON.parse(readFileSync(new URL('./fixtures/instagram-template-search.json', import.meta.url), 'utf8')) as { queries: Query[] };

describe('Instagram template lookup', () => {
  const catalog = loadCatalog();

  it('covers every Instagram format with English and Chinese task phrases', () => {
    const expected = new Set(queries.map((query) => query.expected));
    expect(catalog.filter((entry) => entry.platform === 'instagram').every((entry) => expected.has(entry.id))).toBe(true);
    for (const id of expected) {
      expect(new Set(queries.filter((query) => query.expected === id).map((query) => query.lang))).toEqual(new Set(['zh', 'en']));
    }
  });

  it('retrieves the labelled format in the first three Instagram candidates', () => {
    for (const query of queries) {
      const results = searchTemplateIndex(catalog, { q: query.query, platform: 'instagram', limit: 3 });
      expect(results.every(({ template }) => template.platform === 'instagram')).toBe(true);
      expect(results.map(({ template }) => template.id), query.query).toContain(query.expected);
    }
  });
});
