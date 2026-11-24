/**
 * The one list of what a reading did not recover (types.ts, Unrecovered): the kind of a change no standard transition
 * explains and that has no measured path, the shape of an edge no model fits, a camera that could not be read, text or
 * speech no tool read, a beat the reader or the recogniser was not sure of, a caption colour that could not be told.
 * Each with where it is, why, and how to settle it. describe writes it as unrecovered.json and lists it in
 * REFERENCE.md; whoever reads the frames appends to it in elements.json. Pure.
 */
import type { Transcript } from '../speech/types';
import type { TextTrack } from '../text/types';
import type { Measure, Unrecovered } from '../types';
import { UNSURE, type Beat } from './beats';
import { shotSheetFile, transitionFile } from './frames';
import { cameraKnown, edgeKnown, kindKnown, ownEffect } from './known';

export const UNRECOVERED_FILE = 'unrecovered.json';

const two = (n: number): string => String(n).padStart(2, '0');
const r2 = (v: number): number => Math.round(v * 100) / 100;
const quote = (t: string): string => '"' + t.replace(/"/g, "'") + '"';

export interface ReadWith { text?: TextTrack | undefined; transcript?: Transcript | undefined; beats?: readonly Beat[] }

const ofTransitions = (m: Measure): Unrecovered[] => {
  const fps = m.source.fps;
  return m.boundaries.flatMap((b, k): Unrecovered[] => {
    if (b.kind === 'cut') return [];
    const n = k + 2, track = m.tracks?.find((t) => t.of === 'transition' && t.shot === n);
    const where = { transition: n, time: [r2((b.start + 1) / fps), r2(b.end / fps)] as [number, number] };
    const kind = kindKnown(b, track), edge = track ? edgeKnown(track) : undefined;
    const out: Unrecovered[] = [];
    // A change whose path was measured as an effect of its own is recovered by that path, whatever its label.
    if (kind.status !== 'measured' && !(track && ownEffect(track) && edge?.status === 'measured'))
      out.push({ what: 'how shot ' + two(n) + ' begins: the kind of the change' + (track ? '' : ' and the path of what moves in it'), where, why: kind.basis,
        settle: 'Go through ' + transitionFile(n) + ' frame by frame; write it in elements.json as "custom" with what moves, along which path and behind which edge, or as the standard kind it is, with why.', by: 'measurement' });
    if (edge && edge.status === 'unknown')
      out.push({ what: 'the shape of the edge that opens shot ' + two(n), where, why: edge.basis, settle: 'Take it from ' + transitionFile(n) + ': say in elements.json how the edge runs on three of its frames.', by: 'measurement' });
    return out;
  });
};

const ofShots = (m: Measure): Unrecovered[] =>
  m.shots.flatMap((s): Unrecovered[] => {
    const camera = cameraKnown(s);
    if (camera.status !== 'unknown') return [];
    const fps = m.source.fps;
    return [{ what: 'the camera of shot ' + two(s.index + 1), where: { shot: s.index + 1, time: [r2(s.start / fps), r2(s.end / fps)] }, why: camera.basis,
      settle: 'Hold the first frame of ' + shotSheetFile(s.index + 1) + ' against its last: the same framing is a still camera.', by: 'measurement' }];
  });

const ofTools = (m: Measure, r: ReadWith): Unrecovered[] => {
  const whole = { time: [0, r2(m.source.duration)] as [number, number] };
  const fps = m.source.fps;
  const look = r.text?.captionLook;
  return [
    ...(r.text ? [] : [{ what: 'the on-screen text: captions, titles, labels, watermarks', where: whole, why: 'no text reader was available', settle: 'Read the words off the pictures; or set a reader up (video-tools.md) and describe again.', by: 'measurement' as const }]),
    ...(r.transcript || !m.source.hasAudio ? [] : [{ what: 'what is said', where: whole, why: 'no transcriber was available', settle: 'Take the lines from the captions; or set a transcriber up (video-tools.md) and describe again.', by: 'measurement' as const }]),
    ...(look && !look.color ? [{ what: 'the colour of the caption letters', where: whole, why: 'the letters gave no single colour that could be measured', settle: 'Take it from the frames of a shot with a caption.', by: 'measurement' as const }] : []),
    ...(r.beats ?? []).flatMap((b, i): Unrecovered[] => (b.confidence >= UNSURE ? [] : [{ what: 'the words of beat ' + i + ' (read as ' + quote(b.text) + ')', where: { time: [r2(b.start / fps), r2(b.end / fps)] },
      why: 'the reader or the recogniser was not sure of them', settle: 'Read the line off the frames of that moment (popost video look <video> --at ' + r2((b.start + b.end) / 2 / fps) + ').', by: 'measurement' }])),
  ];
};

/** Everything the reading did not recover, the changes first, then the shots, then what no tool read. */
export const unrecoveredOf = (m: Measure, r: ReadWith = {}): Unrecovered[] => [...ofTransitions(m), ...ofShots(m), ...ofTools(m, r)];

/** Where an entry is, in a few words. */
export const whereText = (u: Unrecovered): string => {
  const at = u.where.time ? u.where.time[0].toFixed(2) + '-' + u.where.time[1].toFixed(2) + ' s' : '';
  const place = u.where.transition !== undefined ? 'the change into shot ' + two(u.where.transition) : u.where.shot !== undefined ? 'shot ' + two(u.where.shot) : 'the whole video';
  return place + (at && (u.where.transition !== undefined || u.where.shot !== undefined) ? ' (' + at + ')' : !at || place === 'the whole video' && u.where.time?.[0] === 0 ? '' : ' at ' + at);
};

/** One entry as a line of a list. */
export const unrecoveredLine = (u: Unrecovered): string =>
  '- ' + whereText(u) + ': ' + u.what + '. Why: ' + u.why + '.' + (u.assumed ? ' Assumed instead: ' + u.assumed + '.' : '') + (u.settle ? ' To settle it: ' + u.settle : '');

/** At most this many entries are listed in REFERENCE.md; the file has all. */
export const LISTED = 12;

/** unrecovered.json. */
export const unrecoveredFile = (list: readonly Unrecovered[]): Record<string, unknown> => ({
  version: 1,
  about: 'What the reading did not recover. Each entry: what, where (shot and transition numbered from 1 as in shots/NN.md and transitions/NN.jpg; time in seconds), why, settle (how to settle it). Append what you could not see to "unrecovered" in elements.json, with "assumed": what the re-make does instead.',
  unrecovered: list,
});
