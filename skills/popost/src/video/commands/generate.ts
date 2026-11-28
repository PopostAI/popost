/**
 * `popost video generate video|image <request.json> <out-file>`: the built-in generator (video/generate/cloud.ts), set
 * up with POPOST_GEN_CMD="popost video generate". Unlike the other video commands it speaks the generator contract
 * (video/generate/index.ts): one JSON line on success, `{"credits": n, "chargedCredits": n, "key"?: ...}`; for a price
 * the user has not agreed to, `{"confirm": {...}}` and exit code 3, nothing charged (with reason "unplanned" and the
 * clip for a clip that is not among the agreed clips of its project); any failure, one line on stderr and exit code 1
 * (2: the request or the setup needs fixing). `--models` lists the platform's video models.
 */
import type { ParsedArgs } from '../../args';
import { errorText } from '../../core/error-text';
import { printJson } from '../../core/util';
import { DEFAULT_KEY_ENV, PopostClient } from '../../providers/api';
import { isRecord, type JsonRecord } from '../../providers/base';
import { loadConfig, providerConfig } from '../../providers/cli-config';
import { CliReject, exitCodeOf, ImageProviderError } from '../../providers/errors';
import { scrub, secretValues } from '../../providers/secrets';
import { aroundPath, inProject } from '../../providers/task';
import type { Runtime } from '../../runtime';
import type { Subcommand } from '../../workflow/subcommands';
import { cloudSettings, GenerateError, listModels, makeClip } from '../generate/cloud';
import { makePicture } from '../generate/cloud-image';
import { CONFIRM_EXIT, ConfirmNeeded, type GenerateRequest } from '../generate/index';
import { CREDIT_OPTIONS, ceilingOf } from './credits';
import { userPath, VideoCommandError, type Commands } from './shared';

interface Platform {
  readonly client: PopostClient;
  /** The popost section of the private config. */
  readonly config: JsonRecord;
  readonly secrets: string[];
}

/** The client as every platform command builds it: the private config's popost section, then the environment. */
export const platform = async (rt: Runtime): Promise<Platform> => {
  const cfg = await loadConfig(rt);
  const config = providerConfig(cfg, 'popost');
  const auth = isRecord(config.auth) ? config.auth : {};
  const client = new PopostClient(rt, { baseUrl: config.baseUrl as string | undefined, keyEnv: (auth.envVar as string | undefined) || DEFAULT_KEY_ENV, timeoutSec: Number(config.timeoutSec || 60) });
  return { client, config, secrets: secretValues(rt, cfg) };
};

const LISTS = ['images', 'videos', 'audios'] as const;

const isPaths = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');

/** The request file; references are paths from the working directory. Model, resolution or budget in it are not read. */
const readRequest = async (rt: Runtime, file: string): Promise<GenerateRequest> => {
  const data: unknown = await rt.fs.readText(file).then((t) => JSON.parse(t) as unknown, () => undefined);
  if (!isRecord(data)) throw new GenerateError('The request ' + file + ' is not a JSON object the generator can read.', 2);
  if (typeof data.prompt !== 'string' || !data.prompt.trim()) throw new GenerateError('The request has no "prompt": it says what the clip or picture shows.', 2);
  const { seconds, aspect } = data;
  if (seconds !== undefined && !(typeof seconds === 'number' && Number.isInteger(seconds) && seconds >= 1)) throw new GenerateError('"seconds" is a whole number of seconds; it is ' + JSON.stringify(seconds) + '.', 2);
  if (aspect !== undefined && typeof aspect !== 'string') throw new GenerateError('"aspect" is a ratio such as "16:9", or "adaptive"; it is ' + JSON.stringify(aspect) + '.', 2);
  const lists: Partial<Record<(typeof LISTS)[number], string[]>> = {};
  for (const list of LISTS) {
    const paths = data[list];
    if (paths === undefined) continue;
    if (!isPaths(paths)) throw new GenerateError('"' + list + '" is a list of file paths.', 2);
    if (paths.length) lists[list] = paths.map((p) => userPath(rt, p));
  }
  const frames: { firstFrame?: string; lastFrame?: string } = {};
  for (const key of ['firstFrame', 'lastFrame'] as const) {
    const path = data[key];
    if (path === undefined) continue;
    if (typeof path !== 'string' || !path.trim()) throw new GenerateError('"' + key + '" is the path of a picture.', 2);
    frames[key] = userPath(rt, path);
  }
  return { prompt: data.prompt, ...(seconds !== undefined ? { seconds } : {}), ...(aspect !== undefined ? { aspect } : {}), ...lists, ...frames, ...(data.audio === false ? { audio: false as const } : {}), ...(data.priceOnly === true ? { priceOnly: true as const } : {}) };
};

const USAGE = 'Give the kind, the request and the output file: popost video generate video|image <request.json> <out-file> (or --models).';

const exitOf = (error: unknown): number =>
  error instanceof GenerateError ? error.exitCode : error instanceof VideoCommandError ? 2 : error instanceof CliReject ? error.code : error instanceof ImageProviderError ? exitCodeOf(error) : 1;

const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, ' ').trim();

const run = async (args: ParsedArgs, rt: Runtime): Promise<number> => {
  let secrets: string[] = [];
  try {
    const found = await platform(rt);
    secrets = found.secrets;
    if (args.flag('models')) {
      printJson(rt, { ok: true, ...(await listModels(found.client)) }, true);
      return 0;
    }
    const [kind, request, out] = [args.string('kind'), args.string('request'), args.string('out')];
    if (!kind || !request || !out) throw new GenerateError(USAGE, 2);
    const maxCredits = ceilingOf(args);
    const project = args.string('project');
    const s = cloudSettings(rt, { yes: args.flag('yes') || maxCredits !== undefined, ...(maxCredits !== undefined ? { maxCredits } : {}), approve: args.list('approve-unplanned'), ...(project ? { project: userPath(rt, project) } : {}) });
    const asked = await readRequest(rt, userPath(rt, request));
    const target = userPath(rt, out);
    if (asked.priceOnly && kind !== 'video') throw new GenerateError('"priceOnly" is for a clip; a picture is priced when it is made.', 2);
    // The project the file is for (--project, the one materials names, else the one around the output file): what this
    // call charges joins the project's line on the account page.
    const inside = s.gate.project ? inProject(rt, s.gate.project, 'video') : await aroundPath(rt, target);
    if (kind === 'video') printJson(rt, await makeClip(inside, (await platform(inside)).client, s, asked, target));
    else {
      const made = await makePicture(inside, s, found.config, asked, target);
      printJson(rt, { ...made, chargedCredits: made.credits ?? 0 });
    }
    return 0;
  } catch (error) {
    if (error instanceof ConfirmNeeded) {
      printJson(rt, { confirm: error.confirm });
      rt.stderr(oneLine(error.message) + '\n');
      return CONFIRM_EXIT;
    }
    rt.stderr(oneLine(scrub(errorText(error), secrets)) + '\n');
    return exitOf(error);
  }
};

const generate: Subcommand = {
  spec: {
    description:
      'the built-in generator for POPOST_GEN_CMD="popost video generate": makes a clip or a picture on popost.ai with your account, paid in credits, only at a price the user agreed to (--confirm --max-credits N; POPOST_GEN_MAX_CREDITS or --yes still work); prints {"credits", "chargedCredits", "key"}, or {"confirm": {...}} with exit code 3. In a project with agreed clips (production/approved-clips.json) a clip that is not one of them is asked about (reason "unplanned") until --approve-unplanned <key>',
    positionals: [
      { name: 'kind', choices: ['video', 'image'], required: false, help: 'a clip or a picture' },
      { name: 'request', required: false, help: 'request.json: { "prompt", "seconds"?, "aspect"?, "images"?, "videos"?, "audios"?, "firstFrame"?, "lastFrame"?, "audio"?: false (no sound track, where the model can), "priceOnly"? }; frames never together with references' },
      { name: 'out', required: false, help: 'the file to write: .mp4 for a clip, .png, .jpg or .webp for a picture' },
    ],
    options: [
      { flag: '--models', kind: 'flag', help: 'list the video models (id, resolutions, seconds, aspect ratios, reference limits, credits) and make nothing' },
      { flag: '--yes', kind: 'flag', help: 'the user agreed to the price this call was shown; a budget set in POPOST_GEN_MAX_CREDITS still holds' },
      ...CREDIT_OPTIONS,
      { flag: '--approve-unplanned', kind: 'append', metavar: 'KEY', help: 'the user said yes to this clip, which is not among the agreed clips of its project (its key is in confirm.clip of exit code 3)' },
      { flag: '--project', metavar: 'DIR', help: 'the project the file is for: its agreed clips hold (production/approved-clips.json) and its charges join its line on the account page; by default the project around the output file' },
    ],
  },
  run,
};

export const generateCommands: Commands = { generate };
