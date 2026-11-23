/**
 * Text over a recorded page (b1/b2: agents dropped the big sticker words laid over screen recordings). On a frame with
 * many lines a line used to be in-picture whatever its size, near-identical page lines were counted once per cue and
 * called watermarks, and captions read a little small were lost. Now: a large line laid on stays a title (a page's own
 * headline that scrolls with it does not), a watermark is never three at once, and a caption set like the band's
 * others keeps its role on a crowded frame.
 */
import { describe, expect, it } from 'vitest';
import { buildCues } from '../../src/video/text/cues';
import type { TextLine, TextSample } from '../../src/video/text/types';

const line = (text: string, x: number, y: number, w: number, h: number, confidence = 0.95): TextLine => ({ text, confidence, box: [x, y, w, h] });

/** 75 samples, one every 6 frames at 30 fps (15 s): a page scrolling up 0.4% of the height a sample under everything. */
const COUNT = 75;
const pageLines = (k: number): TextLine[] => Array.from({ length: 40 }, (_, i) => ({ i, y: 0.1 + 0.06 * i - 0.004 * k }))
  .filter(({ y }) => y > 0.08 && y < 0.84).map(({ i, y }) => line('设置选项' + (i + 1) + '：打开后可以调整这一项的默认行为', 0.12, y, 0.37, 0.032, 0.9));
const CAPTIONS = ['打开设置页面找到这个选项', '把它打开就可以了', '账户这里也有一个开关', '很多人都不知道', '通知设置做完之后', '每天能省下半小时'];
const caption = (k: number): TextLine | undefined => {
  const t = CAPTIONS[Math.floor(k / 12.5)];
  if (!t) return undefined;
  // The first and the last are read a fifth smaller, as the reader read them over a page.
  const h = t === CAPTIONS[0] || t === CAPTIONS[5] ? 0.04 : 0.05, w = 0.028 * t.length;
  return line(t, 0.5 - w / 2, 0.88, w, h);
};
const samples: TextSample[] = Array.from({ length: COUNT }, (_, k) => ({
  frame: k * 6,
  lines: [
    ...pageLines(k),
    ...(k >= 4 && k <= 24 ? [line('超简单', 0.06, 0.2, 0.34, 0.13)] : []),
    ...(k >= 10 && k <= 24 ? [line('搞定', 0.3, 0.6, 0.26, 0.14)] : []),
    // the page's own headline, large, scrolling with it
    ...(k >= 30 && k <= 60 ? [line('账户与安全中心', 0.12, 0.5 - 0.004 * (k - 30), 0.5, 0.07)] : []),
    line('@someone', 0.8, 0.04, 0.15, 0.035),
    ...[caption(k)].filter((l): l is TextLine => l !== undefined),
  ],
}));

describe('text over a recorded page', () => {
  const cues = buildCues(samples, { step: 6, total: COUNT * 6, fps: 30 }).cues;
  const roles = (text: string): string[] => [...new Set(cues.filter((c) => c.text === text).map((c) => c.role))];

  it('keeps large words laid on the page as titles, and says why', () => {
    expect(roles('超简单')).toEqual(['title']);
    expect(roles('搞定')).toEqual(['title']);
    expect(cues.find((c) => c.text === '超简单')?.why).toMatch(/laid over a page: \d+\.\d times the lines around it/);
  });

  it('leaves a page\'s own headline that scrolls with the page in the picture', () => {
    // Read as one line whose box grew as it moved: 4% of the height up while it was on screen.
    const headline = cues.filter((c) => c.text === '账户与安全中心');
    expect(headline.every((c) => c.box[3] > 1.5 * c.size)).toBe(true);
    expect(roles('账户与安全中心')).toEqual(['in-picture']);
  });

  it('calls no page line a watermark, and the one watermark still one', () => {
    expect(cues.filter((c) => c.role === 'watermark').map((c) => c.text)).toEqual(['@someone']);
    expect(cues.filter((c) => c.text.startsWith('设置选项')).every((c) => c.role === 'in-picture')).toBe(true);
  });

  it('keeps every caption, those read smaller over the page too', () => {
    for (const t of CAPTIONS) expect(roles(t), t).toEqual(['caption']);
  });
});
