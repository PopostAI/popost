/**
 * How many characters a caption line may have: measured by laying out probe text in the real band with the real
 * style in Chrome (the page's layout facts, as checkLayout uses them), for full-width (CJK) and for Latin text
 * separately. Without Chrome the capacity is estimated from the box and the font size, and says so.
 */
import { BrowserUnavailableError } from '../../render/browser';
import type { Runtime } from '../../runtime';
import { withTempDir } from '../host';
import type { Box, Canvas, Project, TextStyle } from '../types';
import { DEFAULT_LINE_HEIGHT } from '../presets/text-styles';
import { openSession } from '../render/session';
import type { LayoutFact } from '../page/contract';
import type { Capacity } from './types';

/** Full-width characters: CJK ideographs and radicals, kana, hangul, CJK and full-width punctuation, emoji. */
const WIDE = /[\u{1100}-\u{115f}\u{2e80}-\u{303f}\u{3040}-\u{30ff}\u{3100}-\u{9fff}\u{ac00}-\u{d7af}\u{f900}-\u{faff}\u{fe30}-\u{fe4f}\u{ff00}-\u{ff60}\u{ffe0}-\u{ffe6}\u{1f300}-\u{1faff}\u{20000}-\u{3134f}]/u;

export const charsOf = (text: string): string[] => Array.from(text.trim());
export const isWide = (ch: string): boolean => WIDE.test(ch);

/** Full-width characters and the others (spaces included) of a line. */
export const countScripts = (text: string): { wide: number; narrow: number } => {
  const chars = charsOf(text);
  const wide = chars.filter(isWide).length;
  return { wide, narrow: chars.length - wide };
};

/** The script of a text: CJK when full-width characters are at least as many as the other visible ones. */
export const scriptOf = (text: string): 'cjk' | 'latin' => {
  const { wide } = countScripts(text);
  const visible = charsOf(text).filter((c) => !/\s/.test(c)).length;
  return wide > 0 && wide >= visible - wide ? 'cjk' : 'latin';
};

/**
 * The share of a band a line takes: a full-width character takes 1/cjk of it, any other 1/latin. A line fits when this
 * is at most 1. Mixed lines ("AI 带货") are counted this way too; the swap test's layout check is the final word.
 */
export const usageOf = (text: string, cap: Pick<Capacity, 'cjk' | 'latin'>): number => {
  const { wide, narrow } = countScripts(text);
  return (wide ? wide / Math.max(cap.cjk, 1e-9) : 0) + (narrow ? narrow / Math.max(cap.latin, 1e-9) : 0);
};

/** Probe text: everyday sentences, so that Latin word wrapping and CJK punctuation rules are what real lines meet. */
export const PROBE_TEXT = {
  cjk: [
    '今天我们聊一聊怎样在三分钟里做出一条好看的短视频，先选题，再拍摄和剪辑，最后发布并复盘。每一步都有方法，也有常见的坑，跟着做就不会走弯路，第一次也能做好。',
    '很多人以为好内容靠运气，其实靠的是结构：开头一句话抓住人，中间三个要点讲清楚，结尾告诉观众下一步做什么。照着这个顺序写，你的视频会更容易被看完。',
  ],
  latin: [
    'Here is how to make a short video that people watch to the end: pick one idea, show it in the first second, cut every line that does not help, and end with one clear thing to do next time.',
    'Three small things changed my mornings this year. I wake up at the same time every day, I drink a glass of water before coffee, and I write down the one task that would make the day count.',
    'Most people think good videos need luck, but they need a plan: a strong first line, three points that are easy to follow, and an ending that tells the viewer exactly what to do after watching.',
  ],
} as const;

/** The first n characters of probe text j of a script (repeated when it is too short), without trailing spaces. */
export const probeText = (script: 'cjk' | 'latin', j: number, n: number): string => {
  const list = PROBE_TEXT[script];
  const base = list[j % list.length] ?? '';
  const long = Array.from({ length: Math.ceil(n / Math.max(1, base.length)) + 1 }, () => base).join(script === 'cjk' ? '' : ' ');
  return Array.from(long).slice(0, n).join('').trimEnd();
};

export interface Band { canvas: Canvas; box: Box; style: TextStyle }

const linesOf = (b: Band): number => {
  const size = b.style.size ?? 0.045;
  return Math.max(0, Math.floor((b.box[3] + 1e-9) / (size * (b.style.lineHeight ?? DEFAULT_LINE_HEIGHT))));
};

/** Average advance of a Latin character (spaces included) in a bold sans-serif face, as a fraction of the font size. */
const LATIN_ADVANCE = 0.55;
/** Share of a Latin line that word wrapping leaves usable, on average. */
const WRAP_LOSS = 0.9;

export const estimateCapacity = (b: Band): Capacity => {
  const sizePx = (b.style.size ?? 0.045) * b.canvas.height;
  const width = b.box[2] * b.canvas.width;
  const spacing = (b.style.letterSpacing ?? 0) * sizePx;
  const lines = linesOf(b);
  return {
    cjk: lines * Math.floor(width / (sizePx + spacing)),
    latin: Math.floor(lines * Math.floor(width / (sizePx * LATIN_ADVANCE + spacing)) * WRAP_LOSS),
    lines, measured: false,
    method: 'estimated from the box and the font size (no Chrome): full-width characters 1 em, Latin ' + LATIN_ADVANCE + ' em with ' + Math.round((1 - WRAP_LOSS) * 100) + '% lost to wrapping',
  };
};

interface Probe { script: 'cjk' | 'latin'; j: number; n: number; text: string }

const probesOf = (est: Capacity): Probe[] => {
  const most = (n: number): number => Math.ceil(n * 2) + 8;
  return (['cjk', 'latin'] as const).flatMap((script) => PROBE_TEXT[script].flatMap((_t, j) =>
    Array.from({ length: most(script === 'cjk' ? est.cjk : est.latin) }, (_x, i) => ({ script, j, n: i + 1, text: probeText(script, j, i + 1) }))));
};

/** One caption track per band, each with its probes one frame apart; layout does not depend on time. */
const probeProject = (bands: Band[], probes: Probe[][]): Project => {
  const frames = Math.max(1, ...probes.map((p) => p.length));
  return {
    version: 1, canvas: bands[0]?.canvas ?? { width: 1080, height: 1920, fps: 30 }, materials: [],
    segments: [{ id: 'probe', frames, base: { color: '#000000' } }],
    tracks: bands.map((b, k) => ({ id: 'probe-' + k, type: 'caption', box: b.box, style: b.style, cues: (probes[k] ?? []).map((p, i) => ({ text: p.text, during: { segment: 'probe', from: i, to: i + 1 } })) })),
  };
};

const METHOD = 'measured in Chrome: prefixes of ' + PROBE_TEXT.cjk.length + ' CJK and ' + PROBE_TEXT.latin.length + ' English probe texts laid out in the box with its style; the smallest length before the first that does not fit';

/** The capacity of one band from its probes' layout facts. */
const capacityFrom = (probes: Probe[], facts: Map<string, LayoutFact>, k: number): Capacity => {
  const of = (script: 'cjk' | 'latin'): { cap: number; lines: number } => {
    const all = PROBE_TEXT[script].map((_t, j) => {
      const mine = probes.map((p, i) => ({ p, f: facts.get('probe-' + k + '#' + i) })).filter((x) => x.p.script === script && x.p.j === j);
      const bad = mine.find((x) => !x.f?.fits);
      const cap = bad ? bad.p.n - 1 : mine.length;
      return { cap, lines: Math.max(0, ...mine.filter((x) => x.p.n <= cap).map((x) => x.f?.lines ?? 0)) };
    });
    return { cap: Math.min(...all.map((x) => x.cap)), lines: Math.max(...all.map((x) => x.lines)) };
  };
  const cjk = of('cjk'), latin = of('latin');
  return { cjk: cjk.cap, latin: latin.cap, lines: Math.max(cjk.lines, latin.lines, 0), measured: true, method: METHOD };
};

/**
 * The capacities of boxes of text on one canvas, measured: every prefix of every probe text is laid out in each box
 * (one page, one layout call), and the capacity of a probe text is the length before its first prefix that does not
 * fit. A script's capacity is the smallest over its probe texts, so any line of that length fits as the probes did.
 */
export const measureCapacities = async (rt: Runtime, bands: Band[]): Promise<Capacity[]> => {
  const est = bands.map(estimateCapacity);
  if (!bands.length) return est;
  const probes = est.map(probesOf);
  return withTempDir(rt, 'popost-video-capacity-', async (dir) => {
    await rt.fs.writeFile(rt.path.join(dir, 'video.json'), JSON.stringify(probeProject(bands, probes)));
    // Without a browser the capacities stay estimates, and each says so (estimateCapacity's method).
    const session = await openSession(rt, dir, { scale: 0.25 }).catch((e: unknown) => {
      if (e instanceof BrowserUnavailableError) return undefined;
      throw e;
    });
    if (!session) return est;
    const facts = await session.layout().finally(() => session.close());
    const byId = new Map(facts.map((f) => [f.id, f] as const));
    return probes.map((p, k) => capacityFrom(p, byId, k));
  });
};

export const measureCapacity = async (rt: Runtime, b: Band): Promise<Capacity> => (await measureCapacities(rt, [b]))[0] ?? estimateCapacity(b);
