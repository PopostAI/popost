/** Default locations of the CLI's quotes, tasks and config, from the runtime's environment (never from `process`). */
import type { Runtime } from '../runtime';

/** `~`: `$HOME` (or `%USERPROFILE%`); a host without one (the web sandbox) falls back to the working directory. */
export const homeDir = (rt: Runtime): string => rt.env.HOME || rt.env.USERPROFILE || rt.cwd;

export const resolvePath = (rt: Runtime, path: string): string => rt.path.resolve(rt.cwd, path);

export const defaultQuoteDir = (rt: Runtime): string => rt.env.POPOST_QUOTE_DIR || rt.path.join(homeDir(rt), '.cache', 'popost', 'quotes');

export const defaultTaskDir = (rt: Runtime): string => rt.env.POPOST_TASK_DIR || rt.path.join(homeDir(rt), '.cache', 'popost', 'tasks');

export const defaultConfigPath = (rt: Runtime): string => rt.path.join(homeDir(rt), '.config', 'social-post-studio', 'config.json');

/** The package's read-only mock fixtures (`mock_models.json`, `mock_result.png`); runtime state never goes here. */
export const staticMockDir = (rt: Runtime): string => rt.path.join(rt.skillRoot, 'assets', 'mock');
