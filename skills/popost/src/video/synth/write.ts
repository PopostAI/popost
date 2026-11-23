/**
 * Writes a synthetic case to disk as a project directory: video.json plus the pictures it refers to, each made by
 * ffmpeg from a lavfi source. Nothing binary is stored in the repository.
 */
import type { Runtime } from '../../runtime';
import { heavyJobs, mapLimit } from '../host';
import { runFfmpegOk } from '../media/ffmpeg';
import type { PictureRecipe, SynthCase } from './generate';
import { rng } from './generate';

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

/**
 * The colours of a gradients picture, drawn from its seed. ffmpeg's gradients source picks colours it is not given
 * at random even with a seed (its seed only places the gradient's line), so a picture is reproducible only when every
 * colour is named.
 */
const gradientColours = (seed: number, n: number): string => {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => 'c' + i + '=0x' + [0, 0, 0].map(() => r.int(0, 255).toString(16).padStart(2, '0')).join('')).join(':');
};

const lavfi = (recipe: PictureRecipe, width: number, height: number): { input: string; seek: number } => {
  const size = 'size=' + width + 'x' + height;
  switch (recipe.source) {
    case 'mandelbrot': return { input: 'mandelbrot=' + size + ':rate=10:start_scale=' + (1.5 + (recipe.seed % 10) / 10).toFixed(1), seek: 1 + (recipe.seed % 30) / 10 };
    case 'testsrc2': return { input: 'testsrc2=' + size + ':rate=10', seek: (recipe.seed % 50) / 10 };
    case 'cellauto': return { input: 'cellauto=' + size + ':rate=10:rule=' + [18, 30, 110, 150][recipe.seed % 4] + ':seed=' + recipe.seed, seek: 2 };
    case 'gradients': return { input: 'gradients=' + size + ':rate=10:seed=' + recipe.seed + ':nb_colors=' + (3 + (recipe.seed % 4)) + ':' + gradientColours(recipe.seed, 3 + (recipe.seed % 4)), seek: (recipe.seed % 40) / 10 };
    case 'smptebars': return { input: 'smptebars=' + size + ':rate=10', seek: 0 };
    case 'life': return { input: 'life=' + size + ':rate=10:seed=' + recipe.seed + ':ratio=0.3:mold=12:life_color=#40e0d0:death_color=#402010', seek: 1.5 };
  }
};

/**
 * Makes one picture. The hue shift gives many different pictures from few sources. Every picture is written as rgb24:
 * the gradients source draws rgba, and a picture with alpha shows what lies under it on the page.
 */
export const makePicture = async (rt: Runtime, recipe: PictureRecipe, out: string, width: number, height: number): Promise<void> => {
  const { input, seek } = lavfi(recipe, even(width), even(height));
  await rt.fs.mkdir(rt.path.dirname(out));
  await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', input, '-ss', String(seek), '-vf', 'hue=h=' + recipe.hue + ',format=rgb24', '-frames:v', '1', out]);
};

/** video.json and its pictures. pictureScale shrinks the pictures (not the canvas) when the render will be scaled down anyway. */
export const writeCase = async (rt: Runtime, c: SynthCase, dir: string, pictureScale = 1): Promise<void> => {
  await rt.fs.mkdir(dir);
  await rt.fs.writeFile(rt.path.join(dir, 'video.json'), JSON.stringify(c.project, null, 2) + '\n');
  const { width, height } = c.project.canvas;
  await mapLimit(c.pictures, heavyJobs(rt), (p) => makePicture(rt, p.recipe, rt.path.join(dir, p.file), width * pictureScale, height * pictureScale));
};
