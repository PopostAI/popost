import { describe, expect, it } from 'vitest';
import { searchTemplateIndex, type SearchableTemplate } from '../src/workflow/community-search';
const entry = (id: string, name: string, category: string, exclusions: string[] = []): SearchableTemplate => ({ id, platform: 'tiktok', categories: [category], copy: { zh: { name, summary: name, useWhen: name }, en: { name, summary: name, useWhen: name } }, match: { goals: [name], imageCues: [name], exclusions }, revision: 'a'.repeat(64) });
const items = [entry('waterproof-shoes','防水上脚','shoes'),entry('bag-capacity','包袋容量','luggage-bags'),entry('shoe-colors','鞋履多色','shoes',['防水'])];
describe('explicit community lookup', () => {
  it('matches Chinese phrases inside natural requests and isolates platform and category', () => {
    expect(searchTemplateIndex(items,{q:'想做防水鞋上脚图文',platform:'tiktok',category:'shoes'})[0]?.template.id).toBe('waterproof-shoes');
    expect(searchTemplateIndex(items,{q:'包袋容量',category:'shoes'})).toEqual([]);
    expect(searchTemplateIndex(items,{q:'防水上脚',platform:'instagram'})).toEqual([]);
  });
  it('avoids arbitrary matches for empty/irrelevant requests and honors exclusions', () => {
    expect(searchTemplateIndex(items,{q:'  '})).toEqual([]);
    expect(searchTemplateIndex(items,{q:'量子物理'})).toEqual([]);
    const normal = searchTemplateIndex(items,{q:'鞋履多色'}).find(x=>x.template.id==='shoe-colors')!;
    const excluded = searchTemplateIndex(items,{q:'鞋履多色防水'}).find(x=>x.template.id==='shoe-colors')!;
    expect(excluded.score).toBeLessThan(normal.score);
    expect(searchTemplateIndex(items,{q:'防水上脚',limit:1})).toHaveLength(1);
  });
});

// Exercise the public command boundary and show that lookup leaves selection to its caller.
import { createTestRuntime, runCli } from '../src/testing/memory';
it('exposes indexed lookup as an explicit read-only CLI command', async () => {
  const rt = createTestRuntime();
  const root = rt.path.join(rt.skillRoot, 'templates/community');
  await rt.fs.mkdir(root);
  await rt.fs.writeFile(rt.path.join(root, 'index.json'), JSON.stringify({ schemaVersion: 2, templates: items }));
  expect((await runCli(rt, ['template', 'search', '--query', '防水上脚', '--platform', 'tiktok', '--category', 'shoes'])).code).toBe(0);
  expect(rt.json()).toMatchObject({ ok: true, automaticSelection: false, items: [{ id: 'waterproof-shoes', skillPath: rt.path.join(root, 'waterproof-shoes/SKILL.md') }] });
  expect((await runCli(rt, ['template', 'search', '--query', '防水上脚', '--limit', '0'])).code).toBe(2);
});
