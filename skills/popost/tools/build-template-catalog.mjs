#!/usr/bin/env node
/**
 * Generates templates/community/README.md, the one-file catalog an agent reads to choose a bundled template:
 * every template grouped by category, with its name and "use when" line in both languages. Deterministic; the
 * source of truth is templates/community/index.json. `--check` exits 1 when README.md is out of date.
 * Run from anywhere: node skills/popost/tools/build-template-catalog.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../templates/community/', import.meta.url));

const groupLabel = (entries) => {
  const [first] = entries;
  if (first.platform === 'instagram') return { zh: 'Instagram 图文', en: 'Instagram Carousels' };
  const [zh, en] = [first.match.goals[2], first.match.goals[4]];
  return first.categories.length === 0 || !zh || !en ? { zh: '杂志风', en: 'Editorial' } : { zh, en };
};

export const renderCatalog = (index) => {
  const groups = new Map();
  for (const entry of index.templates) {
    const key = entry.categories[0] ?? (entry.platform === 'xiaohongshu' ? 'editorial' : entry.platform);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const count = (platform) => index.templates.filter((entry) => entry.platform === platform).length;
  const lines = [
    '# Community templates',
    '',
    `${index.templates.length} creation recipes: ${count('tiktok')} TikTok commerce formats, ${count('xiaohongshu')} editorial layouts and ${count('instagram')} Instagram carousels. Search index schema: ${index.schemaVersion}.`,
    '',
    'Shortlist 1–3 templates by subject and intended layout. Read each linked SKILL.md before choosing. Keyword lookup: `popost template search`.',
    '',
    '按主题与图文结构初选 1–3 套，再完整阅读对应 SKILL.md。也可用 `popost template search` 按关键词查找。',
  ];
  for (const [key, entries] of groups) {
    const label = groupLabel(entries);
    lines.push('', `## ${label.zh} / ${label.en} (\`${key}\`, ${entries.length})`, '');
    for (const entry of entries) {
      lines.push(`- [${entry.copy.zh.name} / ${entry.copy.en.name}](./${entry.id}/SKILL.md)`);
      lines.push(`  - ${entry.copy.zh.useWhen}`, `  - ${entry.copy.en.useWhen}`);
    }
  }
  return `${lines.join('\n')}\n`;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = renderCatalog(JSON.parse(readFileSync(`${root}index.json`, 'utf8')));
  if (process.argv.includes('--check')) {
    if (readFileSync(`${root}README.md`, 'utf8') !== next) {
      process.stderr.write('templates/community/README.md is out of date: run node skills/popost/tools/build-template-catalog.mjs\n');
      process.exit(1);
    }
  } else {
    writeFileSync(`${root}README.md`, next);
  }
}
