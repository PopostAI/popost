/**
 * The coding agents `popost install` knows, and where each reads user-level skills. A path is listed only when an
 * official document or a real install on a developer machine confirms it; for any other agent use `--dir`.
 *
 * - Claude Code: `~/.claude/skills/<name>/SKILL.md`. https://code.claude.com/docs/en/skills ("Personal: ~/.claude/skills").
 * - Codex: `$HOME/.agents/skills` (USER scope). https://developers.openai.com/codex/skills (now served at
 *   learn.chatgpt.com/docs/build-skills): "REPO: $CWD/.agents/skills … USER: $HOME/.agents/skills"; vercel-labs/skills
 *   docs/agents.md lists the same global path for Codex. Codex keeps its own home in `$CODEX_HOME` (default `~/.codex`),
 *   which only tells us Codex is installed; `~/.codex/skills` holds Codex's bundled `.system` skills, not the user's.
 *
 * Not covered, no authoritative path found (2026-11-14): WorkBuddy (official docs say only "the user config directory";
 * `~/.workbuddy/skills` appears in community articles only) and Doubao (no documented skills directory).
 */
import type { Runtime } from '../runtime';

export interface AgentTarget {
  readonly id: string;
  readonly label: string;
  /** The agent's own home: its presence means the agent is installed. */
  readonly home: (rt: Runtime, homeDir: string) => string;
  /** The directory whose sub-directories are skills. */
  readonly skillsDir: (rt: Runtime, homeDir: string) => string;
}

export const AGENTS: readonly AgentTarget[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    home: (rt, home) => rt.path.join(home, '.claude'),
    skillsDir: (rt, home) => rt.path.join(home, '.claude', 'skills'),
  },
  {
    id: 'codex',
    label: 'Codex',
    home: (rt, home) => ((rt.env.CODEX_HOME ?? '').trim() ? rt.path.resolve(rt.cwd, rt.env.CODEX_HOME!.trim()) : rt.path.join(home, '.codex')),
    skillsDir: (rt, home) => rt.path.join(home, '.agents', 'skills'),
  },
];

export const AGENT_IDS: readonly string[] = AGENTS.map((agent) => agent.id);
