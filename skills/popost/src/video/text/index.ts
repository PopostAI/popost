/**
 * Text of a video: sample frames, have a reader read them, turn the lines into cues with roles.
 *
 * Reading is the slow part. By default every sampled frame (five a second) is read whole. With "every" above 1 it is
 * done in two passes: one frame in "every" is read whole, which finds every text and, when the video has captions,
 * the band they sit in; then the frames in between are read as a strip around that band, and text outside the band
 * keeps the timing of the whole-frame pass; a video without captions is read at the coarse rate only.
 *
 * Measured on 2026-11-20 with the RapidOCR tool on a loaded 8-core machine, one 17.8 s 1280x720 video: whole frames
 * 37 to 38 s; strips (30% of the frame, the least that reader still searches for lines in) 43 to 54 s, with one
 * extra caption cue. That reader's cost is per picture, not per pixel, so strips do not pay and are off by default.
 * What would pay is fewer pictures: finding the moments a caption changes from pixels and reading one frame per
 * stretch. That is not built.
 */
import type { Runtime } from '../../runtime';
import { withTempDir } from '../host';
import { probe, runFfmpegOk } from '../media/ffmpeg';
import type { OnStage } from '../progress';
import { buildCues } from './cues';
import { measureBars } from './bar';
import { measureCaptionLook } from './look';
import type { TextLine, TextReader, TextSample, TextTrack } from './types';

export { buildCues } from './cues';
export { commandTextReader, textReaderCommand } from './reader-command';
export type { CaptionHighlight, CaptionLook, TextCue, TextLine, TextReader, TextRole, TextSample, TextTrack } from './types';

export interface ReadTextOptions {
  /** Frames between samples of the caption band. Default: about a fifth of a second (6 at 30 fps). */
  step?: number;
  /** 1 (default): every sampled frame is read whole. Above 1: whole frames every "every" steps, caption strips between. */
  every?: number;
  /** Longer side of the pictures given to the reader. Default 1280: small text needs the pixels. */
  maxSide?: number;
  /** Told what is being done (taking frames out, the reader at work), for a progress line. */
  onStage?: OnStage;
}

export interface TextReading { samples: TextSample[]; step: number; total: number; fps: number; whole?: number; strips?: number }

/** A horizontal band of the frame: top and bottom as fractions of the height. */
export interface Band { top: number; bottom: number }

/** The band that holds the captions of a track, with some air above and below; undefined when there are fewer than three. */
export const captionBandOf = (track: TextTrack): Band | undefined => {
  const captions = track.cues.filter((c) => c.role === 'caption');
  if (captions.length < 3) return undefined;
  const size = captions.map((c) => c.size).sort((a, b) => a - b)[Math.floor(captions.length / 2)] ?? 0;
  const top = Math.min(...captions.map((c) => c.box[1])) - 0.7 * size;
  const bottom = Math.max(...captions.map((c) => c.box[1] + c.box[3])) + 0.7 * size;
  return { top: Math.max(0, Math.round(top * 1000) / 1000), bottom: Math.min(1, Math.round(bottom * 1000) / 1000) };
};

const inBand = (l: TextLine, band: Band): boolean => {
  const centre = l.box[1] + l.box[3] / 2;
  return centre >= band.top && centre <= band.bottom;
};

/**
 * One sample per fine frame. A frame read whole keeps its lines. A frame read as a strip gets the strip's lines
 * (moved back into frame coordinates) plus, held from the last whole frame before it, the lines outside the band.
 */
export const mergeBandSamples = (whole: TextSample[], strips: TextSample[], band: Band): TextSample[] => {
  const height = band.bottom - band.top;
  const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
  const sorted = [...whole].sort((a, b) => a.frame - b.frame);
  const placed = strips.map((s): TextSample => {
    const before = [...sorted].reverse().find((w) => w.frame <= s.frame) ?? sorted[0];
    const held = (before?.lines ?? []).filter((l) => !inBand(l, band));
    const lines = s.lines.map((l): TextLine => ({ ...l, partial: true, box: [l.box[0], r4(band.top + l.box[1] * height), l.box[2], r4(l.box[3] * height)] }));
    return { frame: s.frame, lines: [...held, ...lines] };
  });
  return [...sorted, ...placed].sort((a, b) => a.frame - b.frame);
};

const numbered = async (rt: Runtime, dir: string, prefix: string, frames: number[]): Promise<{ frame: number; file: string }[]> => {
  const files = (await rt.fs.readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith('.jpg')).sort();
  // ffmpeg numbers its output from 1, in the order the frames were selected.
  return files.slice(0, frames.length).map((f, k) => ({ frame: frames[k] ?? 0, file: rt.path.join(dir, f) }));
};

/**
 * A strip must not be too flat: readers treat a very wide, low picture as one line of text and skip looking for
 * lines in it (RapidOCR does above 8 to 1). The band is grown evenly until the strip is at most 6 to 1.
 */
export const readableBand = (band: Band, frameWidth: number, frameHeight: number): Band => {
  const need = Math.min(1, frameWidth / frameHeight / 6);
  const grow = Math.max(0, need - (band.bottom - band.top)) / 2;
  const top = Math.max(0, Math.min(1 - need, band.top - grow));
  return { top: Math.round(top * 1000) / 1000, bottom: Math.round(Math.max(band.bottom, top + need) * 1000) / 1000 };
};

/** Samples the video and has the reader read it: the raw lines, before any tracking. */
export const readSamples = async (rt: Runtime, video: string, reader: TextReader, opts: ReadTextOptions = {}): Promise<TextReading> => {
  const info = await probe(rt, video);
  const step = Math.max(1, opts.step ?? Math.round(info.fps / 5));
  const every = Math.max(1, Math.round(opts.every ?? 1));
  const coarse = step * every;
  const maxSide = opts.maxSide ?? 1280;
  const scale = Math.min(1, maxSide / Math.max(info.width, info.height));
  const width = Math.round((info.width * scale) / 2) * 2;
  const size = scale < 1 ? ',scale=' + width + ':-2' : '';
  return withTempDir(rt, 'popost-video-frames-', async (root) => {
    const wholeFrames = Array.from({ length: Math.ceil(info.frames / coarse) }, (_, k) => k * coarse);
    opts.onStage?.('taking ' + wholeFrames.length + ' frames out');
    await runFfmpegOk(rt, ['-y', '-i', video, '-vf', 'select=not(mod(n\\,' + coarse + '))' + size, '-fps_mode', 'passthrough', '-q:v', '2', rt.path.join(root, 'w%06d.jpg')]);
    const listed = await numbered(rt, root, 'w', wholeFrames);
    opts.onStage?.('the reader is reading ' + listed.length + ' frames');
    const whole = (await reader.read(listed)).sort((a, b) => a.frame - b.frame);
    const found = every > 1 ? captionBandOf(buildCues(whole, { step: coarse, total: info.frames, fps: info.fps })) : undefined;
    const band = found ? readableBand(found, info.width, info.height) : undefined;
    // No captions: nothing on screen changes several times a second, and one frame a second is all there is to read.
    if (!band) return { samples: whole, step: coarse, total: info.frames, fps: info.fps, whole: whole.length, strips: 0 };
    const stripFrames = Array.from({ length: Math.ceil(info.frames / step) }, (_, k) => k * step).filter((n) => n % coarse !== 0);
    const crop = ',crop=iw:trunc(ih*' + (band.bottom - band.top).toFixed(4) + '/2)*2:0:trunc(ih*' + band.top.toFixed(4) + ')';
    await runFfmpegOk(rt, ['-y', '-i', video, '-vf', 'select=not(mod(n\\,' + step + '))*gt(mod(n\\,' + coarse + ')\\,0)' + size + crop, '-fps_mode', 'passthrough', '-q:v', '2', rt.path.join(root, 's%06d.jpg')]);
    const stripped = await numbered(rt, root, 's', stripFrames);
    opts.onStage?.('the reader is reading ' + stripped.length + ' caption strips');
    const strips = await reader.read(stripped);
    return { samples: mergeBandSamples(whole, strips, band), step, total: info.frames, fps: info.fps, whole: whole.length, strips: strips.length };
  });
};

/** Raw lines to cues. Kept apart from reading so that the rules can be re-run on saved samples at no cost. */
export const cuesOf = (r: TextReading): TextTrack => buildCues(r.samples, { step: r.step, total: r.total, fps: r.fps });

/**
 * The track with its bars looked at in the frames (bar.ts: which word was marked when; two words in a row whose mark
 * moves are a bar) and what is behind its caption lines' letters (look.ts), measured on the video's frames of those
 * lines; without captions enough, the track without a caption look.
 */
export const withCaptionLook = async (rt: Runtime, video: string, track: TextTrack): Promise<TextTrack> => {
  const barred = await measureBars(rt, video, track);
  const look = await measureCaptionLook(rt, video, barred);
  return look ? { ...barred, captionLook: look } : barred;
};

/** Reads a video's text and returns the cues in source frames. */
export const readText = async (rt: Runtime, video: string, reader: TextReader, opts: ReadTextOptions = {}): Promise<TextTrack> =>
  cuesOf(await readSamples(rt, video, reader, opts));
