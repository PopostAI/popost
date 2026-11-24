/**
 * `popost video scene example`: the example scenes with declared parameters (scene/examples.ts). Without a name it lists
 * them with every parameter; with a name it sets values (--set name=value), writes the scene into a project (--out) and
 * renders a sheet of its frames on its own, without a project (--sheet). Each prints one JSON document.
 */
import { printJson } from '../../core/util';
import { ProjectError } from '../render/session';
import { EXAMPLES, ExampleError, exampleFile, previewScene, readExample, setExample } from '../scene/examples';
import { command, userPath, VideoCommandError } from './shared';

/** "1280x720" -> [1280, 720]. */
const sizeOf = (text: string): [number, number] => {
  const m = /^(\d+)x(\d+)$/.exec(text.trim());
  if (!m || Number(m[1]) < 16 || Number(m[2]) < 16) throw new VideoCommandError('--size takes the canvas as WIDTHxHEIGHT in pixels, for example 1280x720; got "' + text + '".');
  return [Number(m[1]), Number(m[2])];
};

export const sceneExample = command(
  'example scenes with adjustable parameters (' + EXAMPLES.join(', ') + '): without a name, lists each with its parameters (name, type, default, range, what it does); with a name, sets values (--set name=value), writes the scene (--out) and renders a sheet of its frames without a project (--sheet)',
  {
    positionals: [{ name: 'name', required: false, help: 'the example: ' + EXAMPLES.join(', ') }],
    options: [
      { flag: '--set', kind: 'append', metavar: 'NAME=VALUE', help: 'a parameter of the example, for example --set spread=45; repeat it for several' },
      { flag: '--size', default: '1280x720', help: 'the canvas the scene is written for, WIDTHxHEIGHT (the project\'s canvas)' },
      { flag: '--out', metavar: 'HTML', help: 'write the scene with these values to this file, for example project/scenes/shot-02.html' },
      { flag: '--sheet', metavar: 'JPG', help: 'render the scene on its own and write one picture of its frames, each with its time' },
      { flag: '--seconds', kind: 'number', help: 'how many seconds the sheet covers (default: the effect\'s delay and duration, and half a second more)' },
      { flag: '--frames', kind: 'int', default: 12, help: 'how many frames the sheet shows, spread evenly' },
    ],
  },
  async (args, rt) => {
    const name = args.string('name');
    try {
      if (!name) {
        const all = await Promise.all(EXAMPLES.map((n) => readExample(rt, n)));
        printJson(rt, { ok: true, examples: all.map((e) => ({ name: e.name, about: e.about, file: exampleFile(e.name), params: e.params })),
          next: 'popost video scene example <name> --set <param>=<value> --sheet look/<name>.jpg shows one; --out project/scenes/shot-NN.html writes it (references/video-scenes.md, "Example scenes with parameters")' });
        return 0;
      }
      const ex = await readExample(rt, name);
      const size = sizeOf(args.req('size'));
      const set = setExample(ex, args.list('set'), size);
      if (set.problems.length) {
        printJson(rt, { ok: false, example: name, errors: set.problems.length, problems: set.problems, params: ex.params });
        return 2;
      }
      const out = args.string('out'), sheet = args.string('sheet');
      if (out) await rt.fs.writeFile(userPath(rt, out), set.html);
      const length = (Number(set.values.delay) || 0) + (Number(set.values.duration) || 1) + 0.5;
      const drawn = sheet ? await previewScene(rt, { html: set.html, out: userPath(rt, sheet), seconds: args.number('seconds') ?? length, frames: args.number('frames') ?? 12, size }) : undefined;
      printJson(rt, {
        ok: true, example: name, about: ex.about, values: set.values, ...(out ? { file: out } : {}), ...(drawn ? { sheet, seconds: drawn.seconds, grid: [drawn.columns, drawn.rows] } : {}),
        ...(out || drawn ? {} : { params: ex.params }),
        next: drawn ? 'open ' + sheet + ' beside the reference\'s frames of the effect; change --set and render again until they agree' + (out ? '' : ', then add --out project/scenes/shot-NN.html')
          : out ? 'put the pictures of the two shots into its slots (or your own HTML into its two picture divs), then: popost video scene check <project>' : 'add --sheet look/' + name + '.jpg to see it, --out project/scenes/shot-NN.html to write it',
      });
      return 0;
    } catch (e) {
      if (e instanceof ExampleError || e instanceof ProjectError) throw new VideoCommandError(e.message);
      throw e;
    }
  },
);
