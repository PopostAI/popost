#!/usr/bin/env node
// Builds the Skill and checks what `npm publish` would ship, without publishing or writing a tarball:
// every file the CLI and `popost install` need is in, nothing private or developer-only is, versions agree.
//   npm run release:check            (add --no-build to skip the build)
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildSkill, humanSize, npm, packageDir, readJson, repoRoot } from './lib.mjs';

const REQUIRED_FILES = ['package.json', 'SKILL.md', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES', 'dist/cli.js', 'dist/index.js', 'assets/fonts/palette.json'];
const REQUIRED_DIRS = ['references/', 'templates/', 'assets/canvas/', 'assets/project-starter/', 'agents/'];
const FORBIDDEN = [
  [/^(src|tests|tools|bundles)\//, 'developer-only folder'],
  [/(^|\/)node_modules\//, 'node_modules'],
  [/(^|\/)\.env(\.|$)/, 'environment file'],
  [/(^|\/)\.npmrc$/, '.npmrc (may hold a registry token)'],
  [/(^|\/)credentials\.json$/, 'credentials file'],
  [/\.tgz$/, 'a tarball inside the tarball'],
  [/\.(test|spec)\.[cm]?[jt]sx?$/, 'test file'],
  [/(^|\/)SOURCE-MANIFEST\.sha256$/, 'maintainer manifest'],
  [/^(tsconfig[^/]*\.json|vitest\.config\.ts|build\.mjs)$/, 'build configuration'],
];
const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
  [/\bsk-[A-Za-z0-9_-]{24,}/, 'API key shaped token (sk-...)'],
  [/\bnpm_[A-Za-z0-9]{36}\b/, 'npm token'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bBearer [A-Za-z0-9._-]{24,}/, 'bearer token'],
];
const BINARY = /\.(png|jpe?g|webp|gif|woff2?|ttf|otf|zip|ico|gz|tgz|pdf|mp4|webm)$/i;
const MAX_BYTES = 50 * 1024 * 1024;

const problems = [];
const fail = (message) => problems.push(message);

if (!process.argv.includes('--no-build')) buildSkill();

const [pack] = JSON.parse(npm(['pack', '--dry-run', '--json', '--ignore-scripts', '-w', 'popost'], { cwd: repoRoot }));
const files = pack.files.map((f) => f.path.replaceAll('\\', '/'));
const has = (p) => files.includes(p);

for (const file of REQUIRED_FILES) if (!has(file)) fail(`missing from the package: ${file}`);
for (const dir of REQUIRED_DIRS) if (!files.some((f) => f.startsWith(dir))) fail(`missing from the package: ${dir} (no file inside)`);
for (const file of files)
  for (const [pattern, why] of FORBIDDEN) if (pattern.test(file)) fail(`must not be in the package: ${file} (${why})`);

for (const file of files) {
  if (BINARY.test(file)) continue;
  const full = path.join(packageDir, file);
  if (!existsSync(full)) continue;
  const text = readFileSync(full, 'utf8');
  for (const [pattern, what] of SECRETS) if (pattern.test(text)) fail(`${file} contains a ${what}`);
}

const pkg = readJson(path.join(packageDir, 'package.json'));
const cliVersion = /VERSION = '([^']+)'/.exec(readFileSync(path.join(packageDir, 'src', 'version.ts'), 'utf8'))?.[1];
const skillVersion = /^\s*version:\s*"?([^"\n]+)"?\s*$/m.exec(readFileSync(path.join(packageDir, 'SKILL.md'), 'utf8').split('\n---')[0])?.[1];
if (pkg.version !== cliVersion) fail(`package.json version ${pkg.version} differs from src/version.ts ${cliVersion}`);
if (pkg.version !== skillVersion) fail(`package.json version ${pkg.version} differs from SKILL.md metadata.version ${skillVersion}`);
if (pkg.bin?.popost !== 'dist/cli.js') fail('package.json bin.popost must be dist/cli.js');
if (pack.size > MAX_BYTES) fail(`tarball is ${humanSize(pack.size)}, more than ${humanSize(MAX_BYTES)}`);

console.log(`${pack.name}@${pack.version}: ${files.length} files, tarball ${humanSize(pack.size)}, unpacked ${humanSize(pack.unpackedSize)}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('package contents OK');
