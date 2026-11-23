/**
 * A TextReader that runs an external command. The command is given by POPOST_OCR_CMD, for example
 *   POPOST_OCR_CMD="/path/to/python /path/to/skills/popost/tools/video/ocr-rapidocr/ocr.py"
 * and is called as: <command> <list.json> <out.json>
 *   list.json  [{ "frame": 120, "file": "/abs/000120.jpg" }, ...]
 *   out.json   [{ "frame": 120, "lines": [{ "text": "...", "confidence": 0.97, "box": [x, y, w, h] }] }, ...]
 * with boxes as fractions of the frame. Nothing about the model is known here; in the product the same interface is
 * implemented by a server task.
 */
import type { Runtime } from '../../runtime';
import { cpuBudgetOf, toolCommand, withTempDir } from '../host';
import { runTool, TOOL_THREADS, ToolError } from '../tool';
import type { TextReader, TextSample } from './types';

const VARIABLE = 'POPOST_OCR_CMD';

export const textReaderCommand = (rt: Runtime): string | undefined => rt.env[VARIABLE]?.trim() || undefined;

const isSample = (v: unknown): v is TextSample =>
  typeof v === 'object' && v !== null && typeof (v as TextSample).frame === 'number' && Array.isArray((v as TextSample).lines);

/**
 * How many reader processes run side by side: POPOST_OCR_JOBS, default 1. A reader that already uses every core
 * gains nothing from more processes: measured on a loaded 8-core machine with the RapidOCR tool, 1, 3 and 5
 * processes took 39, 60 and 72 s for the same 89 frames. The option is for readers that are single-threaded or remote.
 */
const jobs = (rt: Runtime): number => Math.max(1, Math.min(16, Math.round(Number(rt.env.POPOST_OCR_JOBS) || 1)));

/**
 * The reader processes for `frames` frames and the threads of each, so that processes times threads stays within the
 * CPU budget: POPOST_OCR_JOBS processes at most, one per 8 frames at most, and no more than the budget allows at the
 * threads each one gets (the user's POPOST_TOOL_THREADS, else an equal share of the budget, at most TOOL_THREADS).
 */
export const readerSplit = (rt: Runtime, frames: number): { processes: number; threads: number } => {
  const budget = cpuBudgetOf(rt).cpus;
  const own = Math.floor(Number(rt.env.POPOST_TOOL_THREADS?.trim()));
  const each = own >= 1 ? own : undefined;
  const processes = Math.max(1, Math.min(jobs(rt), Math.ceil(frames / 8), Math.floor(budget / (each ?? 1))));
  return { processes, threads: each ?? Math.max(1, Math.min(TOOL_THREADS, Math.floor(budget / processes))) };
};

/**
 * The reader behind POPOST_OCR_CMD, or undefined when it is not set (text is then simply not read). The reader runs
 * its command through `rt`, the runtime of the command that asked for it.
 */
export const commandTextReader = (rt: Runtime): TextReader | undefined => {
  if (!toolCommand(rt, VARIABLE)) return undefined;
  const readPart = async (dir: string, part: number, frames: { frame: number; file: string }[], threads: number): Promise<TextSample[]> => {
    const list = rt.path.join(dir, 'list-' + part + '.json'), out = rt.path.join(dir, 'out-' + part + '.json');
    await rt.fs.writeFile(list, JSON.stringify(frames));
    await runTool(rt, VARIABLE, 'The text reader', [list, out], { threads });
    const parsed: unknown = JSON.parse(await rt.fs.readText(out));
    if (!Array.isArray(parsed) || !parsed.every(isSample)) throw new ToolError('The text reader wrote something that is not a list of { frame, lines }. See skills/popost/src/video/text/reader-command.ts for the format.');
    return parsed;
  };
  return {
    read: (frames) =>
      withTempDir(rt, 'popost-video-text-', async (dir) => {
        // Frames are dealt out in turn, so every process gets the same mix of easy and busy frames.
        const { processes: n, threads } = readerSplit(rt, frames.length);
        const parts = Array.from({ length: n }, (_, k) => frames.filter((_f, i) => i % n === k));
        const results = await Promise.all(parts.map((part, k) => readPart(dir, k, part, threads)));
        return results.flat().sort((a, b) => a.frame - b.frame);
      }),
  };
};
