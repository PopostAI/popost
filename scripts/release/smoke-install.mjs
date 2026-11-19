#!/usr/bin/env node
// Packs the Skill, installs the tarball into a scratch directory and drives the packed CLI the way a new user does:
// --version, auth status|set|clear, install --dir, install into an agent home. HOME and POPOST_HOME are scratch
// directories, so nothing of the real user is read or written. Nothing is published.
//   npm run release:smoke            (add --no-build to skip the build)
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSkill, isolatedEnv, npm, readJson, repoRoot, run } from './lib.mjs';

const KEY = 'sk-smoke-0123456789abcdefghij-NOT-A-REAL-KEY';
const scratch = mkdtempSync(path.join(tmpdir(), 'popost-smoke-'));
const step = (name) => console.log(`- ${name}`);

const cli = (app, args, env, input) => {
  const entry = path.join(app, 'node_modules', 'popost', 'dist', 'cli.js');
  return run(process.execPath, [entry, ...args], { cwd: scratch, env, input, stdio: ['pipe', 'pipe', 'pipe'] });
};

try {
  if (!process.argv.includes('--no-build')) buildSkill();

  step('npm pack');
  const packed = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '-w', 'popost', '--pack-destination', scratch], { cwd: repoRoot }));
  const tarball = path.join(scratch, packed[0].filename);
  assert.ok(existsSync(tarball), 'npm pack wrote no tarball');

  step('npm install of the tarball (dependencies from the registry or the npm cache)');
  const app = path.join(scratch, 'app');
  mkdirSync(app);
  npm(['install', tarball, '--prefix', app, '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', '--prefer-offline'], { cwd: app });

  const home = path.join(scratch, 'home');
  mkdirSync(home);
  const env = isolatedEnv(home);
  const version = readJson(path.join(repoRoot, 'skills', 'popost', 'package.json')).version;

  step('popost --version');
  assert.equal(cli(app, ['--version'], env).trim(), version);

  step('popost auth status/set/clear with an isolated POPOST_HOME');
  let status = JSON.parse(cli(app, ['auth', 'status'], env));
  assert.equal(status.source, 'none');
  assert.ok(status.credentialsFile.startsWith(scratch), `credentials file outside the scratch directory: ${status.credentialsFile}`);
  const set = cli(app, ['auth', 'set', '--stdin'], env, `${KEY}\n`);
  assert.ok(!set.includes(KEY), 'auth set printed the full key');
  status = JSON.parse(cli(app, ['auth', 'status'], env));
  assert.equal(status.source, 'file');
  assert.ok(readFileSync(status.credentialsFile, 'utf8').includes(KEY));
  assert.ok(!JSON.stringify(status).includes(KEY), 'auth status printed the full key');
  cli(app, ['auth', 'clear'], env);
  assert.equal(JSON.parse(cli(app, ['auth', 'status'], env)).source, 'none');

  step('popost install --dir');
  const skills = path.join(scratch, 'skills');
  const first = JSON.parse(cli(app, ['install', '--dir', skills], env));
  assert.equal(first.installed[0].status, 'installed');
  const installed = path.join(skills, 'popost');
  for (const rel of ['SKILL.md', 'package.json', 'references', 'templates', 'agents', path.join('assets', 'canvas'), path.join('assets', 'fonts', 'palette.json')])
    assert.ok(existsSync(path.join(installed, rel)), `installed Skill lacks ${rel}`);
  for (const rel of ['src', 'tests', 'tools', 'node_modules']) assert.ok(!existsSync(path.join(installed, rel)), `installed Skill must not contain ${rel}`);
  assert.equal(readJson(path.join(installed, 'package.json')).version, version);
  assert.equal(JSON.parse(cli(app, ['install', '--dir', skills], env)).installed[0].status, 'up-to-date');

  step('popost install into agent homes (Claude Code and Codex present in the scratch home)');
  mkdirSync(path.join(home, '.claude'));
  mkdirSync(path.join(home, '.codex'));
  const agents = JSON.parse(cli(app, ['install'], env));
  assert.deepEqual(agents.installed.map((i) => i.agent), ['claude-code', 'codex']);
  assert.ok(existsSync(path.join(home, '.claude', 'skills', 'popost', 'SKILL.md')));
  assert.ok(existsSync(path.join(home, '.agents', 'skills', 'popost', 'SKILL.md')));
  assert.deepEqual(readdirSync(path.join(home, '.claude', 'skills')), ['popost'], 'staging leftovers in the skills directory');

  console.log(`\nsmoke install OK (popost@${version})`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
