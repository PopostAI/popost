/**
 * The floor: a reference video is measured, the draft is built from the measurement with no model, the draft is
 * rendered, the render is measured the same way, and the two measurements are compared. The score says how far
 * measurement alone gets; any model step has to beat it.
 */
import type { Runtime } from '../../runtime';
import { buildDraft, type DraftNote } from '../draft/build';
import { measureVideo } from '../measure/index';
import { renderVideo } from '../render/index';
import { scoreMeasures } from '../score/index';
import type { Measure, Score } from '../types';

export interface FloorOptions { video: string; workDir: string; scale?: number; footage?: 'still' | 'video' }
export interface FloorResult { reference: Measure; replica: Measure; score: Score; notes: DraftNote[]; seconds: { measure: number; draft: number; render: number; measureReplica: number } }

export const runFloor = async (rt: Runtime, o: FloorOptions): Promise<FloorResult> => {
  await rt.fs.mkdir(o.workDir);
  const clock = (): number => Date.now() / 1000;
  const t0 = clock();
  const reference = await measureVideo(rt, o.video);
  const t1 = clock();
  const projectDir = rt.path.join(o.workDir, 'draft');
  const { notes } = await buildDraft(rt, { video: o.video, measure: reference, outDir: projectDir, ...(o.footage ? { footage: o.footage } : {}) });
  // Both measurements live in the project directory under the names the preview debugger looks for.
  await rt.fs.writeFile(rt.path.join(projectDir, 'reference.measure.json'), JSON.stringify(reference, null, 2));
  const t2 = clock();
  const out = rt.path.join(o.workDir, 'replica.mp4');
  // A scale that brings the longer side to about 480 pixels keeps the render fast and is plenty for the measurement.
  const scale = o.scale ?? Math.min(1, 480 / Math.max(reference.source.width, reference.source.height));
  await renderVideo(rt, { projectDir, out, scale });
  const t3 = clock();
  const replica = await measureVideo(rt, out);
  await rt.fs.writeFile(rt.path.join(projectDir, 'replica.measure.json'), JSON.stringify(replica, null, 2));
  const t4 = clock();
  const score = scoreMeasures(reference, replica);
  await rt.fs.writeFile(rt.path.join(o.workDir, 'score.json'), JSON.stringify(score, null, 2));
  return { reference, replica, score, notes, seconds: { measure: t1 - t0, draft: t2 - t1, render: t3 - t2, measureReplica: t4 - t3 } };
};
