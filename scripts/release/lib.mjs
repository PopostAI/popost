// Shared helpers of the release scripts: plain Node, no shell syntax, the same on macOS, Windows and Linux.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const packageDir = path.join(repoRoot, 'skills', 'popost');

/** Runs a command and returns its stdout; stderr goes through, a failure throws. */
export const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], maxBuffer: 256 * 1024 * 1024, ...options });

/** `npm <args>`: through npm's own entry script when started by npm, else `npm` (a .cmd on Windows needs a shell). */
export const npm = (args, options = {}) =>
  process.env.npm_execpath?.endsWith('.js')
    ? run(process.execPath, [process.env.npm_execpath, ...args], options)
    : run('npm', args, { shell: process.platform === 'win32', ...options });

export const buildSkill = () => npm(['run', 'build:skill', '--silent'], { cwd: repoRoot, stdio: 'inherit' });

export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

export const humanSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`);

/** The environment of a child that must not see the real user: own HOME, no popost or Codex settings. */
export const isolatedEnv = (home) => {
  const env = { ...process.env, HOME: home, USERPROFILE: home, POPOST_HOME: path.join(home, '.popost-state') };
  for (const name of ['POPOST_API_KEY', 'POPOST_BASE_URL', 'CODEX_HOME', 'XDG_CONFIG_HOME']) delete env[name];
  return env;
};
