/**
 * The code that runs in the browser (the page that draws frames, the preview's shell) is bundled ahead of time into
 * committed string modules, because the shipped package has no bundler. Those files have to follow their sources: this
 * fails while one does not.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAGE_BUNDLE } from '../../src/video/compile/page-bundle';
import { SHELL_BUNDLE } from '../../src/video/preview/shell-bundle';
import { MOTION_BUNDLE } from '../../src/video/replication/motion-bundle';

const packageRoot = resolve(import.meta.dirname, '..', '..');

interface Bundle { entry: string; name: string; target: string }
interface Builder { VIDEO_BUNDLES: Bundle[]; renderVideoBundle: (bundle: Bundle) => Promise<string> }

const builder = async (): Promise<Builder> =>
  (await import(/* @vite-ignore */ pathToFileURL(resolve(packageRoot, 'bundles', 'build-video.mjs')).href)) as Builder;

describe('video bundles', () => {
  it('are up to date with their sources, and the same bytes on every build', async () => {
    const { VIDEO_BUNDLES, renderVideoBundle } = await builder();
    expect(VIDEO_BUNDLES.map((b) => b.target)).toEqual(['src/video/compile/page-bundle.ts', 'src/video/preview/shell-bundle.ts', 'src/video/replication/motion-bundle.ts']);
    for (const bundle of VIDEO_BUNDLES) {
      const committed = readFileSync(resolve(packageRoot, bundle.target), 'utf8');
      const fresh = await renderVideoBundle(bundle);
      expect(committed === fresh, bundle.target + ' is out of date with ' + bundle.entry + ': run `npm run build:video -w popost` and commit it').toBe(true);
      expect(await renderVideoBundle(bundle)).toBe(fresh);
    }
  });

  it('are self-contained scripts: no module syntax, and they start what they are for', () => {
    for (const code of [PAGE_BUNDLE, SHELL_BUNDLE, MOTION_BUNDLE]) {
      expect(code).not.toMatch(/^\s*(import|export)\b/m);
      expect(code.length).toBeGreaterThan(1000);
    }
    expect(PAGE_BUNDLE).toContain('__popostVideo');
    expect(SHELL_BUNDLE).toContain('/api/state');
    expect(MOTION_BUNDLE).toContain('popostMotion');
  });
});
