/**
 * Local task records of the popost channel and its offline mock (the storage half of providers/popost.py).
 *
 * The platform's generation endpoint is synchronous, so a "task" is the saved answer: `<tasks>/<taskId>.json` plus the
 * inline images in `<tasks>/<taskId>/`. `status`, `result` and `download` only read these; nothing is regenerated.
 * Nothing is ever written into the package: the mock keeps its mutable state in the caller's directory.
 */
import { createHash } from 'node:crypto';
import type { Runtime } from '../runtime';
import { sha256File, writeAtomic } from '../core/util';
import { downloadResult, EXTENSIONS, sniffImageMime } from './api';
import { isInt, isNumber, isRecord, type JsonRecord } from './base';
import { AmbiguousSubmitError, ImageProviderError } from './errors';
import { stampWithOffset } from './time';

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export interface StoredImage extends JsonRecord {
  index: number;
  file?: string;
  url?: string;
  mimeType?: string | null;
  sha256?: string;
  width?: number;
  height?: number;
}

export interface TaskRecord extends JsonRecord {
  taskId: string;
  status: string;
  model?: string;
  images: StoredImage[];
}

export class TaskStore {
  constructor(
    private readonly rt: Runtime,
    private readonly dir: () => string,
  ) {}

  recordPath = (taskId: string): string => this.rt.path.join(this.dir(), `${taskId}.json`);
  private taskRoot = (taskId: string): string => this.rt.path.join(this.dir(), taskId);

  /** Creates the task folder before the paid request goes out, so a result that cannot be saved is known in advance. */
  async prepare(taskId: string): Promise<string> {
    const root = this.taskRoot(taskId);
    const fail = (kind: string) => new ImageProviderError(`任务记录目录不可写（${kind}），未提交: ${root}`);
    if (await this.rt.fs.stat(root)) throw fail('FileExistsError');
    try {
      await this.rt.fs.mkdir(root);
      const probe = this.rt.path.join(root, '.write-probe');
      await this.rt.fs.writeFile(probe, 'ok');
      await this.rt.fs.rm(probe);
    } catch (error) {
      throw fail((error as { code?: string })?.code ?? 'OSError');
    }
    return root;
  }

  /** Saves the platform's answer. A usable image list is required; without one the outcome is unknown, not "free". */
  async store(taskId: string, root: string, data: unknown, model: string | null, aspect: string, count: number, idem: string): Promise<TaskRecord> {
    const hint = `可能已扣费；幂等键 ${idem}，重试前先核对 popost.ai 生成记录`;
    if (!isRecord(data) || !Array.isArray(data.images) || !data.images.length) throw new AmbiguousSubmitError(`生成响应缺少 images，结果不确定。${hint}`);
    const images: StoredImage[] = [];
    for (const [i, img] of data.images.entries()) {
      if (!isRecord(img)) continue;
      const entry = await this.storeImage(root, i, img);
      if (entry) images.push(entry);
    }
    if (!images.length) throw new AmbiguousSubmitError(`生成响应里没有可用图片，结果不确定。${hint}`);
    const usage = isRecord(data.usage) ? data.usage : {};
    const record: TaskRecord = {
      schema: 'popost-task.v1',
      taskId,
      provider: 'popost',
      status: 'completed',
      model: ((data.model as string | undefined) || model) ?? undefined,
      aspect,
      count,
      idempotencyKey: idem,
      createdAt: stampWithOffset(this.rt.now()),
      credits: isNumber(usage.credits) ? usage.credits : null,
      balance: isNumber(data.balance) ? data.balance : null,
      revisedPrompt: typeof data.revisedPrompt === 'string' ? data.revisedPrompt : null,
      images,
    };
    await writeAtomic(this.rt, this.recordPath(taskId), JSON.stringify(record, null, 1));
    return record;
  }

  private async storeImage(root: string, index: number, img: JsonRecord): Promise<StoredImage | null> {
    const entry: StoredImage = { index };
    for (const key of ['width', 'height'] as const) if (isInt(img[key])) entry[key] = img[key];
    if (typeof img.data === 'string' && img.data) {
      const raw = new Uint8Array(Buffer.from(img.data, 'base64'));
      const mime = sniffImageMime(raw.subarray(0, 16));
      if (!mime) throw new Error(`inline image ${index} is not a supported image`);
      const file = `${index}${EXTENSIONS[mime]}`;
      await this.rt.fs.writeFile(this.rt.path.join(root, file), raw);
      return Object.assign(entry, { file, mimeType: mime, sha256: createHash('sha256').update(raw).digest('hex') });
    }
    if (typeof img.url === 'string' && img.url) return Object.assign(entry, { url: img.url, mimeType: (img.mimeType as string | undefined) ?? null });
    return null;
  }

  async load(taskId: string): Promise<TaskRecord> {
    if (!TASK_ID_RE.test(String(taskId ?? ''))) throw new ImageProviderError(`非法 taskId: ${JSON.stringify(taskId)}`);
    const path = this.recordPath(taskId);
    if (!(await this.rt.fs.stat(path))?.isFile)
      throw new ImageProviderError(`本地没有任务记录 ${taskId}（popost 生图为同步接口，记录在 ${this.dir()}；用 --task-dir/--quote-dir 指向生成时的目录）`);
    return JSON.parse(await this.rt.fs.readText(path)) as TaskRecord;
  }

  async status(taskId: string): Promise<JsonRecord> {
    const rec = await this.load(taskId);
    return { taskId, status: rec.status, model: rec.model, images: (rec.images ?? []).length, createdAt: rec.createdAt, credits: rec.credits, idempotencyKey: rec.idempotencyKey };
  }

  async result(taskId: string): Promise<string[]> {
    const rec = await this.load(taskId);
    const root = this.taskRoot(taskId);
    return (rec.images ?? []).map((i) => (i.file ? this.rt.path.join(root, i.file) : (i.url as string)));
  }

  /** Copies the saved images to `outDir` (inline ones) or downloads them (url ones). Never regenerates. */
  async materialize(taskId: string, outDir: string, filename?: string): Promise<JsonRecord[]> {
    const rec = await this.load(taskId);
    if (rec.status !== 'completed') throw new ImageProviderError(`任务 ${taskId} 未 completed（当前 ${String(rec.status)}）`);
    await this.rt.fs.mkdir(outDir);
    const images = rec.images ?? [];
    const base = filename ? this.rt.path.parse(this.rt.path.basename(filename)).name : taskId;
    const out: JsonRecord[] = [];
    for (const img of images) {
      const index = img.index ?? out.length;
      const stem = filename && images.length === 1 ? base : `${base}_${index}`;
      const { dest, url } = await this.place(taskId, outDir, stem, img, index);
      const item: JsonRecord = { index, url, localPath: dest, sha256: await sha256File(this.rt, dest), mimeType: sniffImageMime((await this.rt.fs.readFile(dest)).subarray(0, 16)) };
      for (const key of ['width', 'height'] as const) if (img[key]) item[key] = img[key];
      out.push(item);
    }
    return out;
  }

  private async place(taskId: string, outDir: string, stem: string, img: StoredImage, index: number): Promise<{ dest: string; url: string | null }> {
    const { path } = this.rt;
    if (img.file) {
      const src = path.join(this.taskRoot(taskId), path.basename(img.file));
      const dest = path.join(outDir, stem + path.extname(src));
      await this.rt.fs.writeFile(dest, await this.rt.fs.readFile(src));
      return { dest, url: null };
    }
    const tmp = path.join(outDir, `${stem}.download`);
    const raw = await downloadResult(this.rt, img.url as string, tmp);
    const mime = sniffImageMime(raw.subarray(0, 16));
    if (!mime) {
      await this.rt.fs.rm(tmp);
      throw new ImageProviderError(`结果图 ${index} 下载内容不是图片`);
    }
    const dest = path.join(outDir, stem + EXTENSIONS[mime]);
    await this.rt.fs.rename(tmp, dest);
    return { dest, url: img.url as string };
  }
}

/** The offline mock of the popost channel: a model list from the fixtures, synchronous fake tasks, no network or charge. */
export class PopostMock {
  constructor(
    private readonly rt: Runtime,
    private readonly mockDir: string | null,
    private readonly staticDir: string,
    private readonly modelsPath: unknown,
  ) {}

  /** Mutable state goes to `--mock-dir`, else `.sps-mock` in the working directory; never into the package. */
  private stateDir = (): string => this.mockDir ?? this.rt.path.join(this.rt.cwd, '.sps-mock');
  private tasksFile = (): string => this.rt.path.join(this.stateDir(), 'mock_tasks.json');

  async catalog(): Promise<JsonRecord> {
    const candidates = [typeof this.modelsPath === 'string' ? this.modelsPath : null, this.mockDir ? this.rt.path.join(this.mockDir, 'mock_models.json') : null, this.rt.path.join(this.staticDir, 'mock_models.json')];
    for (const path of candidates) if (path && (await this.rt.fs.stat(path))?.isFile) return JSON.parse(await this.rt.fs.readText(path)) as JsonRecord;
    throw new ImageProviderError('mock 模式缺少模型清单 mock_models.json');
  }

  private async tasks(): Promise<JsonRecord[]> {
    return (await this.rt.fs.stat(this.tasksFile()))?.isFile ? (JSON.parse(await this.rt.fs.readText(this.tasksFile())) as JsonRecord[]) : [];
  }

  async submit(prompt: string, aspect: string, model: string | null, count: number, idem: string, credits: number | null | undefined): Promise<JsonRecord> {
    const tasks = await this.tasks();
    const taskId = `mock-task-${tasks.length + 1}`;
    tasks.push({ taskId, type: 'image', status: 'completed', model, aspect, count, prompt, idempotencyKey: idem, outputs: [{ url: 'mock://mock_result.png' }] });
    await this.rt.fs.writeFile(this.tasksFile(), JSON.stringify(tasks, null, 1));
    const costCredits = credits !== null && credits !== undefined ? credits * count : null;
    return { taskId, model, aspect, count, status: 'completed', costCredits, idempotencyKey: idem, mock: true };
  }

  async status(taskId: string): Promise<JsonRecord> {
    const task = (await this.tasks()).find((t) => t.taskId === taskId);
    if (!task) throw new ImageProviderError(`mock 任务 ${taskId} 不存在`);
    return { ...task, mock: true };
  }

  async materialize(taskId: string, outDir: string, filename?: string): Promise<JsonRecord[]> {
    const data = await this.status(taskId);
    await this.rt.fs.mkdir(outDir);
    const out: JsonRecord[] = [];
    for (const [i, output] of ((data.outputs as JsonRecord[] | undefined) ?? []).entries()) {
      const src = await this.resultImage(String(output.url));
      const dest = this.rt.path.join(outDir, filename ?? `${taskId}_${i}.png`);
      await this.rt.fs.writeFile(dest, await this.rt.fs.readFile(src));
      out.push({ index: i, url: output.url, localPath: dest, sha256: await sha256File(this.rt, dest), mimeType: 'image/png', mock: true });
    }
    return out;
  }

  private async resultImage(url: string): Promise<string> {
    const { path } = this.rt;
    const candidates = [...(this.mockDir ? [path.join(this.mockDir, path.basename(url)), path.join(this.mockDir, 'mock_result.png')] : []), path.join(this.staticDir, 'mock_result.png')];
    for (const candidate of candidates) if ((await this.rt.fs.stat(candidate))?.isFile) return candidate;
    throw new ImageProviderError('mock 缺少结果图：包内 assets/mock/mock_result.png 缺失');
  }
}
