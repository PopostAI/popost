/**
 * `popost serve`: the local editor service (port of `server.serve` and its request handler). It listens on loopback only
 * and is a thin Node `http` adapter: every route is a plain function over `rt.fs` (`routes-get.ts`, `routes-post.ts`), so
 * the same code answers a test without a socket. The editor routes read no key and open no connection. The one exception is
 * cloud save (`../cloud/`, `routes-cloud.ts`): through `PopostClient`, the public popost.ai HTTP API only, it syncs the
 * project when the user has a popost key or has just logged in on popost.ai (`--cloud off` turns it off entirely).
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { CloudService, type CloudOptions } from '../cloud/service';
import { Project } from '../core/project';
import { errorText, printJson } from '../core/util';
import { msg } from '../i18n';
import type { Runtime } from '../runtime';
import {
  errorMessage,
  jsonResponse,
  type ApiRequest,
  type ApiResponse,
  type Ctx,
  type ServiceState,
} from './http-types';
import { hostAllowed } from './request-security';
import { handleGet } from './routes-get';
import { handlePost } from './routes-post';

/** A project bundle may be large, but not unbounded. */
export const MAX_BODY_BYTES = 256 * 1024 * 1024;

const encoder = new TextEncoder();

/** The state of one service: the served project, its previews and its cloud-save state. */
export const createServiceState = (rt: Runtime, root: string, cloud: CloudOptions = {}): ServiceState => {
  const state: ServiceState = { root, previews: new Map(), cloud: new CloudService(rt, () => state.root, cloud) };
  return state;
};

/** Run calls one after another, so a read-modify-write of the project never interleaves with another. */
export const createLock = (): (<T>(fn: () => Promise<T>) => Promise<T>) => {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const result = tail.then(fn, fn);
    tail = result.catch(() => undefined);
    return result;
  };
};

/** The request body, or `null` when it is bigger than `limit`. */
const readBody = (req: IncomingMessage, limit: number): Promise<Uint8Array | null> =>
  new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) return resolve(null);
    const chunks: Uint8Array[] = [];
    let size = 0;
    req.on('data', (chunk: Uint8Array) => {
      size += chunk.byteLength;
      if (size > limit) {
        chunks.length = 0;
        req.pause();
        return resolve(null);
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve(body);
    });
    req.on('error', reject);
  });

const headersOf = (req: IncomingMessage): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers))
    if (value !== undefined) out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  return out;
};

const toRequest = (req: IncomingMessage, body: Uint8Array, port: number): ApiRequest => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  return {
    method: req.method ?? 'GET',
    path: url.pathname,
    rawQuery: url.search.replace(/^\?/, ''),
    query: url.searchParams,
    headers: headersOf(req),
    body,
    port,
  };
};

const send = (res: ServerResponse, response: ApiResponse): void => {
  const body = typeof response.body === 'string' ? encoder.encode(response.body) : response.body;
  res.writeHead(response.status, { ...response.headers, 'Content-Length': String(body.byteLength) });
  res.end(body);
};

const createCtx = (rt: Runtime, state: ServiceState, lock: Ctx['locked'], req: ApiRequest): Ctx => ({
  rt,
  state,
  req,
  load: () => Project.load(rt, state.root),
  locked: lock,
});

const dispatch = async (rt: Runtime, state: ServiceState, lock: Ctx['locked'], req: ApiRequest): Promise<ApiResponse> => {
  const ctx = createCtx(rt, state, lock, req);
  if (req.method === 'GET') return handleGet(ctx);
  if (req.method === 'POST') return handlePost(ctx);
  return jsonResponse(req, 501, { ok: false, error: msg(`unsupported method ${req.method}`, `不支持的请求方法 ${req.method}`) });
};

const handle = async (
  rt: Runtime,
  state: ServiceState,
  lock: Ctx['locked'],
  port: () => number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  try {
    if (!hostAllowed(req.headers.host, port())) {
      return send(res, jsonResponse(toRequest(req, new Uint8Array(), port()), 403, { ok: false, error: msg('host rejected', 'Host 被拒绝') }));
    }
    const body = await readBody(req, MAX_BODY_BYTES);
    if (body === null) {
      const stub = toRequest(req, new Uint8Array(), port());
      return send(res, jsonResponse(stub, 413, { ok: false, error: msg('request body is too large', '请求体过大') }));
    }
    send(res, await dispatch(rt, state, lock, toRequest(req, body, port())));
  } catch (error) {
    if (!res.headersSent) send(res, jsonResponse(toRequest(req, new Uint8Array(), port()), 500, { ok: false, error: errorMessage(error) }));
    else res.destroy();
  }
};

const listen = (server: Server, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });

/**
 * Serve `project` on `127.0.0.1:<port>` (0 picks a free port) until the process is stopped or `rt.signal` aborts. The
 * first line on stdout is `{"ok": true, "listening": url, "project": dir}`: `present` reads it from the service log.
 */
export const serveProject = async (rt: Runtime, project: Project, port: number, cloud: CloudOptions = {}): Promise<number> => {
  const processes = rt.processes;
  if (!processes) {
    printJson(rt, { ok: false, error: msg('serve is not available in this host: it cannot open a network port', '当前宿主不支持 serve：它无法打开网络端口') });
    return 2;
  }
  const state: ServiceState = createServiceState(rt, project.root, cloud);
  const lock = createLock();
  let listening = port;
  const server = processes.createServer((req, res) => {
    handle(rt, state, lock, () => listening, req, res).catch((error: unknown) => {
      rt.stderr(`popost serve: ${errorText(error)}\n`);
      res.destroy();
    });
  });
  listening = await listen(server, port);
  printJson(rt, { ok: true, listening: `http://127.0.0.1:${listening}`, project: project.root });
  state.cloud.autoStart();
  await new Promise<void>((resolve) => {
    server.once('close', resolve);
    rt.signal?.addEventListener(
      'abort',
      () => {
        state.cloud.dispose();
        server.close();
        server.closeAllConnections();
      },
      { once: true },
    );
  });
  return 0;
};
