/**
 * The model behind the plan step and the scene writer. The engine never holds a key or a vendor name: a Model is the
 * interface, and three variables of the runtime's environment name an OpenAI-compatible chat endpoint that implements it:
 *   POPOST_LLM_URL    the base URL, for example https://host/v1 ("/chat/completions" is added)
 *   POPOST_LLM_MODEL  the model name the endpoint expects
 *   POPOST_LLM_KEY    the key, sent as a Bearer token; it is never printed, and an error text that contains it is masked
 * POPOST_LLM_JSON=0 leaves out "response_format" for an endpoint that does not know it. POPOST_LLM_BODY is a JSON
 * object merged into every request, for what only some endpoints know, for example {"thinking":{"type":"disabled"}}
 * (a plan needs no reasoning pass: with it one answer took 5,763 output tokens and 38 s on the first real template).
 */
import type { Runtime } from '../../runtime';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
/** A part of a message that carries pictures: text, or a picture as a data URL (data:image/jpeg;base64,...). */
export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
/** A user message with pictures, for a model that reads them. */
export interface PictureMessage { role: 'user'; content: ContentPart[] }
export type Message = ChatMessage | PictureMessage;
export interface ModelUsage { input: number; output: number }
export interface ModelReply { text: string; usage?: ModelUsage }
export interface Model {
  /** A name for logs: the model, never the endpoint or the key. */
  name: string;
  ask(messages: Message[]): Promise<ModelReply>;
}

export interface HttpModelOptions {
  url: string;
  model: string;
  key?: string;
  /** Ask the endpoint for a JSON object (default true). */
  json?: boolean;
  temperature?: number;
  timeoutMs?: number;
  /** Merged into the request body last. */
  body?: Record<string, unknown>;
}

interface ChatResponse { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }

/** An error text without the key and without the URL's query string (where a key may hide too). */
const masked = (text: string, o: Pick<HttpModelOptions, 'key' | 'url'>): string => {
  const query = o.url.includes('?') ? o.url.slice(o.url.indexOf('?')) : '';
  const noKey = o.key ? text.split(o.key).join('***') : text;
  return query ? noKey.split(query).join('?***') : noKey;
};

/** A request ends at its timeout, or at once when the host aborts the command. */
const deadline = (rt: Runtime, ms: number): AbortSignal => (rt.signal ? AbortSignal.any([rt.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));

/** The model at an OpenAI-compatible endpoint, reached through rt.fetch. */
export const httpModel = (rt: Runtime, o: HttpModelOptions): Model => ({
  name: o.model,
  ask: async (messages) => {
    const body = { model: o.model, messages, temperature: o.temperature ?? 0.3, ...(o.json === false ? {} : { response_format: { type: 'json_object' } }), ...o.body };
    let res: Response;
    try {
      res = await rt.fetch(o.url.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST', signal: deadline(rt, o.timeoutMs ?? 240_000),
        headers: { 'content-type': 'application/json', ...(o.key ? { authorization: 'Bearer ' + o.key } : {}) },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error('The model could not be reached (' + masked(e instanceof Error ? e.message : String(e), o) + '). Check POPOST_LLM_URL.');
    }
    const text = await res.text();
    if (!res.ok) throw new Error('The model endpoint answered ' + res.status + ': ' + masked(text.slice(0, 300), o));
    let data: ChatResponse;
    try { data = JSON.parse(text) as ChatResponse; } catch { throw new Error('The model endpoint did not answer with JSON: ' + masked(text.slice(0, 120), o)); }
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('The model endpoint answered without a message.');
    const input = Number(data.usage?.prompt_tokens), output = Number(data.usage?.completion_tokens);
    return { text: content, ...(Number.isFinite(input) && Number.isFinite(output) ? { usage: { input, output } } : {}) };
  },
});

/** The model the three variables name, or undefined when the URL or the model name is missing. */
export const envModel = (rt: Runtime): Model | undefined => {
  const url = rt.env.POPOST_LLM_URL?.trim(), model = rt.env.POPOST_LLM_MODEL?.trim(), key = rt.env.POPOST_LLM_KEY?.trim();
  if (!url || !model) return undefined;
  const extra = rt.env.POPOST_LLM_BODY?.trim();
  let body: Record<string, unknown> | undefined;
  if (extra) {
    try { body = JSON.parse(extra) as Record<string, unknown>; } catch { throw new Error('POPOST_LLM_BODY is not a JSON object: ' + extra.slice(0, 80)); }
  }
  return httpModel(rt, { url, model, ...(key ? { key } : {}), json: rt.env.POPOST_LLM_JSON !== '0', ...(body ? { body } : {}) });
};
