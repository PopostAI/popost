/**
 * TEMPLATE.md: one screen for a model with a small context. What the template is, how long it runs, its beats as a
 * numbered list (captions[i] is the line of beat i: what the source said or showed there, and whether it was only
 * said), its shots with the range of beats each holds, what to provide and the rules. It aims at MAX_TOKENS: when the
 * full text is longer, it says less (shorter examples, no beat times, one short line per shot, only each beat's length
 * in characters, then no beat list). A beat's wording and length are what a fill needs most, so they go last. A
 * template saved with a reading of the frames (card-elements.ts) says each shot's layout, what to keep, replace and
 * drop at every level, in a few lines per shot at the top levels and one clause lower down; each shot read adds
 * READ_TOKENS to the budget (cardBudget).
 */
import { oneIn } from '../text/share';
import { roughTokens } from '../describe/index';
import { aimText } from '../describe/aim';
import { insetText } from '../describe/inset';
import { KIND_WORDS, looksText, shownIn } from '../describe/kind';
import type { TextTrack } from '../text/types';
import { charsOf } from './capacity';
import { elementsText, readingNotes, type ElementsDetail } from './card-elements';
import { startsOf, transitionFrames } from './structure';
import type { CaptionSlot, Slots, Template, TemplateShot, WordSlot } from './types';

export const MAX_TOKENS = 600;
/** What a shot's reading adds to the budget: what each shot holds is what a fill needs most after its lines. */
export const READ_TOKENS = 40;

/** The card's budget: MAX_TOKENS, and READ_TOKENS for each shot the reading of the frames describes. */
export const cardBudget = (tpl: Template): number => MAX_TOKENS + READ_TOKENS * tpl.shots.filter((s) => s.elements).length;

const s1 = (frame: number, fps: number): string => (frame / fps).toFixed(1);
const clip = (text: string, n: number): string => (charsOf(text).length > n ? charsOf(text).slice(0, n).join('') + '…' : text);
const quote = (t: string): string => '"' + t.replace(/"/g, "'") + '"';

export interface CardSource {
  /** The source's text, with the roles the speech gave it: titles and labels are named in the shots. */
  text?: TextTrack;
  /** Frame rate of the source the text was read from. */
  sourceFps?: number;
  /** How the path of a picture the template keeps (relative to the template directory) is shown. Default: as kept. */
  picture?: (p: string) => string;
}

/** How much the card says, from most to least. */
/** list: one line per beat, one line of the beats' lengths in characters, or nothing beyond the count. */
/** looks: what each shot most likely is with the facts it rests on, the kind alone, or nothing. */
/** elements: how much of each shot's reading (card-elements.ts): a few lines, a clause, or the layout alone. */
interface Detail { example: number; times: boolean; titles: boolean; list: 'lines' | 'lengths' | 'none'; terse: boolean; needs: boolean; looks: 'facts' | 'kind'; elements: ElementsDetail }
const LEVELS: Detail[] = [
  { example: 24, times: true, titles: true, list: 'lines', terse: false, needs: true, looks: 'facts', elements: 'full' },
  { example: 12, times: true, titles: true, list: 'lines', terse: false, needs: true, looks: 'facts', elements: 'full' },
  { example: 12, times: true, titles: true, list: 'lines', terse: false, needs: true, looks: 'kind', elements: 'short' },
  { example: 12, times: false, titles: true, list: 'lines', terse: false, needs: true, looks: 'kind', elements: 'short' },
  { example: 12, times: false, titles: true, list: 'lines', terse: true, needs: true, looks: 'kind', elements: 'short' },
  { example: 6, times: false, titles: true, list: 'lines', terse: true, needs: true, looks: 'kind', elements: 'short' },
  { example: 0, times: false, titles: false, list: 'lengths', terse: true, needs: true, looks: 'kind', elements: 'short' },
  { example: 0, times: false, titles: false, list: 'lengths', terse: true, needs: false, looks: 'kind', elements: 'kinds' },
  { example: 0, times: false, titles: false, list: 'none', terse: true, needs: false, looks: 'kind', elements: 'kinds' },
];

const transitionText = (s: TemplateShot | undefined, room: number): string => {
  // An effect of its own is never shown as a preset: the engine cuts, and a scene draws it.
  if (s?.effect) return 'custom ' + s.effect.frames + 'f';
  const f = transitionFrames(s?.in, room);
  if (!s?.in || f < 2) return 'cut';
  return [s.in.transition, s.in.direction, s.in.mode, s.in.via ? 'via ' + s.in.via : '', f + 'f'].filter(Boolean).join(' ');
};

/** Indexes as runs: 0, 2-4, 9. */
export const runsText = (xs: number[]): string => {
  const out: string[] = [];
  for (let k = 0; k < xs.length; k++) {
    let j = k;
    while (j + 1 < xs.length && (xs[j + 1] ?? 0) === (xs[j] ?? 0) + 1) j++;
    out.push(j > k ? xs[k] + '-' + xs[j] : String(xs[k]));
    k = j;
  }
  return out.join(', ');
};

/** One beat: its index as the fill writes it, its time, whether it was only said, what was there, and a mark when unsure. */
const beatLine = (tpl: Template, slot: CaptionSlot | undefined, b: { start: number; end: number; shown?: false; speech?: 'on-camera' }, i: number, d: Detail): string => {
  const fps = tpl.canvas.fps;
  const was = slot?.example?.text;
  const what = was ? (d.example ? ': ' + quote(clip(was, d.example)) + ' (' + charsOf(was).length + ')' : ' (' + charsOf(was).length + ')') : '';
  return '- captions[' + i + ']' + (d.times ? ' ' + s1(b.start, fps) + '-' + s1(b.end, fps) + ' s' : '') + (b.shown === false ? ', spoken only' : '') + (b.speech === 'on-camera' ? ', on camera' : '') + what + (slot?.unsure ? ' (unsure)' : '');
};

/** The numbered beats; without room for them, one line in the header says where they are (beatsSummary). */
const beatPart = (tpl: Template, slots: Slots, d: Detail): string[] => {
  const beats = tpl.captions?.beats ?? [];
  if (!beats.length || d.list === 'none') return [];
  if (d.list === 'lengths') return ['The source\'s lines had these many characters, captions[0] first: ' + beats.map((_b, i) => charsOf(slots.captions?.lines[i]?.example?.text ?? '').length).join(', ') + '.', ''];
  return ['## Beats (captions[i] is the line of beat i; the source\'s line and its characters)', '', ...beats.map((b, i) => beatLine(tpl, slots.captions?.lines[i], b, i, d)), ''];
};

const beatsSummary = (tpl: Template, d: Detail): string => {
  const beats = tpl.captions?.beats ?? [];
  if (!beats.length) return ' No captions.';
  const only = beats.flatMap((b, i) => (b.shown === false ? [i] : []));
  const kinds = (beats.length - only.length) + ' shown as captions in one band' + (only.length ? ', ' + only.length + ' spoken only (heard, not drawn)' : '');
  if (d.list === 'lines') return ' ' + beats.length + ' beats: ' + kinds + '.';
  return ' ' + beats.length + ' beats, captions[0-' + (beats.length - 1) + ']: ' + kinds + (only.length ? ': ' + runsText(only) : '') + '.';
};

/** The source's bar, in one line: its words (or how many), and which word each shot marks, when the card has room. */
const barText = (slots: Slots, d: Detail): string => {
  const bar = slots.bar;
  if (!bar) return '';
  const names = bar.words.map((w, j) => (w.example ? quote(clip(w.example.text, 12)) : 'word ' + (j + 1)));
  const runs = d.titles ? markedRuns(bar.marked, names) : '';
  return 'A bar of ' + bar.words.length + ' words laid on through the video (' + names.join(' ') + '), not a watermark' + (runs ? '; the marked word follows the shots: ' + runs : '') + '. Fill "bar" with ' + bar.words.length + ' words.';
};

/** shots[a-b] by the word they mark: "Intro" shots[0-2], "Setup" shots[3-5]. */
const markedRuns = (marked: number[], names: string[]): string => {
  const runs: { m: number; from: number; to: number }[] = [];
  marked.forEach((m, k) => {
    const last = runs[runs.length - 1];
    if (m >= 0 && last && last.m === m && last.to === k - 1) last.to = k;
    else if (m >= 0) runs.push({ m, from: k, to: k });
  });
  return runs.map((r) => (names[r.m] ?? '') + ' shots[' + r.from + (r.to > r.from ? '-' + r.to : '') + ']').join(', ');
};

/** Where the caption band is, when the frame's inset puts the captions on the frame or the bars: the scenes leave it free. */
const bandText = (tpl: Template): string => {
  const box = tpl.captions?.box, H = tpl.canvas.height;
  if (!box || (tpl.inset?.captions !== 'below' && tpl.inset?.captions !== 'above')) return '';
  return ' The caption band is [' + box.join(', ') + '] (y ' + Math.round(box[1] * H) + ' to ' + Math.round((box[1] + box[3]) * H) + ' px): ' +
    (tpl.inset.kind === 'bars' ? 'leave it black.' : 'leave it free of the scene\'s own text.');
};

/** Titles and labels the source showed, on the template's clock. */
/** A title belongs to the shots it overlaps by more than half the source's reading step (describe/kind.ts, shownIn). */
const titlesOf = (tpl: Template, src: CardSource): { start: number; end: number; text: string }[] => {
  const ratio = tpl.canvas.fps / (src.sourceFps ?? tpl.canvas.fps);
  return (src.text?.cues ?? []).filter((c) => (c.role === 'title' || c.role === 'label') && !c.bar).map((c) => ({ start: Math.round(c.start * ratio), end: Math.round(c.end * ratio), text: c.text }));
};

/**
 * The places a shot laid words on (slots.json shots[k].words): what the source laid there (the slot's example, else the
 * title the text names in the shot) with its length when the card has room, or how many places.
 */
const wordsText = (slot: WordSlot[] | undefined, d: Detail, title: string | undefined): string => {
  if (!slot?.length) return '';
  if (!d.titles) return ', words ' + slot.length;
  return ', words ' + slot.map((w, j) => {
    const was = w.example?.text ?? (j === 0 ? title : undefined);
    return was ? quote(clip(was, 16)) + (d.times ? ' (' + charsOf(was).length + ')' : '') : '""';
  }).join(', ');
};

const shotLines = (tpl: Template, slots: Slots, src: CardSource, d: Detail): string[] => {
  const fps = tpl.canvas.fps;
  const starts = startsOf(tpl);
  const titles = d.titles ? titlesOf(tpl, src) : [];
  const step = Math.round((src.text?.step ?? 0) * (tpl.canvas.fps / (src.sourceFps ?? tpl.canvas.fps)));
  const beats = tpl.captions?.beats ?? [];
  return tpl.shots.flatMap((s, k) => {
    const from = starts[k] ?? 0, to = from + s.frames;
    const into = k === 0 ? 'start' : transitionText(s, Math.min(tpl.shots[k - 1]?.frames ?? 1, s.frames));
    const needs = s.source === 'footage' ? ' (footage needs ' + (slots.shots[k]?.footage.seconds ?? 0) + ' s)' : '';
    // Laid-on words a fill gives new lines for; other text the source showed is named as it was.
    const found = titles.find((t) => shownIn(t, { start: from, end: to }, step));
    const words = wordsText(slots.shots[k]?.words, d, found?.text);
    const title = words ? undefined : found;
    const mine = beats.flatMap((b, i) => (b.start < to && b.end > from ? [i] : []));
    const range = mine.length ? '; captions[' + mine[0] + (mine.length > 1 ? '-' + mine[mine.length - 1] : '') + ']' : '';
    // A hint the pictures confirm or correct: said only when the measured facts agree (describe/kind.ts).
    const looks = s.looks ? (d.terse ? ', likely ' : '. Most likely ') + (d.looks === 'facts' ? looksText(s.looks) : KIND_WORDS[s.looks.kind]) : '';
    // Where a zoom or pan went: what a capture plan or a scene camera aims at.
    const aim = s.aim ? (d.terse ? ', camera ' : '. The camera ') + aimText(s.aim) : '';
    // What the reading of the frames said: the layout, what to keep, replace and drop, an effect of its own.
    const read = elementsText(s, d.elements, src.picture ?? ((p) => p));
    const line = d.terse
      ? '- shots[' + k + '] ' + s1(from, fps) + '-' + s1(to, fps) + ' ' + into + ', ' + s.source + (d.needs ? needs.replace(' (footage needs', ' (needs') : '') + (title ? ', showed ' + quote(clip(title.text, 16)) : '') + words + range + aim + looks + read.clause
      : (k + 1) + '. shots[' + k + '] ' + s1(from, fps) + '-' + s1(to, fps) + ' s, in: ' + into + '. Source: ' + s.source + needs + (title ? ', showed ' + quote(clip(title.text, 16)) : '') + words + range + aim + looks + read.clause;
    return [line, ...read.lines];
  });
};

const header = (tpl: Template, d: Detail): string[] => {
  const { width, height, fps } = tpl.canvas;
  const shape = width > height ? 'landscape' : width < height ? 'portrait' : 'square';
  return [
    '# Template: ' + tpl.name, '',
    tpl.shots.length + ' shots, ' + s1(tpl.frames, fps) + ' s (' + tpl.frames + ' frames at ' + fps + ' fps), ' + width + 'x' + height + ' ' + shape + ', from a measured reference (' + tpl.source.label + '). You give the content; the program keeps every length, cut, transition and caption time.' +
      beatsSummary(tpl, d),
  ];
};

/** How a fill gets the source's highlighted words, when the source had them (text/highlight.ts, retarget/marks.ts). */
const highlightText = (tpl: Template): string => {
  const h = tpl.captions?.look?.highlight;
  if (!h?.color) return '';
  const of = tpl.captions?.look?.samples;
  const share = h.share ?? (of ? h.lines / of : undefined);
  const lines = slotsLines(tpl);
  const want = share !== undefined && lines ? ' ' + cap(oneIn(share)) + ' has a highlighted word or two: mark about ' + Math.max(1, Math.round(share * lines)) + ' of your ' + lines + ' lines, not every line and not fewer than half of that.' : '';
  return ' The source drew a word or two of ' + h.lines + (of ? ' of ' + of : '') + ' lines in ' + h.color + ': wrap such words in asterisks, "*like this*", for the same.' + want;
};

const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);
const slotsLines = (tpl: Template): number => tpl.captions?.beats.length ?? 0;

/** How the source's lines came on screen, when that was measured (text/reveal.ts): what captionReveal a fill gets by default. */
const revealText = (tpl: Template): string => {
  const r = tpl.captions?.look?.reveal;
  if (!r || r.confidence < 0.6) return '';
  return r.kind === 'whole'
    ? ' The source showed each line whole at once (' + r.lines + ' of ' + r.of + ' line starts measured): leave "captionReveal" out.'
    : ' The source built each line ' + (r.kind === 'words' ? 'word by word' : 'character by character') + ' (' + r.lines + ' of ' + r.of + ' line starts measured): with a voice (--speak) the fill does the same by default; "captionReveal": "whole" turns it off.';
};

const fillPart = (tpl: Template, slots: Slots): string[] => {
  const n = slots.captions?.lines.length ?? 0;
  return [
    '## Fill (fill.json)', '',
    '{"shots": [' + tpl.shots.length + ' entries]' + (n ? ', "captions": [' + n + ' lines]' : '') + '}', '',
    '- shots[k]: {"footage": "assets/a.mp4", "in": 0, "speed": 1} | {"picture": "assets/b.webp", "zoom": 0.04} | {"color": "#101014"} | {"card": {"title": "...", "lines": ["..."]}} (1 s or more' +
      (slots.card ? '; title at most ' + slots.card.title.cjk + ' full-width or ' + slots.card.title.latin + ' Latin characters, up to ' + slots.card.lines + ' lines of ' + slots.card.line.cjk + ' or ' + slots.card.line.latin : '') + ')' +
      ' | {"scene": "scenes/shot-01.html", "slots": {"title": "..."}}: every shot takes a scene, an HTML page of the project that draws the whole shot.',
    ...(n ? ['- captions[i]: the line of beat i; "" for none.' + highlightText(tpl) + revealText(tpl)] : []),
    ...(slots.bar ? ['- bar: ["..."], ' + slots.bar.words.length + ' words from the left, drawn through the video; the marked one follows the shots.'] : []),
    ...(slots.shots.some((s) => s.words?.length) ? ['- shots[k].words: ["..."], a line per place in its "words", set as the source\'s.'] : []),
    ...(tpl.shots.some((s) => s.effect) ? ['- custom in: a scene draws the effect (both pictures and the moving object, as its frames show); fill cuts there and lets that scene cover the whole effect.'] : []),
    '- Optional: voice, speed, say (spoken with --speak: beats take the spoken length), captionColor, captionOutline, sound.',
    ...speechRule(tpl),
  ];
};

/** What the kind of the source's speech means for a fill: whether it has a voice, and which beats a person says in a clip. */
const speechRule = (tpl: Template): string[] => {
  const s = tpl.speech;
  if (!s) return [];
  const dialogue = (tpl.captions?.beats ?? []).flatMap((b, i) => (b.speech === 'on-camera' ? [i] : []));
  const voice = s.kinds.includes('narration') ? 'the narration is re-made as a voice-over ("voice")' : 'no narration, so no "voice" and no --speak unless the user asks for one (--voice-asked "<their words>")';
  return [
    '- Speech of the source: ' + s.kinds.join(', ') + ': ' + voice + '.'
      + (dialogue.length ? ' Beats ' + runsText(dialogue) + ' are said on camera: the person of a generated clip says each line (its request\'s speech.lines names the beat); the voice-over never reads them.' : ''),
  ];
};

const rulesPart = (slots: Slots): string[] => {
  const cap = slots.captions?.capacity;
  return [
    '## Rules', '',
    '- Lists are matched by position. Write no times or frames.',
    ...(cap ? ['- A caption line holds at most ' + cap.cjk + ' full-width or ' + cap.latin + ' Latin characters (' + cap.lines + ' line' + (cap.lines === 1 ? '' : 's') + (cap.measured ? '' : ', estimated') + '); a longer one is refused.'] : []),
    '- Footage lasts its shot from "in". Neighbouring colour shots need clearly different colours. No "keep". Limits: slots.json.',
    '- template check <this dir> --fill fill.json checks the fill; template fill <this dir> --fill fill.json --out <project> checks its files once they are in <project> (scenes, footage, pictures), then builds it.',
  ];
};

/** TEMPLATE.md, and its size in rough tokens. */
export const templateCard = (tpl: Template, slots: Slots, src: CardSource = {}): { text: string; tokens: number } => {
  let out = { text: '', tokens: Infinity };
  for (const d of LEVELS) {
    // The frame around the content changes how every shot is made: it is said whatever else has to go.
    const inset = tpl.inset ? ['', insetText(tpl.inset, tpl.shots.length) + bandText(tpl)] : [];
    const bar = barText(slots, d);
    const notes = readingNotes(tpl).flatMap((n) => ['', n]);
    const text = [...header(tpl, d), ...inset, ...notes, ...(bar ? ['', bar] : []), '', ...beatPart(tpl, slots, d), '## Shots', '', ...shotLines(tpl, slots, src, d), '', ...fillPart(tpl, slots), '', ...rulesPart(slots)].join('\n') + '\n';
    out = { text, tokens: roughTokens(text) };
    if (out.tokens <= cardBudget(tpl)) break;
  }
  return out;
};
