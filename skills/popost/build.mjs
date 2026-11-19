// Bundle the CLI (dist/cli.js) and the in-process library entry (dist/index.js) as ESM, and emit type declarations
// (dist/types/). npm dependencies stay external and are installed with the package.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { chmod, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';

const here = new URL('.', import.meta.url);
await rm(new URL('./dist', here), { recursive: true, force: true });
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  legalComments: 'none',
  logLevel: 'warning',
  absWorkingDir: here.pathname,
};
await build({ ...common, entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js' });
await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/index.js' });
await chmod(new URL('./dist/cli.js', here), 0o755);
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: here.pathname, stdio: 'inherit' });
