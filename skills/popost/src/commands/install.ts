/**
 * `popost install [--agent ID]... [--dir SKILLS_DIR] [--force] [--dry-run]`: copies the Skill (SKILL.md, references/,
 * templates/, agents/, assets/) from this package into the skills directory of the coding agents on this machine, so
 * `npx popost@latest install` is the whole setup, the same on macOS, Windows and Linux. No network, no key.
 */
import { UsageError, withArgs, type CommandSpec, type ParsedArgs } from '../args';
import { errorText, fail, printJson } from '../core/util';
import { BASE_URL_ENV, keyPageUrl } from '../credentials';
import { AGENT_IDS, AGENTS, type AgentTarget } from '../install/agents';
import { installSkill, type InstallResult } from '../install/skill-install';
import { msg } from '../i18n';
import { DEFAULT_BASE_URL } from '../providers/api';
import type { CommandMain, Runtime } from '../runtime';
import { VERSION } from '../version';

const OUTPUT = `output: {"ok": true, "version", "dryRun", "installed": [{"agent", "skillDir", "status": "installed|updated|reinstalled|up-to-date|would-...", "previousVersion", "files"}], "skipped": [{"agent", "reason"}], "next"}`;

const description = (): string => {
  const ids = AGENTS.map((a) => a.id).join(', ');
  return msg(
    `Install the popost Skill for coding agents. Without --agent it installs for every supported agent whose home directory exists on this machine (${ids}) and lists the ones skipped; --agent all forces all supported agents. For any other agent pass its skills directory with --dir. An existing install is replaced (atomically) when its version differs or with --force; the same version is reported as up-to-date. --dry-run shows what would happen and writes nothing.

${OUTPUT}
failure: {"ok": false, "error", ...} exit 1 when nothing could be installed, 2 for a usage error`,
    `为编程 Agent 安装 popost Skill。不带 --agent 时，安装到本机所有已有主目录的受支持 Agent（${ids}），并列出跳过的；--agent all 强制安装到所有受支持的 Agent。其他 Agent 用 --dir 指定它的 skills 目录。已有安装在版本不同或带 --force 时（原子地）替换；版本相同时报告为 up-to-date。--dry-run 只显示将要做什么，不写入任何文件。

${OUTPUT}
failure: {"ok": false, "error", ...} 一个都装不上时退出码 1，用法错误为 2`,
  );
};

const spec = (): CommandSpec => ({
  prog: 'popost install',
  description: description(),
  options: [
    {
      flag: '--agent',
      kind: 'append',
      choices: ['all', ...AGENT_IDS],
      help: msg('install for this agent (repeatable); all = every supported agent', '安装到这个 Agent（可重复）；all = 所有受支持的 Agent'),
    },
    {
      flag: '--dir',
      help: msg(
        'a skills directory to install into (the Skill goes to <dir>/popost); for agents that are not supported by id',
        '要安装到的 skills 目录（Skill 装到 <dir>/popost）；用于没有 id 支持的 Agent',
      ),
    },
    { flag: '--force', kind: 'flag', help: msg('reinstall even when the installed version is the same', '即使已装版本相同也重新安装') },
    { flag: '--dry-run', kind: 'flag', help: msg('show what would be installed; write nothing', '只显示将要安装什么，不写入') },
  ],
});

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
  if ((await rt.fs.stat(home))?.isDirectory) return null;
  return msg(
    `${agent.label} is not installed here (${home} does not exist); use --agent ${agent.id} to install anyway`,
    `本机没有安装 ${agent.label}（${home} 不存在）；仍要安装请用 --agent ${agent.id}`,
  );
};

const plan = async (rt: Runtime, args: ParsedArgs, homeDir: string | undefined): Promise<Plan> => {
  const dir = args.string('dir');
  const asked = args.list('agent');
  if (dir !== undefined) {
    if (asked.length)
      throw new UsageError(msg('--dir and --agent cannot be combined: --dir names the skills directory itself', '--dir 和 --agent 不能同时使用：--dir 直接指定 skills 目录'));
    if (!dir.trim()) throw new UsageError(msg('--dir is empty', '--dir 为空'));
    return { targets: [{ agent: 'custom', skillsDir: rt.path.resolve(rt.cwd, dir) }], skipped: [] };
  }
  if (homeDir === undefined)
    throw new UsageError(msg('no user home directory in this environment: pass --dir <skills directory>', '当前环境没有用户主目录：请传 --dir <skills 目录>'));
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

const nextStep = (page: string) =>
  msg(
    'Restart the agent to load the Skill; keep the supplied companion CLI when using a pinned build. How to use it, for example:\n' +
      'Reproduce a post: "Use popost to reproduce this post link XX; my content is XX."\n' +
      'Create a post: "Use popost to create a TikTok product post for me; my product photo is XX."\n' +
      'To reproduce a post without a social media link, upload reference images instead. To create a post, describe what you want and the style, let it search the template library, or name a template style to follow.\n' +
      `For hosted services run popost auth login, share its verification link and device code, then wait for approval. Manage access at ${page}. Connection does not authorize spending.`,
    '重启 Agent 以加载 Skill；使用固定版本时保留随附的 CLI。怎么用，例如：\n复刻图文：用 popost 复刻这个图文链接 XX，我的内容是 XX。\n创作图文：用 popost 给我创作一个 TikTok 带货图文，我的产品图是 XX。\n复刻图文如果没有社媒链接，可以上传参考图做参考。创作图文可以说出创作要求和风格，也可以自动检索模板库，或指定模板风格去生成。\n' +
      `使用托管服务时运行 popost auth login，把验证链接和设备码发给用户，然后等待批准。在 ${page} 管理访问。连接账户不代表授权消费。`,
  );

const run = async (rt: Runtime, args: ParsedArgs): Promise<number> => {
  const { targets, skipped } = await plan(rt, args, rt.homeDir);
  const dryRun = args.flag('dry-run');
  const installed: (InstallResult & { agent: string })[] = [];
  const failed: { agent: string; error: string }[] = [];
  for (const target of targets) {
    try {
      installed.push({ agent: target.agent, ...(await installSkill(rt, target.skillsDir, { force: args.flag('force'), dryRun, agent: target.agent })) });
    } catch (error) {
      failed.push({ agent: target.agent, error: errorText(error) });
    }
  }
  const page = keyPageUrl((rt.env[BASE_URL_ENV] ?? '').trim() || DEFAULT_BASE_URL);
  if (!installed.length)
    return fail(
      rt,
      failed.length
        ? msg('the Skill could not be installed', 'Skill 安装失败')
        : msg(
            'no supported agent found on this machine: use --agent all to install for every supported agent anyway, or --dir <skills directory> for another agent',
            '本机没有找到受支持的 Agent：仍要安装到所有受支持的 Agent 请用 --agent all，其他 Agent 用 --dir <skills 目录>',
          ),
      1,
      { skipped, ...(failed.length ? { failed } : {}) },
    );
  printJson(rt, { ok: failed.length === 0, version: VERSION, dryRun, installed, skipped, ...(failed.length ? { failed } : {}), next: dryRun ? msg('Dry run: nothing was written.', 'Dry run：没有写入任何文件。') : nextStep(page) }, true);
  return failed.length ? 1 : 0;
};

export const main: CommandMain = (argv, rt) =>
  withArgs(argv, spec(), rt, async (args) => {
    try {
      return await run(rt, args);
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      rt.stderr(`popost install: error: ${error.message}\n`);
      return 2;
    }
  });
