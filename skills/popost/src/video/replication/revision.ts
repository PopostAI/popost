/** A reading revision survives portable file copies but changes when any source requirement changes. */
import { sha256 } from '../../core/util';
import type { ReplicationContract } from './contract';

const canonical = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canonical);
  if (!v || typeof v !== 'object') return v;
  const obj = v as Record<string, unknown>;
  return Object.fromEntries(Object.keys(obj).sort().filter(k => !(k === 'file' && typeof obj.sha256 === 'string'))
    .map(k => [k, canonical(obj[k])]));
};
export const sourceRevision = (c: ReplicationContract): string => sha256(JSON.stringify(canonical({
  source: c.source, audio: { sourceSpeech: c.audio.sourceSpeech, sourceRoles: c.audio.sourceRoles, evidence: c.audio.evidence },
  visual: c.visual, inventory: c.inventory, events: c.events, scope: c.scope,
})));
