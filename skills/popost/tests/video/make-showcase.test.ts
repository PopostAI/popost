import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import type { Project } from '../../src/video/types';
import { parseProject } from '../../src/video/project/schema';
import { checkProjectOnDisk } from '../../src/video/project/check';
import { loadWords } from '../../src/video/compile/words';
import { hasFfmpeg } from '../../src/video/media/ffmpeg';
import { checkLayout, openRenderer } from '../../src/video/render/index';
import { decodePng } from './make-fixtures';

/** examples/showcase: every feature of the third making round and the words of the fourth once, as text only. */
const DIR = path.join(import.meta.dirname, '..', '..', 'references', 'video-examples', 'showcase');
const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ready = (await hasFfmpeg(rt)) && hasChrome();

describe('the showcase example', () => {
  it('passes the schema and check without a single problem, and gives every item and segment a note', async () => {
    const json = JSON.parse(await readFile(path.join(DIR, 'video.json'), 'utf8')) as unknown;
    const parsed = parseProject(json);
    expect(parsed.problems).toEqual([]);
    const p = parsed.project as Project;
    const words = await loadWords(rt, p, DIR);
    expect(Object.keys(words)).toEqual(['voice']);
    expect(await checkProjectOnDisk(rt, p, DIR, { words })).toEqual([]);
    expect([...p.segments, ...p.tracks].filter((x) => !x.note).map((x) => x.id)).toEqual([]);
  });

  it.skipIf(!ready)('renders five frames (a typed title, a zoom held at 2.6x, a cut settling out of a blur, a spoken word, a phrase anchor), and every text fits its box', async () => {
    const renderer = await openRenderer(rt, DIR, { scale: 0.25 });
    try {
      const frames = await Promise.all([30, 100, 112, 252, 296].map(async (n) => decodePng(await renderer.frame(n))));
      frames.forEach((f) => expect([f.width, f.height]).toEqual([270, 480]));
      expect(new Set(frames.map((f) => f.data.toString('base64'))).size).toBe(5);
    } finally {
      await renderer.close();
    }
    expect(await checkLayout(rt, DIR)).toEqual([]);
  });
});
