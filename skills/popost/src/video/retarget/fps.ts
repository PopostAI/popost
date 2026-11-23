/**
 * The frame rate of a project made from a reference. A reference at 50 or 60 frames a second (58.65 was seen) is
 * re-created at half its rate: twice the frames cost twice the drawing, reading and encoding, and what a re-creation
 * keeps (cuts, transitions, captions, the voice) does not need them. Every other rate is rounded to a whole number.
 */
export const HIGH_RATE = 40;

export const projectFps = (sourceFps: number): number => {
  const fps = sourceFps > HIGH_RATE ? sourceFps / 2 : sourceFps;
  return Math.max(1, Math.round(fps));
};
