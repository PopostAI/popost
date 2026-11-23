/**
 * What a shot most likely is (describe/kind.ts), read from clips made with ffmpeg and measured by the real
 * measurement: a page scrolled past many small lines on a light ground, a designed card whose elements enter on a flat
 * ground, a textured picture the camera pans over, and a flat colour that says nothing. The text a reader would find
 * is written by hand, as it would read these pictures.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import { describeReference } from '../../src/video/describe/index';
import { shotLooks } from '../../src/video/describe/kind';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { measureVideo } from '../../src/video/measure/index';
import { templateCard } from '../../src/video/template/card';
import { slotsOf } from '../../src/video/template/slots';
import { templateFrom } from '../../src/video/template/structure';
import type { TextCue, TextTrack } from '../../src/video/text/types';
import type { Measure, ShotMeasure } from '../../src/video/types';

const rt = await createDiskRuntime();
const ffmpeg = await hasFfmpeg(rt);
afterAll(async () => { await rt.cleanup(); });

const W = 320, H = 180, FPS = 30;
/** Lines of "text" at uneven gaps, and a heading now and then, on a light page 1200 px tall, scrolled at 50 px a second. */
const lineY = Array.from({ length: 44 }, (_x, k) => 20 + 24 * k + ((k * 7) % 11)).filter((y) => y < 1180);
const page = 'color=c=0xfafafa:s=' + W + 'x1200:r=' + FPS + ':d=3,' + lineY.map((y, k) => 'drawbox=x=' + (24 + ((k * 5) % 9)) + ':y=' + y + ':w=' + (k % 6 === 0 ? 200 : 90 + ((k * 37) % 170)) + ':h=' + (k % 6 === 0 ? 12 : 6) + ':color=0x2a2a2a:t=fill').join(',') + ",crop=" + W + ':' + H + ":0:'t*50'";
/** A white card and an orange label that enter one after the other on a flat navy ground. */
const card = 'color=c=0x1d2b53:s=' + W + 'x' + H + ':r=' + FPS + ":d=3,drawbox=x=60:y=40:w=200:h=60:color=0xfdfdfd:t=fill:enable='gte(t,0.8)',drawbox=x=60:y=115:w=120:h=24:color=0xe76f51:t=fill:enable='gte(t,1.4)'";
/** A smooth field of many colours, panned over to the right. */
const filmed = "nullsrc=s=640x360:r=" + FPS + ":d=3,format=rgb24,geq=r='128+100*sin(X/7)*cos(Y/9)':g='128+100*sin(X/11+Y/5)':b='128+100*cos(X/13+Y/17)',crop=" + W + ':' + H + ":'40+t*50':'30+t*10'";
const flat = 'color=c=0x3060a0:s=' + W + 'x' + H + ':r=' + FPS + ':d=3';

const cue = (role: TextCue['role'], start: number, y: number, size: number, text: string): TextCue =>
  ({ text, start, end: start + 70, box: [0.08, y, 0.6, size], role, size, samples: 12, confidence: 0.95 });
/** What a reader finds: twelve small lines of the page, a title and a label on the card, nothing on the other two. */
const text: TextTrack = {
  step: 6, sampled: 60,
  cues: [
    ...Array.from({ length: 12 }, (_x, k) => cue('in-picture', 4, 0.05 + 0.07 * k, 0.025, 'line ' + k)),
    cue('title', 100, 0.25, 0.09, 'Why fast pages win'), cue('label', 110, 0.65, 0.06, 'WEB PERFORMANCE'),
  ],
};

let m: Measure;
const shot = (k: number): ShotMeasure => m.shots[k] as ShotMeasure;
beforeAll(async () => {
  if (!ffmpeg) return;
  const video = rt.path.join(rt.dir, 'kinds.mp4');
  const inputs = [page, card, filmed, flat].flatMap((s) => ['-f', 'lavfi', '-i', s]);
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0,format=yuv420p[v]', '-map', '[v]', '-c:v', 'libx264', '-crf', '18', video]);
  m = await measureVideo(rt, video);
}, 120_000);

describe.skipIf(!ffmpeg)('what a shot most likely is', () => {
  it('finds the four shots', () => {
    expect(m.shots.map((s) => [s.start, s.end])).toEqual([[0, 90], [90, 180], [180, 270], [270, 360]]);
  });

  it('calls a scrolled page of many small lines on a light ground a recording of a page or an app', () => {
    const l = shotLooks(shot(0), text.cues);
    expect(l?.kind, JSON.stringify({ l, shot: shot(0) })).toBe('page');
    expect(l?.facts[0]).toBe('12 small lines of text, median height 3%');
    expect(l?.facts[1]).toMatch(/^a flat light ground, #f[0-9a-f]{5} over \d+%$/);
    expect(l?.facts[2]).toMatch(/^the picture moves vertically \d+\.\d%\/s, as a scroll does$/);
  });

  it('calls a few large words on a flat ground with elements that enter a designed picture', () => {
    const l = shotLooks(shot(1), text.cues);
    expect(l?.kind, JSON.stringify({ l, shot: shot(1) })).toBe('design');
    expect(l?.facts).toEqual(['2 large lines of text, up to 9% of the height', expect.stringMatching(/^a flat ground, #1[0-9a-f]{5} over \d+%$/), expect.stringMatching(/^\d elements? enters?$/)]);
  });

  it('calls a textured picture with little text and a moving camera filmed or photographic material', () => {
    const l = shotLooks(shot(2), text.cues);
    expect(l?.kind, JSON.stringify({ l, shot: shot(2) })).toBe('filmed');
    expect(l?.facts, JSON.stringify(shot(2))).toEqual(['little text (0 lines)', expect.stringMatching(/^a textured picture, no colour over \d+%$/), expect.stringMatching(/^the camera pans \d+\.\d%\/s$/)]);
  });

  it('says nothing when the facts do not say: a flat colour, or facts of two kinds at once', () => {
    expect(shotLooks(shot(3), text.cues)).toBeUndefined();
    // The card's title over the textured picture: two facts of a designed picture against the ground of a filmed one.
    const titled = { ...shot(2), events: shot(1).events };
    expect(shotLooks(titled, [...text.cues, cue('title', 190, 0.3, 0.09, 'A title')])).toBeUndefined();
    // Without a reader the text facts are unknown, and the flat colour still says nothing.
    expect(shotLooks(shot(3), undefined)).toBeUndefined();
  });

  it('writes the line into shots/NN.md and the template card, and nothing where it cannot tell', () => {
    const d = describeReference(m, text, 'kinds');
    expect(d.files['shots/01.md']).toMatch(/\n- Most likely: a recording of a page or an app \(12 small lines of text, median height 3%; a flat light ground, .+; the picture moves vertically .+, as a scroll does\)\. The pictures confirm or correct this\.\n/);
    expect(d.files['shots/02.md']).toContain('\n- Most likely: a designed picture (2 large lines of text, up to 9% of the height; ');
    expect(d.files['shots/03.md']).toContain('\n- Most likely: filmed or photographic material (little text (0 lines); a textured picture');
    expect(d.files['shots/04.md']).not.toContain('Most likely');
    const t = templateFrom({ measure: m, text, name: 'kinds', label: 'synthetic', hash: 'sha256:0' });
    expect(t.shots.map((s) => s.looks?.kind)).toEqual(['page', 'design', 'filmed', undefined]);
    const shots = templateCard(t, slotsOf(t, undefined, {})).text.split('\n').filter((l) => /^\d+\. shots\[/.test(l));
    expect(shots[0]).toContain('. Most likely a recording of a page or an app (12 small lines of text');
    expect(shots[3]).not.toContain('likely');
  });
});
