import type { Runtime } from '../../runtime';
import { sha256 } from '../../core/util';
import type { Problem, Resolved } from '../types';
import { playsOf, sourceFrame } from '../timeline/footage';
import { error } from '../project/check-common';

/** A visible speaker cannot silently acquire an unrelated voice or a different source-time mapping. */
export const checkSpeechLocks = async (rt: Runtime, dir: string, r: Resolved): Promise<Problem[]> => {
  const out: Problem[] = [];
  for (const [id, f] of Object.entries(r.footage ?? {})) {
    const file = rt.path.resolve(dir, f.src), receipt = file + '.speech.json';
    if (!(await rt.fs.stat(receipt))) continue;
    const fix = 'Keep this speaking clip’s embedded audio, source in-point, cuts and speed together. To change the words, synchronize a new clip to the final voice first.';
    let lock: { videoSha256?: string };
    try { lock = JSON.parse(await rt.fs.readText(receipt)) as typeof lock; }
    catch { out.push(error('materials.' + id, 'The visible-speech receipt is invalid.', fix)); continue; }
    if (lock.videoSha256 !== sha256(await rt.fs.readFile(file))) { out.push(error('materials.' + id, 'This speaking clip changed after its audio was locked.', fix)); continue; }
    for (const use of playsOf(r).filter(p => p.play.material === id)) {
      const first = Math.max(0, use.first, use.play.start), last = Math.min(r.frames - 1, use.last);
      if (last < first) continue;
      const matched = r.audio.some(a => {
        if (a.src !== f.src || a.start > first || (a.end ?? r.frames) <= last || Math.abs((a.speed ?? 1) - use.play.speed) > 1e-6) return false;
        const audioTime = (a.from ? a.from.frame / a.from.fps : 0) + (first - a.start) / r.canvas.fps * (a.speed ?? 1);
        const videoTime = sourceFrame(use.play, f, r.canvas.fps, first) / f.fps;
        return Math.abs(audioTime - videoTime) <= 1 / f.fps;
      });
      if (!matched) out.push(error('materials.' + id, 'Visible mouth motion has no matching locked audio at timeline frame ' + first + '.', fix));
    }
  }
  return out;
};
