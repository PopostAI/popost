/**
 * `popost video speech-check`: whether the speaking clips of a project said their lines (sound/speech-check.ts). Each
 * clip with a script (its speech receipt) is transcribed once, by the user's own transcriber or popost.ai's; popost.ai's
 * is priced first and paid only with --confirm --max-credits N, as describe pays it. The measured word times go into
 * the receipt: the mix and the captions follow them. A clip that says less than the floor of its script is an error
 * that offers a remake, which is never made here.
 */
import { printJson } from '../../core/util';
import type { Runtime } from '../../runtime';
import { transcriptionPrice } from '../speech/hosted';
import { commandTranscriber, NO_TRANSCRIBER, TRANSCRIBER_HINT, transcriberKind } from '../speech/index';
import { keptMeasurement, MATCH_FLOOR, measureClipSpeech, silentClipProblems, speakingClips, speechMatchProblems, type MeasuredSpeech } from '../sound/speech-check';
import type { Problem } from '../types';
import type { PriceItem } from '../wallet';
import { CREDIT_OPTIONS, walletFor } from './credits';
import { command, userPath, VideoCommandError } from './shared';

/** A clip of the project as a project path; a path outside it is refused. */
const inProject = (rt: Runtime, dir: string, given: string): string => {
  const rel = rt.path.relative(dir, userPath(rt, given)).split(rt.path.sep).join('/');
  if (!rel || rel.startsWith('..') || rt.path.isAbsolute(rel)) throw new VideoCommandError('--clip names a clip of the project; ' + given + ' is not in ' + dir + '.');
  return rel;
};

/** What a clip's line of the report says: its share of the script and what was missing or extra. */
const entry = (file: string, m: MeasuredSpeech, kept: boolean) => ({
  file, share: m.match.share, matched: m.match.matched, script: m.match.script, heard: m.match.heard,
  ...(m.match.missing.length ? { missing: m.match.missing } : {}), ...(m.match.extra.length ? { extra: m.match.extra } : {}),
  spans: m.spans, ...(m.lines ? { lines: m.lines } : {}), ...(m.silent ? { silent: true } : {}), ...(kept ? { kept: true } : {}),
});

export const speechCheck = command(
  'transcribe the speaking clips of a project (each clip whose speech receipt has a script) and hold what each says against its lines: under ' + Math.round(MATCH_FLOOR * 100) + '% of the words is an error with a remake to offer (never made here). The measured times go into the receipts, which the mix and the captions follow. popost.ai\'s transcriber is priced first (exit code 3) and paid with --confirm --max-credits N; a clip heard before is not heard, or paid for, again',
  {
    positionals: [{ name: 'project', help: 'the project directory' }],
    options: [
      { flag: '--clip', kind: 'append', metavar: 'FILE', help: 'only this clip (repeat it); default every speaking clip under assets/' },
      ...CREDIT_OPTIONS,
    ],
  },
  async (args, rt) => {
    const dir = userPath(rt, args.req('project'));
    const listed = args.list('clip').map((c) => inProject(rt, dir, c));
    const files = listed.length ? listed : await speakingClips(rt, dir);
    if (!files.length) {
      printJson(rt, { ok: true, project: dir, clips: [], chargedCredits: 0, note: 'No clip of the project has a script to say (a speech receipt beside it, written when materials makes a clip with "speech").' });
      return 0;
    }
    const kept = new Map<string, MeasuredSpeech>();
    for (const f of files) { const m = await keptMeasurement(rt, dir, f).catch(() => undefined); if (m) kept.set(f, m); }
    const todo = files.filter((f) => !kept.has(f));
    const kind = transcriberKind(rt);
    if (todo.length && !kind) throw new VideoCommandError('Nothing can hear the clips: ' + NO_TRANSCRIBER + '. To check what they say, ' + TRANSCRIBER_HINT + '.');
    const items: PriceItem[] = kind === 'hosted' ? (await Promise.all(todo.map((f) => transcriptionPrice(rt, rt.path.resolve(dir, f), 'the speech of ' + f)))).flat() : [];
    const wallet = todo.length && kind === 'hosted' ? await walletFor(rt, args, items) : undefined;
    const transcriber = todo.length ? commandTranscriber(rt, wallet) : undefined;
    const clips: ReturnType<typeof entry>[] = [], problems: Problem[] = [];
    for (const f of files) {
      const m = kept.get(f) ?? await measureClipSpeech(rt, dir, f, transcriber);
      if (!m) { problems.push({ level: 'warning', at: f, message: f + ' has no script to say (no speech receipt with its text).', fix: 'Leave it out: only a clip made with "speech" is checked.' }); continue; }
      clips.push(entry(f, m, kept.has(f)));
      problems.push(...(m.silent ? silentClipProblems(f) : speechMatchProblems(f, m.match)));
    }
    const errors = problems.filter((p) => p.level === 'error').length;
    printJson(rt, {
      ok: errors === 0, project: dir, clips, chargedCredits: wallet?.spent ?? 0, problems,
      next: errors ? 'Show the user what each failed clip did not say and the price of making it again; nothing is made again without their yes.' : 'The mix and the captions now follow what the clips really say: build or fill again.',
    });
    return errors ? 2 : 0;
  },
  (args) => args.string('project'),
);
