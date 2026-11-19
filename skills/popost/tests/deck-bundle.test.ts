/**
 * The converter that `popost deck` runs in Chromium is the editor's own `compileProject` / `splitProject`, bundled into
 * `src/deck/compile-bundle.ts`. That file is committed, so it has to follow the editor: this fails while it does not.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DECK_BUNDLE } from '../src/deck/compile-bundle';

const packageRoot = resolve(import.meta.dirname, '..');

describe('deck bundle', () => {
  it('is up to date with packages/canvas-editor/src/storage/compile.ts and bundles/deck-entry.ts', async () => {
    const script = pathToFileURL(resolve(packageRoot, 'bundles', 'build-deck.mjs')).href;
    const { renderBundleModule } = (await import(/* @vite-ignore */ script)) as { renderBundleModule: () => Promise<string> };
    const committed = readFileSync(resolve(packageRoot, 'src', 'deck', 'compile-bundle.ts'), 'utf8');
    const fresh = await renderBundleModule();
    expect(
      committed === fresh,
      'src/deck/compile-bundle.ts is out of date with the editor source: run `npm run build:deck -w popost` and commit it',
    ).toBe(true);
  });

  it('is one self-contained script: no module syntax, nothing that would close its <script> tag', () => {
    expect(DECK_BUNDLE).toContain('__popostDeck');
    expect(DECK_BUNDLE).not.toMatch(/^\s*(import|export)\b/m);
    expect(DECK_BUNDLE.toLowerCase()).not.toContain('</script');
  });

  it('is the editor code, not a copy of it: it carries the editor\'s own messages', () => {
    // compileProject / splitProject refuse these inputs with these (Chinese) messages; the converter passes them on
    expect(DECK_BUNDLE).toContain('请至少保留一页图文');
  });
});
