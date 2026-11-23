/**
 * Colours as the reading half decodes them: flat colour frames encoded by ffmpeg with a known matrix and range, tagged
 * or not, decoded by decodeFrames and compared with the colours that went in. An untagged HD source is read as
 * BT.709 and an untagged SD one as BT.601, as players do (src/media/footage.ts, colourOf).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import { decodeFrames } from '../../src/video/media/decode';
import { probe, runFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { ffmpegReady } from './read-clips';

const ok = await ffmpegReady();
let rt: DiskRuntime;

const COLOURS: Array<[number, number, number]> = [[208, 32, 32], [32, 176, 64], [32, 64, 208], [128, 128, 128], [224, 176, 144], [240, 220, 40]];

interface Clip { name: string; w: number; h: number; matrix: 'bt709' | 'bt601'; range: 'tv' | 'pc'; tags: string[] }
const CLIPS: Clip[] = [
  { name: 'HD tagged BT.709', w: 1280, h: 720, matrix: 'bt709', range: 'tv', tags: ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'] },
  { name: 'HD untagged (BT.709)', w: 1280, h: 720, matrix: 'bt709', range: 'tv', tags: [] },
  { name: 'SD untagged (BT.601)', w: 640, h: 360, matrix: 'bt601', range: 'tv', tags: [] },
  { name: 'SD tagged BT.601 full range', w: 640, h: 360, matrix: 'bt601', range: 'pc', tags: ['-colorspace', 'smpte170m', '-color_range', 'pc'] },
];

/** One flat frame per colour, converted to yuv420p with the clip's matrix and range and encoded nearly losslessly. */
const makeClip = async (c: Clip, out: string): Promise<void> => {
  const frames = COLOURS.map((rgb) => { const f = new Uint8Array(c.w * c.h * 3); for (let i = 0; i < c.w * c.h; i++) f.set(rgb, i * 3); return f; });
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', c.w + 'x' + c.h, '-r', '30', '-i', 'pipe:0',
    // the scale filter tags its frames with the matrix it used; an untagged clip has the tag taken off again
    '-vf', 'scale=out_color_matrix=' + c.matrix + ':out_range=' + c.range + ',format=' + (c.range === 'pc' ? 'yuvj420p' : 'yuv420p') + (c.tags.length ? '' : ',setparams=colorspace=unknown:color_primaries=unknown:color_trc=unknown'),
    '-c:v', 'libx264', '-preset', 'veryfast', '-qp', '0', ...c.tags, out], Buffer.concat(frames.map((f) => Buffer.from(f.buffer))));
};

describe.skipIf(!ok)('read: colours of decoded frames', () => {
  let dir = '';
  let errors: Array<{ clip: string; worst: number }> = [];
  beforeAll(async () => {
    rt = await createDiskRuntime();
    dir = rt.dir;
    errors = await Promise.all(CLIPS.map(async (c, k) => {
      const out = dir + '/c' + k + '.mp4';
      await makeClip(c, out);
      const header = (await runFfmpeg(rt, ['-i', out])).stderr;
      if (c.tags.length === 0 && /bt709|bt470bg|smpte170m/.test(header)) throw new Error(c.name + ' came out tagged');
      const d = await decodeFrames(rt, out, { gray: false, probe: await probe(rt, out), width: 64 });
      let worst = 0;
      d.frames.forEach((f, i) => {
        const centre = ((d.height >> 1) * d.width + (d.width >> 1)) * 3;
        for (let ch = 0; ch < 3; ch++) worst = Math.max(worst, Math.abs((f[centre + ch] as number) - ((COLOURS[i] as number[])[ch] as number)));
      });
      return { clip: c.name, worst };
    }));
    console.info('worst channel error per clip: ' + errors.map((e) => e.clip + ' ' + e.worst).join(', '));
  }, 60_000);
  afterAll(() => rt.cleanup());

  it('decodes every colour within 4 levels, tagged or not', () => {
    expect(errors.map((e) => e.clip + ': ' + (e.worst <= MAX_ERROR ? 'ok' : e.worst))).toEqual(CLIPS.map((c) => c.name + ': ok'));
  });
});

// Without the source's matrix an untagged HD clip comes out 21 levels off; chroma upsampling without full interpolation
// leaves up to 4 on saturated flat colours (see decode.ts).
const MAX_ERROR = 4;
