/**
 * An Agent profile names its own sign-in file. Any short name works: `claude-code`, `codex`, `agent-<hash>` for a custom
 * skills folder (install/skill-install.ts); an unknown name is a new, empty profile, not an error.
 */
import { msg } from './i18n';

export const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
export const profileNameHint = (): string =>
  msg(
    'Use a short profile name containing letters, numbers, underscores or hyphens.',
    '请用简短的 profile 名称，只含字母、数字、下划线或连字符。',
  );
