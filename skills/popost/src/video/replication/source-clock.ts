/** Decoded presentation timestamps keep VFR analysis indices independent of an average contract rate. */
import type { Runtime } from '../../runtime';
import { sha256File } from '../../core/util';
import { runFfmpegOk } from '../media/ffmpeg';
import type { ReplicationSource } from './contract';

export interface SourceClockFrame { index: number; ptsSeconds: number; rawPtsSeconds: number; durationSeconds: number; normalizedFrame: number }
export interface SourceClockMap {
  version: 1;
  method: 'decoded-passthrough-framecrc';
  contractFPS: number;
  frames: SourceClockFrame[];
  originPTSSeconds: number;
  declaredDurationSeconds: number;
  nonUniform: boolean;
  note: string;
}

export const sourceClockOf = (crc: string, source: Pick<ReplicationSource, 'fps' | 'frames'>): SourceClockMap => {
  if (!(source.fps > 0) || !Number.isSafeInteger(source.frames) || source.frames <= 0) throw new Error('A valid contract frame clock is required.');
  const match = crc.match(/^#tb\s+0:\s*(\d+)\/(\d+)/m);
  if (!match || Number(match[2]) === 0) throw new Error('Decoded frame timestamps have no valid time base.');
  const tick = Number(match[1]) / Number(match[2]);
  const rows = crc.split('\n').filter(s => s.trim() && !s.trim().startsWith('#')).map(s => s.split(',').map(x => x.trim()));
  if (rows.length !== source.frames) throw new Error('Decoded frame count differs from the bound source contract: '+rows.length+' != '+source.frames+'.');
  const raw = rows.map(row => {
    if (row.length < 4 || !row[2] || !row[3] || !Number.isFinite(Number(row[2])) || !Number.isFinite(Number(row[3])) || Number(row[3]) <= 0) throw new Error('A decoded frame has invalid presentation timestamps.');
    return { pts: Number(row[2])*tick, duration: Number(row[3])*tick };
  });
  const origin = raw[0]!.pts;
  const frames = raw.map((f, index): SourceClockFrame => {
    if (index > 0 && f.pts <= raw[index-1]!.pts) throw new Error('Decoded presentation timestamps must increase; packet decode order is not a presentation-frame index.');
    const ptsSeconds = f.pts-origin;
    return { index, ptsSeconds, rawPtsSeconds: f.pts, durationSeconds: f.duration, normalizedFrame: Math.round(ptsSeconds*source.fps) };
  });
  const step = 1/source.fps, tolerance = Math.max(1e-7, step*.001);
  const nonUniform = frames.some((f, i) => i > 0 && Math.abs(f.ptsSeconds-frames[i-1]!.ptsSeconds-step)>tolerance) || Math.abs(raw.at(-1)!.duration-step)>tolerance;
  return { version: 1, method: 'decoded-passthrough-framecrc', contractFPS: source.fps, frames, originPTSSeconds: origin,
    declaredDurationSeconds: source.frames/source.fps, nonUniform,
    note: 'Indices name decoded presentation frames. ptsSeconds is relative to the first frame; rawPtsSeconds preserves the media timestamp. Convert old analysis indices with this map, never index/averageFPS. The declared source end may include a held final frame.' };
};

export const inspectSourceClock = async (rt: Runtime, reference: string, source: ReplicationSource): Promise<SourceClockMap & { sourceFingerprint: string }> => {
  const hash = await sha256File(rt, reference);
  if (hash.toLowerCase() !== source.fingerprint.toLowerCase()) throw new Error('Reference bytes differ from the bound source contract.');
  // Decode with passthrough timestamps, so B-frame packet order cannot masquerade as the visible frame index.
  const result = await runFfmpegOk(rt, ['-loglevel', 'error', '-i', reference, '-map', '0:v:0', '-an', '-c:v', 'rawvideo', '-pix_fmt', 'gray', '-fps_mode', 'passthrough', '-f', 'framecrc', '-']);
  return { ...sourceClockOf(new TextDecoder().decode(result.stdout), source), sourceFingerprint: hash };
};
