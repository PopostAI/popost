/**
 * `popost video shots <clip>`: the shots inside one clip, found with the cut detector describe uses. A clip generated
 * in one call for several shots (one look, one continuous sound) comes back as one file whose cuts fall only about
 * where they were asked for: this says where they are, keeps a frame of each shot, and with --onto writes the fill
 * entries that put each of its shots on a shot of the template ("in", and the "speed" that makes it as long as the
 * template's shot needs) and the bed that lets the clip's sound run on under them.
 */
import { printJson } from '../../core/util';
import { extractFrame } from '../media/decode';
import { measureVideo } from '../measure/index';
import { SLOWED } from '../project/check-footage';
import { loadTemplate } from '../template/save';
import { fillLengths, footageNeed } from '../template/structure';
import { command, userPath, VideoCommandError, type Commands } from './shared';

/** Frames left out at both ends of a shot of the clip: a generated cut is not always clean to the frame. */
const GUARD = 1;
const r2 = (v: number): number => Math.round(v * 100) / 100;

/** A file of the project as a fill names it: from its assets directory on, when the path has one. */
const fillPath = (typed: string): string => {
  const parts = typed.split(/[\\/]/);
  const at = parts.lastIndexOf('assets');
  return at >= 0 ? parts.slice(at).join('/') : typed;
};

const shots = command(
  'the shots inside one clip (a clip generated for several shots in one call): where its cuts are, a frame of each shot with --out, and with --onto the fill entries ("in", "speed") that put each on a shot of a template, with the bed that lets the clip\'s sound run on under them',
  {
    positionals: [{ name: 'clip', help: 'a video file' }],
    options: [
      { flag: '--out', metavar: 'DIR', help: 'keep the middle frame of each shot there (shot-NN.jpg)' },
      { flag: '--onto', metavar: 'TEMPLATE', help: 'a template directory: the clip\'s shots are put on its shots in order' },
      { flag: '--first', kind: 'int', default: 1, help: 'with --onto: the template shot (from 1) the clip\'s first shot goes on' },
    ],
  },
  async (args, rt) => {
    const typed = args.req('clip');
    const clip = userPath(rt, typed);
    const m = await measureVideo(rt, clip);
    const fps = m.source.fps;
    const out = args.string('out');
    const found = [];
    for (const s of m.shots) {
      const into = s.index > 0 ? m.boundaries[s.index - 1] : undefined;
      const picture = out ? rt.path.join(out, 'shot-' + String(s.index + 1).padStart(2, '0') + '.jpg') : undefined;
      if (picture) {
        await rt.fs.mkdir(userPath(rt, out ?? '.'));
        await extractFrame(rt, clip, Math.floor((s.start + s.end - 1) / 2), userPath(rt, picture), 480);
      }
      found.push({ shot: s.index + 1, from: r2(s.start / fps), to: r2(s.end / fps), seconds: r2((s.end - s.start) / fps), in: s.start, frames: s.end - s.start, ...(into ? { change: into.kind, ...(into.confidence < 0.4 ? { unsure: true } : {}) } : {}), ...(picture ? { picture } : {}) });
    }
    const onto = args.string('onto');
    let fill: Record<string, unknown> | undefined;
    if (onto !== undefined) {
      const pkg = await loadTemplate(rt, userPath(rt, onto));
      const first = (args.number('first') ?? 1) - 1;
      const lengths = fillLengths(pkg.template);
      if (first < 0 || first + m.shots.length > pkg.template.shots.length)
        throw new VideoCommandError('The clip has ' + m.shots.length + ' shots and the template ' + pkg.template.shots.length + ': from shot ' + (first + 1) + ' they do not fit. Open the pictures (--out): a cut the clip does not have, or one too many, changes which shot goes where; give --first, or fill those shots by hand.');
      const footage = fillPath(typed);
      const notes: string[] = [];
      const entries = m.shots.map((s, i) => {
        const k = first + i;
        const need = footageNeed(pkg.template, k, lengths) / pkg.template.canvas.fps;
        const have = Math.max(1, s.end - s.start - 2 * GUARD) / fps;
        const speed = Math.min(4, Math.max(0.25, r2(have / need)));
        if (speed < SLOWED) notes.push('shots[' + k + ']: the clip\'s shot ' + (i + 1) + ' is ' + r2(have) + ' s and the template\'s shot needs ' + r2(need) + ' s, so it would play at ' + speed + ' of its speed. Ask for that shot longer when the group is made again, or fill it otherwise; do not slow it down.');
        return { shot: k + 1, fill: { footage, in: s.start + GUARD, ...(speed !== 1 ? { speed } : {}) } };
      });
      fill = { shots: entries, bed: { footage, shots: [first + 1, first + m.shots.length], in: (m.shots[0]?.start ?? 0) + GUARD }, ...(notes.length ? { notes } : {}) };
    }
    printJson(rt, {
      ok: true, clip, seconds: r2(m.source.frames / fps), fps, sound: m.source.hasAudio, shots: found, cuts: m.boundaries.length, ...(fill ? { fill } : {}),
      note: 'The cuts are measured, and a soft or fast cut can be missed or a fast move read as one: open the pictures before using the list. "in" counts the clip\'s own frames.',
    });
  },
);

export const clipCommands: Commands = { shots };
