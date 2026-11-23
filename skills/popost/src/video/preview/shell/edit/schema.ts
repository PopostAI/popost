/**
 * Reading the JSON schemas of GET /api/schema (made on the server from the zod schema the check uses), so the form
 * takes its allowed values and ranges from the schema instead of a copy of it.
 */
import type { SchemaName } from '../../edit/routes';

export interface JsonSchema {
  type?: string;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  properties?: Record<string, JsonSchema>;
  anyOf?: JsonSchema[];
  prefixItems?: JsonSchema[];
  items?: JsonSchema | false;
}

export type Schemas = Record<SchemaName, JsonSchema>;

/** The object branch of a union (a text style is a name or an object), or the node itself. */
const objectOf = (s: JsonSchema | undefined): JsonSchema | undefined => s?.anyOf?.find((b) => b.type === 'object') ?? s;

/** The schema of a field under s: prop(s, 'style', 'size'). */
export const prop = (s: JsonSchema | undefined, ...keys: string[]): JsonSchema | undefined =>
  keys.reduce<JsonSchema | undefined>((node, k) => objectOf(node)?.properties?.[k], s);

/** The allowed values of a field (an enum, or the enum branch of a union). */
export const choices = (s: JsonSchema | undefined): string[] =>
  (s?.enum ?? s?.anyOf?.find((b) => b.enum)?.enum ?? []).map((v) => String(v));

/** The JSON schema writes "no limit" of an integer as the largest safe integer. */
const LIMITLESS = 9e15;
const bound = (v: number | undefined): number | undefined => (v === undefined || Math.abs(v) >= LIMITLESS ? undefined : v);

export interface Range { min?: number; max?: number; integer: boolean }

export const rangeOf = (s: JsonSchema | undefined): Range => ({
  ...(bound(s?.minimum ?? s?.exclusiveMinimum) === undefined ? {} : { min: bound(s?.minimum ?? s?.exclusiveMinimum) as number }),
  ...(bound(s?.maximum ?? s?.exclusiveMaximum) === undefined ? {} : { max: bound(s?.maximum ?? s?.exclusiveMaximum) as number }),
  integer: s?.type === 'integer',
});

export const fetchSchemas = async (): Promise<Schemas | null> => {
  const res = await fetch('/api/schema', { cache: 'no-store' }).catch(() => undefined);
  return res?.ok ? ((await res.json()) as Schemas) : null;
};
