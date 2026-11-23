import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The video tests draw frames in Chrome and encode them with ffmpeg; the slowest take over a minute on a small machine.
    // Their hooks do the same work (a template saved, a clip rendered in beforeAll), so they get the same time.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Each video test file runs Chrome and ffmpeg, which use several cores each: a file on every core but one (the
    // default), or on half of them, starved them on an 8-core machine, and renders, hooks and timed checks (an abort
    // within 2.5 s) ran out of time. Two files at a time.
    maxWorkers: 2,
  },
});
