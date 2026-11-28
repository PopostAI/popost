/** Strict speech metadata uses the audio track's local clock, independently of its timeline placement. */
import type { Problem, Project, Resolved } from '../types';
import { error } from '../project/check-common';

export const voiceSpanProblems = (project: Pick<Project, 'tracks'>, resolved: Pick<Resolved, 'audio' | 'frames'>): Problem[] => {
  const problems: Problem[] = [];
  for (const track of project.tracks) {
    if (track.type !== 'audio' || track.role !== 'voice') continue;
    const route = resolved.audio.find(a => a.id === track.id);
    const at = 'tracks.' + track.id + '.lines';
    const fix = 'Use speech intervals in frames relative to this audio track\'s start, not global timeline frames. Inspect video replication timeline after placing or trimming the track.';
    if (!route || !track.lines?.length) {
      problems.push(error(at, 'A strict voice track needs actual speech intervals on a resolved audio route.', fix));
      continue;
    }
    const length = (route.end ?? resolved.frames) - route.start;
    for (const [i, [start, end]] of track.lines.entries()) {
      // A deliberately trimmed final line may extend beyond the end; wholly unheard or negative spans are stale.
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || start >= length)
        problems.push(error(at + '[' + i + ']', 'The declared speech interval does not overlap the voice track\'s audible local interval.', fix));
    }
  }
  return problems;
};
