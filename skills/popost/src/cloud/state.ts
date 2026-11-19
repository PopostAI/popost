/**
 * `.popost-editor/cloud.json`: what the last cloud sync of a project left behind. It holds the web deck's address, the
 * project's fingerprint at that moment (so "unsynced local changes" is a cheap comparison) and the uploaded pictures by
 * content hash (so an unchanged picture is never uploaded twice). It never holds a credential. The directory is already
 * left out of project ZIPs.
 */
import type { Project } from '../core/project';
import { isRecord } from '../providers/base';
import { isFile, readJson, writeJson } from '../core/util';
import { STATE_DIR } from '../editor/canvas-state';

export interface CloudRecord {
  readonly projectId: string;
  /** Identifies the authenticated account and API that own this link. */
  readonly accountScope?: string;
  readonly deckId?: string;
  readonly webUrl?: string;
  readonly assetsUrl?: string;
  readonly version?: number;
  /** The project's `canvasRevision` taken just before the last successful sync's export. */
  readonly fingerprint?: string;
  /** Exported content and the bytes of every referenced picture at the last sync. */
  readonly contentHash?: string;
  /** SHA-256 of a picture's bytes -> the upload id the platform gave it. */
  readonly assets: Readonly<Record<string, string>>;
  readonly syncedAt?: string;
}

export const cloudFile = (project: Project): string => project.rt.path.join(project.root, STATE_DIR, 'cloud.json');

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** The record of this project, or `null` when there is none, it is unreadable, or it belongs to another project id. */
export const readCloudRecord = async (project: Project): Promise<CloudRecord | null> => {
  const { rt } = project;
  const file = cloudFile(project);
  if (!(await isFile(rt, file))) return null;
  let raw: unknown;
  try {
    raw = await readJson(rt, file);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.projectId !== project.manifest.projectId) return null;
  const assets: Record<string, string> = {};
  if (isRecord(raw.assets)) for (const [hash, id] of Object.entries(raw.assets)) if (typeof id === 'string' && id) assets[hash] = id;
  return {
    projectId: String(raw.projectId),
    accountScope: text(raw.accountScope),
    deckId: text(raw.deckId),
    webUrl: text(raw.webUrl),
    assetsUrl: text(raw.assetsUrl),
    version: typeof raw.version === 'number' ? raw.version : undefined,
    fingerprint: text(raw.fingerprint),
    contentHash: text(raw.contentHash),
    assets,
    syncedAt: text(raw.syncedAt),
  };
};

export const writeCloudRecord = (project: Project, record: CloudRecord): Promise<void> => writeJson(project.rt, cloudFile(project), record);

/** Whether the record describes a finished sync (a deck exists on the web). */
export const isSynced = (record: CloudRecord | null): record is CloudRecord & { deckId: string; webUrl: string } =>
  Boolean(record?.deckId && record.webUrl);
