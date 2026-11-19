/**
 * What the editor service exchanges with a transport: a plain request and a plain response, so every route is an
 * ordinary async function over `rt.fs` that a test can call without a socket (`server.ts` adapts Node's `http` to it).
 */
import type { CloudService } from '../cloud/service';
import type { Project } from '../core/project';
import type { Runtime } from '../runtime';

export interface ApiRequest {
  readonly method: string;
  /** Path as received (percent-encoded), no query. */
  readonly path: string;
  readonly rawQuery: string;
  readonly query: URLSearchParams;
  /** Header names are lower case. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /** The loopback port the service listens on. */
  readonly port: number;
}

export interface ApiResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array | string;
}

export interface Preview {
  readonly at: number;
  readonly body: string;
  readonly csp: string;
}

export interface ServiceState {
  /** The project being served; `import-project` switches it. */
  root: string;
  /** `/_preview/<id>.html` -> sanitized document, kept in memory for a few minutes. */
  readonly previews: Map<string, Preview>;
  /** Cloud save: login flows, the upload credential, the button's phase and the background pushes. */
  readonly cloud: CloudService;
}

export interface Ctx {
  readonly rt: Runtime;
  readonly state: ServiceState;
  readonly req: ApiRequest;
  /** The project, re-read from disk: an agent or another window may have changed it. */
  readonly load: () => Promise<Project>;
  /** Run `fn` after every earlier locked call finished: project reads-modify-writes never interleave. */
  readonly locked: <T>(fn: () => Promise<T>) => Promise<T>;
}

export const jsonResponse = (req: ApiRequest, status: number, value: unknown): ApiResponse => {
  const body = JSON.stringify(value);
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': `http://127.0.0.1:${req.port}`,
    },
    body,
  };
};

/** A file reply; zips and PNGs are offered as downloads. */
export const fileResponse = (data: Uint8Array, contentType: string, downloadName?: string): ApiResponse => ({
  status: 200,
  headers: {
    'Content-Type': contentType,
    ...(downloadName ? { 'Content-Disposition': `attachment; filename="${downloadName}"` } : {}),
  },
  body: data,
});

export const noStoreResponse = (body: Uint8Array | string, contentType: string, extra: Record<string, string> = {}): ApiResponse => ({
  status: 200,
  headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store', ...extra },
  body,
});

/** A request the caller got wrong: the Python `ValueError` / `SyntaxError` family. */
export const isBadRequest = (error: unknown): boolean =>
  error instanceof SyntaxError || (error instanceof Error && error.name === 'ValueError');

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Parse a JSON body that must be an object. */
export const parseJsonObject = (req: ApiRequest): Record<string, unknown> => {
  const value: unknown = JSON.parse(new TextDecoder().decode(req.body));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('request body must be a JSON object');
    error.name = 'ValueError';
    throw error;
  }
  return value as Record<string, unknown>;
};
