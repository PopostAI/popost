#!/usr/bin/env node
import { guardBrokenPipe } from './broken-pipe';
import { PROFILE_NAME, PROFILE_NAME_HINT } from './profile';
import { run } from './main';
import { createNodeRuntime } from './node-runtime';

guardBrokenPipe([process.stdout, process.stderr], {
  exit: (code) => process.exit(code),
  exitCode: () => Number(process.exitCode ?? 0),
  report: (text) => {
    try {
      process.stderr.write(text);
    } catch {
      // stderr is gone too: nothing left to tell.
    }
  },
});

const args = process.argv.slice(2);
const hasProfile = args[0] === '--profile';
const profile = hasProfile ? args.splice(0, 2)[1] : undefined;
if (hasProfile && !(profile && PROFILE_NAME.test(profile))) {
  process.stderr.write(`popost: error: --profile needs a name. ${PROFILE_NAME_HINT}\n`);
  process.exit(2);
}
run(args, createNodeRuntime(profile)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`popost: ${String(error)}\n`);
    process.exitCode = 1;
  },
);
