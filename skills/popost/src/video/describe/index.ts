/**
 * The layered description of a reference video, laid out for a model with a small context: a card, the numbered beats
 * and one line per shot, one file per shot. Built from the measurement (and the text cues and the speech when readers
 * were available) by a program; no model writes any of it. A key ending in "~" would be an inference; everything
 * written here is measured.
 */
import type { Boundary, Measure, MotionEvent, ShotMeasure, Trajectory } from '../types';
import { phrasesOf } from '../speech/index';
import { coverTolerance, referenceBeats, uncoveredSpeech, UNSURE, type Beat } from './beats';
import { aimText, cameraAim } from './aim';
import { insetText, type Inset } from './inset';
import { looksText, shotLooks, shownIn, type ShotLooks } from './kind';
import { AROUND, fitsPoorly, joinedShots, LEAD_IN, OPENING_FILE, OPENING_PER_SECOND, OPENING_SECONDS, SHOT_FRAMES, shotSheetFile, transitionFile } from './frames';
import type { Phrase, Transcript } from '../speech/types';
import { barsOf, markedText } from '../text/bar';
import { oneIn } from '../text/share';
import type { CaptionLook, TextCue, TextTrack } from '../text/types';
import { shotAmount, videoAmount, type Activity } from '../measure/amount';
import { activities, movementBrief, movementCardLine, movementLine } from './movement';
import { ANGLES, ownEffect, trackBrief, trackText, TRACKS_FILE } from './paths';
import { amountKnown, cameraKnown, kindKnown, LEGEND, NO_PATH, tag } from './known';
import type { Status, Unrecovered } from '../types';
import { LISTED, UNRECOVERED_FILE, unrecoveredLine, unrecoveredOf } from './unrecovered';
import { kindLine, kindRanges, type SpeechFile } from './speech-kind';

export interface Description {
  /** File name (relative to reference/) -> content. */
  files: Record<string, string>;
  /** Rough size of each file in tokens, for the map in REFERENCE.md. */
  tokens: Record<string, number>;
  /** What the reading did not recover (unrecovered.ts): the list REFERENCE.md prints, for unrecovered.json. */
  unrecovered: Unrecovered[];
}

/** A rough count that is good enough to plan a context: CJK characters count one each, other text four characters a token. */
export const roughTokens = (text: string): number => {
  const cjk = (text.match(/[\u{3040}-\u{30ff}\u{3400}-\u{9fff}\u{ac00}-\u{d7af}]/gu) ?? []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
};

const two = (n: number): string => String(n).padStart(2, '0');
const sec = (frame: number, fps: number): string => (frame / fps).toFixed(2);
const pct = (v: number): string => Math.round(v * 100) + '%';
const where = (box: [number, number, number, number]): string => {
  const cx = box[0] + box[2] / 2, cy = box[1] + box[3] / 2;
  return (cy < 0.33 ? 'top' : cy > 0.67 ? 'bottom' : 'middle') + (cx < 0.33 ? ' left' : cx > 0.67 ? ' right' : '');
};
const boxText = (b: [number, number, number, number]): string => 'x ' + pct(b[0]) + '-' + pct(b[0] + b[2]) + ', y ' + pct(b[1]) + '-' + pct(b[1] + b[3]);

/** What the description says of the pictures: whether they were written, and which shots go with the change after them. */
interface Pictures { written: boolean; joined: ReadonlySet<number>; amounts: readonly (number | undefined)[]; activity: readonly (Activity | undefined)[]; amount: number | undefined; tracks: readonly Trajectory[]; measure: Measure }

const MEASURED: Status = { status: 'measured', basis: '' };

/** The trajectory of the change into shot k (from 0). */
const pathInto = (p: Pictures, k: number): Trajectory | undefined => p.tracks.find((t) => t.of === 'transition' && t.shot === k + 1);

/** A change into a shot; sheet: its frame-by-frame picture, named when a label that does not fit sends the reader there. */
const transitionText = (b: Boundary | undefined, sheet?: string): string => {
  if (!b) return 'start';
  if (b.kind === 'cut') return 'cut';
  const label = [b.kind, b.mode, b.direction, b.via ? 'via ' + b.via : '', (b.end - b.start - 1) + 'f'].filter(Boolean).join(' ');
  if (fitsPoorly(b)) return label + ' (does not fit well: ' + (sheet ? 'look at ' + sheet + '; ' : '') + 'it may be an effect of its own)';
  return label + (b.confidence < 0.4 ? ' (unsure)' : '');
};

/** The sheet of the change into shot k (from 0), when the pictures were written and it is not a plain cut. */
const sheetInto = (into: Boundary | undefined, k: number, p: Pictures): string | undefined =>
  p.written && into && into.kind !== 'cut' ? transitionFile(k + 1) : undefined;

const cameraText = (s: ShotMeasure): string => {
  const c = s.camera;
  if (c.kind === 'unknown') return 'unknown';
  if (c.kind === 'static') return 'still';
  if (c.kind === 'unsteady') return 'unsteady';
  const parts: string[] = [];
  if (Math.abs(c.zoomPerS) >= 0.005) parts.push((c.zoomPerS > 0 ? 'push ' : 'pull ') + (Math.abs(c.zoomPerS) * 100).toFixed(1) + '%/s');
  const [px, py] = c.panPerS;
  if (Math.hypot(px, py) >= 0.005) parts.push('pan ' + (Math.abs(px) >= Math.abs(py) ? (px > 0 ? 'right' : 'left') : (py > 0 ? 'down' : 'up')) + ' ' + (Math.hypot(px, py) * 100).toFixed(1) + '%/s');
  return parts.join(', ') || 'still';
};

const eventText = (e: MotionEvent, fps: number): string =>
  '@' + e.start + '-' + e.end + ' (' + sec(e.start, fps) + 's) ' + where(e.box) + ' [' + boxText(e.box) + '] ' + e.kind +
  (e.how ? ', ' + e.how : '') + (e.direction ? ' ' + e.direction : '') + (e.ease && e.ease !== 'instant' ? ', ease ' + e.ease : '') +
  (e.overshoot ? ', overshoot ' + e.overshoot.toFixed(2) : '') + (e.colour ? ', ' + e.colour : '') + (e.confidence < 0.4 ? ' (unsure)' : '');

const quote = (t: string): string => '"' + t.replace(/"/g, "'") + '"';

/** A phrase belongs to the shot in which it starts. */
const saidIn = (phrases: Phrase[], s: ShotMeasure): Phrase[] => phrases.filter((p) => p.start >= s.start && p.start < s.end);

/** The indexes of the beats on screen or said during a shot, as "beat 3" or "beats 3-5". */
const beatRange = (beats: Beat[], s: ShotMeasure): string => {
  const mine = beats.flatMap((b, i) => (b.start < s.end && b.end > s.start ? [i] : []));
  if (!mine.length) return '';
  return mine.length === 1 ? 'beat ' + mine[0] : 'beats ' + mine[0] + '-' + mine[mine.length - 1];
};

/** A very short shot that is part of the change after it (frames.ts, joinedShots), in a few words. */
const joinedText = (s: ShotMeasure, fps: number, sheet: string | undefined): string =>
  'most likely part of the change into #' + two(s.index + 2) + ': ' + ((s.end - s.start) / fps).toFixed(2) + ' s on a flat ground with a moving element right before it,'
  + ' one effect across the boundary, not a designed picture of its own' + (sheet ? '; look at ' + sheet : '');

const timelineLine = (s: ShotMeasure, into: Boundary | undefined, out: Boundary | undefined, cues: TextCue[], beats: Beat[], fps: number, step: number, p: Pictures): string => {
  const inShot = (c: TextCue, sh: ShotMeasure): boolean => shownIn(c, sh, step);
  const k = s.index;
  const together = p.joined.has(k - 1) ? ', one effect with #' + two(k) + ' before it' : '';
  const path = pathInto(p, k);
  const parts = ['#' + two(k + 1) + ' ' + sec(s.start, fps) + '-' + sec(s.end, fps) + ' @' + s.start + '-' + s.end, 'in ' + transitionText(into, sheetInto(into, k, p)) + together + (path ? '; ' + trackBrief(path, fps) : ''), 'camera ' + cameraText(s)];
  if (p.joined.has(k)) parts.push(joinedText(s, fps, sheetInto(out, k + 1, p)));
  const range = beatRange(beats, s);
  if (range) parts.push(range);
  // A bar's words stay through the video (REFERENCE.md names it); a shot says which word it marks.
  const titles = cues.filter((c) => (c.role === 'title' || c.role === 'label') && !c.bar && inShot(c, s));
  if (titles.length) parts.push('text ' + titles.slice(0, 4).map((c) => quote(c.text)).join(' ') + (titles.length > 4 ? ' +' + (titles.length - 4) : ''));
  const lit = cues.find((c) => c.bar?.highlighted?.some(([f, t]) => Math.min(t, s.end) - Math.max(f, s.start) > 0.5 * (s.end - s.start)));
  if (lit) parts.push('bar marks ' + quote(lit.text));
  const written = cues.filter((c) => c.role === 'in-picture' && inShot(c, s)).length;
  if (written >= 8) parts.push('footage with ' + written + ' lines of its own text');
  if (s.events.length) parts.push('motion ' + s.events.length + ' event' + (s.events.length === 1 ? '' : 's'));
  const act = p.activity[k];
  if (act) parts.push(movementBrief(act));
  if (s.background) parts.push('ground ' + s.background);
  return parts.join(' | ');
};

const shotFile = (s: ShotMeasure, into: Boundary | undefined, out: Boundary | undefined, cues: TextCue[], phrases: Phrase[], beats: Beat[], fps: number, step: number, looks: ShotLooks | undefined, p: Pictures): string => {
  const inShot = (c: TextCue, sh: ShotMeasure): boolean => shownIn(c, sh, step);
  const k = s.index;
  const L: string[] = ['# Shot ' + two(k + 1) + ': ' + sec(s.start, fps) + '-' + sec(s.end, fps) + ' s, frames ' + s.start + '-' + (s.end - 1) + ' (' + (s.end - s.start) + ' frames)', ''];
  if (p.written) L.push('- Frames: ' + shotSheetFile(k + 1) + ' (from ' + LEAD_IN + ' s before the change into it to its end). Open it: what it shows wins over the lines below.');
  const range = beatRange(beats, s);
  if (range) L.push('- ' + range.charAt(0).toUpperCase() + range.slice(1) + ' (timeline.md)');
  const inSheet = sheetInto(into, k, p), outSheet = sheetInto(out, k + 1, p);
  // A label that does not fit already names its picture; one that fits gets it at the end of the line.
  const link = (b: Boundary | undefined, sheet: string | undefined): string => (b && sheet && !fitsPoorly(b) ? '; frame by frame: ' + sheet : '');
  L.push('- In: ' + transitionText(into, inSheet) + (into && into.kind !== 'cut' ? ', mixed on frames ' + (into.start + 1) + '-' + (into.end - 1) + ', confidence ' + into.confidence.toFixed(2) : '')
    + (p.joined.has(k - 1) ? '; one effect with shot ' + two(k) + ' before it' : '') + link(into, inSheet) + (into ? tag(kindKnown(into, pathInto(p, k))) : ''));
  L.push('- Out: ' + (out ? transitionText(out, outSheet) + link(out, outSheet) + tag(kindKnown(out, pathInto(p, k + 1))) : 'end of the video'));
  if (into && into.kind !== 'cut' && p.measure.tracks && !pathInto(p, k)) L.push('- Path of the change in:' + tag(NO_PATH) + ' The frames show it' + (inSheet ? ' (' + inSheet + ')' : '') + '.');
  if (p.joined.has(k)) L.push('- This shot is ' + joinedText(s, fps, outSheet) + '. Re-make the two as one effect, a scene that draws it.');
  L.push('- Camera: ' + cameraText(s) + (s.camera.kind !== 'unknown' ? ' (confidence ' + s.camera.confidence.toFixed(2) + ')' : '') + tag(cameraKnown(s)));
  // Where a clear zoom or pan goes, as a box a capture plan or a scene camera can aim at ([x, y, width, height]).
  const aim = cameraAim(s, fps);
  if (aim) L.push('- The camera ' + aimText(aim) + ' ([x, y, width, height] of the canvas)');
  const amount = p.amounts[k];
  if (amount !== undefined) L.push('- Motion amount: ' + amount + (p.amount !== undefined ? ' (the whole video: ' + p.amount + ')' : '') + '. The mean change of the picture between frames 1/15 s apart, in levels of 255; 0 is a still picture.' + tag(amountKnown(p.measure, k)));
  const act = p.activity[k];
  if (act) L.push(movementLine(act, k + 1, p.written) + tag(amountKnown(p.measure, k)));
  if (s.background) L.push('- Ground colour: ' + s.background + (s.palette.length ? '; palette ' + s.palette.slice(0, 5).map((p) => p.hex + ' ' + pct(p.share)).join(', ') : '') + tag(MEASURED));
  // A hint, not a finding: said only when the measured facts agree (kind.ts), for the pictures to confirm or correct. A
  // shot that is part of an effect is not a picture of its own kind.
  if (looks && !p.joined.has(k)) L.push('- Most likely: ' + looksText(looks) + '. The pictures confirm or correct this.' + tag({ status: 'inferred', basis: 'from the measured facts named' }));
  const said = saidIn(phrases, s);
  if (said.length) {
    L.push('', '## Said (recognised speech; names are often misheard, a caption is the better spelling)', '');
    for (const p of said) L.push('- @' + p.start + '-' + p.end + ' ' + quote(p.text) + (p.confidence < 0.6 ? ' (unsure)' : '') + ': ' + p.words.map((w) => w.text + '@' + w.start).join(' '));
  }
  const mine = cues.filter((c) => inShot(c, s));
  const overlay = mine.filter((c) => c.role !== 'in-picture' && !c.bar);
  const bar = mine.filter((c) => c.bar).sort((a, b) => (a.bar?.at ?? 0) - (b.bar?.at ?? 0));
  if (overlay.length || bar.length) {
    L.push('', '## Text laid over the picture', '');
    for (const c of overlay) L.push('- ' + c.role + ' ' + quote(c.text) + ' @' + c.start + '-' + c.end + ', ' + where(c.box) + ' [' + boxText(c.box) + '], height ' + pct(c.size));
    const lit = bar.find((c) => c.bar?.highlighted?.some(([f, t]) => Math.min(t, s.end) - Math.max(f, s.start) > 0.5 * (s.end - s.start)));
    const x0 = Math.min(...bar.map((c) => c.box[0])), x1 = Math.max(...bar.map((c) => c.box[0] + c.box[2])), y0 = Math.min(...bar.map((c) => c.box[1])), y1 = Math.max(...bar.map((c) => c.box[1] + c.box[3]));
    if (bar.length) L.push('- bar (through the video, REFERENCE.md) ' + bar.map((c) => quote(c.text)).join(' ') + ', ' + where([x0, y0, x1 - x0, y1 - y0]) + ', height ' + pct(bar[0]?.size ?? 0) + (lit ? '; ' + quote(lit.text) + ' is marked here' : ''));
  }
  const own = mine.filter((c) => c.role === 'in-picture').sort((a, b) => b.size - a.size);
  if (own.length) {
    L.push('', '## Text that belongs to the footage (' + own.length + ' lines; the largest)', '');
    for (const c of own.slice(0, 8)) L.push('- ' + quote(c.text) + ' ' + where(c.box) + ', height ' + pct(c.size));
  }
  if (s.events.length) {
    L.push('', '## Motion events', '');
    for (const e of s.events) L.push('- ' + eventText(e, fps) + tag({ status: 'measured', confidence: e.confidence, basis: '' }));
  }
  // The change into the shot, the change out of a shot that is part of it, and the shot's own elements that travel.
  const paths = [pathInto(p, k), ...(p.joined.has(k) ? [pathInto(p, k + 1)] : []), ...p.tracks.filter((t) => t.of === 'event' && t.shot === k + 1)].filter((t): t is Trajectory => t !== undefined);
  if (paths.length) {
    L.push('', '## Paths (positions are fractions of the canvas; angles: ' + ANGLES + '; samples in ' + TRACKS_FILE + ')', '');
    for (const t of paths) L.push('- ' + trackText(t, fps));
  }
  return L.join('\n') + '\n';
};

/**
 * What is behind the caption letters, in a few words: "#ffffff letters on a plate #000000 at 60%, padding 0.3, radius
 * 0.2". A colour the measurement was not sure of is said to be unsure, never guessed.
 */
const lookText = (l: CaptionLook): string => {
  const plate = l.plate;
  const letters = (l.color ?? 'unsure-coloured') + (l.weight ? ' ' + l.weight : '') + ' letters';
  const share = l.highlight?.share ?? (l.highlight ? l.highlight.lines / Math.max(1, l.samples) : 0);
  const reveal = l.reveal && l.reveal.confidence >= 0.6
    ? '; each line ' + (l.reveal.kind === 'whole' ? 'appears whole at once' : 'builds up ' + (l.reveal.kind === 'words' ? 'word by word' : 'character by character') + (l.reveal.seconds ? ' over ' + l.reveal.seconds + ' s' : '')) + ' (' + l.reveal.lines + ' of ' + l.reveal.of + ' line starts measured)'
    : '';
  const lit = (l.highlight?.color ? '; a word or two of ' + l.highlight.lines + ' of ' + l.samples + ' lines in ' + l.highlight.color + ' (' + oneIn(share) + ')' : '') + reveal;
  if (l.kind === 'plate' && plate) return letters + ' on a plate ' + plate.color + (plate.opacity < 1 ? ' at ' + pct(plate.opacity) : '') + ', padding ' + plate.padding + ', radius ' + plate.radius + ' of the font size' + lit;
  if (l.kind === 'outline') return letters + ' with ' + (l.outline?.color ? 'a ' + l.outline.color : 'an unsure-coloured') + ' outline' + (l.shadow ? ' and a shadow under it' : '') + lit;
  if (l.kind === 'shadow') return letters + ' with ' + (l.shadow?.color ? 'a ' + l.shadow.color : 'an unsure-coloured') + ' shadow' + lit;
  return 'plain ' + letters + ' (no plate, outline or shadow)' + lit;
};

const histogram = (xs: string[]): string => {
  const n = new Map<string, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' x' + v).join(', ');
};

/** How many frames a caption line appears before (negative) or after its words begin, over the lines that have words. */
const captionLead = (cues: TextCue[], phrases: Phrase[]): { n: number; mean: number; worst: number } => {
  const words = phrases.flatMap((p) => p.words);
  const leads = cues.filter((c) => c.role === 'caption').flatMap((c) => {
    const inside = words.filter((w) => w.start < c.end + 6 && w.end > c.start - 6);
    return inside.length ? [c.start - (inside[0]?.start ?? c.start)] : [];
  });
  const mean = leads.reduce((a, b) => a + b, 0) / Math.max(1, leads.length);
  return { n: leads.length, mean: Math.round(mean * 10) / 10, worst: Math.max(0, ...leads.map((x) => Math.abs(x))) };
};

/** One line about the beats for the card: how many, and what kind. */
const beatsLine = (beats: Beat[], transcript: Transcript | undefined, text: TextTrack | undefined): string => {
  if (!beats.length) return '- Beats: none (no caption was read and no speech was heard)';
  const only = beats.filter((b) => !b.shown).length, silent = beats.filter((b) => b.shown && !b.said).length;
  const both = beats.length - only - silent;
  const said = transcript?.words.length ? [both ? both + ' shown and said' : '', only ? only + ' spoken only' : '', silent ? silent + ' shown in silence' : ''] : [beats.length + ' shown'];
  const left = uncoveredSpeech(beats, transcript, { tolerance: coverTolerance(text), strays: true });
  return '- Beats: ' + beats.length + ' (timeline.md numbers them as the plan\'s captions), ' + said.filter(Boolean).join(', ') + (left.words ? '; ' + left.seconds + ' s of speech in none' : '');
};

/** The pictures block of the card: what each picture holds, and that the frames win over the labels. */
const picturesBlock = (m: Measure): string[] => {
  const into = m.boundaries.flatMap((b, k) => (b.kind === 'cut' ? [] : [two(k + 2)]));
  return [
    '', '## Pictures: open every one before writing a plan', '',
    'The labels in these files (a transition\'s kind, "Most likely") are measurements and can be wrong. When the frames show something else, the frames win; an effect that is not a standard transition is re-made as a scene that draws it.', '',
    '- ' + OPENING_FILE + ': the first ' + OPENING_SECONDS + ' s, ' + OPENING_PER_SECOND + ' frames a second',
    '- shots/NN-frames.jpg: each shot from ' + LEAD_IN + ' s before the change into it to its end, up to ' + SHOT_FRAMES + ' frames',
    into.length
      ? '- transitions/NN.jpg: each change that is not a plain cut, frame by frame from ' + AROUND + ' s before to ' + AROUND + ' s after, named by the shot it leads into: ' + into.join(', ')
      : '- transitions/: none, every change is a plain cut',
    '- The time of each frame is under it; a time on an orange band is a frame inside a measured transition.',
  ];
};

/** Open questions about the transitions: labels the frames do not fit, and short shots that are part of an effect. */
const effectQuestions = (m: Measure, p: Pictures): string[] => {
  const where = (k: number): string => (p.written ? transitionFile(k + 2) : 'the change into shot ' + two(k + 2));
  const poor = m.boundaries.flatMap((b, k) => (fitsPoorly(b) ? [where(k) + ' (' + [b.kind, b.mode, b.direction].filter(Boolean).join(' ') + ')'] : []));
  const joined = [...p.joined].map((k) => 'shot ' + two(k + 1) + ' with ' + where(k));
  const own = p.tracks.filter(ownEffect).map((t) => (p.written ? transitionFile(t.shot) : 'the change into shot ' + two(t.shot)) + ' (' + trackBrief(t, m.source.fps).replace('path: ', '') + ')');
  return [
    ...(own.length ? ['- ' + own.length + ' change' + (own.length === 1 ? ' is' : 's are') + ' not a standard transition by ' + (own.length === 1 ? 'its' : 'their') + ' measured path: ' + own.join(', ') + '. Re-make each as a scene set from the path in its shot\'s file.'] : []),
    ...(poor.length ? ['- ' + poor.length + ' measured transition kind' + (poor.length === 1 ? ' does' : 's do') + ' not fit the frames well: ' + poor.join(', ') + '. Each may be an effect of its own: look at it first.'] : []),
    ...(joined.length ? ['- Very short shots that are most likely part of the effect after them: ' + joined.join(', ') + '.'] : []),
  ];
};

const card = (m: Measure, text: TextTrack | undefined, transcript: Transcript | undefined, phrases: Phrase[], beats: Beat[], name: string, tokens: Record<string, number>, inset: Inset | undefined, p: Pictures, lost: readonly Unrecovered[], speech?: SpeechFile): string => {
  const { fps, frames, width, height, duration, hasAudio } = m.source;
  const lengths = m.shots.map((s) => (s.end - s.start) / fps);
  const L: string[] = ['# Reference: ' + name, ''];
  L.push('Measured by programs. Frame numbers (@) are frames of this video at ' + (Number.isInteger(fps) ? String(fps) : fps.toFixed(3)) + ' fps; use them, rounded seconds can be a frame off.', '');
  L.push('- Length ' + duration.toFixed(2) + ' s (' + frames + ' frames), ' + width + 'x' + height + (width > height ? ' landscape' : width < height ? ' portrait' : ' square') + ', ' + (hasAudio ? 'with sound' : 'silent'));
  L.push('- ' + m.shots.length + ' shots, ' + (m.boundaries.length / Math.max(duration / 60, 1e-6)).toFixed(0) + ' changes a minute; shot length ' + Math.min(...lengths).toFixed(1) + ' to ' + Math.max(...lengths).toFixed(1) + ' s, mean ' + (lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length)).toFixed(1) + ' s');
  if (m.boundaries.length) L.push('- Changes between shots: ' + histogram(m.boundaries.map((b) => b.kind)));
  const moving = m.shots.filter((s) => s.camera.kind === 'move').length;
  L.push('- Camera moves in ' + moving + ' of ' + m.shots.length + ' shots; ' + m.shots.reduce((n, s) => n + s.events.length, 0) + ' motion events in all');
  const moved = p.amounts.flatMap((a, k) => (a === undefined ? [] : [{ a, k }])).sort((x, y) => x.a - y.a);
  if (p.amount !== undefined && moved.length)
    L.push('- Motion amount: ' + p.amount + ' over the video, by shot from ' + moved[0]?.a + ' (#' + two((moved[0]?.k ?? 0) + 1) + ') to ' + moved[moved.length - 1]?.a + ' (#' + two((moved[moved.length - 1]?.k ?? 0) + 1) + '): the mean change of the picture between frames 1/15 s apart, in levels of 255 (0 is a still picture); shots/NN.md has each shot\'s');
  const movement = movementCardLine(p.activity, p.written);
  if (movement) L.push(movement);
  if (inset) L.push('- ' + insetText(inset, m.shots.length));
  if (text) {
    const captions = text.cues.filter((c) => c.role === 'caption');
    if (captions.length) {
      const y = captions.map((c) => c.box[1] + c.box[3] / 2).sort((a, b) => a - b)[Math.floor(captions.length / 2)] ?? 0;
      const size = captions.map((c) => c.size).sort((a, b) => a - b)[Math.floor(captions.length / 2)] ?? 0;
      L.push('- Captions: ' + captions.length + ' lines in a band at ' + pct(y) + ' of the height, line height ' + pct(size) + ', ' + (captions.reduce((n, c) => n + c.end - c.start, 0) / captions.length / fps).toFixed(1) + ' s each on average' + (text.captionLook ? '; ' + lookText(text.captionLook) : ''));
    } else L.push('- Captions: none found');
    const marks = [...new Set(text.cues.filter((c) => c.role === 'watermark').map((c) => c.text))];
    if (marks.length) L.push('- Watermark text (not to be re-created): ' + marks.slice(0, 4).map(quote).join(', '));
    for (const bar of barsOf(text.cues, m.shots)) {
      const marked = markedText(bar);
      L.push('- A bar laid on in the edit through the video (design text a re-make draws, not a watermark): ' + bar.words.map((c) => quote(c.text)).join(' ') + ' at ' + pct((bar.words[0]?.box[1] ?? 0) + (bar.words[0]?.box[3] ?? 0) / 2) + ' of the height' + (marked ? '; the marked word follows the shots: ' + marked : ''));
    }
    const own = text.cues.filter((c) => c.role === 'in-picture').length;
    if (own) L.push('- ' + own + ' lines of text belong to the footage itself (pages, interfaces, documents)');
  } else L.push('- On-screen text was not read (no text reader was available)');
  if (transcript && transcript.words.length) {
    const spoken = transcript.words.reduce((n, w) => n + w.end - w.start, 0) / fps;
    const unsureWords = transcript.words.filter((w) => w.confidence < 0.6).length;
    L.push('- Speech: language ' + transcript.language + ', ' + transcript.words.length + ' words in ' + phrases.length + ' phrases, spoken for ' + spoken.toFixed(1) + ' s of ' + duration.toFixed(1) + ' s; ' + unsureWords + ' words were recognised with low confidence');
    if (text) {
      const lead = captionLead(text.cues, phrases);
      if (lead.n >= 2) L.push('- Captions and speech: a caption line appears ' + Math.abs(lead.mean) + ' frames ' + (lead.mean <= 0 ? 'before' : 'after') + ' its first word on average (' + lead.n + ' lines, at most ' + lead.worst + ' frames apart; the caption times are exact to about ' + Math.ceil(text.step / 2) + ' frames)');
    }
    if (speech) L.push(kindLine(speech));
  } else L.push(speech ? kindLine(speech) : transcript ? '- Speech: none recognised' : '- Speech was not transcribed (no transcriber was available)');
  L.push(beatsLine(beats, transcript, text));
  const dialogue = beats.flatMap((b, i) => (b.speech === 'on-camera' ? [i] : []));
  if (dialogue.length) L.push('- Dialogue beats (a visible person says them; timeline.md marks them "on camera"): ' + dialogue.join(', ') + '. No voice-over reads them: the person of the re-make says them in a clip');
  L.push('- ' + LEGEND);
  if (p.written) L.push(...picturesBlock(m));
  L.push('', '## Not recovered', '');
  L.push('What the reading could not tell, one entry each (all of them, as data, in ' + UNRECOVERED_FILE + '). Settle what you can from the pictures; append what stays open, and what you could not see yourself, to "unrecovered" in elements.json. The delivery notes list every entry that is still open with what was assumed instead.', '');
  L.push(...lost.slice(0, LISTED).map(unrecoveredLine), ...(lost.length > LISTED ? ['- ' + (lost.length - LISTED) + ' more in ' + UNRECOVERED_FILE + '.'] : []));
  L.push(...effectQuestions(m, p));
  if (!lost.length) L.push('- Nothing from the measurement: every value above was read.');
  L.push(transcript ? '- What each shot shows is not in this description: that needs a vision model.' : '- What each shot shows, and what was said, are not in this description: they need a vision model and a transcript.');
  L.push('', '## Files', '', '| File | What it holds | About how many tokens |', '|---|---|---|');
  L.push('| timeline.md | The numbered beats; one line per shot: time, the change into it, camera, its beats, text, motion | ' + (tokens['timeline.md'] ?? 0) + ' |');
  L.push('| shots/NN.md | Everything measured about one shot | ' + Math.round(Object.entries(tokens).filter(([k]) => k.startsWith('shots/')).reduce((n, [, v]) => n + v, 0) / Math.max(1, m.shots.length)) + ' each |');
  if (p.written) {
    L.push('| ' + OPENING_FILE + ', shots/NN-frames.jpg, transitions/NN.jpg | The pictures above: consecutive frames, each with its time | one picture each |');
  }
  if (m.tracks?.length) L.push('| ' + TRACKS_FILE + ' | The sampled positions of ' + m.tracks.length + ' path' + (m.tracks.length === 1 ? '' : 's') + ' (an object or an edge of a transition, an element that travels); shots/NN.md has each in a line | - |');
  L.push('| measure.json | All measured data. Do not read it whole | - |');
  return L.join('\n') + '\n';
};

/** One beat of timeline.md: its index, its time, whether it was only said, what was said or shown, and a mark when unsure. */
const beatText = (b: Beat, i: number, fps: number): string =>
  i + ' ' + sec(b.start, fps) + '-' + sec(b.end, fps) + (b.shown ? '' : ' spoken only') + (b.speech === 'on-camera' ? ' on camera' : '') + ' ' + quote(b.text) + (b.confidence < UNSURE ? ' (unsure)' : '');

const timeline = (m: Measure, cues: TextCue[], beats: Beat[], step: number, p: Pictures): string => {
  const fps = m.source.fps;
  const shots = m.shots.map((s, k) => timelineLine(s, k > 0 ? m.boundaries[k - 1] : undefined, m.boundaries[k], cues, beats, fps, step, p));
  return [
    '# Timeline', '', '## Beats', '',
    'What is said or shown as a caption, once each, in time order (seconds). The plan\'s "captions" follow this list: captions[i] is the new line of beat i. "spoken only": said with no caption on screen; its new line is spoken, not drawn. "on camera": a visible person says it; its new line is said by the person of a generated clip, never by a voice-over. "(unsure)": the reader or the recogniser was not sure.', '',
    ...(beats.length ? beats.map((b, i) => beatText(b, i, fps)) : ['None: no caption was read and no speech was heard.']), '',
    '## Shots', '',
    'One shot per line: #number start-end (seconds) @first-last frame | in: how the shot begins | camera | the beats in it | other text | motion | movement (moves throughout, enters then holds, moves in parts, still: a shot that MOVES THROUGHOUT has its frames opened before its scene is written).'
      + (p.written ? ' The frames of shot NN are in shots/NN-frames.jpg, those of a change into it in transitions/NN.jpg: what they show wins over these labels.' : ''), '',
    ...shots,
  ].join('\n') + '\n';
};

/**
 * name: what to call the reference in the card (not a file name of a private data set). inset: the frame around the
 * content (inset.ts). o.pictures: the pictures of frames.ts were written beside the text, which then names them.
 * o.speech: the record of the speech's kind (speech-kind.ts): the card says it, and confirmed kinds shape the beats.
 */
export const describeReference = (m: Measure, text: TextTrack | undefined, name: string, transcript?: Transcript, inset?: Inset, o: { pictures?: boolean; speech?: SpeechFile } = {}): Description => {
  const p: Pictures = { written: o.pictures === true, joined: joinedShots(m), amounts: m.shots.map((_s, k) => shotAmount(m, k)), activity: activities(m), amount: videoAmount(m), tracks: m.tracks ?? [], measure: m };
  const fps = m.source.fps;
  const boundaries = m.boundaries.map((b) => b.frame);
  const kinds = kindRanges(o.speech);
  const read = referenceBeats({ ...(text ? { text } : {}), ...(transcript ? { transcript } : {}), total: m.source.frames, boundaries, ...(kinds ? { kinds } : {}) });
  const roles = read.text;
  const cues = roles?.cues ?? [];
  const phrases = transcript ? phrasesOf(transcript, { boundaries }) : [];
  const files: Record<string, string> = {};
  // A cue belongs to the shots it overlaps by more than half a reading step (kind.ts, shownIn).
  const step = roles?.step ?? 0;
  files['timeline.md'] = timeline(m, cues, read.beats, step, p);
  // Without a text reader the text facts are unknown, not absent: shotLooks is given no cues then.
  m.shots.forEach((s, k) => { files['shots/' + two(k + 1) + '.md'] = shotFile(s, k > 0 ? m.boundaries[k - 1] : undefined, m.boundaries[k], cues, phrases, read.beats, fps, step, shotLooks(s, roles?.cues, step), p); });
  const tokens = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, roughTokens(v)]));
  const unrecovered = unrecoveredOf(m, { text: roles, transcript, beats: read.beats, ...(o.speech ? { speech: o.speech } : {}) });
  files['REFERENCE.md'] = card(m, roles, transcript, phrases, read.beats, name, tokens, inset, p, unrecovered, o.speech);
  tokens['REFERENCE.md'] = roughTokens(files['REFERENCE.md']);
  return { files, tokens, unrecovered };
};
