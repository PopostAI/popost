/**
 * From per-frame text lines to cues: a line seen in consecutive samples at the same place with the same words is one
 * cue. Then each cue gets a role from how it behaves over the whole video. Pure functions; no file access.
 */
import type { Box } from '../types';
import { barWhy, rowsOf, wideRow } from './bar';
import type { TextCue, TextLine, TextRole, TextSample, TextTrack } from './types';

/** Readers below this confidence are ignored: they are mostly texture read as characters. */
const MIN_CONFIDENCE = 0.6;
/** Two lines are the same words when their edit distance is at most this share of the longer one. */
const SAME_TEXT = 0.34;
/** A cue may be missed in this many consecutive samples (a blurred frame, a transition) and still be one cue. */
const BRIDGE = 1;

const norm = (s: string): string => s.replace(/\s+/g, '').toLowerCase();

/** Levenshtein distance, two rows. */
export const editDistance = (a: string, b: string): number => {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
};

export const sameText = (a: string, b: string): boolean => {
  const x = norm(a), y = norm(b);
  const longer = Math.max(x.length, y.length);
  return longer > 0 && editDistance(x, y) <= SAME_TEXT * longer;
};

/** Same place: the vertical centres are within half a line height and the boxes overlap horizontally. */
const samePlace = (a: Box, b: Box): boolean => {
  const dy = Math.abs(a[1] + a[3] / 2 - (b[1] + b[3] / 2));
  const overlap = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  return dy <= 0.5 * Math.max(a[3], b[3]) && overlap > 0.3 * Math.min(a[2], b[2]);
};

interface Run { lines: TextLine[]; frames: number[]; last: number }

const union = (boxes: Box[]): Box => {
  const x0 = Math.min(...boxes.map((b) => b[0])), y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2])), y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  const r = (v: number): number => Math.round(v * 1e4) / 1e4;
  return [r(x0), r(y0), r(x1 - x0), r(y1 - y0)];
};

/** The reading that most samples agree on; ties go to the more confident one. */
const bestText = (lines: TextLine[]): string => {
  const votes = new Map<string, { n: number; conf: number; text: string }>();
  for (const l of lines) {
    const v = votes.get(norm(l.text)) ?? { n: 0, conf: 0, text: l.text };
    votes.set(norm(l.text), { n: v.n + 1, conf: Math.max(v.conf, l.confidence), text: l.confidence >= v.conf ? l.text : v.text });
  }
  return [...votes.values()].sort((a, b) => b.n - a.n || b.conf - a.conf)[0]?.text ?? '';
};

/** Runs of the same line through consecutive samples. sampleIndex of a frame = its position in the sample list. */
const trackRuns = (samples: TextSample[]): Run[] => {
  const open: Run[] = [];
  const done: Run[] = [];
  samples.forEach((sample, index) => {
    const used = new Set<Run>();
    for (const line of sample.lines) {
      if (line.confidence < MIN_CONFIDENCE || !norm(line.text)) continue;
      const run = open.find((r) => !used.has(r) && samePlace(r.lines[r.lines.length - 1]?.box ?? line.box, line.box) && sameText(r.lines[r.lines.length - 1]?.text ?? '', line.text));
      if (run) { run.lines.push(line); run.frames.push(sample.frame); run.last = index; used.add(run); }
      else { const fresh: Run = { lines: [line], frames: [sample.frame], last: index }; open.push(fresh); used.add(fresh); }
    }
    for (let i = open.length - 1; i >= 0; i--) {
      const r = open[i] as Run;
      if (index - r.last > BRIDGE) { done.push(r); open.splice(i, 1); }
    }
  });
  return [...done, ...open];
};

const toCue = (run: Run, step: number, total: number): Omit<TextCue, 'role'> => {
  const first = run.frames[0] ?? 0, last = run.frames[run.frames.length - 1] ?? 0;
  // Where and how large: from the readings of whole frames when the run has any; a strip's boxes are looser.
  const exact = run.lines.filter((l) => !l.partial);
  const placed = exact.length ? exact : run.lines;
  const box = union(placed.map((l) => l.box));
  const heights = placed.map((l) => l.box[3]).sort((a, b) => a - b);
  // Between two samples the change can be anywhere: the edge is put half a step out, clamped to the video.
  return {
    text: bestText(run.lines), start: Math.max(0, first - Math.floor(step / 2)), end: Math.min(total, last + Math.ceil(step / 2)),
    box, size: Math.round((heights[Math.floor(heights.length / 2)] ?? 0) * 1e4) / 1e4, samples: run.lines.length,
    confidence: Math.round((run.lines.reduce((s, l) => s + l.confidence, 0) / run.lines.length) * 1e3) / 1e3,
  };
};

/**
 * Share of the video's samples in which these words are on screen, wherever they sit (a watermark may jump about),
 * each sample once, and the most cues with these words on screen at once. Summing the readings of every cue with
 * "the same" words counted a sample once per cue: the near-identical lines of a scrolling page ("option 34: turn it
 * on to ...") came to 217% to 1135% of the samples and were called watermarks.
 */
const presence = (cue: Omit<TextCue, 'role'>, all: Omit<TextCue, 'role'>[], frames: readonly number[]): { share: number; atOnce: number } => {
  const same = all.filter((c) => sameText(c.text, cue.text));
  const counts = frames.map((f) => same.filter((c) => f >= c.start && f < c.end).length);
  return { share: counts.filter((n) => n > 0).length / Math.max(1, frames.length), atOnce: Math.max(0, ...counts) };
};

/**
 * Roles, decided over the whole video:
 * - watermark: the same words on screen in at least 40% of the samples, at one place or several, never three at once,
 *   and not drifting (a line whose box grows past its height while it is read scrolls with the page);
 * - caption: a short-lived line in a caption band. A caption band is a horizontal band in which at least three
 *   different lines follow one another: the busiest such band, and a second one only when it holds at least three
 *   quarters as many (bilingual captions);
 * - in-picture: small text (under 3% of the frame's height), or one of many lines on screen at once (a page, a list),
 *   unless it is large and laid on: at least 6% of the height and twice the median of the lines around it, staying in
 *   place (a page's own headline moves with the page when it scrolls); on such a frame a caption keeps its band when it
 *   is set like the band's other captions (centre and size), however small;
 * - title: large text (at least 6% of the height) that is none of the above; label: the rest.
 */
const assignRoles = (cues: Omit<TextCue, 'role'>[], samples: TextSample[], fps: number, step: number): TextCue[] => {
  const frames = samples.map((s) => s.frame);
  const crowd = new Map<number, number>(samples.map((s) => [s.frame, s.lines.filter((l) => l.confidence >= MIN_CONFIDENCE).length]));
  const crowded = (c: Omit<TextCue, 'role'>): boolean => {
    const inRange = [...crowd.entries()].filter(([f]) => f >= c.start && f < c.end).map(([, n]) => n);
    return inRange.length > 0 && inRange.reduce((s, n) => s + n, 0) / inRange.length >= 12;
  };
  const band = (c: Omit<TextCue, 'role'>): number => Math.round((c.box[1] + c.box[3] / 2) * 25);
  const bandTexts = new Map<number, Set<string>>();
  for (const c of cues) {
    if (c.size < 0.03 || (c.end - c.start) / fps > 12) continue;
    const set = bandTexts.get(band(c)) ?? new Set<string>();
    set.add(norm(c.text));
    bandTexts.set(band(c), set);
  }
  // A watermark is laid on in the edit: it is not tiny, it stays for seconds, and its words are on screen through
  // much of the video. Small words that a page repeats everywhere ("Sign in") are in-picture text instead.
  // A line whose box grew well past its height moved while it was read: it scrolls with the page under it.
  const drifts = (c: Omit<TextCue, 'role'>): boolean => c.box[3] > 1.5 * c.size;
  const marks = new Set(cues.filter((c) => {
    if (c.size < 0.03 || (c.end - c.start) / fps < 3 || drifts(c)) return false;
    const p = presence(c, cues, frames);
    return p.share >= 0.4 && p.atOnce <= 2;
  }));
  for (const c of marks) bandTexts.get(band(c))?.delete(norm(c.text));
  // Three or more of them side by side over most of the width, on screen together, are a bar of sections laid on in
  // the edit (bar.ts); the frames confirm it or give it back to the watermarks.
  const bars = rowsOf([...marks]).filter(wideRow);
  const inBar = new Map(bars.flatMap((r, row) => r.map((c, at) => [c, { row, at, of: r.length }] as const)));
  for (const c of inBar.keys()) marks.delete(c);
  const around = (b: number): number => [b - 1, b, b + 1].reduce((n, k) => n + (bandTexts.get(k)?.size ?? 0), 0);
  const busiest = Math.max(0, ...[...bandTexts.keys()].map(around));
  const top = [...bandTexts.keys()].sort((a, b) => around(b) - around(a))[0];
  const inTop = (c: Omit<TextCue, 'role'>): boolean => top !== undefined && Math.abs(band(c) - top) <= 1;
  const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const centre = (c: Omit<TextCue, 'role'>): number => c.box[0] + c.box[2] / 2;
  const topCues = cues.filter((c) => inTop(c) && !marks.has(c) && c.size >= 0.03);
  const topCentre = median(topCues.map(centre)), topSize = median(topCues.map((c) => c.size));
  // A second caption band must look like the first: as busy, set around the same axis, in a similar size. A page's
  // own headline that changes while the footage plays is busy too, but it sits elsewhere and is set differently.
  const likeTop = (c: Omit<TextCue, 'role'>): boolean =>
    around(band(c)) >= 0.75 * busiest && Math.abs(centre(c) - topCentre) <= 0.1 && Math.abs(c.size - topSize) <= 0.4 * topSize;
  const captionBand = (c: Omit<TextCue, 'role'>): boolean => around(band(c)) >= 3 && (inTop(c) || likeTop(c));
  const pct = (v: number): string => Math.round(v * 100) + '%';
  const at = (c: Omit<TextCue, 'role'>): string => pct(c.box[1] + c.box[3] / 2);
  // Why a large line laid over the picture is not a caption: the first rule it fails.
  const notCaption = (c: Omit<TextCue, 'role'>): string =>
    (c.end - c.start) / fps > 12 ? 'on screen ' + Math.round((c.end - c.start) / fps) + ' s, longer than a caption line' : 'outside the caption band';
  const bandCaption = (c: Omit<TextCue, 'role'>): boolean => c.size >= 0.03 && (c.end - c.start) / fps <= 12 && captionBand(c) && !(crowded(c) && c.size < 0.045);
  // On a crowded frame (a page under the captions) a smaller reading of a caption is set like the band's others.
  const sure = cues.filter((c) => !marks.has(c) && bandCaption(c));
  const sureCentre = median(sure.map(centre)), sureSize = median(sure.map((c) => c.size));
  const setLikeCaptions = (c: Omit<TextCue, 'role'>): boolean => sure.length >= 2 && c.size >= 0.03 && (c.end - c.start) / fps <= 12 && captionBand(c) &&
    Math.abs(centre(c) - sureCentre) <= 0.05 && Math.abs(c.size - sureSize) <= 0.3 * sureSize;
  // A large line over a crowded frame: how many times the median line around it, when it is laid on (0 when not).
  const laidOn = (c: Omit<TextCue, 'role'>): number => {
    if (c.size < 0.06 || drifts(c)) return 0;
    const around = samples.filter((s) => s.frame >= c.start && s.frame < c.end).flatMap((s) => s.lines)
      .filter((l) => l.confidence >= MIN_CONFIDENCE && !sameText(l.text, c.text)).map((l) => l.box[3]);
    const times = around.length ? c.size / median(around) : Infinity;
    // A page's own headline moves with the page: its box drifts, or the same words sit elsewhere right before or after.
    const moves = cues.some((o) => o !== c && sameText(o.text, c.text) && Math.abs(o.size - c.size) <= 0.3 * c.size &&
      (Math.abs(o.start - c.end) <= 2 * step || Math.abs(c.start - o.end) <= 2 * step) && !samePlace(o.box, c.box));
    return times >= 2 && !moves ? Math.min(times, 99) : 0;
  };
  const decide = (c: Omit<TextCue, 'role'>): { role: TextRole; why: string } => {
    const bar = inBar.get(c);
    if (bar) return { role: c.size >= 0.06 ? 'title' : 'label', why: barWhy(bars[bar.row] ?? [c]) };
    if (marks.has(c)) return { role: 'watermark', why: 'the same words are on screen in ' + pct(presence(c, cues, frames).share) + ' of the samples' };
    if (bandCaption(c) || setLikeCaptions(c)) return { role: 'caption', why: 'one of ' + around(band(c)) + ' lines that follow one another in the band at ' + at(c) };
    if (c.size < 0.03) return { role: 'in-picture', why: 'small: ' + pct(c.size) + ' of the height' };
    const over = laidOn(c);
    if (crowded(c) && !over) return { role: 'in-picture', why: 'one of many lines on screen at once' };
    if (over) return { role: 'title', why: 'large (' + pct(c.size) + ' of the height) and laid over a page: ' + over.toFixed(1) + ' times the lines around it, staying in place' };
    if (c.size >= 0.06) return { role: 'title', why: 'large (' + pct(c.size) + ' of the height), ' + notCaption(c) };
    return { role: 'label', why: notCaption(c) };
  };
  return cues.map((c): TextCue => ({ ...c, ...decide(c), ...(inBar.has(c) ? { bar: inBar.get(c) } : {}) }));
};

type Bare = Omit<TextCue, 'role'>;
const centreY = (c: Bare): number => c.box[1] + c.box[3] / 2;
/** Alike words: the same within the reader's errors, or one inside the other ("Result" in "Results"). */
const alike = (a: string, b: string): boolean => sameText(a, b) || (Math.min(norm(a).length, norm(b).length) >= 2 && (norm(a).includes(norm(b)) || norm(b).includes(norm(a))));
const xOverlap = (a: Bare, b: Bare): number => Math.min(a.box[0] + a.box[2], b.box[0] + b.box[2]) - Math.max(a.box[0], b.box[0]);
const spanOf = (xs: Bare[]): [number, number][] => {
  const out: [number, number][] = [];
  for (const c of [...xs].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && c.start <= last[1]) last[1] = Math.max(last[1], c.end);
    else out.push([c.start, c.end]);
  }
  return out;
};
const covered = (xs: Bare[]): number => spanOf(xs).reduce((n, [a, b]) => n + b - a, 0);

/**
 * Words that stay on one line through much of the video, read in pieces: a reader splits a word's time where its look
 * changes (a plate behind the marked word of a bar), reads neighbours as one line while neither is marked ("Setup
 * Results"), drops a letter now and then ("Result"), and may place a marked word's box higher. Pieces at one place
 * (boxes overlapping) with alike words are one word; a piece that holds two or more words side by side gives its time
 * to each. Words make a line when their centres are within half a line and their sizes alike. When a line has two
 * words or more, apart, each on screen for 80% of the line's time and the line for 40% of the video, its pieces are
 * replaced by one cue per word: the reading seen most (the longer on a tie), the box nearest the line's centre, the
 * line's whole time.
 */
export const mergeRowPieces = (cues: readonly Bare[], total: number): Bare[] => {
  const pieces = cues.filter((x) => x.size >= 0.03);
  const yOverlap = (a: Bare, b: Bare): boolean => Math.min(a.box[1] + a.box[3], b.box[1] + b.box[3]) > Math.max(a.box[1], b.box[1]);
  const holds = (c: Bare): Bare[] => pieces.filter((o) => o !== c && o.box[2] < 0.8 * c.box[2] && yOverlap(c, o) && xOverlap(c, o) >= 0.6 * o.box[2] && norm(o.text).length >= 2 && norm(c.text).includes(norm(o.text)));
  const spanning = new Set(pieces.filter((c) => new Set(holds(c).map((o) => Math.round((o.box[0] + o.box[2] / 2) * 50))).size >= 2));
  const words: Bare[][] = [];
  for (const c of pieces.filter((x) => !spanning.has(x)).sort((a, b) => b.end - b.start - (a.end - a.start))) {
    const word = words.find((w) => w.some((o) => yOverlap(o, c) && xOverlap(o, c) >= 0.5 * Math.min(o.box[2], c.box[2]) && alike(o.text, c.text)));
    if (word) word.push(c);
    else words.push([c]);
  }
  const mid = (w: Bare[]): number => w.reduce((s, c) => s + centreY(c) * (c.end - c.start), 0) / Math.max(1, w.reduce((s, c) => s + c.end - c.start, 0));
  const sizeOf = (w: Bare[]): number => [...w.map((c) => c.size)].sort((a, b) => a - b)[w.length >> 1] ?? 0;
  const lines: Bare[][][] = [];
  for (const w of [...words].sort((a, b) => mid(a) - mid(b))) {
    const line = lines.find((l) => l.every((v) => Math.abs(mid(v) - mid(w)) <= 0.5 * Math.min(sizeOf(v), sizeOf(w)) && Math.max(sizeOf(v), sizeOf(w)) <= 1.5 * Math.min(sizeOf(v), sizeOf(w))));
    if (line) line.push(w);
    else lines.push([w]);
  }
  const drop = new Set<Bare>(), add: Bare[] = [];
  for (const line of lines) {
    if (line.length < 2) continue;
    const time = (w: Bare[]): Bare[] => [...w, ...[...spanning].filter((s) => holds(s).some((o) => w.includes(o)))];
    const from = Math.min(...line.flat().map((c) => c.start)), to = Math.max(...line.flat().map((c) => c.end));
    const left = (w: Bare[]): number => Math.min(...w.map((c) => c.box[0])), right = (w: Bare[]): number => Math.max(...w.map((c) => c.box[0] + c.box[2]));
    const apart = line.every((w, i) => line.every((v, j) => i === j || right(w) <= left(v) + 0.005 || right(v) <= left(w) + 0.005));
    if (!apart || to - from < 0.4 * total || line.some((w) => covered(time(w)) < 0.8 * (to - from))) continue;
    // Nothing read in pieces: the roles judge these cues as they are.
    if (line.every((w) => w.length === 1 && time(w).length === 1)) continue;
    const centre = [...line.map(mid)].sort((a, b) => a - b)[line.length >> 1] ?? 0;
    for (const w of line) {
      const all = time(w);
      all.forEach((c) => drop.add(c));
      const read = [...w].sort((a, b) => b.samples - a.samples || norm(b.text).length - norm(a.text).length)[0] as Bare;
      const placed = [...w].sort((a, b) => Math.abs(centreY(a) - centre) - Math.abs(centreY(b) - centre))[0] as Bare;
      const n = all.reduce((s, c) => s + c.samples, 0);
      add.push({ ...placed, text: read.text, start: Math.min(...all.map((c) => c.start)), end: Math.max(...all.map((c) => c.end)), samples: n, confidence: Math.round((all.reduce((s, c) => s + c.confidence * c.samples, 0) / Math.max(1, n)) * 1e3) / 1e3 });
    }
  }
  return drop.size ? [...cues.filter((c) => !drop.has(c)), ...add] : [...cues];
};

/**
 * samples: in frame order, every step frames. total: the video's frame count. A cue seen in a single sample with low
 * confidence is dropped: one-off readings are mostly noise.
 */
export const buildCues = (samples: TextSample[], opts: { step: number; total: number; fps: number }): TextTrack => {
  const runs = trackRuns(samples).filter((r) => r.lines.length >= 2 || (r.lines[0]?.confidence ?? 0) >= 0.9);
  const bare = mergeRowPieces(runs.map((r) => toCue(r, opts.step, opts.total)).filter((c) => norm(c.text).length >= 1), opts.total);
  const cues = assignRoles(bare, samples, opts.fps, opts.step).sort((a, b) => a.start - b.start || a.box[1] - b.box[1]);
  return { step: opts.step, sampled: samples.length, cues };
};
