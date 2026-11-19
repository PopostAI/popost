/**
 * Credentials never leave the process: they are read from the environment when a request is sent and are not written
 * anywhere. As a last line of defence, everything a command prints is scrubbed of the values of the environment
 * variables the configuration names (`POPOST_API_KEY` or `auth.envVar`, `$env:NAME` headers).
 */
import type { Runtime } from '../runtime';
import { DEFAULT_KEY_ENV } from './api-errors';
import { isRecord, type JsonRecord } from './base';

const MIN_SECRET_LENGTH = 6; // anything shorter would also match innocent text

const envNames = (section: unknown): string[] => {
  if (!isRecord(section)) return [];
  const names: string[] = [];
  if (isRecord(section.auth) && typeof section.auth.envVar === 'string') names.push(section.auth.envVar);
  const http = isRecord(section.http) ? section.http : {};
  for (const step of [http.submit, http.poll, http.download])
    if (isRecord(step) && isRecord(step.headers))
      for (const value of Object.values(step.headers)) if (typeof value === 'string' && value.startsWith('$env:')) names.push(value.slice(5));
  return names;
};

/** The secret values the configuration can make a command send. */
export const secretValues = (rt: Runtime, cfg: JsonRecord): string[] => {
  const names = [DEFAULT_KEY_ENV, ...envNames(cfg), ...envNames(cfg.popost), ...envNames(cfg.custom)];
  const values = names.map((name) => rt.env[name]).filter((value): value is string => typeof value === 'string' && value.length >= MIN_SECRET_LENGTH);
  return [...new Set(values)];
};

const scrubText = (text: string, secrets: readonly string[]): string => secrets.reduce((out, secret) => out.split(secret).join('[REDACTED]'), text);

/** A copy of `value` with every secret replaced in every string (and key). */
export const scrub = <T>(value: T, secrets: readonly string[]): T => {
  if (!secrets.length) return value;
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') return scrubText(item, secrets);
    if (Array.isArray(item)) return item.map(walk);
    if (isRecord(item)) return Object.fromEntries(Object.entries(item).map(([k, v]) => [scrubText(k, secrets), walk(v)]));
    return item;
  };
  return walk(value) as T;
};
