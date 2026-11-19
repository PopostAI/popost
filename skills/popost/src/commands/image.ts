/**
 * `popost image prepare|quote|run|complete|status` (image_jobs.py): one composition job per project and distinct material
 * jobs. `run` charges only with `--confirm`, a quote id bound to this job, unchanged references and a first attempt
 * (or the retry of an ambiguous one, below); `quote` never charges. Refusals are `{"ok": false, "error": …}` with exit 2; a run or quote answers with the provider
 * CLI's own JSON and exit code (1 refused, 2 environment, 3 not confirmed). A job whose run left the outcome unknown
 * (`ambiguous`) is run again only with a fresh quote and `--confirm`, under the key of that attempt (`--idempotency-key`
 * may name it; any other key is refused): the platform never charges one key twice.
 *
 * A single-job action names its job with `--id` (default composition); `run --quote-id Q` without `--id` takes the job
 * that holds the quote, so a project of material jobs needs no `--id` to run (images/single-job.ts).
 *
 * Independent jobs go together: `quote --id a,b,c` (or `--all`) prices several, `run --quote-id q1,q2,q3` (or
 * `--all-quoted`) runs several side by side, at most four at a time. Each is the single command it would have been, and
 * the answer is one document with a result per job (images/batch-quote.ts, batch-run.ts).
 */
import type { CommandSpec, ParsedArgs } from '../args';
import { withProviderArgs } from '../providers/cli-args';
import { Project } from '../core/project';
import { errorText, fail, printJson } from '../core/util';
import type { CommandMain, Runtime } from '../runtime';
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, splitList, type BatchCall } from '../images/batch-jobs';
import { runBatch } from '../images/batch-run';
import { quoteBatch } from '../images/batch-quote';
import { editFile } from '../images/edit';
import { describeFile } from '../images/info';
import { isOsError, JobError } from '../images/jobs';
import { prepareJob } from '../images/prepare';
import { completeJob, quoteOrRun } from '../images/run';
import { resolveJob } from '../images/single-job';
import { failureText, isExpectedFailure } from '../workflow/errors';

const ACTIONS = ['prepare', 'quote', 'run', 'complete', 'status', 'info'];

const SPEC: CommandSpec = {
  prog: 'popost image',
  description: 'Image jobs (prepare, quote, run, complete, status; each needs --dir). `popost image info --file F [F ...]` is the exception: it prints format, size and transparency of picture files and needs no project (popost image info --help). `popost image edit --file F --out G …` crops, rotates, flips, resizes and converts one picture, also without a project (popost image edit --help).',
  positionals: [{ name: 'action', choices: ACTIONS }],
  options: [
    { flag: '--dir', required: true },
    { flag: '--id', help: 'job id (default composition; run without --id takes the job from --quote-id); quote also takes a list: a,b,c' },
    { flag: '--purpose', choices: ['composition', 'material'], default: 'composition' },
    { flag: '--prompt-file' },
    { flag: '--ref', kind: 'append', help: 'prepare: a picture path, or layout | identity | style | content | all for the registered references' },
    { flag: '--file' },
    { flag: '--tool' },
    { flag: '--note' },
    { flag: '--config' },
    { flag: '--quote-id', help: 'run: the quote to submit, which names its job; several separated by commas run side by side' },
    { flag: '--idempotency-key' },
    { flag: '--confirm', kind: 'flag' },
    { flag: '--aspect' },
    { flag: '--accept-unknown-cost', kind: 'flag' },
    { flag: '--all', kind: 'flag', help: 'quote: every prepared job that has no result and was not submitted' },
    { flag: '--all-quoted', kind: 'flag', help: 'run: every quote that has not been run yet' },
    { flag: '--concurrency', kind: 'int', help: `quote / run of several jobs: how many at a time (default ${DEFAULT_CONCURRENCY}, at most ${MAX_CONCURRENCY})` },
  ],
};

type Batch = { action: 'quote'; target: string[] | 'all' } | { action: 'run'; target: string[] | 'all-quoted' };

const several = (value: string | undefined): boolean => value !== undefined && value.includes(',');

/** Whether this call is a batch, and over what; the flag combinations that make no sense are refused before anything is read. */
const batchOf = (a: ParsedArgs): Batch | null => {
  const action = a.req('action');
  const [id, quoteId] = [a.string('id'), a.string('quote-id')];
  if (a.flag('all') && id !== undefined) throw new JobError('--all and --id are alternatives: name jobs with --id a,b,c, or take every prepared job with --all');
  if (a.flag('all-quoted') && quoteId !== undefined) throw new JobError('--all-quoted and --quote-id are alternatives: name quotes with --quote-id q1,q2, or take every quote not yet run with --all-quoted');
  if (a.flag('all') && action !== 'quote') throw new JobError(action === 'run' ? '--all picks jobs to quote; to run every quoted job use --all-quoted' : '--all applies to quote only');
  if (a.flag('all-quoted') && action !== 'run') throw new JobError(action === 'quote' ? '--all-quoted picks quotes to run; to quote every prepared job use --all' : '--all-quoted applies to run only');
  if (action === 'quote' && (a.flag('all') || several(id))) {
    if (quoteId !== undefined) throw new JobError('--quote-id belongs to run, not to quote');
    return { action, target: a.flag('all') ? 'all' : splitList(id!, '--id') };
  }
  if (action === 'run' && (a.flag('all-quoted') || several(quoteId))) {
    if (id !== undefined) throw new JobError('a run of several jobs finds each job by its quote id: drop --id');
    if (a.string('idempotency-key') !== undefined) throw new JobError('--idempotency-key is one job\'s key; a run of several jobs reuses the key of each job\'s own ambiguous attempt by itself');
    return { action, target: a.flag('all-quoted') ? 'all-quoted' : splitList(quoteId!, '--quote-id') };
  }
  if (several(id)) throw new JobError(action === 'run' ? 'run takes one --id; to run several jobs give their quote ids: --quote-id q1,q2 or --all-quoted' : `${action} takes one --id`);
  if (several(quoteId)) throw new JobError('--quote-id lists apply to run only');
  return null;
};

const callOf = (a: ParsedArgs): BatchCall => {
  const concurrency = a.number('concurrency') ?? DEFAULT_CONCURRENCY;
  if (concurrency < 1 || concurrency > MAX_CONCURRENCY) throw new JobError(`--concurrency must be 1 to ${MAX_CONCURRENCY}: the platform allows ${MAX_CONCURRENCY} generations in flight per user`);
  return { config: a.string('config'), acceptUnknownCost: a.flag('accept-unknown-cost'), concurrency };
};

const actOnBatch = async (rt: Runtime, project: Project, a: ParsedArgs, batch: Batch): Promise<number> => {
  const dir = a.req('dir');
  const call = callOf(a);
  if (batch.action === 'run' && !a.flag('confirm')) throw new JobError('explicit fee authorization required');
  const { document, code } = batch.action === 'quote' ? await quoteBatch(project, dir, batch.target, call) : await runBatch(project, dir, batch.target, call);
  printJson(rt, document, true);
  return code;
};

const prepare = async (rt: Runtime, project: Project, a: ParsedArgs): Promise<number> => {
  const promptFile = a.string('prompt-file');
  if (!promptFile) throw new JobError('--prompt-file is required');
  const made = await prepareJob(project, { id: a.string('id') ?? 'composition', promptFile, purpose: a.req('purpose'), refs: a.list('ref'), aspect: a.string('aspect'), config: a.string('config') });
  const executor = made.job.provider.channel === 'host' ? 'agent-host-tool' : 'provider-cli';
  printJson(rt, { ok: true, jobFile: made.path, job: made.job, executor, ...(made.replaced ? { replaced: true } : {}), ...(made.notes.length ? { notes: made.notes } : {}) }, true);
  return 0;
};

/** `image info` has its own options (a list of files, no project), so it is told apart before the job options are parsed. */
const INFO_SPEC: CommandSpec = {
  prog: 'popost image info',
  description: 'Format, pixel size, transparency and byte size of picture files (PNG, JPEG, WebP, GIF, SVG), read from their headers. Use it instead of probing with identify, file or a script. An unreadable file or a non-picture gets its own entry {"file", "ok": false, "error"}; the exit code is non-zero only when every file failed. hasAlpha says the file carries an alpha channel or a transparent colour (not that any pixel is transparent; not reported for SVG, whose width and height come from its attributes or viewBox when it has them).\n\nexample: popost image info --file assets/a.png inputs/photo.jpg\n  {"ok":true,"images":[{"file":"assets/a.png","format":"png","width":1024,"height":1024,"hasAlpha":true,"bytes":123456}, …]}',
  options: [
    { flag: '--file', kind: 'list', required: true, metavar: 'PATH', help: 'picture files, relative to the working directory' },
    { flag: '--dir', help: 'optional project directory: a relative path that is not found from here is also looked up inside it' },
  ],
};

const infoMain: CommandMain = (argv, rt) =>
  withProviderArgs(argv, INFO_SPEC, rt, async (a) => {
    const dir = a.string('dir');
    const images = await Promise.all(a.list('file').map((file) => describeFile(rt, file, dir)));
    if (images.some((image) => !('ok' in image))) {
      printJson(rt, { ok: true, images });
      return 0;
    }
    return fail(rt, 'none of the files is a readable picture', 2, { images });
  });

/** `image edit` works on one file and needs no project either. */
const EDIT_SPEC: CommandSpec = {
  prog: 'popost image edit',
  description:
    'Crop, rotate, flip, resize and convert one picture (PNG, JPEG, WebP, the first frame of a GIF, SVG) into a new file; the source is never changed. Use it instead of ImageMagick, Pillow, sharp or a scratch page. The steps always run in this order, whatever the order of the options: crop, rotate, flip, resize. --crop is measured on the source as the browser decodes it (`popost image info` gives the size); when a viewer showed you the picture scaled down, use percentages. The extension of --out picks the format (.png, .jpg, .webp); transparency is kept for PNG and WebP, a JPEG gets a white ground (or --background). Enlarging adds no detail: it only makes small things easier to look at. To find a crop box, do not guess: look once with --grid (lines labelled in source pixels), read the box off the lines with a margin around the subject, then crop the source itself (never an enlarged copy).\n\n' +
    'examples:\n' +
    '  popost image edit --file inputs/shot.webp --crop 0,0,400,120 --out P/assets/logo.png            # cut a region out\n' +
    '  popost image edit --file inputs/shot.webp --crop 60%,10%,30%,40% --scale 3 --out /tmp/zoom.jpg  # look at a detail enlarged\n' +
    '  popost image edit --file inputs/shot.webp --crop 0,0,400,250 --scale 3 --grid --out /tmp/grid.jpg  # where exactly is the logo? read the lines\n' +
    '  popost image edit --file inputs/photo.jpg --width 1080 --height 1440 --out P/assets/hero.jpg    # fill 3:4, centre crop (--fit cover)\n' +
    '  popost image edit --file inputs/icon.svg --width 512 --out P/assets/icon.png                    # SVG to PNG\n' +
    '  {"ok":true,"path":"P/assets/logo.png","format":"png","width":400,"height":120,"bytes":8123,"source":{"file":"inputs/shot.webp","format":"webp","width":1600,"height":907},"steps":["crop 0,0,400,120"]}',
  options: [
    { flag: '--file', required: true, metavar: 'PATH', help: 'the picture to read, relative to the working directory' },
    { flag: '--out', required: true, metavar: 'PATH', help: 'the file to write (.png, .jpg, .jpeg or .webp); must not be the source' },
    { flag: '--crop', metavar: 'X,Y,W,H', help: 'the region to keep: source pixels (120,40,800,600) or percentages of the source (10%,0%,50%,100%)' },
    { flag: '--rotate', kind: 'int', metavar: 'DEG', help: '90, 180 or 270 degrees clockwise' },
    { flag: '--flip', choices: ['h', 'v'], help: 'mirror left-right (h) or top-bottom (v)' },
    { flag: '--width', kind: 'int', metavar: 'PX', help: 'result width; alone it keeps the proportions' },
    { flag: '--height', kind: 'int', metavar: 'PX', help: 'result height; alone it keeps the proportions' },
    { flag: '--fit', choices: ['cover', 'contain'], help: 'with both --width and --height: cover fills the box and cuts the overflow at the centre (default); contain shows the whole picture on the ground' },
    { flag: '--scale', kind: 'number', metavar: 'F', help: 'multiply the size instead of --width / --height: 0.5 halves, 3 enlarges three times' },
    { flag: '--grid', kind: 'flag', help: 'draw coordinate lines over the result, labelled in source pixels: look at it to read a crop box, then crop the source without --grid. With --crop / --scale only' },
    { flag: '--background', metavar: 'COLOUR', help: 'hex colour under the picture (#ffffff); default: transparent for PNG / WebP, white for JPEG' },
    { flag: '--quality', kind: 'int', default: 90, help: 'JPEG / WebP quality, 1-100' },
  ],
};

const editMain: CommandMain = (argv, rt) =>
  withProviderArgs(argv, EDIT_SPEC, rt, async (a) => {
    try {
      printJson(rt, await editFile(rt, a));
      return 0;
    } catch (error) {
      return fail(rt, isExpectedFailure(error) ? failureText(error) : errorText(error));
    }
  });

const act = async (rt: Runtime, project: Project, a: ParsedArgs): Promise<number> => {
  const action = a.req('action');
  const batch = batchOf(a);
  if (batch) return actOnBatch(rt, project, a, batch);
  if (action === 'prepare') return prepare(rt, project, a);
  const { path, job } = await resolveJob(project, { action, id: a.string('id'), quoteId: a.string('quote-id') });
  if (action === 'quote' || action === 'run') {
    const outcome = await quoteOrRun(project, job, path, action, { config: a.string('config'), quoteId: a.string('quote-id'), idempotencyKey: a.string('idempotency-key'), confirm: a.flag('confirm'), acceptUnknownCost: a.flag('accept-unknown-cost') });
    printJson(rt, outcome.result, true);
    return outcome.code;
  }
  if (action === 'complete') await completeJob(project, job, path, { file: a.string('file'), tool: a.string('tool'), note: a.string('note') });
  printJson(rt, { ok: true, jobFile: path, job, executor: job.provider.channel === 'host' ? 'agent-host-tool' : 'provider-cli' }, true);
  return 0;
};

const jobsMain: CommandMain = (argv, rt) =>
  withProviderArgs(argv, SPEC, rt, async (a) => {
    try {
      if (a.req('action') === 'info') throw new JobError('info comes first and takes no --dir: popost image info --file a.png [b.png ...]');
      return await act(rt, await Project.load(rt, a.req('dir')), a);
    } catch (error) {
      if (error instanceof JobError || isOsError(error)) return fail(rt, error.message);
      throw error;
    }
  });

export const main: CommandMain = (argv, rt) => {
  if (argv[0] === 'info') return infoMain(argv.slice(1), rt);
  if (argv[0] === 'edit') return editMain(argv.slice(1), rt);
  return jobsMain(argv, rt);
};
