/**
 * The routes of edit mode. Every POST passes the same gate first: the Host header names this server (server.ts),
 * the Origin, when the browser sends one, is this server's own, and the body is at most 1 MB.
 *   POST /api/edit    one operation (ops.ts) -> { ok, op, label, history, state } or { ok: false, problems, history }
 *   POST /api/undo    the step before -> the same answer
 *   POST /api/redo    the step undone last -> the same answer
 *   POST /api/render  starts a render into out.mp4; progress and result come as "render" events
 *   GET  /api/schema  the JSON schema of the parts of video.json the page edits (allowed values and ranges)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { readExportSettings, type ExportAccess, type VideoExportSettings } from '../export-settings';
import {
  AudioTrackSchema, BaseObjectSchema, CaptionTrackSchema, CueSchema, ImageTrackSchema, MotionSchema, SegmentSchema, ShapeTrackSchema,
  SpanObjectSchema, TextStyleSchema, TextTrackSchema, TransitionSchema, VideoTrackSchema,
} from '../../project/schema';
import type { Problem } from '../../types';
import type { PreviewState } from '../protocol';
import type { Editor, EditInfo, Outcome } from './editor';
import { readOp } from './ops';
import type { RenderJob } from './render';

/** The largest body accepted: a whole video.json of a long project is far below it. */
export const MAX_BODY = 1024 * 1024;

export interface EditContext {
  editor: Editor;
  exportAccess?: () => Promise<ExportAccess>;
  studio?: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  render: RenderJob;
  /** Origins a request from the page itself carries: "http://127.0.0.1:<port>" and the other loopback names. */
  origins: ReadonlySet<string>;
  /** After a write: reads the state again, tells the open pages, and returns it. */
  reloaded(): Promise<PreviewState>;
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body));
};

const refuse = (res: ServerResponse, status: number, message: string, fix: string, history?: EditInfo): void =>
  json(res, status, { ok: false, problems: [{ level: 'error', at: '(request)', message, fix }], ...(history ? { history } : {}) });

/**
 * Why a request may not change anything, or undefined. A page on another site can send a POST to a local server; the
 * browser names that site in Origin (and in Sec-Fetch-Site), so a request whose origin is not this server is refused.
 * A client that sends no Origin is not a browser page (curl, a test).
 */
export const crossOrigin = (req: IncomingMessage, origins: ReadonlySet<string>): string | undefined => {
  const origin = req.headers.origin;
  if (origin !== undefined && !origins.has(origin.toLowerCase())) return 'Refused: the request comes from ' + origin + ', not from the preview page.';
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return 'Refused: the request comes from another site (' + site + ').';
  return undefined;
};

/** The body as text, or 'too-large' when it passes MAX_BODY (the rest is read and dropped, so the answer arrives). */
const readBody = (req: IncomingMessage, limit = MAX_BODY): Promise<string | 'too-large'> =>
  new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    const chunks: Buffer[] = [];
    let size = 0;
    let over = declared > limit;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) over = true;
      if (!over) chunks.push(c);
    });
    req.on('end', () => resolve(over ? 'too-large' : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const answer = async (ctx: EditContext, res: ServerResponse, outcome: Outcome): Promise<void> => {
  if (!outcome.ok) return json(res, outcome.status, { ok: false, problems: outcome.problems, history: outcome.info });
  const state = await ctx.reloaded();
  json(res, 200, { ok: true, op: outcome.op, step: outcome.step, label: outcome.label, history: outcome.info, state });
};

const editRoute = async (ctx: EditContext, req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const body = await readBody(req);
  if (body === 'too-large') return refuse(res, 413, 'Refused: the body is larger than ' + MAX_BODY + ' bytes.', 'Send one small operation at a time.', ctx.editor.info());
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return refuse(res, 400, 'The body is not JSON.', 'Send { "op": "set", "path": [...], "value": ... } as JSON.', ctx.editor.info());
  }
  const read = readOp(value);
  if ('problem' in read) return json(res, 400, { ok: false, problems: [read.problem] satisfies Problem[], history: ctx.editor.info() });
  return answer(ctx, res, await ctx.editor.apply(read.op));
};

/** Answers a POST in edit mode (after the Host check of server.ts). */
export const handlePost = async (ctx: EditContext, pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const refusal = crossOrigin(req, ctx.origins);
  if (refusal) {
    req.resume();
    return refuse(res, 403, refusal, 'Open the preview by the URL it printed and edit there.');
  }
  if (pathname === '/api/edit') return editRoute(ctx, req, res);
  const body = await readBody(req, pathname === '/api/studio/import' ? 16 * 1024 * 1024 : MAX_BODY);
  if (body === 'too-large') return refuse(res, 413, 'The request is too large.', 'Use a smaller file or project.');
  if (pathname === '/api/undo') return answer(ctx, res, await ctx.editor.undo());
  if (pathname === '/api/redo') return answer(ctx, res, await ctx.editor.redo());
  let value: Record<string, unknown> = {};
  if (body.trim()) {
    try { const parsed: unknown = JSON.parse(body); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); value = parsed as Record<string, unknown>; }
    catch { return refuse(res, 400, 'Expected a JSON object.', 'Correct the request body.'); }
  }
  if (pathname === '/api/source') return answer(ctx, res, await ctx.editor.replace(value.source, value.base));
  if (pathname.startsWith('/api/studio/') && ctx.studio) {
    try { const result = await ctx.studio(pathname, value); return json(res, 200, { ok: true, result, state: await ctx.reloaded() }); }
    catch (e) { return refuse(res, 422, e instanceof Error ? e.message : String(e), 'Review the selected draft and try again.'); }
  }
  if (pathname === '/api/render') {
    let snapshot: string | undefined;
    let settings: VideoExportSettings | undefined;
    {
      try {
        snapshot = await ctx.editor.snapshot();
        const source = JSON.parse(snapshot) as { canvas: { width: number; height: number }; segments: { frames: number }[] };
        const selected = readExportSettings(value, source.canvas, await ctx.exportAccess?.() ?? { premium: false, verified: false });
        if (body.trim()) settings = selected;
        const total = source.segments.reduce((n, s) => n + s.frames, 0);
        if ((selected.to ?? total) > total || (selected.from ?? 0) >= (selected.to ?? total)) throw new Error('Export range is outside the timeline.');
      } catch (e) { return refuse(res, 422, e instanceof Error ? e.message : String(e), 'Review the export settings or unlock the required resolution.'); }
    }
    if (!ctx.render.start(settings, snapshot)) return refuse(res, 409, 'A render is already running.', 'Wait for it to end; its progress shows in the page.');
    return json(res, 202, { ok: true, render: ctx.render.info() });
  }
  return refuse(res, 404, 'Not found: POST ' + pathname + '.', 'Edit mode answers POST /api/edit, /api/undo, /api/redo and /api/render.');
};

const SCHEMAS = {
  text: TextTrackSchema, image: ImageTrackSchema, shape: ShapeTrackSchema, video: VideoTrackSchema, audio: AudioTrackSchema, caption: CaptionTrackSchema,
  cue: CueSchema, segment: SegmentSchema, base: BaseObjectSchema, transition: TransitionSchema, motion: MotionSchema, style: TextStyleSchema, span: SpanObjectSchema,
} as const;

export type SchemaName = keyof typeof SCHEMAS;

let schemas: Record<SchemaName, unknown> | undefined;

/** The JSON schemas of the parts of video.json the page edits, made from the zod schema the check uses. */
export const editSchemas = (): Record<SchemaName, unknown> => {
  schemas ??= Object.fromEntries(Object.entries(SCHEMAS).map(([name, s]) => [name, z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' })])) as Record<SchemaName, unknown>;
  return schemas;
};
