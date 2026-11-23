/**
 * `popost video eval`: the maintainers' loop. roundtrip renders random projects and measures them against the truth
 * they imply; floor drafts, renders and scores real references with no model (the private set POPOST_VIDEO_DATA names,
 * or videos given by hand); decide records what was decided about the runs before it. Every run appends one line to the
 * ledger, with the commit (git) of the code that ran: the file POPOST_VIDEO_LEDGER names (a ledger kept
 * elsewhere), or else docs/video/eval/ledger.jsonl of the popost checkout it runs in, which git
 * ignores. Outside a checkout the commands refuse. The held-out set prints means only, so that nobody tunes on a single held-out case.
 */
import { isFile, printJson } from '../../core/util';
import type { Runtime } from '../../runtime';
import { loadSet } from '../eval/dataset';
import { runFloor } from '../eval/floor';
import { appendLedger, type LedgerRow } from '../eval/ledger';
import { formatRoundTrip, meanScores, runRoundTrip } from '../eval/roundtrip';
import { programsOf } from '../host';
import { formatScore } from '../score/index';
import { workDir } from '../work';
import { looping } from './loop-shared';
import { command, userPath, VideoCommandError, type Commands } from './shared';

/** The ledger and the code the loop measures, relative to the root of a checkout. */
const LEDGER = 'docs/video/eval/ledger.jsonl';
const ENGINE = 'skills/popost/src/video';

const NOTE = { flag: '--note', default: 'baseline', help: 'one sentence: what was changed and what is expected ("baseline" for a baseline run)' } as const;
const FOOTAGE = { flag: '--footage', choices: ['still', 'video'], default: 'still', help: 'still: every shot rebuilt from a frame; video: the footage is kept' } as const;

const git = async (rt: Runtime, args: string[], cwd: string): Promise<string | undefined> => {
  const r = await programsOf(rt).run(['git', ...args], { cwd }).catch(() => undefined);
  return r && r.code === 0 ? new TextDecoder().decode(r.stdout).trim() : undefined;
};

interface Checkout { root: string; ledger: string }

/** The popost checkout around the working directory, or a message that says where to run the loop. */
const checkout = async (rt: Runtime): Promise<Checkout> => {
  const root = await git(rt, ['rev-parse', '--show-toplevel'], rt.cwd);
  const engine = root === undefined ? undefined : await rt.fs.stat(rt.path.join(root, ENGINE));
  if (root === undefined || !engine?.isDirectory)
    throw new VideoCommandError('popost video eval is the maintainers\' loop: it records every run in ' + LEDGER + ' of a checkout of the popost repository, and ' + rt.cwd + ' is not inside one. Run it from the checkout.');
  const named = rt.env.POPOST_VIDEO_LEDGER?.trim();
  if (!named) return { root, ledger: rt.path.join(root, LEDGER) };
  const ledger = userPath(rt, named);
  if (!(await isFile(rt, ledger)))
    throw new VideoCommandError('POPOST_VIDEO_LEDGER names ' + ledger + ', and there is no file there. Point it at the ledger itself (video/eval/ledger.jsonl of the evaluation repository), or unset it to use ' + LEDGER + ' of this checkout.');
  return { root, ledger };
};

/** The commit of the code that ran, with "+dirty" when the engine has changes that are not committed. */
const commit = async (rt: Runtime, root: string): Promise<string> => {
  const head = await git(rt, ['rev-parse', '--short', 'HEAD'], root);
  if (head === undefined) return 'unknown';
  const dirty = await git(rt, ['status', '--porcelain', '--', ENGINE], root);
  return head + (dirty ? '+dirty' : '');
};

/** "1-20", "3,7,9" or "5". */
const seedList = (text: string): number[] =>
  text.split(',').flatMap((part) => {
    const [a, b] = part.split('-').map(Number);
    if (a === undefined || !Number.isInteger(a) || (b !== undefined && !Number.isInteger(b))) throw new VideoCommandError('Bad seed list "' + text + '". Use for example 1-20 or 3,7,9.');
    return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, i) => a + i);
  });

const roundtrip = command(
  'random projects rendered and measured against the truth they imply: how well the measurement reads what the renderer drew',
  {
    options: [
      { flag: '--seeds', default: '1-20', help: 'for example 1-20 or 3,7,9' },
      { flag: '--scale', kind: 'number', help: 'render scale (default 0.25)' },
      NOTE,
      { flag: '--keep', kind: 'flag', help: 'keep the renders' },
      { flag: '--features', help: 'later format features to add to the random projects: sides and/or moves, separated by commas (a seed without them keeps giving the project it always gave)' },
    ],
  },
  looping(async (args, rt) => {
    const repo = await checkout(rt);
    const started = Date.now();
    const seedText = args.string('seeds') ?? '1-20';
    const seeds = seedList(seedText);
    const features = (args.string('features') ?? '').split(',').filter(Boolean).map((f) => {
      if (f !== 'sides' && f !== 'moves') throw new VideoCommandError('--features takes sides and/or moves, got "' + f + '".');
      return f;
    });
    const scale = args.number('scale');
    const note = args.string('note') ?? 'baseline';
    const work = rt.path.join(workDir(rt), features.length ? 'roundtrip-' + features.join('-') : 'roundtrip');
    const r = await runRoundTrip(rt, {
      seeds, workDir: work, keep: args.flag('keep'), ...(scale === undefined ? {} : { scale }), ...(features.length ? { synth: { features } } : {}),
      onCase: (done, total, seed) => rt.stderr('case ' + seed + ' (' + done + '/' + total + ')\n'),
    });
    const scores = meanScores(r.cases);
    const b = Object.values(r.boundaries).reduce((s, x) => ({ truth: s.truth + x.truth, found: s.found + x.found, right: s.right + x.kindRight }), { truth: 0, found: 0, right: 0 });
    const e = Object.values(r.events).reduce((s, x) => ({ truth: s.truth + x.truth, found: s.found + x.found, right: s.right + x.howRight }), { truth: 0, found: 0, right: 0 });
    const row: LedgerRow = {
      at: rt.now().toISOString(), kind: 'roundtrip', hypothesis: note, commit: await commit(rt, repo.root), data: 'seeds ' + seedText + (features.length ? ', features ' + features.join('+') : ''), cases: r.cases.length, scores,
      detail: { boundaryRecall: b.truth ? Number((b.found / b.truth).toFixed(3)) : 0, boundaryKindRight: b.found ? Number((b.right / b.found).toFixed(3)) : 0, falseBoundaries: r.falseBoundaries, eventRecall: e.truth ? Number((e.found / e.truth).toFixed(3)) : 0, eventHowRight: e.found ? Number((e.right / e.found).toFixed(3)) : 0, falseEvents: r.falseEvents },
      seconds: Math.round((Date.now() - started) / 1000), decision: note === 'baseline' ? 'baseline' : 'open',
    };
    await appendLedger(rt, repo.ledger, row);
    printJson(rt, { ok: true, cases: r.cases.length, work, ledger: repo.ledger, means: scores, detail: row.detail, boundaries: r.boundaries, events: r.events, camera: r.camera, table: formatRoundTrip(r).split('\n') });
  }),
);

const floor = command(
  'real references drafted with no model, rendered, measured and scored: how far measurement alone gets. --set runs the set in POPOST_VIDEO_DATA; the held-out set prints means only',
  {
    positionals: [{ name: 'video', variadic: true, required: false, help: 'videos to run by hand (instead of --set)' }],
    options: [
      { flag: '--set', choices: ['dev', 'heldout'], help: 'the development or the held-out cases of the set in POPOST_VIDEO_DATA (cases.json and split.json)' },
      NOTE,
      FOOTAGE,
      { flag: '--data', help: 'what the videos given by hand are, for the ledger (never their file names); default "ad hoc"' },
    ],
  },
  looping(async (args, rt) => {
    const repo = await checkout(rt);
    const started = Date.now();
    const set = args.string('set') as 'dev' | 'heldout' | undefined;
    const dataDir = rt.env.POPOST_VIDEO_DATA?.trim();
    if (set && !dataDir) throw new VideoCommandError('--set needs POPOST_VIDEO_DATA, the directory of the evaluation set (with cases.json and split.json).');
    const footage = args.string('footage') === 'video' ? 'video' : 'still';
    const where = rt.path.join(workDir(rt), footage === 'video' ? 'floor-footage' : 'floor');
    const targets = set && dataDir
      ? (await loadSet(rt, rt.path.resolve(rt.cwd, dataDir), set)).map((c) => ({ label: 'case ' + c.id + ' (' + c.type + ')', video: c.video, dir: rt.path.join(where, set, c.id) }))
      : args.list('video').map((typed, i) => ({ label: typed, video: userPath(rt, typed), dir: rt.path.join(where, 'adhoc', String(i + 1).padStart(2, '0')) }));
    if (!targets.length) throw new VideoCommandError('Give the videos (popost video eval floor <video> [<video> ...]) or a set (--set dev|heldout).');
    const heldout = set === 'heldout';
    const results = [];
    const cases: Record<string, unknown>[] = [];
    let failed = 0;
    for (const t of targets) {
      // One case that cannot be drafted or rendered must not hide the others: it is counted and the run goes on.
      const r = await runFloor(rt, { video: t.video, workDir: t.dir, footage }).catch((e: unknown) => {
        failed++;
        // A held-out case is not named, nor is what went wrong with it (a message may carry its file name).
        if (!heldout) cases.push({ label: t.label, failed: (e instanceof Error ? e.message : String(e)).split('\n').slice(0, 3).join(' | ') });
        return undefined;
      });
      if (heldout) rt.stderr('held-out case done (' + (results.length + failed) + '/' + targets.length + ')\n');
      if (!r) continue;
      if (!heldout) cases.push({ label: t.label, work: t.dir, composite: r.score.composite, score: formatScore(r.score).split('\n'), notes: r.notes.length, seconds: Object.fromEntries(Object.entries(r.seconds).map(([k, v]) => [k, Number(v.toFixed(1))])) });
      results.push(r);
    }
    const scores = meanScores(results);
    // Only the count and the scores go to the ledger: file names of a private data set stay out of git.
    await appendLedger(rt, repo.ledger, {
      at: rt.now().toISOString(), kind: 'floor', hypothesis: args.string('note') ?? 'baseline', commit: await commit(rt, repo.root),
      data: (set ? 'real set, ' + set : (args.string('data') ?? 'ad hoc')) + (footage === 'video' ? ', footage kept' : ''), cases: results.length, scores, detail: { failed },
      seconds: Math.round((Date.now() - started) / 1000), decision: (args.string('note') ?? 'baseline') === 'baseline' ? 'baseline' : 'open',
    });
    printJson(rt, { ok: failed === 0, ...(set ? { set } : {}), cases: results.length, failed, means: scores, ledger: repo.ledger, ...(heldout ? {} : { work: where, results: cases }) });
    return failed ? 2 : 0;
  }),
);

const decide = command(
  'records in the ledger what was decided about the runs before it, and why (a line is never edited, so a decision is a line of its own)',
  { positionals: [{ name: 'decision', choices: ['accepted', 'rejected'] }, { name: 'why', variadic: true, required: false, help: 'the numbers that decided it' }] },
  looping(async (args, rt) => {
    const repo = await checkout(rt);
    const decision = args.req('decision');
    const why = args.list('why').join(' ').trim();
    if (!why) throw new VideoCommandError('Say why: popost video eval decide ' + decision + ' "<the numbers that decided it>"');
    const row: LedgerRow = { at: rt.now().toISOString(), kind: 'decision', hypothesis: why, commit: await commit(rt, repo.root), data: '', cases: 0, scores: {}, detail: {}, seconds: 0, decision };
    await appendLedger(rt, repo.ledger, row);
    printJson(rt, { ok: true, ledger: repo.ledger, row });
  }),
);

export const evalCommands: Commands = { roundtrip, floor, decide };
