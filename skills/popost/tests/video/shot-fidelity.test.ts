/**
 * What the reading of a shot lets the checks say beyond its layout kind: the size and place of its main picture, the
 * caption words drawn differently and revealed one by one, and the motion inside a recording. Synthetic readings,
 * fills and projects only: no real video's words.
 */
import { describe, expect, it } from 'vitest';
import { extrasOf, motionOf } from '../../src/video/elements/main';
import { fillReadingProblems, notSaidBy, projectReadingProblems, type ReadingFacts } from '../../src/video/elements/findings';
import { readElements } from '../../src/video/elements/read';
import { readingNotes } from '../../src/video/template/card-elements';
import type { Template } from '../../src/video/template/types';
import type { Box, Problem, Project } from '../../src/video/types';

type Shot = ReadingFacts['shots'][number];
const reading = (...shots: Shot[]): ReadingFacts => ({ shots, dropped: [] });
const FULL_REC: Shot = { layout: 'a full-frame screen recording', main: { box: [0, 0, 1, 1], kind: 'screen' } };
const WINDOW: Shot = { layout: 'a window on a designed ground', main: { box: [0.14, 0.14, 0.72, 0.72], kind: 'screen' } };
const SCREEN_SCENE = '<html><head><style>html, body { margin: 0; width: 1280px; height: 720px; }</style></head><body><div id="w"></div><script src="../lib/popost-screen.js"></script><script>popostScreen("#w", {});</script></body></html>';
const scene = (css = '#w { position: absolute; left: 0px; top: 0px; width: 1280px; height: 720px; }'): string => SCREEN_SCENE.replace('</style>', css + '</style>');
const messages = (ps: { at: string; message: string }[]): string[] => ps.map((p) => p.at + ': ' + p.message);

describe('the main picture of a shot: size and place (fill)', () => {
  it('warns when a full-frame recording is built as a designed scene with no picture', () => {
    const p = fillReadingProblems(reading(FULL_REC), { shots: [{ scene: 'scenes/a.html' }] }, new Map([['scenes/a.html', '<html><body><div>A slide</div></body></html>']]));
    expect(p).toHaveLength(1);
    expect(p[0]?.at).toBe('shots[0]');
    expect(p[0]?.message).toContain('"a full-frame screen recording"');
    expect(p[0]?.message).toContain('covers 100% of the frame');
    expect(p[0]?.message).toContain('a designed scene with no picture of the new subject');
    expect(p[0]?.fix).toContain('never another layout');
    // A card or a flat colour has none either; a scene file that was not read is not known.
    expect(fillReadingProblems(reading(FULL_REC), { shots: [{ card: { title: 'x' } }] })).toHaveLength(1);
    expect(fillReadingProblems(reading(FULL_REC), { shots: [{ scene: 'scenes/a.html' }] })).toEqual([]);
  });

  it('takes the screen helper as a picture, full frame or in a window', () => {
    const scenes = new Map([['scenes/a.html', scene()], ['scenes/w.html', scene('#w { position: absolute; left: 180px; top: 90px; width: 920px; height: 540px; }')]]);
    expect(fillReadingProblems(reading(FULL_REC), { shots: [{ scene: 'scenes/a.html' }] }, scenes)).toEqual([]);
    // A window of the same size as the reference's window.
    expect(fillReadingProblems(reading(WINDOW), { shots: [{ scene: 'scenes/w.html' }] }, scenes)).toEqual([]);
    // A helper whose window cannot be read counts as the whole frame.
    expect(fillReadingProblems(reading(FULL_REC), { shots: [{ scene: 'scenes/a.html' }] }, new Map([['scenes/a.html', SCREEN_SCENE]]))).toEqual([]);
  });

  it('warns when the main picture is much smaller, much larger or elsewhere', () => {
    const small = messages(fillReadingProblems(reading(WINDOW), { shots: [{ scene: 'scenes/a.html', items: [{ video: 'a.mp4', box: [0.4, 0.4, 0.2, 0.2] }] }] }, new Map([['scenes/a.html', '<p>x</p>']])));
    expect(small).toEqual(['shots[0]: Shot 1 was read as "a window on a designed ground"; its main picture (a screen) covers 52% of the frame, from 14% across and 14% down ([0.14, 0.14, 0.72, 0.72]); the re-make\'s main picture covers 4% of the frame, from 40% across and 40% down ([0.4, 0.4, 0.2, 0.2]): much smaller.']);
    const tiny = fillReadingProblems(reading({ layout: 'a small window', main: { box: [0.35, 0.25, 0.3, 0.5], kind: 'screen' } }), { shots: [{ footage: 'a.mp4' }] });
    expect(tiny[0]?.message).toContain('much larger');
    const away = fillReadingProblems(reading({ layout: 'a phone on the right', main: { box: [0.7, 0.2, 0.25, 0.6], kind: 'screen' } }), { shots: [{ scene: 's.html', items: [{ image: 'a.png', box: [0.05, 0.2, 0.25, 0.6] }] }] });
    expect(away[0]?.message).toContain('far from that place');
  });

  it('says nothing when the main picture is the same size in the same place, or small, or there is none', () => {
    expect(fillReadingProblems(reading(WINDOW), { shots: [{ scene: 's.html', items: [{ video: 'a.mp4', box: [0.1, 0.1, 0.8, 0.8] }] }] })).toEqual([]);
    expect(fillReadingProblems(reading({ layout: 'a title card' }), { shots: [{ card: { title: 'x' } }] })).toEqual([]);
    expect(fillReadingProblems(reading({ layout: 'a card with a sticker', main: { box: [0.7, 0.7, 0.2, 0.2], kind: 'picture' } }), { shots: [{ card: { title: 'x' } }] })).toEqual([]);
  });

  it('keeps the full-frame and designed warnings as they were', () => {
    const p = fillReadingProblems(reading({ ...FULL_REC, frame: 'full' }), { shots: [{ scene: 's.html', items: [{ video: 'a.mp4', box: [0.6, 0.1, 0.25, 0.8] }] }] });
    expect(messages(p)).toEqual(['shots[0]: Shot 1 was read as "a full-frame screen recording", full frame; it is built as a designed scene whose pictures cover 20% of the frame.']);
  });
});

describe('pictures a scene shows through its own HTML', () => {
  const page = (body: string): string => '<html><head><style>html, body { margin: 0; width: 1280px; height: 720px; }</style></head><body>' + body + '</body></html>';
  const IMG = page('<img src="../assets/page-01.png" style="width:100%">');
  const BG = page('<div style="background: url(\'../assets/page-01.webp\') center / cover"></div>');
  const SVG = page('<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg><style>@font-face { src: url(../fonts/a.woff2); } .x { background: url(data:image/png;base64,AAAA); }</style>');
  const VIDEO = page('<video src="../assets/rec.mp4"></video>');
  const moving: Shot = { ...FULL_REC, motion: 'page: scrolls down' };
  const fill = (name: string, html: string, reading: Shot) => fillReadingProblems({ shots: [reading], dropped: [] }, { shots: [{ scene: name }] }, new Map([[name, html]]));

  it('an <img> or a CSS url is a picture of unknown size: no "no picture" and no size warning', () => {
    expect(fill('a.html', IMG, FULL_REC)).toEqual([]);
    expect(fill('a.html', BG, FULL_REC)).toEqual([]);
    expect(fill('a.html', IMG, WINDOW)).toEqual([]);
    expect(fill('a.html', VIDEO, FULL_REC)).toEqual([]);
  });

  it('a scene with only an inline SVG, a font and a data: URL shows no picture', () => {
    expect(fill('a.html', SVG, FULL_REC).map((p) => p.message)).toHaveLength(1);
    expect(fill('a.html', SVG, FULL_REC)[0]?.message).toContain('no picture of the new subject');
  });

  it('a scene of only stills is built from a still; a <video> or the screen helper is not', () => {
    expect(fill('a.html', IMG, moving).map((p) => p.message.slice(0, 40))).toEqual(['Shot 1 was read with motion inside its p']);
    expect(fill('a.html', BG, moving)).toHaveLength(1);
    expect(fill('a.html', VIDEO, moving)).toEqual([]);
    expect(fill('a.html', IMG + scene(), moving)).toEqual([]);
    expect(fill('a.html', SVG, { ...moving, main: undefined })).toEqual([]);
  });

  it('a project\'s scene is read the same way', () => {
    const p: Project = { version: 1, canvas: { width: 1280, height: 720, fps: 30 }, materials: [], segments: [{ id: 'a', frames: 60, base: { scene: 'a.html' } }], tracks: [] };
    expect(projectReadingProblems(reading(FULL_REC), p, new Map([['a.html', IMG]]))).toEqual([]);
    expect(projectReadingProblems(reading(moving), p, new Map([['a.html', IMG]])).map((x) => x.at)).toEqual(['segments[0].base']);
    expect(projectReadingProblems(reading(moving), p, new Map([['a.html', VIDEO]]))).toEqual([]);
  });
});

describe('the main picture of a shot: size and place (project)', () => {
  const project = (base: Project['segments'][number]['base'], tracks: Project['tracks'] = []): Project => ({
    version: 1, canvas: { width: 1280, height: 720, fps: 30 }, materials: [{ id: 'm', kind: 'video', file: 'assets/m.mp4' }],
    segments: [{ id: 'a', frames: 60, base }], tracks,
  });
  const clip = (box: Box): Project['tracks'] => [{ id: 'clip', type: 'video', material: 'm', box, during: { segment: 'a' } }];

  it('warns about a scene with no picture and a window far smaller than the reference\'s', () => {
    expect(projectReadingProblems(reading(FULL_REC), project({ scene: 's.html' }), new Map([['s.html', '<p>slide</p>']])).map((p) => p.at)).toEqual(['segments[0].base']);
    const small = projectReadingProblems(reading(FULL_REC), project({ scene: 's.html' }, clip([0.4, 0.4, 0.3, 0.3])), new Map());
    expect(small[0]?.message).toContain('much smaller');
  });

  it('says nothing for the screen helper full frame, a window of the same size, or full-frame material', () => {
    expect(projectReadingProblems(reading(FULL_REC), project({ scene: 's.html' }), new Map([['s.html', scene()]]))).toEqual([]);
    expect(projectReadingProblems(reading(WINDOW), project({ scene: 's.html' }, clip([0.14, 0.14, 0.72, 0.72])), new Map())).toEqual([]);
    expect(projectReadingProblems(reading(FULL_REC), project({ material: 'm' }), new Map())).toEqual([]);
  });
});

describe('caption words: marked words and the reveal', () => {
  const lit: Shot = { layout: 'a recording', highlight: 'the key word in yellow', beats: [0, 1] };
  const slow: Shot = { layout: 'a recording', reveal: 'word by word as spoken' };

  it('warns once, naming the shots and the highlight, when no line marks a word', () => {
    const p = fillReadingProblems(reading(lit, { ...lit, beats: [2] }), { shots: [{ color: '#000' }, { color: '#000' }], captions: ['One', 'Two', 'Three'] });
    expect(messages(p)).toEqual(['captions: The reading says shots 1, 2 draw some caption words differently ("the key word in yellow"), and the fill\'s lines for their beats marks no word with asterisks.']);
    expect(p[0]?.fix).toContain('*like this*');
  });

  it('says nothing when a line marks a word, or the shots with a highlight cover no line', () => {
    expect(fillReadingProblems(reading(lit), { shots: [{ color: '#000' }], captions: ['One *Two*', 'Three'] })).toEqual([]);
    expect(fillReadingProblems(reading({ ...lit, beats: [5] }), { shots: [{ color: '#000' }], captions: ['One'] })).toEqual([]);
    expect(fillReadingProblems(reading({ layout: 'x', beats: [0] }), { shots: [{ color: '#000' }], captions: ['One'] })).toEqual([]);
  });

  it('warns when words appear one by one and the fill sets no captionReveal', () => {
    expect(messages(fillReadingProblems(reading(slow), { shots: [{ color: '#000' }] }))).toEqual(['captionReveal: The reading says the caption words appear one by one in shot 1 ("word by word as spoken"), and the fill sets no captionReveal.']);
    expect(fillReadingProblems(reading(slow), { shots: [{ color: '#000' }], captionReveal: 'words' })).toEqual([]);
    expect(fillReadingProblems(reading({ layout: 'x', reveal: 'the whole line at once' }), { shots: [{ color: '#000' }] })).toEqual([]);
    expect(fillReadingProblems(reading({ layout: 'x', reveal: '逐字出现' }), { shots: [{ color: '#000' }] })).toHaveLength(1);
  });

  it('checks a project\'s caption track the same way', () => {
    const track = (text: string, extra: Record<string, unknown> = {}): Project['tracks'] =>
      [{ id: 'subs', type: 'caption', box: [0.1, 0.85, 0.8, 0.1], cues: [{ text, during: { segment: 'a' } }], ...extra } as Project['tracks'][number]];
    const proj = (tracks: Project['tracks']): Project => ({ version: 1, canvas: { width: 1280, height: 720, fps: 30 }, materials: [], segments: [{ id: 'a', frames: 60, base: { color: '#000' } }], tracks });
    const rf = reading({ ...lit, reveal: 'letter by letter' });
    expect(projectReadingProblems(rf, proj(track('Plain line')), new Map()).map((p) => p.at)).toEqual(['tracks[0].cues', 'tracks[0].reveal']);
    expect(projectReadingProblems(rf, proj(track('Plain *line*', { reveal: 'words' })), new Map())).toEqual([]);
    expect(projectReadingProblems(rf, proj([]), new Map())).toEqual([]);
  });
});

describe('motion in a recording', () => {
  const moving: Shot = { ...FULL_REC, motion: 'page: scrolls down slowly 3.0-5.5 s' };
  const proj = (base: Project['segments'][number]['base'], tracks: Project['tracks']): Project => ({ version: 1, canvas: { width: 1280, height: 720, fps: 30 }, materials: [{ id: 'm', kind: 'image', file: 'a.png' }], segments: [{ id: 'a', frames: 60, base }], tracks });

  it('warns when a shot that scrolls is built from a picture or from stills in a scene', () => {
    const p = fillReadingProblems(reading(moving), { shots: [{ picture: 'assets/page.png', zoom: 0.03 }] });
    expect(p).toHaveLength(1);
    expect(p[0]?.message).toBe('Shot 1 was read with motion inside its picture: "page: scrolls down slowly 3.0-5.5 s"; it is built from a still picture, where nothing scrolls, zooms, changes page or moves a pointer.');
    expect(p[0]?.fix).toContain('popost video capture');
    const stills = fillReadingProblems(reading(moving), { shots: [{ scene: 's.html', items: [{ image: 'a.png', box: [0, 0, 1, 1] }] }] }, new Map([['s.html', '<p>x</p>']]));
    expect(stills.map((x) => x.at)).toEqual(['shots[0]']);
  });

  it('says nothing for a recording, the screen helper, an unread scene, or a shot that does not move', () => {
    expect(fillReadingProblems(reading(moving), { shots: [{ footage: 'assets/page.mp4' }] })).toEqual([]);
    expect(fillReadingProblems(reading(moving), { shots: [{ scene: 's.html', items: [{ image: 'a.png', box: [0, 0, 1, 1] }] }] }, new Map([['s.html', scene()]]))).toEqual([]);
    expect(fillReadingProblems(reading(moving), { shots: [{ scene: 's.html', items: [{ image: 'a.png', box: [0, 0, 1, 1] }] }] })).toEqual([]);
    expect(fillReadingProblems(reading(FULL_REC), { shots: [{ picture: 'assets/page.png' }] })).toEqual([]);
  });

  it('checks a project: stills without the helper warn, a video track does not', () => {
    const still: Project['tracks'] = [{ id: 'p', type: 'image', material: 'm', box: [0, 0, 1, 1], during: { segment: 'a' } }];
    expect(projectReadingProblems(reading(moving), proj({ scene: 's.html' }, still), new Map([['s.html', '<p>x</p>']])).map((p) => p.at)).toEqual(['segments[0].base']);
    expect(projectReadingProblems(reading(moving), proj({ scene: 's.html' }, still), new Map([['s.html', scene()]]))).toEqual([]);
    expect(projectReadingProblems(reading(moving), proj({ scene: 's.html' }, [{ id: 'v', type: 'video', material: 'm', box: [0, 0, 1, 1], during: { segment: 'a' } }]), new Map())).toEqual([]);
  });

  it('reads motion from the layers, in English and Chinese, and a pointer that moves', () => {
    const page = { id: 'page', kind: 'screen', box: [0, 0, 1, 1] as Box };
    expect(motionOf([{ ...page, moves: 'scrolls down' }])).toBe('page: scrolls down');
    expect(motionOf([{ ...page, enters: '页面向下滚动' }])).toBe('page: 页面向下滚动');
    expect(motionOf([{ ...page, moves: 'sits still' }])).toBeUndefined();
    expect(motionOf([page, { id: 'hand', kind: 'pointer', box: [0.5, 0.5, 0.05, 0.05], moves: 'glides to the button' }])).toBe('hand: glides to the button');
    expect(extrasOf({ design: [], content: [{ ...page, moves: 'zooms in' }], captions: { base: 'x', highlight: 'none', reveal: 'at once' } })).toEqual({ main: { box: page.box, kind: 'screen' }, motion: 'page: zooms in', reveal: 'at once' });
  });
});

describe('the reading file and the card', () => {
  it('reads captions.reveal and refuses it when it is not words', () => {
    const shot = (captions: unknown): unknown => ({ shots: [{ shot: 1, time: [0, 2], layout: 'x', layers: [{ id: 'g', kind: 'ground', box: [0, 0, 1, 1], look: 'flat', role: 'design' }], captions }] });
    const ok = readElements(shot({ base: 'white', highlight: 'yellow', reveal: 'word by word' }));
    expect(ok.elements.shots[0]?.captions).toEqual({ base: 'white', highlight: 'yellow', reveal: 'word by word' });
    expect(ok.problems).toEqual([]);
    expect(readElements(shot({ base: 'white', reveal: 3 })).problems.map((p) => p.level)).toEqual(['error']);
  });

  it('TEMPLATE.md has one short line when a shot has a highlight or a reveal', () => {
    const tpl = (captions?: { base: string; highlight?: string; reveal?: string }): Template => ({ shots: [{ elements: { layout: 'x', design: [], content: [], dropped: [], ...(captions ? { captions } : {}) } }] }) as unknown as Template;
    const lines = (t: Template): string[] => readingNotes(t).filter((l) => l.startsWith('Captions: '));
    expect(lines(tpl({ base: 'a', highlight: 'yellow' }))).toHaveLength(1);
    expect(lines(tpl({ base: 'a', reveal: 'word by word' }))[0]?.length).toBeLessThan(200);
    expect(lines(tpl({ base: 'a', highlight: 'none' }))).toEqual([]);
    expect(lines(tpl())).toEqual([]);
  });
});

describe('template check with a project says each warning once', () => {
  const w = (at: string, message: string, fix: string): Problem => ({ level: 'warning', at, message, fix });
  const fill = [w('shots[8]', 'Shot 9 is built as a designed scene.', 'Keep the layout kind.'), w('shots[4]', 'Shot 5 is built from a still picture.', 'Record it.')];

  it('leaves out a project warning about the same shot with the same fix, in other words', () => {
    const project = [w('segments[8].base', 'Shot 9 is built as a designed picture.', 'Keep the layout kind.'), w('segments[4].base', 'Shot 5 is built from still pictures.', 'Record it.')];
    expect(notSaidBy(fill, project)).toEqual([]);
  });

  it('keeps one about another shot, one with another fix, and one in the same words is left out', () => {
    const project = [w('segments[3].base', 'Shot 4 is built as a designed picture.', 'Keep the layout kind.'), w('segments[8].base', 'Shot 9 shows the platform.', 'Remove it.'), w('tracks[2]', 'Shot 5 is built from a still picture.', 'Other.')];
    expect(notSaidBy(fill, project).map((p) => p.at)).toEqual(['segments[3].base', 'segments[8].base']);
  });
});
