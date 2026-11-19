#!/usr/bin/env node
import { guardBrokenPipe } from './broken-pipe';
import { PROFILE_NAME, profileNameHint } from './profile';
import { msg, resolveLang, withLang } from './i18n';
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
  const text = withLang(resolveLang(process.env), () => msg('--profile needs a name. ', '--profile 需要一个名称。') + profileNameHint());
  process.stderr.write(`popost: error: ${text}\n`);
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
