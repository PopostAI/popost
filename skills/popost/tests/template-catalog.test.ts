/** templates/community/README.md is generated from index.json; it must list every template and stay readable in one go. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from './template-search-eval';

const skillRoot = fileURLToPath(new URL('..', import.meta.url));
const readme = readFileSync(`${skillRoot}templates/community/README.md`, 'utf8');

describe('community template catalog', () => {
  it('is up to date with index.json (regenerate with node tools/build-template-catalog.mjs)', () => {
    expect(() => execFileSync(process.execPath, ['tools/build-template-catalog.mjs', '--check'], { cwd: skillRoot, stdio: 'pipe' })).not.toThrow();
  });

  it('links every template once, with its use-when line in both languages, and stays small', () => {
    for (const entry of loadCatalog()) {
      expect(readme.split(`](./${entry.id}/SKILL.md)`).length - 1).toBe(1);
      expect(readme).toContain(entry.copy.zh.useWhen);
      expect(readme).toContain(entry.copy.en.useWhen);
    }
    // The expanded bilingual catalog retains a bounded single-pass reading budget.
    expect(Buffer.byteLength(readme)).toBeLessThan(70 * 1024);
  });
});
