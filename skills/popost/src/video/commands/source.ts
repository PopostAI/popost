/**
 * `popost video source <url-or-file> --out project/source`: collects one source of the new video's content (its text,
 * its pictures, its colours, the links to the product's own site) and prints the inventory (video/source/collect.ts).
 */
import { printJson } from '../../core/util';
import { collectSource, INVENTORY_FILE, MAX_PICTURES, SourceError } from '../source/collect';
import { command, userPath, VideoCommandError, type Commands } from './shared';

const source = command(
  'collects a source of the new video: fetches one page or README (or reads a file; no link is followed), saves its text, downloads the pictures it references (the logo first; badges and tracking pixels left out) and prints an inventory: each picture with its file, what the source says of it, its pixel size and where it came from; the brand colours it can read; the links to the product\'s own site',
  {
    positionals: [{ name: 'source', help: 'an https address (a page, a raw README) or a local .md, .txt or .html file' }],
    options: [
      { flag: '--out', required: true, metavar: 'DIR', help: 'where it goes: project/source, so that the checks find the text and the pictures' },
      { flag: '--max-pictures', kind: 'int', default: MAX_PICTURES, help: 'the most pictures to download, in the order of the source after the logo' },
    ],
  },
  async (args, rt) => {
    const outDir = userPath(rt, args.req('out'));
    const max = args.number('max-pictures') ?? MAX_PICTURES;
    if (!(max >= 0 && max <= 200)) throw new VideoCommandError('--max-pictures is a number from 0 to 200.');
    const entry = await collectSource(rt, { source: args.req('source'), outDir, maxPictures: max }).catch((e: unknown) => {
      if (e instanceof SourceError) throw new VideoCommandError(e.message);
      throw e;
    });
    const shown = (file: string): string => rt.path.relative(rt.cwd, rt.path.join(outDir, file)) || file;
    printJson(rt, {
      ok: true, source: entry.source, title: entry.title, text: shown(entry.text),
      pictures: entry.pictures.map((p) => ({ ...p, file: shown(p.file) })), skipped: entry.skipped,
      colours: entry.colours, site: entry.site, otherHosts: entry.otherHosts, inventory: shown(INVENTORY_FILE),
      note: 'Open the pictures you plan to use. In a fill a picture is its path from the project directory; in a scene, from the scene file ("../source/pictures/..."). An SVG is kept as SVG: an <img> of a scene shows it. Pictures and facts come from the product\'s own sources only.',
    });
  },
);

export const sourceCommands: Commands = { source };
