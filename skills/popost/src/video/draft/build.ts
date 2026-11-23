/**
 * The draft builder: a measurement becomes a first project, with no model involved.
 * - one segment per shot, with the measured transition into it;
 * - the shot's picture is a frame of the source, taken where the shot is clean (after the transition in, before the
 *   first element appears), with the measured camera move;
 * - every element that appears becomes a picture item cut out of the source once it has settled, with the entrance
 *   the measurement saw, and the exit when a matching disappearance was seen.
 * Everything approximated or left out is listed in the notes, so a model (or a person) knows what to look at.
 */
import type { Runtime } from '../../runtime';
import { heavyJobs, mapLimit } from '../host';
import { runFfmpegOk } from '../media/ffmpeg';
import type { Boundary, Box, Material, Measure, MotionEvent, MotionSpec, Project, Segment, ShotMeasure, Track, TransitionSpec } from '../types';

export interface DraftNote { at: string; kind: 'approximate' | 'left-out' | 'inferred'; message: string }
export interface DraftResult { project: Project; notes: DraftNote[] }
export interface DraftOptions {
  video: string;
  measure: Measure;
  outDir: string;
  minConfidence?: number;
  /**
   * What fills each shot. 'still' (default): one clean frame of the reference with the measured camera move, and
   * every measured element as an item: everything is rebuilt, which is the hard case and the loop's floor.
   * 'video': the reference's own footage for that shot, frame for frame, with its sound: nothing is rebuilt, the
   * segments only mark where each shot is, ready to be replaced one by one.
   */
  footage?: 'still' | 'video';
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

/**
 * The PNG is written without colour tags. A frame of a BT.709 video would otherwise carry cICP / cHRM / gAMA chunks,
 * and Chrome converts a tagged picture when it draws it: dark backgrounds came out clearly darker (measured on a real
 * reference: 36 became 23). The pixel values are the same with or without the tags.
 */
const UNTAGGED = ',format=rgb24,setparams=color_primaries=unknown:color_trc=unknown:colorspace=unknown';

/** One frame of the source as a PNG, optionally cropped to a box given in fractions of the frame. */
const grab = async (rt: Runtime, video: string, frame: number, out: string, size: { width: number; height: number }, box?: Box): Promise<void> => {
  const crop = box
    ? ',crop=' + [even(box[2] * size.width), even(box[3] * size.height), Math.round(box[0] * size.width), Math.round(box[1] * size.height)].join(':')
    : '';
  await runFfmpegOk(rt, ['-y', '-i', video, '-vf', 'select=eq(n\\,' + Math.max(0, frame) + ')' + crop + UNTAGGED, '-frames:v', '1', '-fps_mode', 'passthrough', out]);
};

const transitionSpec = (b: Boundary, toFrames: (n: number) => number): TransitionSpec | undefined => {
  if (b.kind === 'cut') return undefined;
  const frames = Math.max(2, toFrames(b.end - b.start - 1));
  return {
    transition: b.kind, frames,
    ...(b.direction ? { direction: b.direction } : {}),
    ...(b.mode ? { mode: b.mode } : {}),
    ...(b.via ? { via: b.via } : {}),
  };
};

/** Longest entrance or exit the project format accepts (check enforces it). */
const MAX_MOTION_FRAMES = 600;

/** room: the frames this entrance or exit may take, so that an entrance and an exit never overlap inside one item. */
const motionSpec = (ev: MotionEvent, toFrames: (n: number) => number, room: number): MotionSpec => {
  const frames = Math.max(1, Math.min(toFrames(ev.end - ev.start), room, MAX_MOTION_FRAMES));
  const ease = ev.ease && ev.ease !== 'instant' ? { ease: ev.ease } : {};
  switch (ev.how) {
    case 'fade': return { preset: 'fade', frames, ...ease };
    case 'slide': return { preset: 'slide', frames, ...ease, ...(ev.direction ? { direction: ev.direction } : {}) };
    case 'wipe': return { preset: 'wipe', frames, ...ease, ...(ev.direction ? { direction: ev.direction } : {}) };
    case 'scale': return ev.overshoot && ev.overshoot > 0.03 ? { preset: 'pop', frames, overshoot: Number(ev.overshoot.toFixed(2)), ...ease } : { preset: 'scale-in', frames, ...ease };
    default: return { preset: 'none' };
  }
};

const overlap = (a: Box, b: Box): number => {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return w <= 0 || h <= 0 ? 0 : (w * h) / Math.min(a[2] * a[3], b[2] * b[3]);
};

/** The frame of a shot that shows its plain picture: after the transition in, before anything enters. */
const cleanFrame = (shot: ShotMeasure, into: Boundary | undefined, out: Boundary | undefined): number => {
  const first = into ? Math.max(shot.start, into.end) : shot.start;
  const last = (out ? Math.min(shot.end - 1, out.start) : shot.end - 1);
  const firstAppear = shot.events.filter((e) => e.kind === 'appear').map((e) => e.start).sort((a, b) => a - b)[0];
  const limit = firstAppear === undefined ? last : Math.min(last, firstAppear - 1);
  // A pull-out ends on the widest view, so the widest view is the picture; everything else starts from its first frame.
  if (shot.camera.kind === 'move' && shot.camera.zoomPerS < 0) return Math.max(first, limit);
  return Math.min(Math.max(first, shot.start), Math.max(first, limit));
};

/**
 * The draft that keeps the footage: one video material (a copy of the reference inside the project), one segment per
 * shot starting at the shot's first source frame, hard cuts everywhere because the footage carries its own
 * transitions, and the reference's sound as one audio track.
 */
const buildFootageDraft = async (rt: Runtime, o: DraftOptions): Promise<DraftResult> => {
  const m = o.measure;
  const fps = Math.max(1, Math.round(m.source.fps));
  const ratio = fps / m.source.fps;
  const notes: DraftNote[] = [];
  if (Math.abs(ratio - 1) > 1e-6) notes.push({ at: 'canvas.fps', kind: 'approximate', message: 'The source runs at ' + m.source.fps.toFixed(3) + ' fps; the project uses ' + fps + ', so some source frames are skipped or shown twice.' });
  // The runtime has no copy: the reference is read whole and written, byte for byte.
  await rt.fs.writeFile(rt.path.join(o.outDir, 'assets', 'reference.mp4'), await rt.fs.readFile(o.video));
  const materials: Material[] = [{ id: 'reference', kind: 'video', file: 'assets/reference.mp4', note: 'the reference itself' }];
  const tracks: Track[] = [];
  if (m.source.hasAudio) {
    await runFfmpegOk(rt, ['-y', '-i', o.video, '-vn', '-c:a', 'aac', '-b:a', '160k', rt.path.join(o.outDir, 'assets', 'reference.m4a')]);
    materials.push({ id: 'reference-sound', kind: 'audio', file: 'assets/reference.m4a', note: 'the sound of the reference' });
    tracks.push({ id: 'sound', type: 'audio', material: 'reference-sound' });
  }
  const total = Math.round(m.source.frames * ratio);
  const starts = m.shots.map((s) => Math.round(s.start * ratio));
  const segments: Segment[] = m.shots.map((shot, k) => ({
    id: 'shot-' + String(k + 1).padStart(2, '0'),
    frames: Math.max(1, (starts[k + 1] ?? total) - (starts[k] ?? 0)),
    base: { material: 'reference', in: shot.start, fit: 'cover' },
  }));
  const kinds = m.boundaries.filter((b) => b.kind !== 'cut').length;
  if (kinds) notes.push({ at: 'segments', kind: 'inferred', message: kinds + ' measured transition(s) are part of the footage itself, so the segments are joined by hard cuts.' });
  const project: Project = { version: 1, canvas: { width: even(m.source.width), height: even(m.source.height), fps }, materials, segments, tracks, note: 'draft that keeps the footage of the reference, no model involved' };
  await rt.fs.writeFile(rt.path.join(o.outDir, 'video.json'), JSON.stringify(project, null, 2) + '\n');
  await rt.fs.writeFile(rt.path.join(o.outDir, 'draft-notes.json'), JSON.stringify(notes, null, 2) + '\n');
  return { project, notes };
};

export const buildDraft = async (rt: Runtime, o: DraftOptions): Promise<DraftResult> => {
  if (o.footage === 'video') return buildFootageDraft(rt, o);
  const m = o.measure;
  const minConfidence = o.minConfidence ?? 0.35;
  const fps = Math.max(1, Math.round(m.source.fps));
  const ratio = fps / m.source.fps;
  const toFrames = (n: number): number => Math.round(n * ratio);
  const size = { width: m.source.width, height: m.source.height };
  const notes: DraftNote[] = [];
  if (Math.abs(ratio - 1) > 1e-6) notes.push({ at: 'canvas.fps', kind: 'approximate', message: 'The source runs at ' + m.source.fps.toFixed(3) + ' fps; the project uses ' + fps + '.' });
  await rt.fs.mkdir(rt.path.join(o.outDir, 'assets'));
  const materials: Material[] = [];
  const segments: Segment[] = [];
  const tracks: Track[] = [];
  // Pictures to cut out of the reference, an ffmpeg each, run a few at a time by the CPU budget.
  const jobs: (() => Promise<void>)[] = [];

  m.shots.forEach((shot, k) => {
    const id = 'shot-' + String(k + 1).padStart(2, '0');
    const into = k > 0 ? m.boundaries[k - 1] : undefined;
    const out = m.boundaries[k];
    const start = toFrames(shot.start);
    const frames = Math.max(1, toFrames(shot.end) - start);
    const file = 'assets/' + id + '.png';
    materials.push({ id: 'pic-' + id, kind: 'image', file, note: 'placeholder: a frame of the reference' });
    jobs.push(() => grab(rt, o.video, cleanFrame(shot, into, out), rt.path.join(o.outDir, file), size));
    const cam = shot.camera;
    const moving = cam.kind === 'move' && cam.confidence >= minConfidence;
    const camera = moving ? { ...(Math.abs(cam.zoomPerS) >= 0.005 ? { zoom: Number(cam.zoomPerS.toFixed(3)) } : {}), ...(Math.hypot(...cam.panPerS) >= 0.005 ? { pan: [Number(cam.panPerS[0].toFixed(3)), Number(cam.panPerS[1].toFixed(3))] as [number, number] } : {}) } : undefined;
    if (moving && camera?.pan) notes.push({ at: 'segments[' + k + '].base.camera', kind: 'approximate', message: 'A pan needs a picture wider than one frame; one frame of the reference is used and scaled up.' });
    const segment: Segment = { id, frames, base: { material: 'pic-' + id, ...(camera && Object.keys(camera).length ? { camera } : {}) } };
    if (into) {
      const spec = transitionSpec(into, toFrames);
      if (spec) {
        segment.in = spec;
        if (into.confidence < minConfidence) notes.push({ at: 'segments[' + k + '].in', kind: 'inferred', message: 'The kind of this transition was measured with low confidence (' + into.confidence.toFixed(2) + ').' });
      }
    }
    segments.push(segment);

    const appears = shot.events.filter((e) => e.kind === 'appear');
    const leaves = shot.events.filter((e) => e.kind === 'disappear');
    appears.forEach((ev, i) => {
      const itemId = id + '-el' + (i + 1);
      const gone = leaves.find((d) => d.start >= ev.end && overlap(d.box, ev.box) > 0.5);
      const settled = Math.min((gone ? gone.start : shot.end) - 1, ev.end + 2);
      const pic = 'assets/' + itemId + '.png';
      materials.push({ id: 'pic-' + itemId, kind: 'image', file: pic, note: 'placeholder: an element cut out of the reference' });
      jobs.push(() => grab(rt, o.video, settled, rt.path.join(o.outDir, pic), size, ev.box));
      const from = Math.max(0, toFrames(ev.start) - start);
      const to = gone ? Math.max(from + 1, toFrames(gone.end) - start) : frames;
      // Half of the item's time each at most, so a long measured event cannot make the entrance and the exit collide.
      const room = Math.max(1, Math.floor((to - from) / 2));
      const asked = toFrames(ev.end - ev.start);
      if (asked > room) notes.push({ at: 'tracks.' + itemId, kind: 'approximate', message: 'The measured entrance lasts ' + asked + ' frames; the draft uses ' + Math.min(room, MAX_MOTION_FRAMES) + '.' });
      tracks.push({
        id: itemId, type: 'image', material: 'pic-' + itemId, fit: 'cover', box: ev.box,
        during: { segment: id, from, ...(gone ? { to } : {}) },
        enter: motionSpec(ev, toFrames, room), ...(gone ? { exit: motionSpec(gone, toFrames, room) } : {}),
      });
      if (ev.confidence < minConfidence) notes.push({ at: 'tracks.' + itemId, kind: 'inferred', message: 'This element event was measured with low confidence (' + ev.confidence.toFixed(2) + ').' });
    });
    const changes = shot.events.filter((e) => e.kind === 'change').length;
    if (changes) notes.push({ at: 'segments[' + k + ']', kind: 'left-out', message: changes + ' change event(s) inside this shot have no counterpart in the draft.' });
  });

  await mapLimit(jobs, heavyJobs(rt), (job) => job());
  // The segments must add up to the source's length, so that later frame numbers still line up.
  const total = toFrames(m.source.frames);
  const sum = segments.reduce((s, x) => s + (x.frames ?? 0), 0);
  const last = segments[segments.length - 1];
  if (last && sum !== total) last.frames = Math.max(1, (last.frames ?? 1) + total - sum);
  // A draft must always pass check: a transition may not be longer than either of the segments it joins. A measured
  // span that is (a short shot between two effects, or a misread) is cut down, or becomes a hard cut, and noted.
  segments.forEach((segment, k) => {
    const before = segments[k - 1];
    if (!segment.in || !before) return;
    const room = Math.min(before.frames ?? 1, segment.frames ?? 1);
    const asked = segment.in.frames ?? 0;
    if (asked <= room) return;
    if (room < 2) delete segment.in;
    else segment.in.frames = room;
    notes.push({ at: 'segments[' + k + '].in', kind: 'approximate', message: 'The measured ' + (segment.in?.transition ?? 'transition') + ' spans ' + asked + ' frames, longer than a neighbouring shot (' + room + ' frames); ' + (room < 2 ? 'it became a hard cut.' : 'it was shortened to ' + room + '.') });
  });
  const project: Project = { version: 1, canvas: { width: even(size.width), height: even(size.height), fps }, materials, segments, tracks, note: 'draft built from a measurement, no model involved' };
  await rt.fs.writeFile(rt.path.join(o.outDir, 'video.json'), JSON.stringify(project, null, 2) + '\n');
  await rt.fs.writeFile(rt.path.join(o.outDir, 'draft-notes.json'), JSON.stringify(notes, null, 2) + '\n');
  return { project, notes };
};
