/** Explicit, local lookup. A result is a candidate; it never changes a creation's selected template. */
export interface SearchableTemplate {
  readonly id: string;
  readonly platform: string;
  readonly categories: readonly string[];
  readonly copy: { readonly zh: { readonly name: string; readonly summary: string; readonly useWhen: string }; readonly en: { readonly name: string; readonly summary: string; readonly useWhen: string } };
  readonly match: { readonly goals: readonly string[]; readonly imageCues: readonly string[]; readonly exclusions: readonly string[] };
  readonly revision: string;
}
export interface TemplateSearchQuery {
  readonly q: string;
  readonly platform?: string;
  readonly category?: string;
  readonly limit?: number;
}
const normalize = (text: string) => text.normalize('NFKC').toLowerCase().trim();
const tokens = (text: string): string[] => {
  const result = normalize(text).match(/[a-z0-9]+|[\p{Script=Han}]+/gu) ?? [];
  return [...new Set(result.flatMap((word) => /\p{Script=Han}/u.test(word) && word.length > 2 ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word]))];
};
export const searchTemplateIndex = <T extends SearchableTemplate>(catalog: readonly T[], query: TemplateSearchQuery): { template: T; score: number }[] => {
  const text = normalize(query.q);
  if (!text) return [];
  const words = new Set(tokens(text));
  const relevance = (term: string) => {
    const value = normalize(term);
    if (value && text.includes(value)) return 8;
    return Math.min(6, tokens(value).filter((word) => words.has(word)).length * 2);
  };
  return catalog
    .filter((entry) => (!query.platform || entry.platform === query.platform) && (!query.category || entry.categories.includes(query.category)))
    .map((template) => ({ template, score: Math.max(relevance(template.copy.zh.name), relevance(template.copy.en.name)) * 2 + [...template.match.goals, ...template.match.imageCues].reduce((sum, term) => sum + relevance(term), 0) - 12 * template.match.exclusions.filter((term) => text.includes(normalize(term))).length }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || (a.template.id < b.template.id ? -1 : a.template.id > b.template.id ? 1 : 0))
    .slice(0, Math.max(1, Math.min(50, query.limit ?? 10)));
};
