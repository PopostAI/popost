/**
 * The preview server: the runtime's local HTTP server (rt.processes), bound to 127.0.0.1 by default. A host without
 * one (the web agent's sandbox) cannot run a preview, and is told so. Read-only unless started with edit: true; the
 * routes that write are in edit/routes.ts and exist only then.
 *   GET /             the shell
 *   GET /page         the compiled page of the project, or a page listing its problems (status 422)
 *   GET /project/...  files of the project directory
 *   GET /reference    the reference video, with Range support
 *   GET /api/state    PreviewState as JSON (protocol.ts)
 *   GET /api/events   server-sent events: "reload" when a source changed ("render" too in edit mode)
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Runtime } from '../../runtime';
import { VideoUnavailableError } from '../host';
import { resolveInside, sendFile } from './files';
import { shellHtml } from './html';
import { createEditor, PROJECT_FILE } from './edit/editor';
import { createRenderJob } from './edit/render';
import { editSchemas, handlePost, type EditContext } from './edit/routes';
import { createLoader, type Loader, type SourceOptions } from './project';
import { RELOAD_EVENT, RENDER_EVENT, type PreviewState } from './protocol';
import { watchSources } from './watch';
import { exportAccess } from './export-settings';
import { studioMetadata } from './studio-data';
import { studioAction } from './studio-actions';
import { createVideoCloud } from './cloud';
import { createThumbnails } from './thumbnails';

export interface PreviewOptions extends SourceOptions {
  /** 0 or absent: any free port. */
  port?: number;
  /** Default 127.0.0.1. */
  host?: string;
  /** Edit mode (edit/): routes that change video.json, offered on a loopback address only. */
  edit?: boolean;
  cloud?: boolean;
}

export interface PreviewServer { url: string; close(): Promise<void> }

interface EventHub { add(res: ServerResponse): void; send(event: string, data: unknown): void; close(): void }

/** A comment line every 15 s keeps proxies and idle timeouts from closing the event stream. */
const createEventHub = (): EventHub => {
  const clients = new Set<ServerResponse>();
  const ping = setInterval(() => clients.forEach((c) => c.write(': ping\n\n')), 15_000);
  ping.unref();
  return {
    add: (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 1000\n\n');
      clients.add(res);
      res.on('close', () => clients.delete(res));
    },
    send: (event, data) => {
      const message = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
      clients.forEach((c) => c.write(message));
    },
    close: () => {
      clearInterval(ping);
      clients.forEach((c) => c.end());
      clients.clear();
    },
  };
};

interface Context { rt: Runtime; projectDir: string; reference?: string; loader: Loader; hub: EventHub; hosts: Set<string> | undefined; edit?: EditContext; cloud?: ReturnType<typeof createVideoCloud>; thumbnails?: ReturnType<typeof createThumbnails> }

const text = (res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra }).end(body);
};

const html = (res: ServerResponse, status: number, body: string): void => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
};

const serveProjectFile = async (ctx: Context, req: IncomingMessage, res: ServerResponse, rawRel: string): Promise<void> => {
  let rel: string;
  try {
    rel = decodeURIComponent(rawRel);
  } catch {
    return text(res, 400, 'Bad path encoding: ' + rawRel + '. Encode the path with encodeURIComponent per segment.');
  }
  const file = await resolveInside(ctx.rt, ctx.projectDir, rel);
  if (!file) return text(res, 403, 'Refused: "' + rel + '" lies outside the project directory. Only files inside it are served.');
  return sendFile(ctx.rt, req, res, file);
};

const route = async (ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> => {
  // The raw path, not a normalised URL: "/project/../x" must be refused, not quietly turned into "/x".
  const pathname = (req.url ?? '/').split('?')[0] ?? '/';
  if (pathname === '/') return html(res, 200, shellHtml(Boolean(ctx.edit)));
  if (pathname === '/page') {
    const { page } = await ctx.loader.load();
    return html(res, page.status, page.html);
  }
  if (pathname === '/api/state') {
    const { state } = await ctx.loader.load();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(withEdit(ctx, state)));
    return;
  }
  if (pathname === '/api/cloud/status' && ctx.cloud) { res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(await ctx.cloud.status())); return; }
  if (pathname === '/api/cloud/callback' && ctx.cloud) { const url=new URL(req.url??'', 'http://localhost'); const result=ctx.cloud.callback(url.searchParams.get('code'),url.searchParams.get('state')); res.writeHead(result.ok?303:400,{'location':'/cloud-done.html','cache-control':'no-store','referrer-policy':'no-referrer'}).end(result.ok?'':result.error);return; }
  if (pathname === '/cloud-done.html' && ctx.cloud) return html(res,200,'<!doctype html><meta charset="utf-8"><title>Popost</title><p>已开始保存到云端，可以关闭此页。Cloud save started. You can close this tab.</p>');
  if (pathname === '/api/export-options' && ctx.edit) {
    const access = await exportAccess(ctx.rt);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(access)); return;
  }
  if (pathname === '/api/studio' && ctx.edit) {
    const { state } = await ctx.loader.load();
    const meta = await studioMetadata(ctx.rt, ctx.projectDir, withEdit(ctx, state));
    let lastExport: unknown = null;
    try { lastExport = JSON.parse(await ctx.rt.fs.readText(ctx.rt.path.join(ctx.projectDir, '.studio', 'last-export.json'))); } catch { /* No previous export. */ }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ...meta, lastExport })); return;
  }
  if (pathname === '/api/source' && ctx.edit) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="video.json"', 'cache-control': 'no-store' }).end(await ctx.edit.editor.snapshot()); return;
  }
  if (pathname === '/api/thumbnail' && ctx.thumbnails) {
    const frame = Number(new URL(req.url ?? '', 'http://localhost').searchParams.get('frame'));
    if (!Number.isSafeInteger(frame) || frame < 0) return text(res, 400, 'Choose a whole frame.');
    const { state } = await ctx.loader.load();
    const png = await ctx.thumbnails.get(frame, state.generation);
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=60' }).end(png); return;
  }
  if (pathname === '/api/schema' && ctx.edit) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(editSchemas()));
    return;
  }
  if (pathname === '/api/events') return ctx.hub.add(res);
  if (pathname === '/reference') {
    if (!ctx.reference) return text(res, 404, 'No reference video was given. Start the preview with --reference <video file>.');
    return sendFile(ctx.rt, req, res, ctx.reference);
  }
  if (pathname.startsWith('/project/')) return serveProjectFile(ctx, req, res, pathname.slice('/project/'.length));
  if (pathname === '/favicon.ico') return void res.writeHead(204).end();
  return text(res, 404, 'Not found: ' + pathname + '. The preview serves /, /page, /project/<file>, /reference, /api/state and /api/events.');
};

/** The state with the edit session's history and render, in edit mode. */
const withEdit = (ctx: Context, state: PreviewState): PreviewState =>
  ctx.edit ? { ...state, edit: { ...ctx.edit.editor.info(), render: ctx.edit.render.info() } } : state;

const handle = (ctx: Context) => (req: IncomingMessage, res: ServerResponse): void => {
  const writes = req.method === 'POST' && ctx.edit !== undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD' && !writes) {
    req.resume();
    return ctx.edit
      ? text(res, 405, 'Only GET, HEAD and POST are answered.', { allow: 'GET, HEAD, POST' })
      : text(res, 405, 'The preview is read-only: only GET and HEAD are answered.', { allow: 'GET, HEAD' });
  }
  // A page on another site could reach a local server through a host name it controls (DNS rebinding); a request
  // that does not name this server by its own address is refused.
  if (ctx.hosts && !ctx.hosts.has((req.headers.host ?? '').toLowerCase())) {
    req.resume();
    return text(res, 403, 'Refused: unknown Host header. Open the preview by the URL it printed.');
  }
  const pathname = (req.url ?? '/').split('?')[0] ?? '/';
  (writes && ctx.edit ? handlePost(ctx.edit, pathname, req, res) : route(ctx, req, res)).catch((e: unknown) => {
    if (res.headersSent) return void res.destroy();
    text(res, 500, 'Preview error: ' + (e instanceof Error ? e.message : String(e)));
  });
};

const listen = (server: Server, port: number, host: string): Promise<AddressInfo> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address() as AddressInfo);
    });
  });

/** A file or directory the user named that is not what it should be: reported to the user, who can fix it. */
export class PreviewInputError extends Error {
  override name = 'PreviewInputError';
}

const requireFile = async (rt: Runtime, file: string | undefined, what: string, fix: string): Promise<void> => {
  if (file === undefined) return;
  const info = await rt.fs.stat(rt.path.resolve(rt.cwd, file)).catch(() => null);
  if (!info?.isFile) throw new PreviewInputError('preview: the ' + what + ' "' + file + '" is not a readable file. ' + fix);
};

const checkInputs = async (rt: Runtime, o: PreviewOptions): Promise<void> => {
  const dir = await rt.fs.stat(rt.path.resolve(rt.cwd, o.projectDir)).catch(() => null);
  if (!dir?.isDirectory) throw new PreviewInputError('preview: the project directory "' + o.projectDir + '" does not exist or is not a directory. Pass the directory that holds video.json.');
  await requireFile(rt, o.reference, 'reference video', 'Pass --reference with the path of a video file (mp4, webm or mov).');
  await requireFile(rt, o.measure, 'render measurement', 'Pass --measure with a measure.json written by "popost video measure".');
  await requireFile(rt, o.referenceMeasure, 'reference measurement', 'Pass --reference-measure with a measure.json written by "popost video measure".');
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

const allowedHosts = (host: string, port: number): Set<string> | undefined => {
  if (!LOOPBACK.has(host)) return undefined;
  return new Set(['127.0.0.1', 'localhost', '[::1]'].map((h) => h + ':' + port));
};

/** The edit routes' context: the session's editor, the render job, and how to reload after a write. */
const editContext = async (ctx: Context, hosts: ReadonlySet<string>): Promise<EditContext> => ({
  editor: await createEditor(ctx.rt, ctx.projectDir),
  exportAccess: () => exportAccess(ctx.rt),
  studio: async (path, body) => {
    if(path==='/api/studio/cloud/start' && ctx.cloud){if(ctx.cloud.mode()!=='anonymous')throw new Error('Browser authorization is only needed when no key is configured.');return ctx.cloud.start(body.lang==='en'?'en':'zh',Number([...ctx.hosts!][0]!.split(':').pop()));}
    if(path==='/api/studio/cloud/push' && ctx.cloud){if(ctx.cloud.mode()==='off')throw new Error('Cloud save is disabled.');return ctx.cloud.push({lang:body.lang==='en'?'en':'zh',force:body.force===true});}
    const { state } = await ctx.loader.load();
    if (!ctx.edit) throw new Error('Studio is read-only.');
    return studioAction(ctx.rt, ctx.projectDir, ctx.edit.editor, withEdit(ctx, state), path, body);
  },
  render: createRenderJob(ctx.rt, ctx.projectDir, (info) => ctx.hub.send(RENDER_EVENT, info)),
  origins: new Set([...hosts].map((h) => 'http://' + h)),
  reloaded: async () => {
    ctx.cloud?.scheduleAutoPush();
    const generation = ctx.loader.bump();
    const { state } = await ctx.loader.load();
    ctx.hub.send(RELOAD_EVENT, { generation });
    return withEdit(ctx, state);
  },
});

/**
 * A change the watcher saw. In edit mode, video.json alone changing to what the editor wrote itself is not news: the
 * edit route already reloaded. Anything else is, and an edit of video.json made outside becomes a step of the history.
 */
const onSourceChange = async (ctx: Context, changed: ReadonlySet<string>): Promise<void> => {
  const projectFile = ctx.rt.path.join(ctx.projectDir, PROJECT_FILE);
  const outside = ctx.edit ? await ctx.edit.editor.sync() : true;
  if (!outside && [...changed].every((f) => f === projectFile)) return;
  ctx.cloud?.scheduleAutoPush();
  const generation = ctx.loader.bump();
  // Read the new state now, so that the shell's request after the event finds it ready (and new sources watched).
  await ctx.loader.load().catch(() => undefined);
  ctx.hub.send(RELOAD_EVENT, { generation });
};

/** opts: the paths as the user typed them (against rt.cwd). The caller closes the server. */
export const startPreview = async (rt: Runtime, opts: PreviewOptions): Promise<PreviewServer> => {
  const processes = rt.processes;
  if (!processes) throw new VideoUnavailableError('The preview runs a local web server, which this host does not offer. Run popost video preview on a desktop, or look at frames with popost video frame.');
  await checkInputs(rt, opts);
  const projectDir = rt.path.resolve(rt.cwd, opts.projectDir);
  const host = opts.host ?? '127.0.0.1';
  if (opts.edit && !LOOPBACK.has(host))
    throw new PreviewInputError('preview: edit mode is offered on the loopback address only (127.0.0.1); "' + host + '" would let other machines change the project. Leave out --host, or leave out --edit.');
  const sources: SourceOptions = { ...opts, projectDir, ...(opts.reference ? { reference: rt.path.resolve(rt.cwd, opts.reference) } : {}) };
  const loader = createLoader(rt, sources);
  await loader.load();
  const hub = createEventHub();
  const ctx: Context = { rt, projectDir, ...(sources.reference ? { reference: sources.reference } : {}), loader, hub, hosts: undefined };
  const server = processes.createServer(handle(ctx));
  const address = await listen(server, opts.port ?? 0, host);
  ctx.hosts = allowedHosts(host, address.port);
  if (opts.edit && ctx.hosts) ctx.edit = await editContext(ctx, ctx.hosts);
  if(opts.edit) { ctx.cloud=createVideoCloud(rt,projectDir,async()=>withEdit(ctx,(await loader.load()).state),opts.cloud!==false);ctx.cloud.autoStart(); }
  ctx.thumbnails = createThumbnails(rt, projectDir);
  const watcher = watchSources(rt, {
    paths: () => loader.sources(),
    onChange: (changed) => void onSourceChange(ctx, changed).catch(() => undefined),
  });
  const shown = host.includes(':') ? '[' + host + ']' : host;
  return {
    url: 'http://' + shown + ':' + address.port + '/',
    close: async () => {
      watcher.close();
      ctx.cloud?.dispose();
      await ctx.thumbnails?.close();
      hub.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
};
