/**
 * Describes how a host opens the project in the Popost web workbench, a local editor service, or its own editor.
 * The host opens the browser or panel after receiving the handoff.
 */
import { CloudError } from '../cloud/errors';
import { pushProject } from '../cloud/push';
import { resolveCloudMode, type CloudMode } from '../cloud/service';
import type { Project } from '../core/project';
import { readJson, sha256, writeJson } from '../core/util';
import { DEFAULT_KEY_ENV, PopostClient } from '../providers/api';
import { isRecord } from '../providers/base';
import { PopostApiError } from '../providers/errors';
import { msg } from '../i18n';
import type { Runtime } from '../runtime';
import { STATE_DIR } from './canvas-state';

/** The editor build's version (`packages/canvas-editor/src/version.ts`); a service of another version is not reused. */
export const EDITOR_VERSION = '4.1.2';

export const editorInfo = (project: Project) => {
  const identity = sha256(project.rt.path.resolve(project.root));
  return {
    schema: 'popost-editor-info.v1',
    version: EDITOR_VERSION,
    projectId: project.manifest.projectId || identity.slice(0, 32),
    projectIdentity: identity,
    capabilities: ['edit-text', 'edit-layout', 'save-local', 'export-png', 'export-formats', 'compare-reference', 'export-project', 'cloud-save'],
  };
};

/** `codex` when running under Codex, else `generic`; any other name is passed through. */
const resolveHost = (rt: Runtime, host: string): string => (host === 'auto' ? (rt.env.CODEX_THREAD_ID ? 'codex' : 'generic') : host);

/** What the handoff says about cloud save: how this service syncs and, once it did, where the work is on the web. */
export interface CloudHandoff {
  readonly mode: CloudMode;
  readonly state: string;
  readonly webUrl?: string;
  readonly deckId?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

const editorHandoff = (
  rt: Runtime,
  project: Project,
  editorUrl: string,
  host: string,
  transport: 'loopback-http' | 'web-http',
  cloud: CloudHandoff,
  reused = false,
): Record<string, unknown> => {
  const name = resolveHost(rt, host);
  const { capabilities, ...info } = editorInfo(project);
  const localOnly = ['save-local', 'cloud-save', 'export-project', 'compare-reference'];
  const hostAction =
    name === 'codex'
      ? {
          tool: 'mcp__codex_app__open_in_codex',
          arguments: { target: { type: 'browser', url: editorUrl }, placement: 'right' },
        }
      : { capability: 'open_url_in_panel', url: editorUrl, placement: 'side-panel', discoverFrom: 'available host tools' };
  return {
    ok: true,
    host: name,
    ...info,
    capabilities: capabilities.filter((capability) =>
      transport === 'web-http' ? !localOnly.includes(capability) : cloud.mode !== 'off' || capability !== 'cloud-save'
    ),
    schema: 'popost-editor-handoff.v1',
    url: editorUrl,
    transport,
    reusedService: reused,
    open: { kind: 'web-url', url: editorUrl, preferredPlacement: 'side-panel' },
    requiresHostAction: true,
    opened: false,
    hostAction,
    cloud,
  };
};

export const handoff = (
  rt: Runtime,
  project: Project,
  origin: string,
  host = 'auto',
  reused = false,
  cloud: CloudHandoff = { mode: 'off', state: 'idle' },
): Record<string, unknown> => editorHandoff(rt, project, `${origin}/editor.html${project.manifest.sources.some((s) => s.role === 'layout') ? '?compare=1' : ''}`, host, 'loopback-http', cloud, reused);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Does `url` answer as the editor service of this very project and editor version? */
const probe = async (rt: Runtime, url: string, expected: Record<string, unknown>): Promise<boolean> => {
  try {
    const response = await rt.fetch(`${url}/api/editor-info`, { signal: AbortSignal.timeout(700) });
    const info = (await response.json()) as Record<string, unknown>;
    return info.projectIdentity === expected.projectIdentity && info.version === EDITOR_VERSION;
  } catch {
    return false;
  }
};

/** A loopback service URL we wrote ourselves: `http://127.0.0.1:<port>` and nothing else. */
const isLoopbackOrigin = (url: unknown): url is string => {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && !!parsed.port && parsed.origin === url;
  } catch {
    return false;
  }
};

const saveHandoff = async (rt: Runtime, project: Project, result: Record<string, unknown>) => {
  await writeJson(rt, rt.path.join(project.root, 'editor-handoff.json'), result);
  return result;
};

const reusable = async (rt: Runtime, state: string, info: Record<string, unknown>, port: number) => {
  try {
    const old = await readJson<{ url?: unknown }>(rt, state);
    if (!isLoopbackOrigin(old.url)) return null;
    if (port && new URL(old.url).port !== String(port)) return null;
    return (await probe(rt, old.url, info)) ? old.url : null;
  } catch {
    return null;
  }
};

interface ServiceLog {
  /** The first `{"listening": url}` line, once the service answers as this project. */
  readonly url?: string;
  /** What the service printed when it could not start (`{"ok": false, "error": …}`). */
  readonly error?: string;
}

/** Read what the detached service wrote to its log so far. */
const readLog = async (rt: Runtime, log: string, info: Record<string, unknown>): Promise<ServiceLog> => {
  let text = '';
  try {
    text = await rt.fs.readText(log);
  } catch {
    return {};
  }
  for (const line of text.split('\n')) {
    let entry: { listening?: unknown; ok?: unknown; error?: unknown } | null;
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue; // not a JSON line
    }
    if (!entry || typeof entry !== 'object') continue;
    if (entry.ok === false) return { error: String(entry.error ?? msg('unknown error', '未知错误')) };
    if (isLoopbackOrigin(entry.listening) && (await probe(rt, entry.listening, info))) return { url: entry.listening };
  }
  return {};
};

const READY_TIMEOUT_MS = 10_000;

/** A running service's own answer; a service from before cloud save has no such route, so it offers none. */
const reportedCloud = async (rt: Runtime, url: string): Promise<CloudHandoff> => {
  try {
    const response = await rt.fetch(`${url}/api/cloud/status`, { signal: AbortSignal.timeout(700) });
    const status = (await response.json()) as { ok?: unknown; mode?: unknown; state?: unknown; webUrl?: unknown };
    if (!response.ok || status.ok !== true || typeof status.mode !== 'string') throw new Error('no cloud status');
    return { mode: status.mode as CloudMode, state: String(status.state), ...(typeof status.webUrl === 'string' ? { webUrl: status.webUrl } : {}) };
  } catch {
    return { mode: 'off', state: 'idle' };
  }
};

/** Reuse this project's running editor service or start a detached one, and describe how to open it. */
export const presentLocal = async (
  rt: Runtime,
  project: Project,
  host: string,
  port: number,
  cloud = true,
  fallback?: CloudHandoff['error'],
): Promise<Record<string, unknown>> => {
  const processes = rt.processes;
  if (!processes) throw new Error(msg('the local editor service is not available in this host', '当前宿主不支持本地编辑器服务'));
  const info = editorInfo(project);
  const dir = rt.path.join(project.root, STATE_DIR);
  await rt.fs.mkdir(dir);
  const state = rt.path.join(dir, 'service.json');
  const running = await reusable(rt, state, info, port);
  const mode = resolveCloudMode(rt, cloud, Boolean(fallback));
  const localHandoff = (url: string, reused: boolean, status: CloudHandoff) =>
    saveHandoff(rt, project, handoff(rt, project, url, host, reused, { ...status, ...(fallback ? { error: fallback } : {}) }));
  if (running) {
    const status = await reportedCloud(rt, running);
    if (mode === status.mode) return localHandoff(running, true, status);
  }

  // stdout goes to a durable log, so the service outlives this command and its address can be read back
  const log = rt.path.join(dir, `server-${rt.now().getTime()}.log`);
  const cloudArg = !cloud ? 'off' : fallback ? 'login' : 'auto';
  const argv = [...processes.selfCommand, 'serve', '--dir', project.root, '--port', String(port), '--cloud', cloudArg];
  const { pid } = await processes.spawnDetached(argv, { cwd: rt.cwd, logFile: log });
  const deadline = rt.now().getTime() + READY_TIMEOUT_MS;
  while (rt.now().getTime() < deadline) {
    const { url, error } = await readLog(rt, log, info);
    if (error) throw new Error(msg(`editor service did not start: ${error}; inspect ${log}`, `编辑器服务没有启动：${error}；请查看 ${log}`));
    if (url) {
      await writeJson(rt, state, { url, pid, version: EDITOR_VERSION });
      return localHandoff(url, false, await reportedCloud(rt, url));
    }
    await sleep(50);
  }
  throw new Error(msg(`editor service readiness timed out; inspect ${log}`, `等待编辑器服务就绪超时；请查看 ${log}`));
};

/** Use the authenticated account to keep cached links separate when users switch keys or API endpoints. */
const presentCloud = async (rt: Runtime, project: Project, host: string): Promise<Record<string, unknown>> => {
  const client = new PopostClient(rt);
  const account = await client.request('GET', '/me', { timeoutSec: 10 });
  const user = isRecord(account) && isRecord(account.user) ? account.user : null;
  if (typeof user?.id !== 'string' || !user.id) throw new CloudError('BAD_RESPONSE', msg('The Popost account has no user ID.', 'Popost 账号没有用户 ID。'));
  const accountScope = sha256(JSON.stringify([client.baseUrl, user.id]));
  const locale = project.manifest.language?.toLowerCase().startsWith('zh') ? 'zh' : undefined;
  const { deckId, webUrl } = await pushProject(rt, { dir: project.root, client, accountScope, locale });
  const url = project.manifest.sources.some((s) => s.role === 'layout') ? `${webUrl}?compare=1` : webUrl;
  return editorHandoff(rt, project, url, host, 'web-http', { mode: 'keyed', state: 'saved', deckId, webUrl });
};

/** `--host web`: hand the project to the host's own editor (the popost.ai workbench). */
const WEB_HOST = 'web';

/**
 * `present`: the host's own editor, the workbench tied to a configured key, or a local service.
 * A host's answer is the command's JSON as it is.
 */
export const present = async (
  rt: Runtime,
  project: Project,
  host: string,
  port: number,
  cloud = true,
): Promise<Record<string, unknown>> => {
  const own = rt.editorHost;
  if (host === WEB_HOST && !own)
    throw new Error(
      msg(
        '--host web needs a host that shows projects itself (the popost.ai workbench); this one has none',
        '--host web 需要一个能自己展示工程的宿主（popost.ai 工作台）；当前宿主没有',
      ),
    );
  if (own && (host === WEB_HOST || host === 'auto' || host === own.id)) return own.present(project.root);
  if (!rt.processes)
    throw new Error(
      own
        ? msg(
            `host "${host}" is not available here: the project is shown by the host's own editor (--host ${WEB_HOST} or auto)`,
            `这里不能用宿主 "${host}"：工程由宿主自带的编辑器展示（--host ${WEB_HOST} 或 auto）`,
          )
        : msg(
            'present is not available in this host: it has no local editor service and no editor of its own',
            '当前宿主不支持 present：它既没有本地编辑器服务，也没有自带的编辑器',
          ),
    );
  if (cloud && (rt.deviceAccess || rt.env[DEFAULT_KEY_ENV]?.trim())) {
    let result: Record<string, unknown>;
    try {
      result = await presentCloud(rt, project, host);
    } catch (error) {
      const code = error instanceof PopostApiError || error instanceof CloudError ? error.code ?? 'ERROR' : 'ERROR';
      const message = code === 'DECK_CONFLICT'
        ? msg('The Popost web project has newer edits. Use the local editor for your local changes.', 'Popost 网页版工程有更新的编辑。本地改动请在本地编辑器里处理。')
        : msg(
            'Could not open the Popost web workbench. Use Save to Cloud from the local editor to sign in and try again.',
            '无法打开 Popost 网页工作台。请在本地编辑器里用“保存到云端”登录后重试。',
          );
      return presentLocal(rt, project, host, port, cloud, { code, message });
    }
    if (!project.manifest.sources.some((source) => source.role === 'layout')) return saveHandoff(rt, project, result);
    const local = await presentLocal(rt, project, host, port, cloud);
    return saveHandoff(rt, project, { ...local, cloud: result.cloud });
  }
  return presentLocal(rt, project, host, port, cloud);
};
