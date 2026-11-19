/** Puts the Skill payload into one skills directory: a staged copy, then an atomic swap, so an agent never sees half a Skill. */
import { createHash } from 'node:crypto';
import type { Runtime } from '../runtime';
import { listPayload, readManifest, type PackageManifest } from './payload';

export const SKILL_DIR_NAME = 'popost';

export type InstallStatus = 'installed' | 'updated' | 'reinstalled' | 'up-to-date' | 'would-install' | 'would-update' | 'would-reinstall';

export interface InstallResult {
  readonly skillDir: string;
  readonly status: InstallStatus;
  readonly previousVersion?: string | null;
  readonly files: number;
}

const installedVersion = async (rt: Runtime, skillDir: string): Promise<string | null> => {
  try {
    const data = JSON.parse(await rt.fs.readText(rt.path.join(skillDir, 'package.json'))) as { version?: unknown };
    return typeof data.version === 'string' ? data.version : null;
  } catch {
    return null;
  }
};

const decide = (exists: boolean, previous: string | null, manifest: PackageManifest, force: boolean, dryRun: boolean): InstallStatus => {
  const same = exists && previous === manifest.version;
  if (same && !force) return 'up-to-date';
  const base = !exists ? 'install' : same ? 'reinstall' : 'update';
  if (dryRun) return `would-${base}` as InstallStatus;
  return base === 'install' ? 'installed' : base === 'update' ? 'updated' : 'reinstalled';
};

const stage = async (rt: Runtime, root: string, files: readonly string[], staging: string): Promise<void> => {
  for (const rel of files) await rt.fs.writeFile(rt.path.join(staging, ...rel.split('/')), await rt.fs.readFile(rt.path.join(root, ...rel.split('/'))));
};

/** Replaces `target` by `staging`: the old copy is moved aside first and put back when the swap fails. */
const swap = async (rt: Runtime, staging: string, target: string, aside: string, exists: boolean): Promise<void> => {
  if (exists) await rt.fs.rename(target, aside);
  try {
    await rt.fs.rename(staging, target);
  } catch (error) {
    if (exists) await rt.fs.rename(aside, target);
    throw error;
  }
  await rt.fs.rm(aside);
};

/** Installs into `<skillsDir>/popost`. `up-to-date` when that copy has this package's version (unless `force`). */
export const installSkill = async (
  rt: Runtime,
  skillsDir: string,
  options: { force: boolean; dryRun: boolean; agent?: string },
): Promise<InstallResult> => {
  const root = rt.skillRoot;
  const manifest = await readManifest(rt, root);
  const files = await listPayload(rt, root, manifest.files);
  if (!files.includes('SKILL.md')) throw new Error(`${rt.path.join(root, 'SKILL.md')} is missing: nothing to install`);
  const skillDir = rt.path.join(skillsDir, SKILL_DIR_NAME);
  const stat = await rt.fs.stat(skillDir);
  if (stat && !stat.isDirectory) throw new Error(`${skillDir} exists and is not a directory: move it away first`);
  const previous = stat ? await installedVersion(rt, skillDir) : null;
  const status = decide(stat !== null, previous, manifest, options.force, options.dryRun);
  const result: InstallResult = { skillDir, status, ...(stat ? { previousVersion: previous } : {}), files: files.length };
  if (status === 'up-to-date' || options.dryRun) return result;
  const id = rt.randomUUID().slice(0, 8);
  const staging = rt.path.join(skillsDir, `.${SKILL_DIR_NAME}.new-${id}`);
  const aside = rt.path.join(skillsDir, `.${SKILL_DIR_NAME}.old-${id}`);
  try {
    await stage(rt, root, files, staging);
    const entry = rt.path.join(staging, 'SKILL.md');
    const profile = options.agent && options.agent !== 'custom'
      ? options.agent
      : 'agent-' + createHash('sha256').update(skillsDir).digest('hex').slice(0, 10);
    const instructions = await rt.fs.readText(entry);
    await rt.fs.writeFile(entry, instructions.replace('<!-- installed-profile -->',
      `For every CLI command in this Agent, use the prefix \`popost --profile ${profile}\` (or pass \`--profile ${profile}\` directly after the pinned CLI executable). Keep this profile across new chats.`));
    await swap(rt, staging, skillDir, aside, stat !== null);
  } finally {
    await rt.fs.rm(staging);
  }
  return result;
};
