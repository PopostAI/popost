/**
 * `popost video doctor` and `popost video probe`: what this machine can do for video, and what a video file is.
 */
import { printJson } from '../../core/util';
import type { Runtime } from '../../runtime';
import { cpuBudgetOf, toolCommand } from '../host';
import { ffmpegPath, hasFfmpeg, probe, runFfmpeg } from '../media/ffmpeg';
import { connected } from '../hosted-api';
import { musicEnabled } from '../music/hosted';
import { command, userPath, type Commands } from './shared';

/** The optional tools a user can plug in, and the environment variable that names each. */
const TOOLS = { readText: 'POPOST_OCR_CMD', transcribe: 'POPOST_ASR_CMD', speak: 'POPOST_TTS_CMD', generate: 'POPOST_GEN_CMD' } as const;

const ffmpegVersion = async (rt: Runtime): Promise<string | null> => {
  if (!(await hasFfmpeg(rt))) return null;
  const text = new TextDecoder().decode((await runFfmpeg(rt, ['-version'])).stdout);
  return text.match(/ffmpeg version (\S+)/)?.[1] ?? 'unknown';
};

const canDraw = async (rt: Runtime): Promise<string | true> => {
  try {
    await (await rt.launchBrowser('frames')).close();
    return true;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const HOSTED = 'popost.ai';
const HOSTED_NOTE = {
  speak: 'popost: voices (popost:default-male, popost:default-female, popost:<id> from popost video voice list), with word times; recommended',
  transcribe: 'popost.ai transcribes the speech' + ' (a transcriber of your own in POPOST_ASR_CMD goes first when it is set)',
  music: 'popost video music make: background music generated from a description, priced by its length (popost video music quote); switched on by POPOST_VIDEO_MUSIC, and made only as the user agreed',
  paid: 'in credits, at least 1 a call: each paid command prints its price without --confirm (exit code 3) and charges only with --confirm --max-credits N',
};
const CONNECT = 'Connect a popost.ai account with popost auth login (recommended): voice-over and transcription then work without local tools. Or set POPOST_TTS_CMD / POPOST_ASR_CMD to tools of your own (skills/popost/tools/video/ has examples).';

/** What a person timing a first run should know: a reader or transcriber may fetch its model then (minutes). */
const FIRST_RUN = 'The first run of a text reader or a transcriber may download its model (several hundred MB; it took 15 minutes on one new machine): run it once on a short clip before timing anything.';

const doctor = command(
  'what this machine has for video: ffmpeg, a browser to draw frames with, the CPU budget the work keeps to, and the optional tools named in the environment',
  {},
  async (_args, rt) => {
    const [version, browser] = await Promise.all([rt.programs ? ffmpegVersion(rt) : null, canDraw(rt)]);
    const named = Object.fromEntries(Object.entries(TOOLS).map(([name, variable]) => [name, toolCommand(rt, variable) ? variable : null]));
    // A connected account speaks and transcribes with popost.ai (the user's own tool goes first where it is set); music only when switched on.
    const account = connected(rt);
    const tools = { ...named, transcribe: named.transcribe ?? (account ? HOSTED : null), speak: named.speak ?? (account ? HOSTED : null), music: musicEnabled(rt) ? HOSTED : null };
    const { music, ...hostedNote } = HOSTED_NOTE;
    const offers = account ? { hosted: musicEnabled(rt) ? { ...hostedNote, music } : hostedNote } : { connect: CONNECT };
    const missing = [
      ...(rt.programs ? [] : ['this host cannot run local programs, so no video command works here']),
      ...(rt.programs && version === null ? ['ffmpeg was not found: install it or set POPOST_FFMPEG (asked for "' + ffmpegPath(rt) + '")'] : []),
      ...(browser === true ? [] : [browser]),
    ];
    const budget = rt.programs ? cpuBudgetOf(rt) : undefined;
    const cpus = budget ? { budget: budget.cpus, from: budget.source } : null;
    const reading = named.readText !== null || named.transcribe !== null;
    printJson(rt, { ok: missing.length === 0, ffmpeg: version, browser: browser === true, cpus, tools, ...offers, ...(reading ? { note: FIRST_RUN } : {}), ...(missing.length ? { missing } : {}) });
    return missing.length ? 2 : 0;
  },
);

const probeCommand = command(
  'size, frame rate, exact frame count, duration and sound of a video file',
  { positionals: [{ name: 'video', help: 'a video file ffmpeg can read' }] },
  async (args, rt) => {
    printJson(rt, { ok: true, ...(await probe(rt, userPath(rt, args.req('video')))) });
  },
);

export const mediaCommands: Commands = { doctor, probe: probeCommand };
