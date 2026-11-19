/**
 * An Agent profile names its own sign-in file. Any short name works: `claude-code`, `codex`, `agent-<hash>` for a custom
 * skills folder (install/skill-install.ts); an unknown name is a new, empty profile, not an error.
 */
export const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
export const PROFILE_NAME_HINT = 'Use a short profile name containing letters, numbers, underscores or hyphens.';
