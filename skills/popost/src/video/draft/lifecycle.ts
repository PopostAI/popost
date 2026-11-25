import type { Runtime } from '../../runtime';
import { applicationPids, detectDraftApplication, runNative, type DraftApplication } from './targets';
import { readNativeReceipt } from './native';

export interface DraftOpenResult { ok: boolean; restarted: boolean; quitPending?: boolean; message?: string }
const pause = (rt: Runtime, ms: number): Promise<void> => rt.sleep?.(ms) ?? new Promise(resolve => setTimeout(resolve, ms));
const waitForExit = async (rt: Runtime, app: DraftApplication): Promise<boolean> => {
  for (let attempt = 0; attempt < 25; attempt++) {
    if (!(await applicationPids(rt, app)).length) return true;
    await pause(rt, 200);
  }
  return false;
};
const opening = new Set<string>();
/** Called only by the post-export Open/Restart button. Never force-kill an editor that does not finish quitting. */
export const openNativeDraft = async (rt: Runtime, dir: string, receiptId: string): Promise<DraftOpenResult> => {
  const receipt = await readNativeReceipt(rt, dir, receiptId), app = await detectDraftApplication(rt, receipt.target);
  if (!app.appPath || !app.executable) return { ok: false, restarted: false, message: 'The target editor could not be found. Install it, then open the saved draft.' };
  if (rt.path.resolve(app.root!) !== rt.path.resolve(receipt.root)) return { ok: false, restarted: false, message: 'The editor’s draft location changed. Export a new draft to its current folder.' };
  if (opening.has(app.target)) return { ok: false, restarted: false, message: 'The target editor is already opening. Please wait.' };
  opening.add(app.target);
  let restarted = false;
  try {
    const pids = await applicationPids(rt, app); restarted = pids.length > 0;
    for (const pid of pids) {
      if (rt.platform === 'darwin') await runNative(rt, ['kill', '-TERM', String(pid)]);
      else await runNative(rt, ['taskkill', '/PID', String(pid)]);
    }
    if (restarted && !await waitForExit(rt, app)) return { ok: false, restarted, quitPending: true };
    for (let attempt = 0; attempt < 4; attempt++) {
      if (rt.platform === 'darwin') await runNative(rt, ['open', '-a', app.appPath]);
      else if (rt.processes) await rt.processes.spawnDetached([app.executable], { cwd: app.appPath, logFile: rt.path.join(dir, '.studio', 'native-editor.log') });
      else return { ok: false, restarted, message: 'This host cannot launch the desktop editor.' };
      for (let check = 0; check < 5; check++) {
        if ((await applicationPids(rt, app)).length) return { ok: true, restarted };
        await pause(rt, 200);
      }
    }
    return { ok: false, restarted, message: 'The draft is saved, but the target editor did not finish opening. Open it manually or try again.' };
  } finally { opening.delete(app.target); }
};
