/**
 * `popost install [--agent ID]... [--dir SKILLS_DIR] [--force] [--dry-run]`: copies the Skill (SKILL.md, references/,
 * templates/, agents/, assets/) from this package into the skills directory of the coding agents on this machine, so
 * `npx popost@latest install` is the whole setup, the same on macOS, Windows and Linux. No network, no key.
 */
import { UsageError, withArgs, type CommandSpec, type ParsedArgs } from '../args';
import { fail, printJson } from '../core/util';
import { BASE_URL_ENV, keyPageUrl } from '../credentials';
import { AGENT_IDS, AGENTS, type AgentTarget } from '../install/agents';
import { installSkill, type InstallResult } from '../install/skill-install';
import { DEFAULT_BASE_URL } from '../providers/api';
import type { CommandMain, Runtime } from '../runtime';
import { VERSION } from '../version';

const DESCRIPTION = `Install the popost Skill for coding agents. Without --agent it installs for every supported agent whose home directory exists on this machine (${AGENTS.map((a) => a.id).join(', ')}) and lists the ones skipped; --agent all forces all supported agents. For any other agent pass its skills directory with --dir. An existing install is replaced (atomically) when its version differs or with --force; the same version is reported as up-to-date. --dry-run shows what would happen and writes nothing.

output: {"ok": true, "version", "dryRun", "installed": [{"agent", "skillDir", "status": "installed|updated|reinstalled|up-to-date|would-...", "previousVersion", "files"}], "skipped": [{"agent", "reason"}], "next"}
failure: {"ok": false, "error", ...} exit 1 when nothing could be installed, 2 for a usage error`;

const SPEC: CommandSpec = {
  prog: 'popost install',
  description: DESCRIPTION,
  options: [
    { flag: '--agent', kind: 'append', choices: ['all', ...AGENT_IDS], help: 'install for this agent (repeatable); all = every supported agent' },
    { flag: '--dir', help: 'a skills directory to install into (the Skill goes to <dir>/popost); for agents that are not supported by id' },
    { flag: '--force', kind: 'flag', help: 'reinstall even when the installed version is the same' },
    { flag: '--dry-run', kind: 'flag', help: 'show what would be installed; write nothing' },
  ],
};

interface Target {
  readonly agent: string;
  readonly skillsDir: string;
}
interface Plan {
  readonly targets: Target[];
  readonly skipped: { agent: string; reason: string }[];
}

const detect = async (rt: Runtime, agent: AgentTarget, homeDir: string): Promise<string | null> => {
  const home = agent.home(rt, homeDir);
  return (await rt.fs.stat(home))?.isDirectory ? null : `${agent.label} is not installed here (${home} does not exist); use --agent ${agent.id} to install anyway`;
};

const plan = async (rt: Runtime, args: ParsedArgs, homeDir: string | undefined): Promise<Plan> => {
  const dir = args.string('dir');
  const asked = args.list('agent');
  if (dir !== undefined) {
    if (asked.length) throw new UsageError('--dir and --agent cannot be combined: --dir names the skills directory itself');
    if (!dir.trim()) throw new UsageError('--dir is empty');
    return { targets: [{ agent: 'custom', skillsDir: rt.path.resolve(rt.cwd, dir) }], skipped: [] };
  }
  if (homeDir === undefined) throw new UsageError('no user home directory in this environment: pass --dir <skills directory>');
  const explicit = asked.length > 0;
  const wanted = asked.includes('all') || !explicit ? AGENTS : AGENTS.filter((a) => asked.includes(a.id));
  const targets: Target[] = [];
  const skipped: Plan['skipped'] = [];
  for (const agent of wanted) {
    const reason = explicit ? null : await detect(rt, agent, homeDir);
    if (reason) skipped.push({ agent: agent.id, reason });
    else targets.push({ agent: agent.id, skillsDir: agent.skillsDir(rt, homeDir) });
  }
  return { targets, skipped };
};

const NEXT = (page: string) =>
  `Restart the agent to load the Skill; keep the supplied companion CLI when using a pinned build. 怎么用，例如：\n复刻图文：用 popost 复刻这个图文链接 XX，我的内容是 XX。\n创作图文：用 popost 给我创作一个 TikTok 带货图文，我的产品图是 XX。\n复刻图文如果没有社媒链接，可以上传参考图做参考。创作图文可以说出创作要求和风格，也可以自动检索模板库，或指定模板风格去生成。\nFor hosted services run popost auth login, share its verification link and device code, then wait for approval. Manage access at ${page}. Connection does not authorize spending.`;

const run = async (rt: Runtime, args: ParsedArgs): Promise<number> => {
  const { targets, skipped } = await plan(rt, args, rt.homeDir);
  const dryRun = args.flag('dry-run');
  const installed: (InstallResult & { agent: string })[] = [];
  const failed: { agent: string; error: string }[] = [];
  for (const target of targets) {
    try {
      installed.push({ agent: target.agent, ...(await installSkill(rt, target.skillsDir, { force: args.flag('force'), dryRun, agent: target.agent })) });
    } catch (error) {
      failed.push({ agent: target.agent, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const page = keyPageUrl((rt.env[BASE_URL_ENV] ?? '').trim() || DEFAULT_BASE_URL);
  if (!installed.length)
    return fail(
      rt,
      failed.length ? 'the Skill could not be installed' : 'no supported agent found on this machine: use --agent all to install for every supported agent anyway, or --dir <skills directory> for another agent',
      1,
      { skipped, ...(failed.length ? { failed } : {}) },
    );
  printJson(rt, { ok: failed.length === 0, version: VERSION, dryRun, installed, skipped, ...(failed.length ? { failed } : {}), next: dryRun ? 'Dry run: nothing was written.' : NEXT(page) }, true);
  return failed.length ? 1 : 0;
};

export const main: CommandMain = (argv, rt) =>
  withArgs(argv, SPEC, rt, async (args) => {
    try {
      return await run(rt, args);
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      rt.stderr(`popost install: error: ${error.message}\n`);
      return 2;
    }
  });
