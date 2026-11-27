/**
 * `popost video doctor` and `popost video probe`: what this machine can do for video, and what a video file is.
 */
import { printJson } from '../../core/util';
import type { Runtime } from '../../runtime';
import { cpuBudgetOf, toolCommand } from '../host';
import { ffmpegPath, hasFfmpeg, probe, runFfmpeg } from '../media/ffmpeg';
import { ASR_BUDGET, hostedTranscriptionAbsence } from '../speech/hosted';
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

/** What a person timing a first run should know: a reader or transcriber may fetch its model then (minutes). */
const FIRST_RUN = 'The first run of a text reader or a transcriber may download its model (several hundred MB; it took 15 minutes on one new machine): run it once on a short clip before timing anything.';

const doctor = command(
  'what this machine has for video: ffmpeg, a browser to draw frames with, the CPU budget the work keeps to, and the optional tools named in the environment',
  {},
  async (_args, rt) => {
    const [version, browser] = await Promise.all([rt.programs ? ffmpegVersion(rt) : null, canDraw(rt)]);
    const named = Object.fromEntries(Object.entries(TOOLS).map(([name, variable]) => [name, toolCommand(rt, variable) ? variable : null]));
    // Without a transcriber of its own, a connected account transcribes with popost.ai within a confirmed budget.
    const hosted = named.transcribe ? undefined : hostedTranscriptionAbsence(rt);
    const tools = { ...named, transcribe: named.transcribe ?? (hosted ? null : ASR_BUDGET) };
    const offers = hosted?.connected ? { hosted: { transcribe: 'popost.ai transcribes for credits: ' + hosted.why } } : {};
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
