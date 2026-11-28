/**
 * `popost video materials`: the clips and pictures a list asks for, made from prompts by the generator behind
 * POPOST_GEN_CMD (generate/index.ts; `popost video generate` is the built-in one on popost.ai). Paid as images are:
 * without --confirm nothing is charged and the prices come back with exit code 3; with --confirm --max-credits N (what is
 * left of the one budget of the video) the files are made within N, and chargedCredits says what was spent. The first
 * confirmed run of a project makes its clips the agreed clips (production/approved-clips.json); a paid clip that is
 * not one of them is asked about on its own (reason "unplanned"), and made only with --approve-unplanned <key>.
 */
import { errorText } from '../../core/error-text';
import { isFile, printJson } from '../../core/util';
import { scrub } from '../../providers/secrets';
import type { Runtime } from '../../runtime';
import { readUserJson } from '../../workflow/io';
import { characterAnchor } from '../generate/character';
import { checkRequests, commandGenerator, groupingAdvice, makeMaterials, NOTES, type AnchorPicture, type Generator, type MadeMaterial, type MaterialRequest } from '../generate/index';
import type { Problem } from '../types';
import { CONFIRM_EXIT, Wallet } from '../wallet';
import { CREDIT_OPTIONS, ceilingOf } from './credits';
import { platform } from './generate';
import { command, userPath, VideoCommandError } from './shared';
import { hasMusicTrack } from '../music/provenance';
import { loadTemplate } from '../template/save';
import { beatTimesOf } from '../template/speech-rules';

const errorsIn = (problems: readonly Problem[]): number => problems.filter((p) => p.level === 'error').length;

const PICTURE_EXT = ['.png', '.jpg', '.jpeg', '.webp'];

/** --anchor-image: the caller's picture as a path in the project; a file from elsewhere is copied to assets/anchor-image.<ext>. */
const givenAnchor = async (rt: Runtime, dir: string, given: string): Promise<AnchorPicture> => {
  const from = userPath(rt, given);
  const ext = rt.path.extname(from).toLowerCase();
  if (!PICTURE_EXT.includes(ext) || !(await isFile(rt, from))) throw new VideoCommandError('--anchor-image is a PNG, JPEG or WebP picture that exists; "' + given + '" is not. Give the path of the picture every clip should keep to.');
  const inside = rt.path.relative(dir, from);
  if (inside && !inside.startsWith('..') && !rt.path.isAbsolute(inside)) return { file: inside.split(rt.path.sep).join('/') };
  const file = 'assets/anchor-image' + ext;
  await rt.fs.mkdir(rt.path.join(dir, 'assets'));
  await rt.fs.writeFile(rt.path.join(dir, file), await rt.fs.readFile(from));
  return { file };
};

/** --character: a character of the user's popost.ai library, its picture downloaded into the project. A key never reaches the message. */
const characterOf = async (rt: Runtime, dir: string, id: string): Promise<AnchorPicture> => {
  let secrets: string[] = [];
  try {
    const found = await platform(rt);
    secrets = found.secrets;
    return await characterAnchor(rt, found.client, id, dir);
  } catch (error) {
    throw new VideoCommandError('The character ' + id + ' could not be used: ' + scrub(errorText(error), secrets).replace(/\s*\n\s*/g, ' ').trim());
  }
};

/** The generator with the budget left and the clips the user approved one by one added to the environment of each call. */
const budgeted = (generator: Generator, wallet: Wallet | undefined, approve: readonly string[]): Generator => ({
  make: async (kind, request, out, env) => {
    const made = await generator.make(kind, request, out, {
      ...env,
      ...(wallet ? { POPOST_GEN_MAX_CREDITS: String(wallet.left) } : {}),
      ...(approve.length ? { POPOST_GEN_APPROVE: approve.join(',') } : {}),
    });
    wallet?.pay(made.chargedCredits ?? made.credits ?? 0);
    return made;
  },
});

const UNPLANNED_NEXT =
  'Nothing was charged for these clips: they are not among the clips the user agreed to (a new clip, a regeneration or variant, or a changed request), and generated video is the expensive item. Show the user each clip, why it is needed and its price; only after a yes, run the same command again with --approve-unplanned <key> for each clip they approved.';
const PRICE_NEXT =
  'Nothing was charged for these files. When the credits fit what is left of the budget the user agreed to for this video, run the same command again with --confirm --max-credits <what is left>; otherwise show the user the credits (and the balance) and run it so once they agree.';

/** What the user has to agree to before the files that wait are made: unplanned clips first, then prices. */
const toAgree = (materials: readonly MadeMaterial[]): { confirm: Record<string, unknown>; next: string } | undefined => {
  const asked = materials.filter((m) => m.confirm);
  if (!asked.length) return undefined;
  const sum = (list: readonly MadeMaterial[]): number => list.reduce((n, m) => n + (m.confirm?.credits ?? 0), 0);
  const balance = asked.map((m) => m.confirm?.balance).find((b): b is number => typeof b === 'number');
  const items = asked.map((m) => ({ kind: m.kind, what: m.file, credits: m.confirm?.credits ?? 0, ...(m.confirm?.seconds !== undefined ? { seconds: m.confirm.seconds } : {}) }));
  const unplanned = asked.filter((m) => m.confirm?.reason === 'unplanned');
  const clips = unplanned.map((m) => ({ ...m.confirm?.clip, credits: m.confirm?.credits ?? 0 }));
  return unplanned.length
    ? { confirm: { credits: sum(unplanned), ...(balance !== undefined ? { balance } : {}), reason: 'unplanned', clip: clips[0], clips, items }, next: UNPLANNED_NEXT }
    : { confirm: { credits: sum(asked), ...(balance !== undefined ? { balance } : {}), items }, next: PRICE_NEXT };
};

export const materials = command(
  'makes the clips and pictures a list asks for, from prompts; a file that exists is not made again, and what each shows goes to materials.json for plan. Two or more clips keep what they share the same through one reference picture (the anchor). Needs POPOST_GEN_CMD; --check only reads the list. Paid generation is priced first (exit code 3, nothing charged) and made with --confirm --max-credits N; a clip that is not among the agreed clips needs --approve-unplanned <key>',
  {
    positionals: [{ name: 'requests', help: 'a JSON list of material requests: file, prompt, seconds, aspect, references; visible people list cast role ids from cast.json ([] for no people), and visible speech declares speech {mode:"native",language,lines:[{speaker,text,beat}]} (timed lines; needs --template) or {mode,speaker,text,audio?}. New single-appearance people may be defined directly; recurring roles reuse a completed image. Frames/continues cannot be combined with references.' }],
    options: [
      { flag: '--out', required: true, metavar: 'DIR', help: 'the project directory the files go into' },
      { flag: '--check', kind: 'flag', help: 'only say what is wrong with the list; nothing is made' },
      { flag: '--template', metavar: 'DIR', help: 'the template the clips are for: a line of "speech.lines" that names a beat gets its time from it, and every beat the reference said on camera must be said by one clip' },
      { flag: '--anchor', kind: 'flag', help: 'the default for two or more clips: one of them is made first and a frame of it goes to the others as a reference picture, so that they keep the same person, product and place; given, it is done for a single clip too. A request with "anchor": false stays out' },
      { flag: '--no-anchor', kind: 'flag', help: 'no shared reference picture: every clip is made from its own request alone' },
      { flag: '--anchor-image', metavar: 'FILE', help: 'a picture of yours as the anchor of every clip (the person, the product); no clip is made first' },
      { flag: '--character', metavar: 'ID', help: 'a character of your popost.ai character library as the anchor: its picture is downloaded into the project and every clip keeps that person' },
      ...CREDIT_OPTIONS,
      { flag: '--approve-unplanned', kind: 'append', metavar: 'KEY', help: 'the user said yes to this clip, which is not among the agreed clips (its key is in confirm.clip of exit code 3); repeat it for each' },
    ],
  },
  async (args, rt) => {
    const requests = (await readUserJson(rt, args.req('requests'))) as MaterialRequest[];
    const dir = userPath(rt, args.req('out'));
    const template = args.string('template');
    const times = template === undefined ? undefined : beatTimesOf(await loadTemplate(rt, userPath(rt, template)));
    if (args.flag('check')) {
      const wrong = await checkRequests(rt, requests, dir, {selectedIdentity:!!(args.string('character')||args.string('anchor-image')), ...(times ? { times } : {})});
      // Advice on how the list is cut into calls is a warning: the list can be made as it is.
      printJson(rt, { ok: wrong.length === 0, requests: Array.isArray(requests) ? requests.length : 0, problems: [...wrong, ...groupingAdvice(requests)] });
      return wrong.length ? 2 : 0;
    }
    const [image, character, off] = [args.string('anchor-image'), args.string('character'), args.flag('no-anchor')];
    if ([image !== undefined, character !== undefined, off].filter(Boolean).length > 1) throw new VideoCommandError('Give one of --anchor-image, --character and --no-anchor: a video has one anchor picture, or none.');
    const max = ceilingOf(args);
    const generator = commandGenerator(rt);
    if (!generator) throw new VideoCommandError('No generator is configured: set POPOST_GEN_CMD to a tool of yours (skills/popost/tools/video/ has examples), or to "popost video generate" (popost.ai, paid in credits), or use --check.');
    const picture = image !== undefined ? await givenAnchor(rt, dir, image) : character !== undefined ? await characterOf(rt, dir, character) : undefined;
    const wallet = max !== undefined ? new Wallet(max) : undefined;
    const r = await makeMaterials(rt, {
      requests, dir, generator: budgeted(generator, wallet, args.list('approve-unplanned')), plan: wallet !== undefined,
      // The template's beats give spoken lines their times; a video with a music track of its own gets clips without music.
      ...(times ? { times } : {}), music: await hasMusicTrack(rt, dir),
      ...(off ? { anchor: false } : args.flag('anchor') ? { anchor: true } : {}), ...(picture ? { picture } : {}),
      // A clip takes minutes: a person watching sees which one, on stderr; stdout keeps the one JSON document.
      onStep: (file, done, total) => rt.stderr(file + ' (' + (done + 1) + '/' + total + ')\n'),
    });
    const agree = toAgree(r.materials);
    printJson(rt, {
      ok: errorsIn(r.problems) === 0, dir, notes: rt.path.join(dir, NOTES),
      made: r.materials.filter((m) => m.made).length, kept: r.materials.filter((m) => !m.made && !m.error && !m.waiting).length, failed: r.materials.filter((m) => m.error && !m.confirm).length,
      ...(r.materials.some((m) => m.waiting) ? { waiting: r.materials.filter((m) => m.waiting).length } : {}),
      credits: r.credits, chargedCredits: r.chargedCredits, ...(r.anchor ? { anchor: r.anchor } : {}), ...(r.toConfirm ? { toConfirm: r.toConfirm } : {}), ...(agree ?? {}),
      materials: r.materials, ...(r.notes?.length ? { notes: r.notes } : {}), problems: [...r.problems, ...groupingAdvice(requests)],
    });
    return agree ? CONFIRM_EXIT : errorsIn(r.problems) ? 2 : 0;
  },
  (args) => args.string('out'),
);
