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
import { msg } from '../i18n';

const ACTIONS = ['prepare', 'quote', 'run', 'complete', 'status', 'info'];

const spec = (): CommandSpec => ({
  prog: 'popost image',
  description: msg(
    'Image jobs (prepare, quote, run, complete, status; each needs --dir). `popost image info --file F [F ...]` is the exception: it prints format, size and transparency of picture files and needs no project (popost image info --help). `popost image edit --file F --out G …` crops, rotates, flips, resizes and converts one picture, also without a project (popost image edit --help).',
    '图片任务（prepare、quote、run、complete、status；都需要 --dir）。`popost image info --file F [F ...]` 是例外：它输出图片文件的格式、尺寸和透明度，不需要项目（popost image info --help）。`popost image edit --file F --out G …` 对一张图片做裁剪、旋转、翻转、缩放和格式转换，同样不需要项目（popost image edit --help）。',
  ),
  positionals: [{ name: 'action', choices: ACTIONS }],
  options: [
    { flag: '--dir', required: true },
    {
      flag: '--id',
      help: msg(
        'job id (default composition; run without --id takes the job from --quote-id); quote also takes a list: a,b,c',
        '任务 id（默认 composition；run 不带 --id 时按 --quote-id 找任务）；quote 还可以接列表：a,b,c',
      ),
    },
    { flag: '--purpose', choices: ['composition', 'material'], default: 'composition' },
    { flag: '--prompt-file' },
    {
      flag: '--ref',
      kind: 'append',
      help: msg(
        'prepare: a picture path, or layout | identity | style | content | all for the registered references',
        'prepare：图片路径，或用 layout | identity | style | content | all 指代已登记的参考图',
      ),
    },
    { flag: '--file' },
    { flag: '--tool' },
    { flag: '--note' },
    { flag: '--config' },
    {
      flag: '--quote-id',
      help: msg(
        'run: the quote to submit, which names its job; several separated by commas run side by side',
        'run：要提交的报价，它对应自己的任务；多个用逗号分隔时并行运行',
      ),
    },
    { flag: '--idempotency-key' },
    { flag: '--confirm', kind: 'flag' },
    { flag: '--aspect' },
    { flag: '--accept-unknown-cost', kind: 'flag' },
    { flag: '--all', kind: 'flag', help: msg('quote: every prepared job that has no result and was not submitted', 'quote：所有已准备、没有结果且未提交过的任务') },
    { flag: '--all-quoted', kind: 'flag', help: msg('run: every quote that has not been run yet', 'run：所有还没运行的报价') },
    {
      flag: '--concurrency',
      kind: 'int',
      help: msg(
        `quote / run of several jobs: how many at a time (default ${DEFAULT_CONCURRENCY}, at most ${MAX_CONCURRENCY})`,
        `对多个任务 quote / run 时同时进行几个（默认 ${DEFAULT_CONCURRENCY}，最多 ${MAX_CONCURRENCY}）`,
      ),
    },
  ],
});

type Batch = { action: 'quote'; target: string[] | 'all' } | { action: 'run'; target: string[] | 'all-quoted' };

const several = (value: string | undefined): boolean => value !== undefined && value.includes(',');

/** Whether this call is a batch, and over what; the flag combinations that make no sense are refused before anything is read. */
const batchOf = (a: ParsedArgs): Batch | null => {
  const action = a.req('action');
  const [id, quoteId] = [a.string('id'), a.string('quote-id')];
  if (a.flag('all') && id !== undefined)
    throw new JobError(
      msg(
        '--all and --id are alternatives: name jobs with --id a,b,c, or take every prepared job with --all',
        '--all 和 --id 只能选一个：用 --id a,b,c 点名任务，或用 --all 选所有已准备的任务',
      ),
    );
  if (a.flag('all-quoted') && quoteId !== undefined)
    throw new JobError(
      msg(
        '--all-quoted and --quote-id are alternatives: name quotes with --quote-id q1,q2, or take every quote not yet run with --all-quoted',
        '--all-quoted 和 --quote-id 只能选一个：用 --quote-id q1,q2 点名报价，或用 --all-quoted 选所有还没运行的报价',
      ),
    );
  if (a.flag('all') && action !== 'quote')
    throw new JobError(
      action === 'run'
        ? msg('--all picks jobs to quote; to run every quoted job use --all-quoted', '--all 用来选要报价的任务；要运行所有已报价任务请用 --all-quoted')
        : msg('--all applies to quote only', '--all 只用于 quote'),
    );
  if (a.flag('all-quoted') && action !== 'run')
    throw new JobError(
      action === 'quote'
        ? msg('--all-quoted picks quotes to run; to quote every prepared job use --all', '--all-quoted 用来选要运行的报价；要给所有已准备任务报价请用 --all')
        : msg('--all-quoted applies to run only', '--all-quoted 只用于 run'),
    );
  if (action === 'quote' && (a.flag('all') || several(id))) {
    if (quoteId !== undefined) throw new JobError(msg('--quote-id belongs to run, not to quote', '--quote-id 属于 run，不属于 quote'));
    return { action, target: a.flag('all') ? 'all' : splitList(id!, '--id') };
  }
  if (action === 'run' && (a.flag('all-quoted') || several(quoteId))) {
    if (id !== undefined) throw new JobError(msg('a run of several jobs finds each job by its quote id: drop --id', '运行多个任务时按报价 id 找各自的任务：去掉 --id'));
    if (a.string('idempotency-key') !== undefined)
      throw new JobError(
        msg(
          "--idempotency-key is one job's key; a run of several jobs reuses the key of each job's own ambiguous attempt by itself",
          '--idempotency-key 是单个任务的键；运行多个任务时，每个任务会自动沿用它自己那次结果不明的提交所用的键',
        ),
      );
    return { action, target: a.flag('all-quoted') ? 'all-quoted' : splitList(quoteId!, '--quote-id') };
  }
  if (several(id))
    throw new JobError(
      action === 'run'
        ? msg(
            'run takes one --id; to run several jobs give their quote ids: --quote-id q1,q2 or --all-quoted',
            'run 只接一个 --id；要运行多个任务请给出它们的报价 id：--quote-id q1,q2 或 --all-quoted',
          )
        : msg(`${action} takes one --id`, `${action} 只接一个 --id`),
    );
  if (several(quoteId)) throw new JobError(msg('--quote-id lists apply to run only', '--quote-id 列表只用于 run'));
  return null;
};

const callOf = (a: ParsedArgs): BatchCall => {
  const concurrency = a.number('concurrency') ?? DEFAULT_CONCURRENCY;
  if (concurrency < 1 || concurrency > MAX_CONCURRENCY)
    throw new JobError(
      msg(
        `--concurrency must be 1 to ${MAX_CONCURRENCY}: the platform allows ${MAX_CONCURRENCY} generations in flight per user`,
        `--concurrency 必须是 1 到 ${MAX_CONCURRENCY}：平台允许每个用户同时进行 ${MAX_CONCURRENCY} 个生成`,
      ),
    );
  return { config: a.string('config'), acceptUnknownCost: a.flag('accept-unknown-cost'), concurrency };
};

const actOnBatch = async (rt: Runtime, project: Project, a: ParsedArgs, batch: Batch): Promise<number> => {
  const dir = a.req('dir');
  const call = callOf(a);
  if (batch.action === 'run' && !a.flag('confirm')) throw new JobError(msg('explicit fee authorization required', '需要明确的付费授权（--confirm）'));
  const { document, code } = batch.action === 'quote' ? await quoteBatch(project, dir, batch.target, call) : await runBatch(project, dir, batch.target, call);
  printJson(rt, document, true);
  return code;
};

const prepare = async (rt: Runtime, project: Project, a: ParsedArgs): Promise<number> => {
  const promptFile = a.string('prompt-file');
  if (!promptFile) throw new JobError(msg('--prompt-file is required', '需要 --prompt-file'));
  const made = await prepareJob(project, { id: a.string('id') ?? 'composition', promptFile, purpose: a.req('purpose'), refs: a.list('ref'), aspect: a.string('aspect'), config: a.string('config') });
  const executor = made.job.provider.channel === 'host' ? 'agent-host-tool' : 'provider-cli';
  printJson(rt, { ok: true, jobFile: made.path, job: made.job, executor, ...(made.replaced ? { replaced: true } : {}), ...(made.notes.length ? { notes: made.notes } : {}) }, true);
  return 0;
};

/** `image info` has its own options (a list of files, no project), so it is told apart before the job options are parsed. */
const INFO_EXAMPLE = 'popost image info --file assets/a.png inputs/photo.jpg\n  {"ok":true,"images":[{"file":"assets/a.png","format":"png","width":1024,"height":1024,"hasAlpha":true,"bytes":123456}, …]}';

const infoSpec = (): CommandSpec => ({
  prog: 'popost image info',
  description: msg(
    'Format, pixel size, transparency and byte size of picture files (PNG, JPEG, WebP, GIF, SVG), read from their headers. Use it instead of probing with identify, file or a script. An unreadable file or a non-picture gets its own entry {"file", "ok": false, "error"}; the exit code is non-zero only when every file failed. hasAlpha says the file carries an alpha channel or a transparent colour (not that any pixel is transparent; not reported for SVG, whose width and height come from its attributes or viewBox when it has them).\n\nexample: ' + INFO_EXAMPLE,
    '读取图片文件（PNG、JPEG、WebP、GIF、SVG）的文件头，给出格式、像素尺寸、透明度和字节数。用它代替 identify、file 或脚本探测。无法读取的文件或不是图片的文件各自得到一项 {"file", "ok": false, "error"}；只有全部文件都失败时退出码才非零。hasAlpha 表示文件带 alpha 通道或透明色（不代表真有像素是透明的；SVG 不报告该项，SVG 的宽高取自它的属性或 viewBox）。\n\n示例：' + INFO_EXAMPLE,
  ),
  options: [
    { flag: '--file', kind: 'list', required: true, metavar: 'PATH', help: msg('picture files, relative to the working directory', '图片文件，相对于当前工作目录') },
    {
      flag: '--dir',
      help: msg(
        'optional project directory: a relative path that is not found from here is also looked up inside it',
        '可选的项目目录：从这里找不到的相对路径也会在其中查找',
      ),
    },
  ],
});

const infoMain: CommandMain = (argv, rt) =>
  withProviderArgs(argv, infoSpec(), rt, async (a) => {
    const dir = a.string('dir');
    const images = await Promise.all(a.list('file').map((file) => describeFile(rt, file, dir)));
    if (images.some((image) => !('ok' in image))) {
      printJson(rt, { ok: true, images });
      return 0;
    }
    return fail(rt, msg('none of the files is a readable picture', '没有一个文件是可读取的图片'), 2, { images });
  });

/** Command lines and output: the same in both languages. */
const EDIT_EXAMPLES =
    '  popost image edit --file inputs/shot.webp --crop 0,0,400,120 --out P/assets/logo.png            # cut a region out\n' +
    '  popost image edit --file inputs/shot.webp --crop 60%,10%,30%,40% --scale 3 --out /tmp/zoom.jpg  # look at a detail enlarged\n' +
    '  popost image edit --file inputs/shot.webp --crop 0,0,400,250 --scale 3 --grid --out /tmp/grid.jpg  # where exactly is the logo? read the lines\n' +
    '  popost image edit --file inputs/photo.jpg --width 1080 --height 1440 --out P/assets/hero.jpg    # fill 3:4, centre crop (--fit cover)\n' +
    '  popost image edit --file inputs/icon.svg --width 512 --out P/assets/icon.png                    # SVG to PNG\n' +
    '  {"ok":true,"path":"P/assets/logo.png","format":"png","width":400,"height":120,"bytes":8123,"source":{"file":"inputs/shot.webp","format":"webp","width":1600,"height":907},"steps":["crop 0,0,400,120"]}';

/** `image edit` works on one file and needs no project either. */
const editSpec = (): CommandSpec => ({
  prog: 'popost image edit',
  description: msg(
    'Crop, rotate, flip, resize and convert one picture (PNG, JPEG, WebP, the first frame of a GIF, SVG) into a new file; the source is never changed. Use it instead of ImageMagick, Pillow, sharp or a scratch page. The steps always run in this order, whatever the order of the options: crop, rotate, flip, resize. --crop is measured on the source as the browser decodes it (`popost image info` gives the size); when a viewer showed you the picture scaled down, use percentages. The extension of --out picks the format (.png, .jpg, .webp); transparency is kept for PNG and WebP, a JPEG gets a white ground (or --background). Enlarging adds no detail: it only makes small things easier to look at. To find a crop box, do not guess: look once with --grid (lines labelled in source pixels), read the box off the lines with a margin around the subject, then crop the source itself (never an enlarged copy).\n\nexamples:\n' + EDIT_EXAMPLES,
    '对一张图片（PNG、JPEG、WebP、GIF 的第一帧、SVG）做裁剪、旋转、翻转、缩放和格式转换，写到新文件；源文件永远不变。用它代替 ImageMagick、Pillow、sharp 或临时网页。无论选项顺序如何，步骤总按这个顺序执行：裁剪、旋转、翻转、缩放。--crop 以浏览器解码后的源图为准（`popost image info` 给出尺寸）；如果查看器给你看的是缩小后的图，请用百分比。--out 的扩展名决定格式（.png、.jpg、.webp）；PNG 和 WebP 保留透明，JPEG 会垫白底（或 --background）。放大不会增加细节：只是让小东西更容易看清。找裁剪框时不要猜：先用 --grid 看一次（网格线标的是源图像素），从网格线读出框选范围并给主体留出边距，再对源图本身裁剪（不要对放大后的副本裁剪）。\n\n示例：\n' + EDIT_EXAMPLES,
  ),
  options: [
    { flag: '--file', required: true, metavar: 'PATH', help: msg('the picture to read, relative to the working directory', '要读取的图片，相对于当前工作目录') },
    { flag: '--out', required: true, metavar: 'PATH', help: msg('the file to write (.png, .jpg, .jpeg or .webp); must not be the source', '要写入的文件（.png、.jpg、.jpeg 或 .webp）；不能是源文件') },
    { flag: '--crop', metavar: 'X,Y,W,H', help: msg('the region to keep: source pixels (120,40,800,600) or percentages of the source (10%,0%,50%,100%)', '要保留的区域：源图像素（120,40,800,600）或源图的百分比（10%,0%,50%,100%）') },
    { flag: '--rotate', kind: 'int', metavar: 'DEG', help: msg('90, 180 or 270 degrees clockwise', '顺时针 90、180 或 270 度') },
    { flag: '--flip', choices: ['h', 'v'], help: msg('mirror left-right (h) or top-bottom (v)', '左右镜像（h）或上下翻转（v）') },
    { flag: '--width', kind: 'int', metavar: 'PX', help: msg('result width; alone it keeps the proportions', '结果宽度；单独给出时保持比例') },
    { flag: '--height', kind: 'int', metavar: 'PX', help: msg('result height; alone it keeps the proportions', '结果高度；单独给出时保持比例') },
    { flag: '--fit', choices: ['cover', 'contain'], help: msg('with both --width and --height: cover fills the box and cuts the overflow at the centre (default); contain shows the whole picture on the ground', '同时给出 --width 和 --height 时：cover 填满框并居中裁掉溢出部分（默认）；contain 在底色上显示整张图') },
    { flag: '--scale', kind: 'number', metavar: 'F', help: msg('multiply the size instead of --width / --height: 0.5 halves, 3 enlarges three times', '按倍数缩放，代替 --width / --height：0.5 缩小一半，3 放大三倍') },
    { flag: '--grid', kind: 'flag', help: msg('draw coordinate lines over the result, labelled in source pixels: look at it to read a crop box, then crop the source without --grid. With --crop / --scale only', '在结果上画坐标网格线，标注源图像素：看图读出裁剪框，再去掉 --grid 裁剪源图。只能配合 --crop / --scale') },
    { flag: '--background', metavar: 'COLOUR', help: msg('hex colour under the picture (#ffffff); default: transparent for PNG / WebP, white for JPEG', '图片下面的十六进制底色（#ffffff）；默认 PNG / WebP 透明，JPEG 白色') },
    { flag: '--quality', kind: 'int', default: 90, help: msg('JPEG / WebP quality, 1-100', 'JPEG / WebP 质量，1-100') },
  ],
});

const editMain: CommandMain = (argv, rt) =>
  withProviderArgs(argv, editSpec(), rt, async (a) => {
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
  withProviderArgs(argv, spec(), rt, async (a) => {
    try {
      if (a.req('action') === 'info')
        throw new JobError(
          msg('info comes first and takes no --dir: popost image info --file a.png [b.png ...]', 'info 要写在最前面，并且不接 --dir：popost image info --file a.png [b.png ...]'),
        );
      return await act(rt, await Project.load(rt, a.req('dir')), a);
    } catch (error) {
      if (error instanceof JobError || isOsError(error)) return fail(rt, errorText(error));
      throw error;
    }
  });

export const main: CommandMain = (argv, rt) => {
  if (argv[0] === 'info') return infoMain(argv.slice(1), rt);
  if (argv[0] === 'edit') return editMain(argv.slice(1), rt);
  return jobsMain(argv, rt);
};
