#!/usr/bin/env node
import { guardBrokenPipe } from './broken-pipe';
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
const profile = args[0] === '--profile' ? args.splice(0, 2)[1] : undefined;
run(args, createNodeRuntime(profile)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`popost: ${String(error)}\n`);
    process.exitCode = 1;
  },
);
