/**
 * The scene check's findings that look at a shot as a viewer does: text on screen too briefly to read or never in a short shot,
 * a picture that is nearly all ground, numbers no file of the project holds. Synthetic scenes only; the numbers'
 * reading is tested on its own first (no browser needed).
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import { hasFfmpeg } from '../../src/video/media/ffmpeg';
import { checkScenes, type SceneCheck } from '../../src/video/scene/check';
import { figuresIn, untraced, valuesIn } from '../../src/video/scene/numbers';
import type { Project } from '../../src/video/types';
import { projectDir } from './make-fixtures';

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ready = (await hasFfmpeg(rt)) && hasChrome();

describe('scene check: numbers and where they come from', () => {
  it('reads figures with their unit or sign, and leaves out years, indexes, lone digits, times and names', () => {
    expect(figuresIn('59K stars, $59K, 3.5% churn, 12,000 users, 2万 用户, x3 faster').map((f) => f.shown)).toEqual(['59K', '$59K', '3.5%', '12,000', '2万', 'x3']);
    expect(figuresIn('Step 1 2 3 · 01 02 · in 2026 · 2026年 · 12:30 · 16:9 · 2026-11-21 · COVID-19 · H264 · 5G · 4th')).toEqual([]);
    expect(figuresIn('增长35%达到1.2亿').map((f) => f.shown)).toEqual(['35%', '1.2亿']);
  });

  it('finds a figure written differently in a source: separators, K and 万, a currency on either side, a rounding', () => {
    const values = valuesIn(['The repo has 59,213 stars and 12000 users; churn is 3.46%; 5.9万 downloads; revenue 59 USD; 1.2 million views.']);
    const missing = (shown: string): string[] => untraced([shown], values).map((f) => f.shown);
    expect(missing('12,000 users')).toEqual([]);
    expect(missing('59,213 stars · 59K stars · 6万 · 59元 · $59 · 3.5% · 1,200,000 · 1.2M')).toEqual([]);
    expect(missing('3.4% · 12,001 · 12.5K · 77% · $60K')).toEqual(['3.4%', '12,001', '12.5K', '77%', '$60K']);
  });
});

const W = 640, H = 360, FPS = 30;
const page = (body: string, css: string): string =>
  '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:' + W + 'px;height:' + H + 'px;overflow:hidden;background:#101828;font-family:sans-serif}'
  + '.t{position:absolute;left:40px;top:140px;font:700 40px sans-serif;color:#fff}@keyframes in{from{opacity:0}to{opacity:1}}' + css + '</style></head><body>' + body + '</body></html>';
/** A text whose fade-in starts at delay seconds and lasts 0.1 s. */
const entering = (text: string, delay: number): string => page('<div class="t" style="animation:in 0.1s linear ' + delay + 's both">' + text + '</div>', '');
/** Three items of a list, the first two at 0.5 s and 2 s, the last at last seconds, each fading in for 0.1 s. */
const list = (last: number): string => page(([[0.5, 'Measure first'], [2, 'Fix the slowest page'], [last, 'Measure again']] as [number, string][]).map(([delay, text], i) =>
  '<div class="t" style="top:' + (60 + i * 80) + 'px;animation:in 0.1s linear ' + delay + 's both">' + text + '</div>').join(''), '');
/** A gradient ground with three soft blurred blobs on it, and nothing else. */
const BLOBS = page('<div class="b b1"></div><div class="b b2"></div><div class="b b3"></div>',
  'body{background:linear-gradient(160deg,#1b2350,#090b18)}.b{position:absolute;border-radius:50%;filter:blur(45px)}'
  + '.b1{left:10%;top:15%;width:35%;height:45%;background:#7c3aed;opacity:.55}.b2{left:55%;top:40%;width:40%;height:50%;background:#06b6d4;opacity:.45}.b3{left:30%;top:60%;width:25%;height:30%;background:#f472b6;opacity:.4}');
/** The same ground with a white card and its text on it. */
const CARD = BLOBS.replace('</body>', '<div class="card"><div class="l">RELEASE NOTES</div><div class="h">Ship it on Friday</div></div></body>')
  .replace('</style>', '.card{position:absolute;left:150px;top:90px;width:340px;padding:20px;background:#fff;border-radius:10px}.l{font:700 13px sans-serif;color:#e76f51}.h{font:800 28px sans-serif;color:#1d2b53}</style>');

const SCENES: Record<string, string> = {
  'scenes/late.html': entering('Offer ends soon', 0.5),
  'scenes/early.html': entering('Offer ends soon', 0.16),
  'scenes/shared.html': entering('Join the beta', 1),
  'scenes/blobs.html': BLOBS,
  'scenes/card.html': CARD,
  'scenes/traced.html': page('<div class="t">12,000 users</div><div class="t" style="top:200px">59,213 stars</div>', ''),
  'scenes/invented.html': page('<div class="t">Churn fell to 3.5%</div><div class="t" style="top:200px">12,000 users</div>', ''),
  // Late too, though fully opaque all along: still below the edge of the box that hides its overflow, then still a speck.
  'scenes/masked.html': page('<div style="position:absolute;left:40px;top:140px;height:56px;overflow:hidden"><div class="t" style="position:static;animation:up 0.1s linear 0.48s both">Rises from below</div></div>', '@keyframes up{from{transform:translateY(130%)}to{transform:none}}'),
  'scenes/grown.html': page('<div class="t" style="animation:grow 0.1s linear 0.48s both">Grows from a speck</div>', '@keyframes grow{from{transform:scale(0.1)}to{transform:none}}'),
  // Items arriving with the voice over a 6 s shot: the last one at 3.5 s stays 2.5 s (fine), at 5 s only 1 s (too briefly).
  'scenes/list.html': list(3.5),
  'scenes/list-late.html': list(5),
};

const seg = (id: string, scene: string, frames: number): Project['segments'][number] => ({ id, frames, base: { scene } });
const PROJECT: Project = {
  version: 1, canvas: { width: W, height: H, fps: FPS }, materials: [],
  segments: [
    seg('late', 'scenes/late.html', 24), seg('early', 'scenes/early.html', 24), seg('long', 'scenes/shared.html', 90), seg('short', 'scenes/shared.html', 24),
    seg('blobs', 'scenes/blobs.html', 30), seg('card', 'scenes/card.html', 30), seg('traced', 'scenes/traced.html', 30), seg('invented', 'scenes/invented.html', 30),
    seg('masked', 'scenes/masked.html', 24), seg('grown', 'scenes/grown.html', 24),
    seg('list', 'scenes/list.html', 180), seg('list-late', 'scenes/list-late.html', 180),
  ],
  tracks: [{ id: 'subs', type: 'caption', box: [0.05, 0.85, 0.9, 0.1], cues: [
    { text: 'Over 12000 people use it', during: { segment: 'traced', from: 0, to: 30 } },
    { text: 'Up 77% this year', during: { segment: 'invented', from: 0, to: 30 } },
  ] }],
};

describe.skipIf(!ready)('scene check: what a viewer sees', () => {
  let dir = '';
  let r: SceneCheck;
  const at = (k: number): string => 'segments[' + k + '].base.scene';
  const said = (k: number): string => r.problems.filter((p) => p.at === at(k)).map((p) => p.level + ': ' + p.message + ' Fix: ' + (p.fix ?? '')).join('\n');
  beforeAll(async () => {
    dir = await projectDir('scene-findings-', PROJECT);
    await mkdir(path.join(dir, 'scenes'));
    await mkdir(path.join(dir, 'source'));
    for (const [file, html] of Object.entries(SCENES)) await writeFile(path.join(dir, file), html);
    await writeFile(path.join(dir, 'source', 'notes.md'), 'From the project page: the tool has 12000 users and 59,213 stars.\n');
    r = await checkScenes(rt, dir, undefined, { shotsDir: 'shots' });
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('warns when a short shot shows its text too briefly to read, and says when it comes and how long it stays', () => {
    expect(said(0)).toMatch(/warning: In segment "late" \("scenes\/late.html"\), a shot of 0\.80 s, "Offer ends soon" becomes visible only at about 0\.\d\d s and stays 0\.\d\d s: too briefly to read it \(less than half the shot and less than 1\.5 s\)\. At 0\.40 s it cannot be seen yet; half-way through: picture shots[\\/]segment-01-f12\.png\./);
    expect(said(0)).toContain('Let it be visible by 0.40 s here, so that it stays half the shot or more');
    expect(said(1)).not.toMatch(/becomes visible|nearly empty/);
    // Opaque all along, but behind the edge of a box that hides its overflow, then too small to read.
    expect(said(8)).toMatch(/"Rises from below" becomes visible only at about 0\.5\d s and stays 0\.2\d s/);
    expect(said(9)).toMatch(/"Grows from a speck" becomes visible only at about 0\.5\d s and stays 0\.2\d s/);
  });

  it('lets the items of a list arrive with the voice over a long shot, as long as the last one stays long enough to read', () => {
    // 6 s: the last item at 3.5 s, after the middle, stays 2.5 s; at 5 s it stays about 1 s, less than 1.5 s and half the shot.
    expect(said(10)).toBe('');
    expect(said(11)).toMatch(/^warning: In segment "list-late" \("scenes\/list-late.html"\), a shot of 6\.00 s, "Measure again" becomes visible only at about 5\.\d\d s and stays 0\.\d\d s: too briefly to read it \(less than half the shot and less than 1\.5 s\)\. At 4\.50 s it cannot be seen yet/);
    expect(said(11)).toContain('Let it be visible by 4.50 s here, so that it stays 1.5 s or more');
  });

  it('warns when a shot never shows a text that a longer segment with the same scene file shows', () => {
    expect(said(3)).toMatch(/In segment "short" \("scenes\/shared.html"\), a shot of 0\.80 s, "Join the beta" is never visible \(picture shots[\\/]segment-04-f\d+\.png\), though segment "long" \(3\.00 s\) shows it with the same scene file/);
    expect(said(2)).toBe('');
  });

  it('measures how much of the middle picture stands out from its ground, and warns about one that is nearly all ground', () => {
    const fill = (id: string): number => r.scenes.find((s) => s.id === id)?.fill ?? -1;
    expect(fill('blobs')).toBeLessThan(0.02);
    expect(fill('card')).toBeGreaterThan(0.1);
    expect(said(4)).toMatch(/warning: Half-way through segment "blobs" \("scenes\/blobs.html"\) the picture is nearly empty: [\d.]+% of it stands out from its ground, and it shows no text \(picture shots[\\/]segment-05-f177\.png\)\./);
    expect(said(5)).toBe('');
    expect(r.scenes.find((s) => s.id === 'card')).toMatchObject({ at: 'segments[5]', scene: 'scenes/card.html', seconds: 1, frames: [199, 207, 214], pictures: [path.join('shots', 'segment-06-f199.png'), path.join('shots', 'segment-06-f207.png'), path.join('shots', 'segment-06-f214.png')] });
  });

  it('warns about numbers that no file of the project holds, in a scene and in a caption, and not about those it holds', () => {
    expect(said(6)).toBe('');
    expect(said(7)).toMatch(/^warning: The numbers shown in segment "invented" \("scenes\/invented.html"\) are found in no file of the project: 3\.5% \(picture shots[\\/]segment-08-f\d+\.png\)\. Fix: If they come from a source, save that text into the project/);
    const captions = r.problems.filter((p) => p.at.startsWith('tracks['));
    expect(captions.map((p) => p.at + ' ' + p.message)).toEqual(['tracks[0].cues[1].text The caption "Up 77% this year" (segment "invented") shows numbers found in no file of the project: 77%.']);
    expect(r.problems.every((p) => p.level === 'warning')).toBe(true);
  });
});
