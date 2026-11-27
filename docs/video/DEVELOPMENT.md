# Video engine: development rules

For everyone, person or agent, who changes the video engine: `skills/popost/src/video/`, here called `src/`, and its
tests in `skills/popost/tests/video/`, here called `tests/`. Chinese version: `DEVELOPMENT.zh.md` (same content).
The maintainers keep the progress notes, the evaluation tools and the ledger outside this repository.

## 1. What this package is

The engine behind video re-creation and template-based video generation. It has two halves and a loop that joins them:

| Half | Does | Directories |
|---|---|---|
| Making | `video.json` -> checked project -> resolved timeline -> one HTML page that shows any frame -> MP4 | `src/project` `src/timeline` `src/presets` `src/page` `src/compile` `src/render` |
| Reading | Any video file -> a measurement (cuts, transitions, camera, motion events, colour) -> a score against another measurement | `src/media` `src/measure` `src/score` |
| Loop | Random projects with known truth, the model-free draft, evaluation runs and their ledger | `src/synth` `src/draft` `src/eval` `eval/` |

It needs ffmpeg and Chromium (and zod, which reads `video.json`). It is part of the popost Skill: its commands are
`popost video …` (`src/commands/`), and an agent uses them as `skills/popost/references/video.md` says. It is
developed on the branch `feat/video` and is not in a published `popost` release yet.

## 2. The contract

`src/types.ts` is the contract between the halves: the project, the resolved timeline, the measurement, the score.
Its header fixes the frame conventions. Learn these five before changing anything:

1. Every time is an **integer frame**. Seconds appear only when two videos of different frame rates are compared.
2. Every position is a **fraction of the canvas** (`[x, y, width, height]`, origin top left).
3. Segment k starts at S_k, the sum of the lengths before it. **Transitions never change the length of the video.** A
   transition of F frames mixes the pictures on frames a .. a+F-1 with a = S_k - floor(F / 2).
4. A measured boundary is `{ start, end, frame }`: the last purely old frame, the first purely new frame, and where
   the new shot takes over. A hard cut is `{ frame - 1, frame, frame }`.
5. What is said is placed by **words, not frames**. A words file gives an audio material's tokens (as `src/align`
   writes them) in frames from the start of the file; a phrase span puts an item on its phrase's tokens, so it moves
   when the wording, the voice or the language changes. Anchor to a phrase whatever belongs to what is said.

A change to `types.ts` is a change to both halves. Make it in one commit with the code and the tests of both sides,
and say so in the commit message.

## 3. Rules of the code

- **The page runtime is a pure function of the frame number.** `applyFrame(n)` sets every style from `n` alone: no
  timers, no `requestAnimationFrame`, no CSS transitions or animations, no state kept from the previous call, no
  unseeded randomness. A frame reached by jumping and the same frame reached by playing must be byte-identical. This
  is what lets export run in parallel and lets preview and export share one page. A picture that has to load (a frame
  of video footage) is awaited with `settle()` after `applyFrame(n)` and before the frame is captured or reported as
  shown; `settle()` only waits and never changes what is shown.
- **Presets are data plus pure functions** in `src/presets`. The same functions run in Node (tests, truth) and in the
  page. A preset never touches the DOM.
- **Measurement is deterministic.** The same file gives the same `Measure`, byte for byte as JSON.
- **Nothing is a fallback kind.** When no transition model fits, the measurement returns its best guess with a low
  confidence; it does not default to "dissolve". Low confidence is information; a silent default is not.
- **Code adapted from another project** only under a licence that allows it, with the project, its copyright and its
  licence named in `NOTICE` and at the top of each adapted file.
- **No new dependency** without a reason in the commit message and, if it ships in a build, a line in `NOTICE`.
  Not allowed: Remotion (licence) and any model inference inside this package. GSAP is used only as an npm dependency
  that is not bundled: `popost video scene library` copies its unchanged file into a project, and `NOTICE` names its
  licence.
- **No secrets, no vendor names, no private addresses** in code, tests, fixtures or logs. A service is reached through
  an interface whose implementation lives on the server.
- **The Runtime**: code under `src/` never imports `node:fs`, `node:child_process`, `node:http`, `node:net` or
  `node:os` and never reads `process`; a function that touches files, programs, the browser or the environment takes
  the `Runtime` (`skills/popost/src/runtime.ts`) as its first parameter. ESLint enforces it. A command prints one
  JSON document; an expected failure is `{ "ok": false, "error" }` with exit code 2.
- **TypeScript of the Skill**: local imports have no extension; no enums, namespaces or constructor parameter
  properties; type-only imports use `import type`.
- **Style**: strict types and no `any`; `const` arrow functions; files of at most about 400 lines, functions under
  about 50, nesting at most 4 levels. A comment says what the code cannot: units, conventions, why a threshold has
  its value.
- **Error messages** name the location, the allowed values and one fix (the `Problem` type). They are written for a
  weak model that will read them and try again.

### The CPU budget

Nothing in the engine asks the machine how many processors it has. On a shared host or in a container limited by a
CPU quota that count is the host's, and work sized by it oversubscribes what the process may really use (a reader
library that sized its threads that way froze a machine twice). One number, the budget, decides instead:

- **Where it comes from**: `POPOST_CPUS` when it is a whole number from 1; else the smaller of the process's
  processor affinity and the CPU quota of its control group (cgroup v2 `cpu.max`, v1 `cpu.cfs_quota_us` /
  `cpu.cfs_period_us`, on its group and every group above it), rounded up, at least 1. The rule is
  `src/cpu-budget.ts`; `src/node-runtime.ts` reads the files once and reports the budget as
  `LocalPrograms.parallelism`; engine code asks `cpuBudgetOf(rt)` (`src/video/host.ts`). Node's
  `availableParallelism()` counts the affinity; Node 24 (libuv 1.52) also applies a cgroup v2 quota but rounds it
  down (1.5 processors gives 1); Node 20 and 22 were not checked here. So the runtime reads both itself.
  `popost video doctor` prints `cpus: { budget, from }`.
- **What derives from it**: every ffmpeg gets `-threads` (each input and the output) and `-filter_threads` /
  `-filter_complex_threads` from `withThreads` in `media/ffmpeg.ts`, the one place ffmpeg starts. A render draws
  with one Chrome page per four processors (one below eight), at most four, each with `--num-raster-threads` from
  the budget (1 to 4, Chrome's range; `chromiumArgs` in `src/render/browser.ts`). A tool gets `POPOST_TOOL_THREADS`, the
  budget but at most four, unless the user set it, and `POPOST_OCR_JOBS` copies times threads stay within the
  budget. Describe's three parts and readback's two run side by side from four processors and one after another
  below (the same bytes either way). Batches of ffmpeg runs (draft pictures, synth pictures, footage probes, the two
  decodes of a measurement) run one per two processors (`heavyJobs`, `mapLimit`).
- **Priority**: ffmpeg and the tools start through `nice -n 10` on Linux and macOS (lowering a running process
  reaches only its first thread on Linux) and at BELOW_NORMAL on Windows (`os.setPriority`). Chrome is started by
  Playwright at the CLI's priority, so the encoder that drains it (render, capture) stays at that priority: lowered
  below Chrome, a one-processor render of the showcase took 218 s instead of 50.
- **A new heavy step** takes its threads or how many run side by side from `cpuBudgetOf(rt)`, and a test runs it at
  budget 1.

Measured on 2026-11-21 on a 16-processor arm64 machine, each run pinned to as many processors as its budget: describe
of a synthetic 30 s 960x720 clip with ten caption lines and a tone, with the RapidOCR reader and the faster-whisper
transcriber (`--language zh`); a render of `references/video-examples/showcase` (1080x1920, 330 frames). Memory:
the largest process, and the whole tree's peak with its file cache (cgroup `memory.peak`).

| Budget | describe | render |
|---|---|---|
| 1 (`POPOST_CPUS=1`, 1 processor) | 52.7 s, 96% CPU; 656 MB, tree 1.17 GB | 49.6 s, 6.7 frames/s, 1 page; 468 MB, tree 875 MB |
| 2 | 37.1 s, 167%; 654 MB, tree 1.14 GB | 24.3 s, 13.8 frames/s, 1 page; 527 MB, tree 885 MB |
| 4 | 27.1 s, 313%; 651 MB, tree 918 MB | 15.0 s, 22.4 frames/s, 1 page; 578 MB, tree 941 MB |
| 1 from a quota (`CPUQuota=100%`, 8 processors) | 54.7 s, 96%; 654 MB, tree 1.17 GB | 74.7 s, 4.4 frames/s, 1 page; 484 MB, tree 876 MB |

One processor costs about twice the four-processor time for describe and three times for a render; 2 GB of memory
is enough at every budget. The describe files are byte-identical at every budget and to an unbudgeted run.

Under a quota the engine keeps to one processor's worth (doctor: `cgroup v2 cpu.max: 1 processor`), but two things
are not sized by the budget: Chrome's own thread pools (up to 29 threads in one of its processes, sized by the
machine's count) and ffmpeg 7's threads per stage (about 10 in a run; `-threads` sizes only the codec's). They spread
over the 8 processors the process may run on, and the quota throttles them: Chrome used 33 s of CPU for the render
against 22.5 s pinned. The quota render took 75 to 78 s when nothing else ran, and 55 s in four runs with a small
sampling loop running beside it (likely the idle virtual processors waking sooner). With `--num-raster-threads`
from the budget (now the default) Chrome used 28.6 s, and the render took 61 s alone and 49.6 s beside the loop;
pinned to one processor it is unchanged (51 s).

## 4. Tests

- Test files are named by half: `tests/make-*.test.ts`, `tests/read-*.test.ts`, `tests/loop-*.test.ts`.
- A test gets its runtime from `createDiskRuntime()` and skips itself when ffmpeg or Chrome is missing (`hasFfmpeg(rt)`; Chrome through
  `POPOST_CHROME` / `PLAYWRIGHT_CHROMIUM` or the usual locations).
- **No binary files in git.** Test media is made at test time (ffmpeg lavfi sources, our own renderer) in a temporary
  directory and removed afterwards.
- Small and short: canvases around 180x320, clips of 1 to 4 seconds.
- An accuracy test asserts a threshold the code actually meets and prints the table, so a run shows the numbers.
- A failing test is never weakened to pass. Fix the code, or mark the test `it.fails` / `it.skip` with the reason
  and say so in the commit message.

Commands, from the repository root:

```bash
npx tsc -p skills/popost/tsconfig.json                     # types of the whole Skill
(cd skills/popost && npx vitest run --config vitest.config.ts tests/video --maxWorkers=2) # the video tests
(cd skills/popost && npx vitest run --config vitest.config.ts tests/video/loop-plan.test.ts) # one file
npx eslint skills/popost/src/video skills/popost/tests/video --max-warnings 0
npm run check:video -w popost                             # the page bundle matches its sources (build:video rebuilds it)
npx vite-node skills/popost/src/cli.ts video --help  # popost video, run from the sources
```

- Run vitest with `--config vitest.config.ts` in `skills/popost` (`npm run test:skill` runs every test of the Skill). Without the config
  the timeout is 5 seconds and every test that starts Chrome fails on a busy machine.
- A check decides a commit by its **exit code**. Do not pipe it into `tail` or `grep` in the same command that
  commits: the pipe hides the failure. (This is how a failing test was committed twice in the first night.)
- The engine, the tests and the local readers write temporary files under `TMPDIR`. Where `/tmp` is a small RAM
  disk (on some machines it is 2 GB), point it at a directory on disk:
  `export TMPDIR=<repository>/.video-work/tmp`.

On a machine shared with other work, run heavy commands one at a time and at low priority, for example
`flock <a lock file> nice -n 10 npm run test:skill`.

With a connected popost.ai account (`popost auth login`), voice-over and transcription run there by default, paid in
credits like images: a paid command prices its work and stops with exit code 3 unless it gets `--confirm --max-credits N`
(the rest of the video's one budget), and prints `chargedCredits`; generated clips outside the agreed list need
`--approve-unplanned <key>` (`production/approved-clips.json`). Every Open API request made in a project carries the
project's task (`x-popost-task`, `x-popost-task-title`, `x-popost-agent-session`; `src/providers/task.ts`), and
`popost usage --dir P` reads what the platform booked under it (`--title TEXT` names the task first). Environment variables, all optional: `POPOST_FFMPEG`,
`POPOST_CHROME`; `POPOST_OCR_CMD`, `POPOST_ASR_CMD`, `POPOST_TTS_CMD`, `POPOST_TTS_MODEL` (the local readers and a speaker
of your own, see `tools/`; when set, the transcriber and the speaker go before the account's); `POPOST_LLM_URL`,
`POPOST_LLM_MODEL`, `POPOST_LLM_KEY`, `POPOST_LLM_JSON` (the model of the plan step, see `src/plan/model.ts`; a key
is never written to a file, a log or a test); `POPOST_RENDER_PAGES`; `POPOST_VIDEO_DATA`, `POPOST_VIDEO_WORK`.

## 5. The evaluation loop

The loop exists so that a change is kept because a number moved, not because it looked better. `popost video` is the
Skill's command line; from the repository run it as `npx vite-node skills/popost/src/cli.ts video …` (or build it with
`npm run build:skill` and run `node skills/popost/dist/cli.js video …`). `eval` runs only inside a checkout.

| Run | Command | Answers |
|---|---|---|
| Round trip | `popost video eval roundtrip --seeds 1-20` | How well does the measurement read what the renderer drew? Truth = the project |
| Floor | `popost video eval floor <video> …` | How far does measurement alone get on a real reference, with no model? |
| Floor on the real set | `popost video eval floor --set dev` | The same over the development cases of the set in `POPOST_VIDEO_DATA`; `--set heldout` prints means only |
| Preview | `popost video preview <project-dir> --reference <video>` | What does the project show at each frame, and how does it line up with the measurements? Read-only |

Rules (design section 13.6):

1. One hypothesis, one change, one ledger line. Give the hypothesis with `--note "…"`. Failed experiments are
   recorded too.
2. Run the baseline three times first; its spread is the noise band. A change counts only beyond the band.
3. Accept a change when the development set improves beyond noise, the held-out set does not fall, and time and cost
   stay inside their limits.
4. **Protected paths**: `src/score/`, the datasets, and these rules. A change to them is never part of an iteration.
   It is its own commit, reviewed by a person, and it resets the baseline.
5. Label every failed case from the fixed list (read wrongly, mapped to the wrong preset, layout, timing, material,
   render) and work on the largest group.
6. Paid generation is off in the loop unless a run was given a spending limit.

Where things go:

- The ledger, `video/eval/ledger.jsonl` of the evaluation repository: one line per run with the hypothesis, the commit,
  the data, the scores, the decision. Lines are appended, never edited. `popost video eval` writes the file
  `POPOST_VIDEO_LEDGER` names, or else `docs/video/eval/ledger.jsonl` of the checkout, which git ignores.
- `.popost/video/` under the directory the command runs in (not in git): renders, measurements, per-case files, a
  voice's measured pace. Override with `POPOST_VIDEO_WORK`.
- Reference videos of the real set are never committed, and their file names do not go into the ledger. The set
  lives outside the repository; `POPOST_VIDEO_DATA` points to it (`cases.json`, `split.json`; see `src/eval/dataset.ts`).
  The split is fixed; nobody tunes on a held-out case.
- Measurement files next to a project have fixed names, which the preview looks for: `measure.json` or
  `replica.measure.json` for the render, `reference.measure.json` or `truth.json` for the reference.

## 6. How to add things

| Adding | Touch | Then |
|---|---|---|
| A transition kind | `TRANSITION_KINDS` in `types.ts`; `src/presets/transition.ts` and its defaults (if it changes one picture and has an amount: `ONE_SIDED_TRANSITIONS` and its one-sided look in `EFFECTS`); a fit in `src/measure`; the confusion table in `src/score`; `src/synth/generate.ts` | Preset test (`make-presets`, and `make-transition-sides` for a one-sided kind), determinism test, round trip with the new kind; record recall and kind accuracy |
| A motion preset | `MOTION_PRESETS`; `src/presets/motion.ts`; the `how` mapping in `src/synth/truth.ts` and `src/draft/build.ts` | The same |
| A loop preset | `LOOP_PRESETS` in `types.ts`; `loopState`, `LOOP_DEFAULTS` and `LOOP_AMOUNT_RANGE` in `src/presets/loop.ts` (the identity at j = 0, so it starts without a jump) | A state test and a determinism frame in `tests/make-loop.test.ts` |
| A look of items (like rotate, border, shadow) | `ItemLook` in `types.ts` and its resolved field on `ResolvedItem`; `itemCommon` in `src/project/schema.ts` (and the `KeyTable` of `issues.ts`); `lookOf` in `src/timeline/items.ts`; static CSS in `src/page/dom.ts`, or per frame through `itemStateAt` in `src/timeline/frame.ts` | A render test that decodes a frame and checks what is visible |
| A measurement | A pure function on decoded thumbnails in `src/measure`; a field in `Measure` | A synthetic test with truth; an entry in `src/measure/README.md` with its accuracy |
| A score dimension | `DIMENSIONS`; `src/score` (a protected path) | The validation tests of design section 13.2: self, re-encode, graded damage, unrelated |
| A track type | `types.ts`; schema, its `KeyTable` entry and a `src/project/check-*.ts`; `src/timeline/items.ts` (a track may expand into several items, as a caption track does); the runtime; the draft builder if it can be measured | Schema, timeline and render tests |

## 7. Git

- Branch `feat/video-skill`. Commit in small steps that pass the type check, eslint and the video tests; push after each
  milestone so that others can continue.
- Commit messages follow the repository: `feat(video): …`, `fix(video): …`, `test(video): …`, `docs(video): …`, in
  English, saying what changed and why.
- At a milestone, say in the commit message what works with its numbers, what does not, what is next.
- Before committing, `git diff --cached --numstat | awk '$1 == "-"'` must print nothing (no binary files).
- A change under `skills/popost/` also regenerates `skills/popost/SOURCE-MANIFEST.sha256` (see `AGENTS.md`).
