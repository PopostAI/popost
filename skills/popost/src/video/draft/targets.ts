import type { Runtime } from '../../runtime';
import type { DraftTarget } from './schema';

const PRODUCTS = {
  jianying: { label: '剪映专业版', bundle: 'com.lemon.lvpro', app: 'VideoFusion-macOS.app', data: 'JianyingPro', exe: 'JianyingPro.exe' },
  capcut: { label: 'CapCut', bundle: 'com.lemon.lvoverseas', app: 'CapCut.app', data: 'CapCut', exe: 'CapCut.exe' },
} as const;
export interface DraftApplication {
  target: DraftTarget;
  label: string;
  supported: boolean;
  usable: boolean;
  appPath?: string;
  executable?: string;
  root?: string;
  running: boolean;
}
export const readTarget = (value: unknown): DraftTarget => {
  if (value !== 'jianying' && value !== 'capcut') throw new Error('Choose Jianying Pro or CapCut.');
  return value;
};
const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes).trim();
export const runNative = async (rt: Runtime, argv: string[]): Promise<string | undefined> => {
  try {
    const result = await rt.programs?.run(argv);
    return result?.code === 0 ? textOf(result.stdout) : undefined;
  } catch { return undefined; }
};
const readJson = async (rt: Runtime, file: string): Promise<Record<string, unknown> | undefined> => {
  if (!(await rt.fs.stat(file))) return undefined;
  const data: unknown = JSON.parse(await rt.fs.readText(file));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The target editor’s draft settings are invalid. Open that editor and check its draft location.');
  return data as Record<string, unknown>;
};
/** Qt settings escape backslashes and Unicode code units, including custom draft paths. */
export const unescapeDraftPath = (value: string): string => value.replace(/\\(\\|x[0-9a-fA-F]{1,4})/g, (_, code: string) => code === '\\' ? '\\' : String.fromCharCode(Number.parseInt(code.slice(1), 16)));

const draftRoot = async (rt: Runtime, data: string): Promise<string> => {
  const base = rt.platform === 'win32' ? rt.env.LOCALAPPDATA ?? rt.path.join(rt.homeDir!, 'AppData', 'Local') : rt.path.join(rt.homeDir!, 'Movies');
  const userData = rt.path.join(base, data, 'User Data');
  const fallback = rt.path.join(userData, 'Projects', 'com.lveditor.draft');
  const settings = rt.path.join(userData, 'Config', 'globalSetting');
  if (await rt.fs.stat(settings)) {
    const custom = /^currentCustomDraftPath\s*=\s*(.+)$/m.exec(await rt.fs.readText(settings))?.[1]?.trim();
    if (custom) {
      const root = unescapeDraftPath(custom);
      if (!rt.path.isAbsolute(root)) throw new Error('The editor’s custom draft folder is not an absolute path. Check its settings before exporting.');
      if (!(await rt.fs.stat(root))?.isDirectory) throw new Error('The editor’s custom draft folder is unavailable. Open the editor and reconnect that location before exporting.');
      return rt.path.normalize(root);
    }
  }
  const indexed = await readJson(rt, rt.path.join(fallback, 'root_meta_info.json'));
  const redirect = indexed?.root_path;
  if (typeof redirect === 'string' && rt.path.isAbsolute(redirect) && !(await rt.fs.stat(redirect))?.isDirectory) throw new Error('The editor’s indexed draft folder is unavailable. Open the editor and check its draft location.');
  return typeof redirect === 'string' && rt.path.isAbsolute(redirect) ? rt.path.normalize(redirect) : fallback;
};

const macApp = async (rt: Runtime, target: DraftTarget): Promise<{ appPath: string; executable: string } | undefined> => {
  const product = PRODUCTS[target];
  const found = await runNative(rt, ['mdfind', 'kMDItemCFBundleIdentifier == "' + product.bundle + '"']);
  const candidates = [...(found?.split('\n') ?? []), rt.path.join('/Applications', product.app), rt.path.join(rt.homeDir!, 'Applications', product.app)];
  for (const appPath of [...new Set(candidates)]) {
    if (!appPath.endsWith('.app') || !(await rt.fs.stat(appPath))?.isDirectory) continue;
    const plist = rt.path.join(appPath, 'Contents', 'Info.plist');
    if (await runNative(rt, ['plutil', '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist]) !== product.bundle) continue;
    const name = await runNative(rt, ['plutil', '-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist]);
    if (name && rt.path.basename(name) === name) return { appPath, executable: rt.path.join(appPath, 'Contents', 'MacOS', name) };
  }
  return undefined;
};
const windowsApp = async (rt: Runtime, target: DraftTarget): Promise<{ appPath: string; executable: string } | undefined> => {
  const product = PRODUCTS[target];
  const base = rt.env.LOCALAPPDATA ?? rt.path.join(rt.homeDir!, 'AppData', 'Local');
  const registry = await runNative(rt, ['reg', 'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + product.data, '/v', 'InstallLocation']);
  const installed = /REG_(?:EXPAND_)?SZ\s+(.+)/.exec(registry ?? '')?.[1]?.trim();
  const roots = [...(installed ? [installed] : []), rt.path.join(base, product.data), rt.path.join(rt.env.PROGRAMFILES ?? 'C:\\Program Files', product.data)];
  const search = async (dir: string, depth: number): Promise<string | undefined> => {
    if (!(await rt.fs.stat(dir))?.isDirectory) return undefined;
    const exe = rt.path.join(dir, product.exe);
    if ((await rt.fs.stat(exe))?.isFile) return exe;
    if (!depth) return undefined;
    const entries = (await rt.fs.readdir(dir)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const name of entries) {
      const found = await search(rt.path.join(dir, name), depth - 1);
      if (found) return found;
    }
    return undefined;
  };
  for (const root of roots) {
    const executable = await search(root, 3);
    if (executable) return { appPath: rt.path.dirname(executable), executable };
  }
  return undefined;
};

/** Match the main executable exactly; helper processes and unrelated applications are never termination targets. */
export const applicationPids = async (rt: Runtime, app: DraftApplication): Promise<number[]> => {
  if (!app.executable) return [];
  if (rt.platform === 'darwin') {
    const ps = await runNative(rt, ['ps', '-axo', 'pid=,comm=']);
    if (ps === undefined) throw new Error('Could not check whether the target editor is running.');
    return ps.split('\n').flatMap(line => {
      const entry = /^\s*(\d+)\s+(.+)$/.exec(line);
      return entry && entry[2] === app.executable ? [Number(entry[1])] : [];
    });
  }
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
  const result = await runNative(rt, ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script]);
  if (result === undefined) throw new Error('Could not check whether the target editor is running.');
  const parsed: unknown = result ? JSON.parse(result) : [];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row: { ProcessId?: number; ExecutablePath?: string; CommandLine?: string }) =>
    row && row.ExecutablePath?.toLowerCase() === app.executable!.toLowerCase() && !/--type=|--service-name=|--mojo-platform-channel-handle=/.test(row.CommandLine ?? '') && Number.isInteger(row.ProcessId) ? [row.ProcessId!] : []);
};
export const detectDraftApplication = async (rt: Runtime, target: DraftTarget): Promise<DraftApplication> => {
  const product = PRODUCTS[target];
  const supported = !!rt.homeDir && !!rt.programs && (rt.platform === 'darwin' || rt.platform === 'win32');
  if (!supported) return { target, label: product.label, supported: false, usable: false, running: false };
  const [root, app] = await Promise.all([draftRoot(rt, product.data), rt.platform === 'darwin' ? macApp(rt, target) : windowsApp(rt, target)]);
  const info: DraftApplication = { target, label: product.label, supported: true, usable: !!app || !!(await rt.fs.stat(root))?.isDirectory, root, ...app, running: false };
  info.running = (await applicationPids(rt, info)).length > 0;
  return info;
};
