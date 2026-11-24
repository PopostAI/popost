/**
 * Numbers a video shows that no file of the project holds: a figure on a dashboard or in a caption that a model made
 * up. The figures are read from the text a scene shows and from the captions, and looked for in the text files the
 * project keeps outside its scenes (sources the agent saved, the request, an outline). Matching is lenient about how
 * a number is written (12,000 = 12000 = 12K = 1.2万, a currency sign before or after, a percent sign) and about
 * rounding (59K and 59,213; 35% and 35.4%), so a warning means the value itself is nowhere. Pure, except
 * projectTexts, which reads the files.
 */
import type { Runtime } from '../../runtime';

/** A number as shown: as written, its value, and how far a source's value may be from it (a rounding to it). */
export interface Figure { shown: string; value: number; tolerance: number }

/** Multipliers written after a number. */
const MULTIPLIERS: Readonly<Record<string, number>> = {
  k: 1e3, m: 1e6, b: 1e9, bn: 1e9, thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12,
  千: 1e3, 万: 1e4, 十万: 1e5, 百万: 1e6, 千万: 1e7, 亿: 1e8, 万亿: 1e12,
};
/** Letters a number glued to is part of a word (H264, mp4); Chinese characters around a number are not. */
const LATIN = '\\p{Script=Latin}\\p{Script=Greek}\\p{Script=Cyrillic}';
const SIGNS = '%|‰|倍|[x×](?![' + LATIN + '])|[$€£¥￥₩₹]|元|美元|块';
const WORDS = '十万|百万|千万|万亿|[千万亿]|(?:thousand|million|billion|trillion)s?\\b|[kmb]n?(?![' + LATIN + '])';
/**
 * A number in a text: what stands before it (a currency, a times sign, a plus or minus), its digits (thousands
 * separated by commas, a decimal part), and what follows it: a sign or a multiplier (a space allowed), or a unit of
 * letters glued to it (12GB, 4th).
 */
const NUMBER = new RegExp('(?<![' + LATIN + '\\p{N}_.,])((?:US|HK|S|A|C)?[$€£¥￥₩₹]\\s?|(?:RMB|USD|EUR|GBP|CNY|SGD)\\s?|[x×]\\s?|[+\\-−±~≈])?'
  + '(\\d{1,3}(?:,\\d{3})+|\\d+)(\\.\\d+)?(?![\\d,.]\\d)(\\s?(?:' + SIGNS + '|' + WORDS + ')|[' + LATIN + ']+)?', 'giu');
const SIGN = new RegExp('^(?:' + SIGNS + ')$', 'iu');
/** Just before a number: a digit and a separator (the later part of a time, a ratio, a date), or a name and a hyphen. */
const AFTER_PART = new RegExp('(?:\\d[:/.\\-]|[' + LATIN + ']-)$', 'u');
/** Just after a number: a separator and a digit (the earlier part of a time, a ratio, a date). */
const BEFORE_PART = /^[:/-]\d/;

interface Read {
  /** As written, without a unit of letters or a word that is not a multiplier. */
  shown: string;
  /** The digits as a number, before any multiplier. */
  base: number;
  /** What follows, lower case, its multiplier (1 for none), and whether a space stands between them. */
  after: string;
  multiplier: number;
  spaced: boolean;
  /** Digits after the decimal point. */
  places: number;
  /** A sign, a currency or a thousands comma was written with it. */
  marked: boolean;
  /** The digits as written, decimal point included. */
  digits: string;
  at: number;
  end: number;
}

const readAll = (text: string): Read[] =>
  [...text.matchAll(NUMBER)].flatMap((m): Read[] => {
    const before = m[1] ?? '', whole = m[2] ?? '', decimals = m[3] ?? '', rawAfter = m[4] ?? '';
    const after = rawAfter.trim().toLowerCase();
    const base = Number(whole.replace(/,/g, '') + decimals);
    if (!Number.isFinite(base)) return [];
    const multiplier = MULTIPLIERS[after] ?? MULTIPLIERS[after.replace(/s$/, '')] ?? 1;
    // "3 x 4" is a size or a product: a times sign counts only glued to the number (3x, x3).
    const sign = SIGN.test(after) && !(/^\s/.test(rawAfter) && /^[x×]$/.test(after));
    const at = m.index ?? 0;
    return [{
      shown: (before + whole + decimals + (sign || multiplier > 1 ? rawAfter : '')).trim(), base, after, multiplier, spaced: /^\s/.test(rawAfter),
      places: Math.max(0, decimals.length - 1), marked: before.trim() !== '' || sign || whole.includes(','), digits: whole + decimals, at, end: at + m[0].length,
    }];
  });

/** A Latin letter after a space is a unit (5 m, 3 b), not a multiplier; glued to the number it is one (5M, 3b). */
const multiplierOf = (r: Read): number => (r.spaced && /^[a-z]{1,2}$/.test(r.after) ? 1 : r.multiplier);

/**
 * Whether a number shown is a figure worth tracing: not a year (1900..2099 alone, or followed by 年), not an index with
 * a leading zero (01), not a lone digit (step numbers 1 2 3) unless it has a sign, a decimal part or a multiplier,
 * not a part of a time, a ratio, a date or a name (12:30, 16:9, 2026-11-21, COVID-19), not an ordinal (4th) or a
 * digit with letters (5G, 3D).
 */
const isFigure = (r: Read, text: string): boolean => {
  if (/^0\d/.test(r.digits) || r.after === '年' || /^(?:st|nd|rd|th)$/.test(r.after)) return false;
  if (r.marked || multiplierOf(r) > 1 || r.places > 0) return true;
  if (r.digits.length === 1) return false;
  if (r.digits.length === 4 && r.base >= 1900 && r.base <= 2099) return false;
  return !AFTER_PART.test(text.slice(Math.max(0, r.at - 2), r.at)) && !BEFORE_PART.test(text.slice(r.end, r.end + 2));
};

/**
 * The figures of a text, each once, in order: numbers with their unit or sign (59K, $59K, 3.5%, 12,000, 2万, x3) and
 * plain numbers of two digits or more (isFigure says what is left out). The tolerance is half a unit of the last digit
 * written: 59K stands for 58,500 to 59,500, 3.5% for 3.45% to 3.55%, 12,000 for itself.
 */
export const figuresIn = (text: string): Figure[] => {
  const out = new Map<string, Figure>();
  for (const r of readAll(text)) {
    if (!isFigure(r, text) || out.has(r.shown)) continue;
    const multiplier = multiplierOf(r);
    out.set(r.shown, { shown: r.shown, value: r.base * multiplier, tolerance: (0.5 * multiplier) / 10 ** r.places });
  }
  return [...out.values()];
};

/**
 * Every value the texts hold, sorted: each number as written, and multiplied too when a multiplier follows it (a
 * source is read generously: "59 thousand" and "5.9万" give 59000, "5 m" gives 5 and 5000000).
 */
export const valuesIn = (texts: readonly string[]): Float64Array => {
  const values: number[] = [];
  for (const text of texts) for (const r of readAll(text)) values.push(r.base, ...(r.multiplier > 1 ? [r.base * r.multiplier] : []));
  return Float64Array.from(values).sort();
};

/** Whether a value of the sources rounds to the figure (a hair more, for decimals written in binary). */
export const traced = (f: Figure, values: Float64Array): boolean => {
  const slack = f.tolerance + 1e-9 * Math.max(1, Math.abs(f.value));
  let lo = 0, hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((values[mid] ?? 0) < f.value - slack) lo = mid + 1; else hi = mid;
  }
  return lo < values.length && (values[lo] ?? Infinity) <= f.value + slack;
};

/** The figures of the texts that no value of the sources accounts for, each once, in the order shown. */
export const untraced = (shown: readonly string[], values: Float64Array): Figure[] => {
  const seen = new Set<string>();
  return shown.flatMap((t) => figuresIn(t)).filter((f) => {
    if (seen.has(f.shown) || traced(f, values)) return false;
    seen.add(f.shown);
    return true;
  });
};

/** Text files a project may hold a source in. */
const TEXT_FILES = /\.(?:md|markdown|txt|text|json|csv|tsv|html?|xml|srt|vtt)$/i;
/**
 * Files the programs write, full of numbers that are no source: the project itself (video.json, which holds the
 * captions and slots being checked), its backup, measurements, the words of a voice, the steps of a scene writer, and
 * the files that hold the reference's own text: the project's record of its template (reference.facts.json) and a
 * template's reference-text.json; and the inventory of the pictures a source gave (pixel sizes, not facts).
 */
const PROGRAM_FILES = /(?:^|\/)(?:video\.json(?:\.bak)?|(?:[^/]*\.)?measure\.json|text\.json|transcript\.json|slots\.json|reference\.facts\.json|reference-text\.json|[^/]*\.words\.json|[^/]*\.steps\.json|[^/]*\.inventory\.json)$/i;
/** A larger file is not read: a source saved as text is far smaller. */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * A directory the Skill wrote from a reference: what describe writes (REFERENCE.md beside measure.json) or a template
 * (template.json beside slots.json). Its words and numbers are the reference's, never a source of the new video.
 */
const fromReference = (names: readonly string[]): boolean =>
  (names.includes('REFERENCE.md') && names.includes('measure.json')) || (names.includes('template.json') && names.includes('slots.json'));

/** The visible text of an HTML page: no scripts, no styles, no tags. */
const htmlText = (html: string): string =>
  html.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|#160);/gi, ' ');

/**
 * The text of every text file of the project outside scenes/ (and hidden directories), with its path from the
 * project directory; the files the programs write, and directories written from the reference, are left out. root:
 * the project directory (absolute).
 */
export const projectTexts = async (rt: Runtime, root: string): Promise<{ file: string; text: string }[]> => {
  const out: { file: string; text: string }[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    const names = await rt.fs.readdir(dir).catch((): string[] => []);
    if (depth > 0 && fromReference(names)) return;
    for (const name of names) {
      const full = rt.path.join(dir, name);
      const rel = rt.path.relative(root, full).split(rt.path.sep).join('/');
      const stat = await rt.fs.stat(full);
      if (stat?.isDirectory) {
        if (depth < 6 && !name.startsWith('.') && name !== 'node_modules' && !(depth === 0 && name === 'scenes')) await walk(full, depth + 1);
      } else if (stat?.isFile && TEXT_FILES.test(name) && !PROGRAM_FILES.test(rel) && stat.size <= MAX_BYTES) {
        const text = await rt.fs.readText(full).catch(() => '');
        out.push({ file: rel, text: /\.html?$/i.test(name) ? htmlText(text) : text });
      }
    }
  };
  await walk(root, 0);
  return out;
};
