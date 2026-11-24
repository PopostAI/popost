/**
 * The trajectories of a measurement (measure/tracks.ts) in words, for the files a model reads: one line per path, with
 * the numbers a scene is set from (start and end, path angle, speed, size, duration, the shape of the edge). The samples
 * themselves are in tracks.json.
 */
import type { Measure, RevealEdge, Trajectory } from '../types';

export const TRACKS_FILE = 'tracks.json';
export const ANGLES = '0 is to the right, 90 down, -90 up, 180 to the left';

const pct = (v: number): string => Math.round(v * 100) + '%';
const deg = (v: number): string => (Math.round(v) || 0) + ' degrees';
const at = (p: [number, number]): string => '[' + p[0].toFixed(2) + ', ' + p[1].toFixed(2) + ']';
const seconds = (frames: number, fps: number): string => (frames / fps).toFixed(2) + ' s';

/** The edge of the new picture, in a few words. */
export const edgeText = (e: RevealEdge): string => {
  const how = ' (fit ' + e.fit.toFixed(2) + ' on ' + pct(e.share) + ' of the frames)';
  if (e.shape === 'straight') return 'behind a straight edge that travels at ' + deg(e.angle ?? 0) + how;
  if (e.shape === 'wedge') return 'as a wedge of ' + Math.round(e.spread ?? 0) + ' degrees whose tip points at ' + deg(e.angle ?? 0) + how;
  if (e.shape === 'circle') return (e.grows === false ? 'outside a circle that closes on ' : 'inside a circle that grows from ') + at(e.centre ?? [0.5, 0.5]) + how;
  return 'behind an edge that is neither straight, a circle nor a wedge' + how + ': the frames show its shape';
};

const travelText = (t: Trajectory, fps: number): string =>
  'from ' + at(t.path.from) + ' to ' + at(t.path.to) + ' on frames ' + t.start + '-' + t.end + ' (' + seconds(t.end - t.start, fps) + '), path angle ' + deg(t.path.angle)
  + (t.path.straightness >= 0.9 ? ', straight' : ', bent (straightness ' + t.path.straightness.toFixed(2) + ')') + ', ' + t.path.speed.toFixed(2) + ' canvas widths a second, ease ' + t.path.ease
  + ', size ' + pct(t.size[0]) + ' x ' + pct(t.size[1]) + ' of the canvas';

/** One trajectory as a line of a shot's file. */
export const trackText = (t: Trajectory, fps: number): string => {
  const known = ' Measured (' + t.method + ', confidence ' + t.confidence.toFixed(2) + ').';
  if (t.of === 'event' || !t.reveal) return 'Motion event ' + ((t.event ?? 0) + 1) + ': the element travels ' + travelText(t, fps) + '.' + known;
  const r = t.reveal;
  const head = 'The change into shot ' + String(t.shot).padStart(2, '0') + ', frames ' + r.start + '-' + r.end + ' (' + seconds(r.end - r.start, fps) + '): the new picture opens ' + edgeText(r.edge) + '.';
  return head + (t.what === 'object' ? ' An object leads it: its centre goes ' + travelText(t, fps) + '.' : '') + known;
};

/** A few words for the line of timeline.md. */
export const trackBrief = (t: Trajectory, fps: number): string =>
  t.reveal ? 'path: ' + (t.what === 'object' ? 'an object at ' + deg(t.path.angle) + ' leads ' : '') + (t.reveal.edge.shape === 'irregular' ? 'an edge of its own' : 'a ' + t.reveal.edge.shape + (t.reveal.edge.shape === 'circle' ? '' : ' edge')) + ', ' + seconds(t.reveal.end - t.reveal.start, fps)
    : 'path: ' + deg(t.path.angle) + ', ' + seconds(t.end - t.start, fps);

/** The trajectory of the change into shot n (from 1), and those of the shot's events. */
export const transitionTrack = (m: Measure, n: number): Trajectory | undefined => m.tracks?.find((t) => t.of === 'transition' && t.shot === n);
export const eventTracks = (m: Measure, n: number): Trajectory[] => (m.tracks ?? []).filter((t) => t.of === 'event' && t.shot === n);

/** A change that a standard transition does not make: an object leads it, or its edge is not straight. */
export const ownEffect = (t: Trajectory): boolean => t.of === 'transition' && (t.what === 'object' || (t.reveal !== undefined && t.reveal.edge.shape !== 'straight'));

/** tracks.json: the trajectories with what their numbers mean. */
export const tracksFile = (m: Measure): Record<string, unknown> => ({
  version: 1,
  units: {
    position: 'centre [x, y] and size [width, height] as fractions of the canvas, origin top left',
    angle: 'degrees on screen, measured in pixels: ' + ANGLES,
    time: 'frames of the video at ' + m.source.fps + ' fps',
    length: 'canvas widths; speed: canvas widths a second',
  },
  tracks: m.tracks ?? [],
});
