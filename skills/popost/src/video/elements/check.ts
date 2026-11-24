/**
 * elements.json held to the measurement: a shot without an entry, a custom change with no description, a change the
 * measurement says its label does not fit that the reading calls standard without saying why, a watermark the text
 * reader found that no platform layer covers, captions read in a shot with no caption layer, a mark that does not say
 * why it is there, and a last shot made mostly of the platform's or the author's layers (an end card, which a re-make
 * never copies), and the labels of how each field is known held to the reading (status.ts). Each finding names its place and gives one fix, for the model that wrote the file. Pure.
 */
import { fitsPoorly, shotSheetFile, transitionFile } from '../describe/frames';
import { shownIn } from '../describe/kind';
import { error, warning } from '../project/check-common';
import type { TextTrack } from '../text/types';
import type { Boundary, Box, Measure, Problem } from '../types';
import type { ReadElements } from './read';
import { isDropped, ROLES, type ShotReading } from './types';
import { countLabels, statusProblems, unknownProblems, type LabelCounts } from './status';

/** A shot's time may differ from the measured one by this much (seconds) before it is worth a word. */
const TIME_SLACK = 0.25;
/** A layer covers a text when it holds this share of the text's box. */
const COVER = 0.5;

const two = (n: number): string => String(n).padStart(2, '0');
const quote = (t: string): string => '"' + t.replace(/"/g, "'") + '"';
const clip = (t: string, n: number): string => (t.length > n ? t.slice(0, n - 1) + '…' : t);
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Numbers as runs: 2-4, 7. */
const runs = (xs: readonly number[]): string => {
  const out: string[] = [];
  for (let k = 0; k < xs.length; k++) {
    let j = k;
    while (j + 1 < xs.length && (xs[j + 1] ?? 0) === (xs[j] ?? 0) + 1) j++;
    out.push(j > k ? xs[k] + '-' + xs[j] : String(xs[k]));
    k = j;
  }
  return out.join(', ');
};

/** The share of box a that box b covers. */
export const covered = (a: Box, b: Box): number => {
  const w = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return (w * h) / Math.max(1e-9, a[2] * a[3]);
};

/** The smallest box around some boxes. */
const around = (boxes: readonly Box[]): Box => {
  const x0 = Math.min(...boxes.map((b) => b[0])), y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2])), y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  return [r3(x0), r3(y0), r3(x1 - x0), r3(y1 - y0)];
};

/** A measured change in the words describe writes: "slide cover right". */
export const measuredLabel = (b: Boundary): string => [b.kind, b.mode, b.direction, b.via ? 'via ' + b.via : ''].filter(Boolean).join(' ');

interface Context { r: ReadElements; m: Measure; text?: TextTrack | undefined; at: (shot: number) => string; byNumber: (shot: number) => ShotReading | undefined }

const coverageProblems = ({ r, m, at }: Context): Problem[] => {
  const fps = m.source.fps, s2 = (f: number): string => (f / fps).toFixed(2);
  const missing = m.shots.filter((s) => !r.present.includes(s.index + 1)).map((s) =>
    error('shots', 'Shot ' + (s.index + 1) + ' (' + s2(s.start) + '-' + s2(s.end) + ' s) has no entry.', 'Open ' + shotSheetFile(s.index + 1) + ' and add {"shot": ' + (s.index + 1) + ', "time": [' + s2(s.start) + ', ' + s2(s.end) + '], "layout": "...", "layers": [...]} for it.'));
  const extra = r.present.filter((n) => n > m.shots.length).map((n) =>
    error(at(n) + '.shot', 'There is no shot ' + n + ': the measurement has ' + m.shots.length + '.', 'Remove the entry, or give it the number of the shot it describes.'));
  const times = r.elements.shots.flatMap((s) => {
    const ms = m.shots[s.shot - 1];
    if (!ms || (Math.abs(s.time[0] - ms.start / fps) <= TIME_SLACK && Math.abs(s.time[1] - ms.end / fps) <= TIME_SLACK)) return [];
    return [warning(at(s.shot) + '.time', 'Shot ' + s.shot + ' is ' + s2(ms.start) + '-' + s2(ms.end) + ' s in the measurement; its entry says ' + s.time[0] + '-' + s.time[1] + ' s.', 'Copy the measured time, [' + s2(ms.start) + ', ' + s2(ms.end) + ']: entries go by the measured shots. Where the frames show a change the measurement missed, say so in "rebuild".')];
  });
  return [...missing, ...extra, ...times];
};

const transitionProblems = ({ r, m, at }: Context): Problem[] =>
  r.elements.shots.flatMap((s): Problem[] => {
    const here = at(s.shot) + '.transitionIn', t = s.transitionIn;
    if (s.shot === 1) return t && t.kind !== 'cut' ? [error(here, 'Shot 1 has no change into it, and its entry gives one (' + t.kind + ').', 'Leave "transitionIn" out of shot 1 and say how the video opens in the "enters" of its layers.')] : [];
    const b = m.boundaries[s.shot - 2];
    if (!b) return [];
    const pic = b.kind === 'cut' ? '' : transitionFile(s.shot);
    const look = pic ? ' (look at ' + pic + ')' : '';
    if (!t) return [warning(here, 'Shot ' + s.shot + ' does not say how it begins.', 'Write the change into it as the frames show it' + look + ': {"kind": "cut"}, a standard kind with "seconds", or {"kind": "custom", "seconds": ..., "description": "..."}.')];
    if (t.kind === 'custom' && !t.description)
      return [error(here + '.description', 'The change into shot ' + s.shot + ' is "custom" and has no "description".', 'Say frame by frame what happens' + (pic ? ' in ' + pic : '') + ': which object moves and along which path, the shape of the edge, what is revealed.')];
    if (t.kind !== 'custom' && fitsPoorly(b) && !t.description)
      return [warning(here, 'The measurement says its label for the change into shot ' + s.shot + ' (' + measuredLabel(b) + ') does not fit the frames, and the reading calls it "' + t.kind + '" without saying why.',
        'Look at ' + pic + ' frame by frame. If no standard transition makes what it shows, write "kind": "custom" with a "description" (which object moves, its path, the edge, what is revealed); if "' + t.kind + '" is right, say in "description" what makes it one.')];
    return [];
  });

const watermarkProblems = ({ m, text, at, byNumber }: Context): Problem[] => {
  const step = text?.step ?? 0;
  return (text?.cues ?? []).filter((c) => c.role === 'watermark').flatMap((c) => {
    const shots = m.shots.filter((s) => shownIn(c, s, step)).map((s) => s.index + 1);
    const bare = shots.filter((n) => {
      const s = byNumber(n);
      return s !== undefined && !s.drop && !s.layers.some((l) => isDropped(l.role) && covered(c.box, l.box) >= COVER);
    });
    if (!bare.length) return [];
    const box = '[' + c.box.map(r3).join(', ') + ']';
    return [warning(at(bare[0] ?? 1) + '.layers', 'The measurement read ' + quote(c.text) + ' as a watermark at ' + box + ' in shot' + (shots.length > 1 ? 's ' : ' ') + runs(shots) + '; no platform layer covers it in shot' + (bare.length > 1 ? 's ' : ' ') + runs(bare) + '.',
      'Add {"id": "watermark", "kind": "platform", "role": "platform", "box": ' + box + ', "look": "...", "content": ' + quote(c.text) + '} to ' + (bare.length > 1 ? 'each of them' : 'that shot') + ' (role creator when it is the author\'s name): a re-make never draws it.')];
  });
};

const captionProblems = ({ r, m, text, at }: Context): Problem[] => {
  const step = text?.step ?? 0;
  return r.elements.shots.flatMap((s) => {
    const ms = m.shots[s.shot - 1];
    if (!ms || s.drop || s.layers.some((l) => l.kind === 'caption')) return [];
    const lines = (text?.cues ?? []).filter((c) => c.role === 'caption' && shownIn(c, ms, step));
    if (!lines.length) return [];
    return [warning(at(s.shot) + '.layers', 'The measurement read ' + lines.length + ' caption line' + (lines.length === 1 ? '' : 's') + ' in shot ' + s.shot + ' (' + quote(clip(lines[0]?.text ?? '', 40)) + '), and the reading has no layer of kind "caption".',
      'Add {"id": "captions", "kind": "caption", "role": "design", "box": [' + around(lines.map((c) => c.box)).join(', ') + '], "look": "<the letters and their plate or outline>"} and their style as "captions": {"base": "...", "highlight": "..."}.')];
  });
};

const markProblems = ({ r, at }: Context): Problem[] =>
  r.elements.shots.flatMap((s) => {
    const here = at(s.shot);
    const marks = s.emphasis ?? [];
    const noWhy = marks.flatMap((e, j) => (e.why ? [] : [warning(here + '.emphasis[' + j + '].why', 'The ' + e.what + ' on ' + quote(e.on) + ' in shot ' + s.shot + ' does not say why it is there.',
      'Say in "why" what the line at that moment says that makes ' + quote(e.on) + ' worth marking: the re-make puts the same kind of mark on what its own line talks about.')]));
    const unexplained = marks.length ? [] : s.layers.filter((l) => l.kind === 'highlight' || l.kind === 'pointer').map((l) =>
      warning(here + '.layers', 'Layer "' + l.id + '" of shot ' + s.shot + ' is a ' + l.kind + ', and the shot has no "emphasis" that says what it marks and why.',
        'Add "emphasis": [{"what": "' + (l.kind === 'pointer' ? 'pointer' : 'box') + '", "on": "<what it marks>", "why": "<what the line at that moment says>"}].'));
    return [...noWhy, ...unexplained];
  });

const endProblems = ({ r, m, at, byNumber }: Context): Problem[] => {
  const shots = r.elements.shots;
  const kept = shots.filter((s) => !s.drop && s.shot <= m.shots.length).map((s) => s.shot);
  const lastKept = Math.max(0, ...kept);
  const out = shots.filter((s) => s.drop && s.shot < lastKept).map((s) =>
    error(at(s.shot) + '.drop', 'Shot ' + s.shot + ' is dropped whole, and shot ' + lastKept + ' after it is not: only shots at the end can be dropped (the platform\'s end card, the author\'s sign-off).', 'Remove "drop" and mark its platform and author layers with those roles: the shot is re-made with the new subject, without them.'));
  if (shots.length && !kept.length) out.push(error('shots', 'Every shot is dropped: nothing would be re-made.', 'Remove "drop" from every shot but the platform\'s or the author\'s own at the end.'));
  // The last shot that is re-made (a shot without an entry counts as re-made).
  let end = m.shots.length;
  while (end > 1 && byNumber(end)?.drop) end--;
  if (byNumber(end)?.sameEffectAsNext)
    out.push(warning(at(end) + '.sameEffectAsNext', 'Shot ' + end + ' is the last one re-made, and its entry says an animation runs on into the next.', 'Leave "sameEffectAsNext" out of the last shot.'));
  const last = byNumber(m.shots.length);
  const own = last && !last.drop ? last.layers.filter((l) => l.kind !== 'ground') : [];
  const theirs = own.filter((l) => isDropped(l.role));
  if (last && own.length && theirs.length * 2 > own.length)
    out.push(warning(at(last.shot), 'The last shot (' + last.shot + ') is made mostly of the platform\'s or the author\'s layers (' + theirs.map((l) => l.id).join(', ') + '): an end card, which a re-make never copies.',
      'Write "drop": "the platform\'s end card; the re-make ends with its own closing": template save leaves the shot out and the shot before it becomes the re-make\'s closing. If the re-make keeps the shot, give the layers it keeps the role design or content.'));
  return out;
};

/** One line per measured shot: its time, layout, the change into it, its layers by role, its marks and captions. */
const summaryOf = ({ m, byNumber }: Context): string[] =>
  m.shots.map((ms, k) => {
    const n = k + 1, s = byNumber(n);
    const head = '#' + two(n) + ' ' + (ms.start / m.source.fps).toFixed(2) + '-' + (ms.end / m.source.fps).toFixed(2);
    if (!s) return head + ' | no entry';
    if (s.drop) return head + ' | dropped: ' + clip(s.drop, 80);
    const t = s.transitionIn;
    const into = k === 0 ? 'start' : !t ? 'in: not said' : 'in ' + t.kind + (t.kind === 'custom' && t.description ? ': ' + clip(t.description, 50) : '');
    const roles = ROLES.map((role) => [role, s.layers.filter((l) => l.role === role).length] as const).filter(([, c]) => c > 0).map(([role, c]) => role + ' ' + c).join(', ');
    const marks = s.emphasis?.length ? s.emphasis.map((e) => e.what + ' on ' + clip(e.on, 24)).join(', ') : '';
    const caps = s.captions ? 'captions ' + clip(s.captions.base, 30) + (s.captions.highlight && !/^none\b/i.test(s.captions.highlight) ? ', highlight ' + clip(s.captions.highlight, 30) : '') : '';
    return [head + ' ' + clip(s.layout, 50), into + (s.sameEffectAsNext ? ', runs on into #' + two(n + 1) : ''), roles, marks, caps].filter(Boolean).join(' | ');
  });

/** The problems of a reading against the measurement (its shape's problems first) and one line per shot. */
export const checkElements = (r: ReadElements, m: Measure, text?: TextTrack): { problems: Problem[]; summary: string[]; labels: LabelCounts } => {
  const ctx: Context = { r, m, text, at: (shot) => 'shots[' + (r.where[shot] ?? 0) + ']', byNumber: (shot) => r.elements.shots.find((s) => s.shot === shot) };
  return {
    problems: [...r.problems, ...coverageProblems(ctx), ...transitionProblems(ctx), ...watermarkProblems(ctx), ...captionProblems(ctx), ...markProblems(ctx), ...endProblems(ctx), ...statusProblems(r, m, ctx.at), ...unknownProblems(r, ctx.at)],
    summary: summaryOf(ctx), labels: countLabels(r),
  };
};
