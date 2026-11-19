/**
 * Scene Skill (template) mounting, pure local (port of `template_plugins.py`).
 * - `locateSkill` really reads the scene Skill's SKILL.md, hashes it, lists the references. A missing or unreadable
 *   SKILL.md is an error result: never a silent fallback, never a downgrade to free creation.
 * - `recallCandidates` is lexical recall only (`verdict_authoritative` is always false). Platform words are never a
 *   content key. The agent reads the full text and decides.
 * - `detectConflict` does not assert a conflict; it only flags `requiresReview`.
 */
import type { Runtime } from '../runtime';
import { sha256 } from '../core/util';
import { compareCodePoints } from '../core/pyjson';
import { fromCwd } from './io';

const PLATFORM_WORDS = new Set(['tiktok', 'xiaohongshu', 'instagram', 'douyin', 'x']);
const STOP = new Set(
  '的 了 和 与 及 或 在 是 我 你 他 她 它 我们 你们 他们 这 那 一个 一款 to a the of for and or with on in is are be do does'.split(
    ' ',
  ),
);

export interface SkillReference {
  path: string;
  exists: boolean;
}

export interface SkillFound {
  ok: true;
  route: 'found';
  path: string;
  skillId: string;
  name: string;
  version: string | null;
  sha256: string;
  references: SkillReference[];
  resourcesPresent: boolean;
  missingRefs: string[];
  fullTextBytes: number;
}

export interface SkillMissing {
  ok: false;
  route: 'error';
  path: string;
  error: string;
}

export type SkillLocation = SkillFound | SkillMissing;

/** Only `name`, `description` and `version` of the front matter are read. */
export const parseFrontmatter = (text: string): Record<string, string> => {
  const fields: Record<string, string> = {};
  const block = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(text);
  if (!block) return fields;
  for (const line of block[1]!.split(/\r\n|[\n\r]/)) {
    const match = /^\s*(name|version|description)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    fields[match[1]!] = value;
  }
  return fields;
};

/** Python opens text files in universal-newline mode: the hash is taken over the text with `\n` line ends. */
const readSkillText = async (rt: Runtime, path: string): Promise<string | null> => {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    return decoder.decode(await rt.fs.readFile(path)).replace(/\r\n?/g, '\n');
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
};

const isFile = async (rt: Runtime, path: string) => (await rt.fs.stat(path))?.isFile ?? false;

const listReferences = async (rt: Runtime, path: string, text: string): Promise<SkillReference[]> => {
  const references: SkillReference[] = [];
  const dir = rt.path.join(path, 'references');
  if ((await rt.fs.stat(dir))?.isDirectory) {
    const names = (await rt.fs.readdir(dir)).sort(compareCodePoints);
    for (const name of names.filter((n) => n.endsWith('.md') || n.endsWith('.json'))) {
      const full = rt.path.join(dir, name);
      references.push({ path: full, exists: await isFile(rt, full) });
    }
  }
  // Follow the links in the text too: listing a directory cannot find a missing target.
  const known = new Set(references.map((r) => r.path));
  for (const [, link] of text.matchAll(/\]\(([^)]+)\)/g)) {
    const rel = link!.split('#', 1)[0]!.replace(/^[<>]+|[<>]+$/g, '');
    if (!rel || rel.includes('://') || rel.startsWith('#')) continue;
    const full = rt.path.resolve(path, rel);
    if (known.has(full)) continue;
    references.push({ path: full, exists: await isFile(rt, full) });
    known.add(full);
  }
  return references;
};

export const locateSkill = async (rt: Runtime, userPath: string): Promise<SkillLocation> => {
  const path = fromCwd(rt, userPath);
  let skillMd = rt.path.join(path, 'SKILL.md');
  const alternative = rt.path.join(path, 'SOURCE-SKILL.md');
  if (!(await isFile(rt, skillMd)) && (await isFile(rt, alternative))) skillMd = alternative;
  if (!(await isFile(rt, skillMd)))
    return { ok: false, route: 'error', path, error: `SKILL.md 缺失：${skillMd}（资源错误，不静默替换）` };
  const text = await readSkillText(rt, skillMd);
  if (text === null)
    return { ok: false, route: 'error', path, error: 'SKILL.md 非合法 UTF-8（资源错误，不降级自由创作）' };
  const frontmatter = parseFrontmatter(text);
  const references = await listReferences(rt, path, text);
  const missingRefs = references.filter((r) => !r.exists).map((r) => r.path);
  return {
    ok: true,
    route: 'found',
    path,
    skillId: rt.path.basename(path),
    name: frontmatter.name ?? '',
    version: frontmatter.version ?? null,
    sha256: sha256(text),
    references,
    resourcesPresent: missingRefs.length === 0,
    missingRefs, // not fatal here; the caller decides whether to treat it as an error
    fullTextBytes: new TextEncoder().encode(text).length,
  };
};

const tokens = (text: string): Set<string> => {
  const out = new Set<string>();
  for (const token of text.toLowerCase().match(/[A-Za-z][A-Za-z0-9_+-]*|[\u4e00-\u9fff]{2,}/g) ?? [])
    if (!PLATFORM_WORDS.has(token) && !STOP.has(token)) out.add(token);
  return out;
};

/** Directories (up to three levels below a root) that hold a SKILL.md. */
const scanRoots = async (rt: Runtime, roots: readonly string[]): Promise<string[]> => {
  const found = new Set<string>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    const subdirs: string[] = [];
    for (const name of await rt.fs.readdir(dir)) {
      const full = rt.path.join(dir, name);
      const stat = await rt.fs.stat(full);
      if (stat?.isDirectory) subdirs.push(full);
      else if (stat?.isFile && name === 'SKILL.md') found.add(dir);
    }
    for (const sub of subdirs) await walk(sub, depth + 1);
  };
  for (const root of roots) {
    const dir = fromCwd(rt, root);
    if ((await rt.fs.stat(dir))?.isDirectory) await walk(dir, 0);
  }
  return [...found].sort(compareCodePoints);
};

export interface Candidate {
  path: string;
  name: string;
  version: string | null;
  sha256: string;
  score: number;
  matchedTokens: string[];
  verdict_authoritative: false;
  note: string;
}

/** Lexical scoring over name and folder name; the platform hint is echoed back and never scored. */
export const recallCandidates = async (
  rt: Runtime,
  brief: string,
  roots: readonly string[],
  platformHint: string | null = null,
) => {
  const briefTokens = tokens(brief);
  const candidates: Candidate[] = [];
  for (const dir of await scanRoots(rt, roots)) {
    const info = await locateSkill(rt, dir);
    if (!info.ok) continue;
    const matched = [...tokens(`${info.name} ${rt.path.basename(dir)}`)].filter((t) => briefTokens.has(t));
    candidates.push({
      path: dir,
      name: info.name,
      version: info.version,
      sha256: info.sha256,
      score: matched.length,
      matchedTokens: matched.sort(compareCodePoints),
      verdict_authoritative: false,
      note: '词法候选，非最终审美/适配结论；agent 须通读全文后终判',
    });
  }
  candidates.sort((a, b) => b.score - a.score || compareCodePoints(a.path, b.path));
  return { ok: true, platform_hint: platformHint, count: candidates.length, candidates };
};

const CONFLICT_NOTE =
  '指定模板与 supplied 参考同时存在且为 strict：本模块只标 requiresReview，' +
  '不直接改 strict、不静默二选一；agent 通读两者实核后，未经用户明确授权' +
  '不得偏离模板结构或改 strict 模式。';

export const detectConflict = (templateChosen: boolean, referenceSupplied: boolean, strict: boolean) => {
  const both = templateChosen && referenceSupplied;
  return {
    templateChosen,
    referenceSupplied,
    strict,
    conflict: null, // not asserted: the agent reads both and decides
    requiresReview: both && strict,
    authorizationField: 'templateConflictAuthorization',
    note: both && strict ? CONFLICT_NOTE : '',
  };
};
