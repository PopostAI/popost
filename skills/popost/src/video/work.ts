/**
 * Where the video commands keep caches and scratch work (a voice's measured pace, swap-test renders, evaluation runs,
 * the record of renders and reviews of each project): POPOST_VIDEO_WORK when it is set, else .popost/video under the
 * working directory. A shipped command has no repository to put them in, so they go beside the work of the person or
 * agent that runs it.
 */
import type { Runtime } from '../runtime';

export const workDir = (rt: Runtime): string => rt.path.resolve(rt.cwd, rt.env.POPOST_VIDEO_WORK?.trim() || rt.path.join('.popost', 'video'));

/** The record of renders and reviews (render/record.ts): one small file per project. */
export const reviewsDir = (rt: Runtime): string => rt.path.join(workDir(rt), 'reviews');
