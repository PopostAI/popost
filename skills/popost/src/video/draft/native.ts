import type { Runtime } from '../../runtime';
import type { Project } from '../types';
import { draftContent, type DraftTarget } from './schema';
import { draftSourceHash, prepareDraft, type PreparedDraft } from './export';
import { detectDraftApplication, type DraftApplication } from './targets';

export interface NativeDraftReceipt {
  version: 1;
  receiptId: string;
  target: DraftTarget;
  directory: string;
  root: string;
  name: string;
  sourceHash: string;
  clips: number;
  audio: number;
  captions: number;
}
export interface NativeDraftResult extends NativeDraftReceipt { productLabel: string; productRunning: boolean; canOpen: boolean }
export const nativeReceiptFile = (rt: Runtime, dir: string, id: string): string => {
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id)) throw new Error('Invalid draft export receipt.');
  return rt.path.join(dir, '.studio', 'native-exports', id.toLowerCase() + '.json');
};
export const readNativeReceipt = async (rt: Runtime, dir: string, id: string): Promise<NativeDraftReceipt> => {
  const receipt = JSON.parse(await rt.fs.readText(nativeReceiptFile(rt, dir, id))) as NativeDraftReceipt;
  if (receipt.version !== 1 || receipt.receiptId.toLowerCase() !== id.toLowerCase() || !['jianying', 'capcut'].includes(receipt.target)) throw new Error('The saved draft export receipt is invalid.');
  if (!(await rt.fs.stat(rt.path.join(receipt.directory, 'draft_meta_info.json')))?.isFile) throw new Error('The exported draft folder is no longer available. Export a new draft.');
  return receipt;
};
const copied = async (rt: Runtime, from: string, to: string): Promise<void> => {
  if (rt.fs.copyFile) await rt.fs.copyFile(from, to);
  else await rt.fs.writeFile(to, await rt.fs.readFile(from));
};
const availableName = async (rt: Runtime, dir: string, root: string): Promise<string> => {
  const base = (rt.path.basename(dir) === 'project' ? rt.path.basename(rt.path.dirname(dir)) : rt.path.basename(dir)).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 70) || 'Project';
  const title = base.toLowerCase().startsWith('popost') ? base : 'Popost · ' + base, used = new Set<string>();
  const folders = (await rt.fs.stat(root))?.isDirectory ? await rt.fs.readdir(root) : [];
  for (const folder of folders.filter(name => /^Popost-[\da-f-]{36}$/i.test(name))) {
    try { const meta = JSON.parse(await rt.fs.readText(rt.path.join(root, folder, 'draft_meta_info.json'))) as { draft_name?: string }; if (meta.draft_name) used.add(meta.draft_name); }
    catch { /* A missing or unreadable existing draft is preserved. */ }
  }
  for (let version = 1; version < 10000; version++) {
    const name = title + (version === 1 ? '' : ' ' + version);
    if (!used.has(name)) return name;
  }
  return title + ' ' + rt.now().getTime();
};
const resultOf = async (rt: Runtime, receipt: NativeDraftReceipt): Promise<NativeDraftResult> => {
  const app = await detectDraftApplication(rt, receipt.target);
  return { ...receipt, productLabel: app.label, productRunning: app.running, canOpen: !!app.appPath };
};

/** Publish one complete, self-contained folder. The target application owns and refreshes its own draft index. */
export const installNativeDraft = async (rt: Runtime, dir: string, prepared: PreparedDraft, app: DraftApplication, requestId: string): Promise<NativeDraftResult> => {
  const receiptFile = nativeReceiptFile(rt, dir, requestId), id = requestId.toLowerCase();
  if (!app.usable || !app.root) throw new Error('Install and open the selected editor on this computer before exporting.');
  const directory = rt.path.join(app.root, 'Popost-' + id), marker = rt.path.join(directory, '.popost-export.json');
  if (await rt.fs.stat(directory)) {
    if (!(await rt.fs.stat(marker))) throw new Error('The draft folder already exists. It was preserved; start a new export.');
    const prior = JSON.parse(await rt.fs.readText(marker)) as NativeDraftReceipt;
    if (prior.receiptId !== id || prior.target !== app.target || prior.sourceHash !== prepared.sourceHash) throw new Error('This export id belongs to another snapshot. Start a new export.');
    await rt.fs.writeFile(receiptFile, JSON.stringify(prior), { private: true });
    return resultOf(rt, await readNativeReceipt(rt, dir, id));
  }
  const name = await availableName(rt, dir, app.root);
  const receipt: NativeDraftReceipt = { version: 1, receiptId: id, target: app.target, directory, root: app.root, name, sourceHash: prepared.sourceHash, clips: prepared.videos.length, audio: prepared.audio.length, captions: prepared.captions.length };
  const staging = rt.path.join(app.root, '.popost-' + id + '-' + rt.randomUUID());
  await rt.fs.mkdir(staging);
  try {
    const media = [...prepared.videos, ...prepared.audio];
    for (const item of media) {
      if (!/^media\/[a-zA-Z0-9._-]+$/.test(item.file)) throw new Error('Invalid prepared media path.');
      await copied(rt, rt.path.join(prepared.directory, item.file), rt.path.join(staging, item.file));
    }
    const absolute = (items: typeof media) => items.map(item => ({ ...item, file: rt.path.join(directory, item.file) }));
    const draft = draftContent(rt, { id: id.toUpperCase(), name, target: app.target, ...prepared, videos: absolute(prepared.videos), audio: absolute(prepared.audio), os: rt.platform === 'win32' ? 'windows' : 'mac' });
    const body = JSON.stringify(draft), now = rt.now().getTime() * 1000;
    const library = absolute(media).map(item => ({ id: item.id, file_Path: item.file, extra_info: rt.path.basename(item.file), duration: item.duration, width: item.width ?? 0, height: item.height ?? 0, type: 0, metetype: item.width ? 'video' : 'music', item_source: 1, create_time: -1, import_time: -1, import_time_ms: -1, roughcut_time_range: { start: 0, duration: item.duration }, sub_time_range: { start: -1, duration: -1 }, md5: '' }));
    const meta = { draft_id: id.toUpperCase(), draft_name: name, draft_fold_path: directory, draft_root_path: app.root, draft_cover: rt.path.join(directory, 'draft_cover.jpg'), draft_deeplink_url: '', draft_enterprise_info: {}, draft_materials: [0, 1, 2, 3, 6, 7, 8].map(type => ({ type, value: type === 0 ? library : [] })), draft_materials_copied_info: [], draft_segment_extra_info: [], draft_is_invisible: false, draft_is_ai_shorts: false, draft_cloud_last_action_download: false, draft_cloud_materials: [], tm_draft_create: now, tm_draft_modified: now, tm_duration: prepared.duration };
    for (const file of ['draft_content.json', 'draft_info.json', 'template-2.tmp']) await rt.fs.writeFile(rt.path.join(staging, file), body);
    await rt.fs.writeFile(rt.path.join(staging, 'draft_meta_info.json'), JSON.stringify(meta));
    await rt.fs.writeFile(rt.path.join(staging, 'draft_settings'), '[General]\ndraft_create_time=' + Math.floor(now / 1e6) + '\ndraft_last_edit_time=' + Math.floor(now / 1e6) + '\nreal_edit_keys=1\nreal_edit_seconds=0\n');
    await copied(rt, prepared.cover, rt.path.join(staging, 'draft_cover.jpg'));
    for (const folder of ['.backup', 'Resources', 'adjust_mask', 'common_attachment', 'matting', 'qr_upload', 'smart_crop', 'subdraft']) await rt.fs.mkdir(rt.path.join(staging, folder));
    await rt.fs.writeFile(rt.path.join(staging, '.popost-export.json'), JSON.stringify(receipt));
    await rt.fs.rename(staging, directory);
  } finally { await rt.fs.rm(staging); }
  await rt.fs.writeFile(receiptFile, JSON.stringify(receipt), { private: true });
  return resultOf(rt, receipt);
};

const pending = new Map<string, { signature: string; task: Promise<NativeDraftResult> }>();
export const exportNativeDraft = (rt: Runtime, dir: string, source: Project, target: DraftTarget, requestId: string): Promise<NativeDraftResult> => {
  nativeReceiptFile(rt, dir, requestId);
  const key = rt.path.resolve(dir), current = pending.get(key);
  const signature = JSON.stringify({ requestId: requestId.toLowerCase(), target, source });
  if (current) {
    if (current.signature === signature) return current.task;
    return Promise.reject(new Error('A draft export is already running. Wait for it to finish.'));
  }
  const task = (async () => {
    const app = await detectDraftApplication(rt, target);
    if (!app.usable) throw new Error('Install and open the selected editor on this computer before exporting.');
    const file = nativeReceiptFile(rt, dir, requestId);
    if (await rt.fs.stat(file)) {
      const prior = await readNativeReceipt(rt, dir, requestId);
      if (prior.target !== target || prior.sourceHash !== await draftSourceHash(rt, dir, source)) throw new Error('The timeline changed. Start a new export.');
      return resultOf(rt, prior);
    }
    return installNativeDraft(rt, dir, await prepareDraft(rt, dir, source), app, requestId);
  })().finally(() => { pending.delete(key); });
  pending.set(key, { signature, task });
  return task;
};
