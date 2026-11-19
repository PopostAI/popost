/** Shared fixtures for the local editor service tests (not a test file itself). */
import type { CloudOptions } from '../src/cloud/service';
import { Project } from '../src/core/project';
import { createLock, createServiceState } from '../src/editor/server';
import { handleGet } from '../src/editor/routes-get';
import { handlePost } from '../src/editor/routes-post';
import type { ApiRequest, ApiResponse, Ctx, ServiceState } from '../src/editor/http-types';
import { SKILL_ROOT, type TestRuntime } from '../src/testing/memory';
import { newProject, newRuntime } from './workflow-helpers';

export const PORT = 4321;
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const EDITOR_INDEX = '<!doctype html><html><head><title>Editor</title></head><body>editor</body></html>';

/** A runtime with a fake editor build under `assets/canvas` and a one-page project `P` (300x400). */
export const editorFixture = async (cloud: CloudOptions = {}): Promise<{ rt: TestRuntime; project: Project; state: ServiceState }> => {
  const rt = await newRuntime();
  await rt.fs.writeFile(`${SKILL_ROOT}/assets/canvas/index.html`, EDITOR_INDEX);
  await rt.fs.writeFile(`${SKILL_ROOT}/assets/canvas/assets/app.js`, 'console.log("editor")');
  const project = await newProject(rt, 'P', 'editor test', 300, 400);
  return { rt, project, state: createServiceState(rt, project.root, cloud) };
};

export interface RequestInit {
  readonly query?: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}

export const request = (method: string, path: string, init: RequestInit = {}): ApiRequest => {
  const raw =
    init.body === undefined
      ? new Uint8Array()
      : init.body instanceof Uint8Array
        ? init.body
        : new TextEncoder().encode(JSON.stringify(init.body));
  const query = init.query ?? '';
  return {
    method,
    path,
    rawQuery: query,
    query: new URLSearchParams(query),
    headers: { host: `127.0.0.1:${PORT}`, ...init.headers },
    body: raw,
    port: PORT,
  };
};

export const ctxFor = (rt: TestRuntime, state: ServiceState, req: ApiRequest): Ctx => ({
  rt,
  state,
  req,
  load: () => Project.load(rt, state.root),
  locked: createLock(),
});

export const bodyText = (response: ApiResponse): string =>
  typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body);

export const bodyJson = (response: ApiResponse): Record<string, unknown> => JSON.parse(bodyText(response)) as Record<string, unknown>;

/** `GET path` against the routes. */
export const get = (rt: TestRuntime, state: ServiceState, path: string, init: RequestInit = {}): Promise<ApiResponse> =>
  handleGet(ctxFor(rt, state, request('GET', path, init)));

/** `POST path` with the same-origin header the editor sends. */
export const post = (rt: TestRuntime, state: ServiceState, path: string, body: unknown, headers: Record<string, string> = { origin: ORIGIN }): Promise<ApiResponse> =>
  handlePost(ctxFor(rt, state, request('POST', path, { body, headers })));
