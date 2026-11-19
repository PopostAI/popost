#!/usr/bin/env node
import { run } from './main';
import { createNodeRuntime } from './node-runtime';

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
