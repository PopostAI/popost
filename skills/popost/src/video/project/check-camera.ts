/**
 * Checks of keyframed camera moves: lengths, order, scales of at least 1, inside the segment, and edges that a shift
 * would show.
 */
import type { CameraMove, CameraSpec, Problem } from '../types';
import { edgeShown, fullMove } from '../presets/camera';
import { error, warning, type CheckContext } from './check-common';

/** An edge narrower than this share of the canvas is antialiasing, not a gap. */
const EDGE_EPS = 1e-4;

const moveProblems = (m: CameraMove, i: number, prev: CameraMove | undefined, len: number, at: string, id: string): Problem[] => {
  const here = at + '.moves[' + i + ']';
  const out: Problem[] = [];
  if (m.to <= m.from)
    out.push(error(here + '.to', 'Move ' + i + ' of segment "' + id + '" ends (to ' + m.to + ') where or before it starts (from ' + m.from + ').', 'Make "to" larger than "from"; frames count from the start of the segment.'));
  if (len > 0 && m.from >= len)
    out.push(error(here + '.from', 'Move ' + i + ' starts at frame ' + m.from + ', but segment "' + id + '" has frames 0..' + (len - 1) + '.', 'Start it inside the segment, at most ' + (len - 1) + '.'));
  const low = m.scale.find((s) => s < 1);
  if (low !== undefined)
    out.push(error(here + '.scale', 'Move ' + i + ' of segment "' + id + '" has scale ' + low + ', below 1: the picture would be smaller than the frame and an edge would show.',
      'Use scales of at least 1. To pull out, go from a larger scale down to 1, for example [1.3, 1].'));
  if (prev && m.from < prev.to)
    out.push(error(here + '.from', 'Move ' + i + ' starts at frame ' + m.from + ', before move ' + (i - 1) + ' ends (to ' + prev.to + '); moves run one after another.',
      'Set "from" of move ' + i + ' to at least ' + prev.to + ', or end move ' + (i - 1) + ' earlier.'));
  const edge = low === undefined ? edgeShown(fullMove(m, 0)) : 0;
  if (edge > EDGE_EPS)
    out.push(warning(here + (m.shift ? '.shift' : '.focus'), 'Move ' + i + ' of segment "' + id + '" moves the picture so far that its edge shows, by up to ' + (edge * 100).toFixed(1) + '% of the canvas.',
      'Keep the offset within (scale - 1) / 2 on each axis: use a smaller shift or a larger scale.'));
  return out;
};

/** Problems of a base's camera at the JSON path at (the base's path + ".camera"); k: the segment's index. */
export const checkCamera = (ctx: CheckContext, camera: CameraSpec | undefined, k: number, at: string): Problem[] => {
  if (!camera || !('moves' in camera)) return [];
  const len = ctx.tl.lengths[k] ?? 0;
  const id = ctx.project.segments[k]?.id ?? '';
  return camera.moves.flatMap((m, i) => moveProblems(m, i, camera.moves[i - 1], len, at, id));
};
