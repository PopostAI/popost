/**
 * template check --assets <project>: the project's caption text against the template's measured caption size. A
 * template from a reference whose caption lines were 6% of the height, filled, then the caption track's style edited
 * by hand: half the size, twice the size, a named style near it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { captionSizeProblems } from '../../src/video/template/project';
import { jsonText } from '../../src/video/template/save';
import { slotsOf } from '../../src/video/template/slots';
import { templateFrom } from '../../src/video/template/structure';
import type { TemplatePackage } from '../../src/video/template/types';
import type { TextTrack } from '../../src/video/text/types';
import type { CaptionTrack, Measure, Problem, Project } from '../../src/video/types';

let rt: DiskRuntime;

const measure: Measure = {
  version: 1,
  source: { width: 720, height: 1280, fps: 30, frames: 180, duration: 6, hasAudio: false },
  boundaries: [{ frame: 90, kind: 'cut', start: 89, end: 90, confidence: 1 }],
  shots: [0, 1].map((k) => ({ index: k, start: k * 90, end: (k + 1) * 90, camera: { kind: 'static' as const, zoomPerS: 0, panPerS: [0, 0] as [number, number], confidence: 0.9 }, background: '#202020', palette: [{ hex: '#202020', share: 0.5 }], events: [] })),
  rhythm: { step: 3, change: [] },
  signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
};
/** Two caption lines 6% of the height tall (77 px on 1280), low in the frame. */
const text: TextTrack = {
  step: 6, sampled: 30,
  cues: [
    { text: 'first line', start: 6, end: 80, box: [0.2, 0.82, 0.6, 0.06], role: 'caption', size: 0.06, samples: 12, confidence: 0.97 },
    { text: 'second line', start: 96, end: 170, box: [0.2, 0.82, 0.6, 0.06], role: 'caption', size: 0.06, samples: 12, confidence: 0.97 },
  ],
};
const template = templateFrom({ measure, text, name: 'captions', label: 'captions', hash: 'x' });
const pkg: TemplatePackage = { template, slots: slotsOf(template, undefined) };
const fill = { shots: [{ color: '#101010' }, { color: '#f0f0f0' }], captions: ['one', 'two'] };

describe('template check: the project\'s captions against the template\'s size', () => {
  let project: Project;
  const withStyle = (style: CaptionTrack['style']): Project => ({ ...project, tracks: project.tracks.map((t) => (t.type === 'caption' ? { ...t, style } : t)) });
  const sized = (size: number): Project => withStyle({ ...((project.tracks.find((t) => t.type === 'caption') as CaptionTrack).style as object), size });

  beforeAll(async () => {
    rt = await createDiskRuntime();
    await rt.fs.writeFile(rt.path.join(rt.dir, 'template', 'template.json'), jsonText(pkg.template));
    await rt.fs.writeFile(rt.path.join(rt.dir, 'template', 'slots.json'), jsonText(pkg.slots));
    await rt.fs.writeFile(rt.path.join(rt.dir, 'fill.json'), JSON.stringify(fill));
    expect((await runCli(rt, ['video', 'template', 'fill', 'template', '--fill', 'fill.json', '--out', 'project'])).code).toBe(0);
    project = JSON.parse(await rt.fs.readText(rt.path.join(rt.dir, 'project', 'video.json'))) as Project;
  });
  afterAll(() => rt.cleanup());

  it('says nothing about the captions template fill wrote, or a style near them', () => {
    expect(template.captions?.style.size).toBeCloseTo(0.0552, 4);
    expect(captionSizeProblems(pkg, project)).toEqual([]);
    expect(captionSizeProblems(pkg, sized(0.05))).toEqual([]);
  });

  it('warns when the captions are much smaller or larger than the reference\'s, with both sizes in pixels', () => {
    const half = captionSizeProblems(pkg, sized(0.0276));
    expect(half).toEqual([{
      level: 'warning', at: 'tracks[0].style.size',
      message: 'The captions of track "captions" are 35 px (font size) on the 1280 px tall canvas; the template\'s are 71 px, set from the reference\'s caption lines, which were 77 px tall: 2.0 times smaller than the reference\'s.',
      fix: 'Give the caption track "style": { ..., "size": 0.0552 } (a fraction of the canvas height), as template fill wrote it, or run template fill again.',
    }]);
    expect(captionSizeProblems(pkg, sized(0.11))[0]?.message).toContain('141 px (font size)');
    expect(captionSizeProblems(pkg, sized(0.11))[0]?.message).toContain('2.0 times larger');
    // A named style is measured by the size it stands for: "label" is 3.2% of the height.
    expect(captionSizeProblems(pkg, withStyle('label'))[0]).toMatchObject({ at: 'tracks[0].style' });
  });

  it('is printed by template check when --assets is the project', async () => {
    const file = rt.path.join(rt.dir, 'project', 'video.json');
    await rt.fs.writeFile(file, JSON.stringify(sized(0.0276)));
    expect((await runCli(rt, ['video', 'template', 'check', 'template', '--fill', 'fill.json', '--assets', 'project'])).code).toBe(0);
    const out = rt.json() as { ok: boolean; problems: Problem[]; projectChecked?: string };
    expect(out.ok).toBe(true);
    expect(out.projectChecked).toBe(file);
    expect(out.problems.filter((p) => p.at.startsWith('tracks')).map((p) => p.at)).toEqual(['tracks[0].style.size']);
    // Without --assets, no project is looked at.
    expect((await runCli(rt, ['video', 'template', 'check', 'template', '--fill', 'fill.json'])).code).toBe(0);
    expect((rt.json() as { problems: Problem[] }).problems.filter((p) => p.at.startsWith('tracks'))).toEqual([]);
  });
});
