/**
 * `popost video template`: a described reference becomes a template (save), what its shots show is read by a model
 * (see), and a fill is shown its limits (show), checked (check), built into a project (fill) or tried with several
 * fills (test). Each prints one JSON document; a fill with errors prints its problems with exit code 2, each with its
 * place and one fix, and `repair`, the same text the plan step sends back to a model.
 */
import type { OptionSpec, PositionalSpec } from '../../args';
import { printJson } from '../../core/util';
import type { Runtime } from '../../runtime';
import { readUserJson } from '../../workflow/io';
import { INSET_FILE, type Inset } from '../describe/inset';
import { budgetProblems, paceBudgets } from '../plan/ask';
import { repairMessage } from '../plan/prompt';
import { seeShots } from '../plan/see';
import type { RetargetPlan } from '../retarget/index';
import { VOICE_FILE, WORDS_FILE } from '../retarget/speak';
import type { Transcript } from '../speech/types';
import { checkFill } from '../template/check';
import { captionSizeProblems } from '../template/project';
import { notSaidBy, projectReadingProblems, projectSceneSources, readingOfTemplate } from '../elements/findings';
import { FACTS_FILE } from '../template/facts';
import { fillPackage, STRUCTURE_FILE } from '../template/fill';
import { loadTemplate, saveTemplate } from '../template/save';
import { splitLongShots } from '../template/split';
import { startsOf } from '../template/structure';
import { generatedFills, swapTest, type SwapFill } from '../template/swap';
import { FILES, SHOTS_FILE, type TemplatePackage } from '../template/types';
import type { TextTrack } from '../text/types';
import type { Measure, Problem, Project } from '../types';
import { workDir } from '../work';
import { configuredModel } from './make';
import { readingIn } from './elements';
import { ELEMENTS_FILE } from '../elements/types';
import { FIT_TEMPO, fitTempoOf, looping } from './loop-shared';
import { command, userPath, VideoCommandError, type Commands } from './shared';
const TEMPLATE: PositionalSpec = { name: 'template-dir', help: 'a directory written by template save' };
const FILL: OptionSpec = { flag: '--fill', required: true, metavar: 'FILE', help: 'the fill: {"shots": [...], "captions": [...]}, matched by position' };
const ASSETS: OptionSpec = { flag: '--assets', metavar: 'DIR', help: 'where the fill\'s files are (its paths are relative to it)' };
const PACE: OptionSpec = { flag: '--pace', kind: 'number', help: 'characters a second of the voice that will speak the lines: a line over its beat\'s budget is an error, as in plan' };

const errorsIn = (problems: readonly Problem[]): Problem[] => problems.filter((p) => p.level === 'error');

/** A file of a described reference, or undefined when it is not there. */
const optionalJson = <T>(rt: Runtime, file: string): Promise<T | undefined> => rt.fs.readText(file).then((t) => JSON.parse(t) as T, () => undefined);

const readFill = async (rt: Runtime, typed: string): Promise<RetargetPlan> => {
  const fill = await readUserJson(rt, typed).catch((e: unknown) => {
    if (e instanceof SyntaxError) throw new VideoCommandError('The fill ' + typed + ' is not valid JSON (' + e.message + ').');
    throw e;
  });
  return fill as RetargetPlan;
};

/** The problems of a fill as the plan step's repair loop reports them, and the budgets it was held to. */
const fillProblems = async (rt: Runtime, pkg: TemplatePackage, fill: RetargetPlan, dir: string | undefined, pace: number | undefined, tempo?: number): Promise<Problem[]> => {
  const checked = await checkFill(rt, pkg, fill, dir === undefined ? {} : { dir });
  // The budgets are read only of a fill whose captions are a list of strings, which checkFill has made sure of.
  return errorsIn(checked).length ? checked : [...checked, ...budgetProblems(pkg, fill, paceBudgets(pkg, pace, tempo))];
};

/** What a fill with errors prints: its problems, and the text a model would be sent to correct them. */
const refused = (rt: Runtime, error: string, problems: Problem[]): number => {
  const errors = errorsIn(problems);
  printJson(rt, { ok: false, error, errors: errors.length, problems, repair: repairMessage(errors) });
  return 2;
};

/** What template save says of the reading it carried: the shots with an effect of its own, and those dropped whole. */
const readingEntry = (pkg: TemplatePackage): Record<string, unknown> => {
  const custom = pkg.template.shots.flatMap((s, k) => (s.effect ? ['shots[' + k + ']'] : []));
  return {
    shots: pkg.template.shots.filter((s) => s.elements).length,
    ...(custom.length ? { custom } : {}),
    ...(pkg.template.dropped?.length ? { dropped: pkg.template.dropped.map((d) => d.shot), closing: 'shots[' + (pkg.template.shots.length - 1) + ']' } : {}),
  };
};

const save = command(
  'a template from what describe wrote: template.json (the structure), slots.json (what may change, within which limits) and TEMPLATE.md (one screen)',
  {
    positionals: [{ name: 'reference-dir', help: 'what popost video describe wrote (measure.json, and text.json and transcript.json when they were read)' }],
    options: [
      { flag: '--out', required: true, metavar: 'DIR', help: 'the template directory to write' },
      { flag: '--name', required: true, help: 'the template\'s name' },
      { flag: '--label', help: 'where it came from, for people (never a file name of a private data set); default: the name' },
      { flag: '--max-shot', kind: 'number', help: 'cut a longer shot into equal parts of at most this many seconds (for clips a generator makes)' },
    ],
  },
  looping(async (args, rt) => {
    const ref = userPath(rt, args.req('reference-dir'));
    const out = userPath(rt, args.req('out'));
    const read = await optionalJson<Measure>(rt, rt.path.join(ref, 'measure.json'));
    if (!read) throw new VideoCommandError('No measure.json in ' + ref + '. Run: popost video describe <video> --out ' + ref);
    const maxShot = args.number('max-shot') ?? 0;
    const split = maxShot > 0 ? splitLongShots(read, maxShot) : { measure: read, added: 0 };
    const text = await optionalJson<TextTrack>(rt, rt.path.join(ref, 'text.json'));
    const transcript = await optionalJson<Transcript>(rt, rt.path.join(ref, 'transcript.json'));
    const inset = await optionalJson<Inset>(rt, rt.path.join(ref, INSET_FILE));
    const label = args.string('label');
    // The reading of the frames, when it was written: held to the measurement first, and refused with its errors.
    const reading = await readingIn(rt, ref, read, text);
    const wrong = reading?.problems.filter((p) => p.level === 'error') ?? [];
    if (wrong.length) {
      printJson(rt, { ok: false, error: ELEMENTS_FILE + ' in ' + ref + ' has ' + wrong.length + ' error(s); nothing was written. Correct them (popost video elements check ' + args.req('reference-dir') + ') and save again.', errors: wrong.length, problems: wrong });
      return 2;
    }
    const r = await saveTemplate(rt, {
      measure: split.measure, ...(text ? { text } : {}), ...(transcript ? { transcript } : {}), ...(inset ? { inset } : {}), name: args.req('name'), ...(label ? { label } : {}), outDir: out,
      ...(reading ? { reading: { elements: reading.elements, dir: ref, measure: read } } : {}),
    });
    const pkg = await loadTemplate(rt, out);
    const cap = pkg.slots.captions?.capacity;
    const errors = errorsIn(r.problems).length;
    printJson(rt, {
      ok: errors === 0, dir: out, files: [FILES.template, FILES.slots, FILES.card],
      shots: pkg.template.shots.length, beats: pkg.template.captions?.beats.length ?? 0, frames: pkg.template.frames, fps: pkg.template.canvas.fps,
      ...(split.added ? { cutsAdded: split.added, maxShot } : {}),
      ...(cap ? { lineHolds: { cjk: cap.cjk, latin: cap.latin, lines: cap.lines, measured: cap.measured } } : {}),
      ...(reading ? { reading: readingEntry(pkg) } : { note: 'There is no ' + ELEMENTS_FILE + ' in ' + ref + ', so the template does not say what each shot holds. Open the pictures, write it (popost video elements questions ' + args.req('reference-dir') + ') and save again.' }),
      errors, problems: r.problems, next: 'popost video template show ' + out,
    });
    return errors ? 2 : 0;
  }),
);

const see = command(
  'what each shot of the reference shows, one sentence each, read from its frames by the model POPOST_LLM_* names (it must read pictures); written to <template-dir>/shots.txt, which plan gives to the model that writes the fill. An agent that looks itself uses popost video look',
  { positionals: [TEMPLATE], options: [{ flag: '--video', required: true, help: 'the reference video the template was saved from' }] },
  looping(async (args, rt) => {
    const dir = userPath(rt, args.req('template-dir'));
    const model = configuredModel(rt);
    const { template: t } = await loadTemplate(rt, dir);
    const starts = startsOf(t);
    const shots = t.shots.map((s, k) => ({ start: (starts[k] ?? 0) / t.canvas.fps, end: ((starts[k] ?? 0) + s.frames) / t.canvas.fps }));
    const r = await seeShots(rt, { video: userPath(rt, args.req('video')), shots, model });
    const file = rt.path.join(dir, SHOTS_FILE);
    await rt.fs.writeFile(file, r.notes.join('\n') + '\n');
    const errors = errorsIn(r.problems).length;
    printJson(rt, {
      ok: errors === 0, model: model.name, file, shots: shots.length, read: r.notes.filter(Boolean).length,
      notes: r.notes.map((note, k) => ({ at: 'shots[' + k + ']', note })), requests: r.requests, inputTokens: r.usage.input, outputTokens: r.usage.output,
      errors, problems: r.problems,
    });
    return errors ? 2 : 0;
  }),
);

const show = command(
  'TEMPLATE.md and the slots with their limits: everything needed to write a fill',
  { positionals: [TEMPLATE] },
  looping(async (args, rt) => {
    const dir = userPath(rt, args.req('template-dir'));
    const { template: t, slots } = await loadTemplate(rt, dir);
    const shotsFile = rt.path.join(dir, SHOTS_FILE);
    const notes = await rt.fs.readText(shotsFile).then((x) => x.split('\n').map((l) => l.trim()), () => undefined);
    // The reading of the frames per shot, as template.json keeps it, a picture's path from the working directory.
    const read = t.shots.flatMap((s, k) => (s.elements || s.effect ? [{
      at: 'shots[' + k + ']', ...s.elements,
      ...(s.effect ? { effect: { ...s.effect, ...(s.effect.picture ? { picture: rt.path.relative(rt.cwd, rt.path.resolve(dir, s.effect.picture)) } : {}) } } : {}),
    }] : []));
    printJson(rt, {
      ok: true, dir, name: t.name, source: t.source, canvas: t.canvas, frames: t.frames, seconds: Number((t.frames / t.canvas.fps).toFixed(2)),
      card: await rt.fs.readText(rt.path.join(dir, FILES.card)), slots,
      ...(notes ? { shotNotes: slots.shots.map((s, k) => ({ at: s.at, note: notes[k] ?? '' })) } : {}),
      ...(read.length ? { shotElements: read } : {}), ...(t.dropped?.length ? { dropped: t.dropped } : {}),
      next: 'write fill.json, then: popost video template check ' + dir + ' --fill fill.json (template fill looks at its files once they are in the project)',
    });
  }),
);

const check = command(
  'the problems of a fill, each with its place, its limit and one fix; files are looked at only with --assets, and when that directory holds a video.json (the project), its captions are held to the template\'s size',
  { positionals: [TEMPLATE], options: [FILL, ASSETS, PACE, { ...FIT_TEMPO, help: 'with --pace: the most a line will be sped up to fit its beat (template fill --fit-tempo); every budget grows by it' }] },
  looping(async (args, rt) => {
    const pkg = await loadTemplate(rt, userPath(rt, args.req('template-dir')));
    const assets = args.string('assets');
    const dir = assets === undefined ? undefined : userPath(rt, assets);
    // A project (after template fill and hand edits): what video.json changed against the template's measurements.
    const projectFile = dir === undefined ? undefined : rt.path.join(dir, 'video.json');
    // One that is not JSON is left to popost video check, which says what is wrong with it.
    const project = projectFile === undefined ? undefined : await optionalJson<Project>(rt, projectFile).catch(() => undefined);
    // The project against the template's reading of the frames: an effect drawn by a preset, the layout changed, the platform's words.
    const reading = project && dir !== undefined ? projectReadingProblems(readingOfTemplate(pkg, (p) => rt.path.relative(rt.cwd, rt.path.resolve(pkg.dir ?? '', p))), project, await projectSceneSources(rt, dir, project)) : [];
    const fromFill = await fillProblems(rt, pkg, await readFill(rt, args.req('fill')), dir, args.number('pace'), fitTempoOf(args));
    // A project warning that says what the fill's warning already says, in the same or other words, is left out (the fill's place is kept).
    const problems = [...fromFill, ...(project ? captionSizeProblems(pkg, project) : []), ...notSaidBy(fromFill, reading)];
    const errors = errorsIn(problems);
    if (errors.length) return refused(rt, 'The fill has ' + errors.length + ' error(s). Correct them and check it again.', problems);
    printJson(rt, { ok: true, errors: 0, problems, filesChecked: assets !== undefined, ...(project ? { projectChecked: projectFile } : {}), ...(assets === undefined ? { note: 'The files were not looked at: give --assets <dir>.' } : {}) });
  }),
);

const fill = command(
  'the project of a fill: video.json, reference.measure.json and reference.facts.json (what the checks compare the project with) in --out, the voice too with --speak. Files the fill names are read from --assets (and copied in) or, without it, from --out itself, so it can run again and again in a project you are building up without changing the files you put there',
  {
    positionals: [TEMPLATE],
    options: [
      FILL,
      { flag: '--out', required: true, metavar: 'DIR', help: 'the project directory' },
      ASSETS,
      { flag: '--speak', kind: 'flag', help: 'speak the captions (POPOST_TTS_CMD) and re-flow every beat to its spoken line' },
      { flag: '--keep-length', kind: 'flag', help: 'with --speak: a beat keeps its reference length when its line is shorter' },
      FIT_TEMPO,
      PACE,
    ],
  },
  looping(async (args, rt) => {
    const pkg = await loadTemplate(rt, userPath(rt, args.req('template-dir')));
    const plan = await readFill(rt, args.req('fill'));
    const outDir = userPath(rt, args.req('out'));
    const assets = args.string('assets');
    const assetsDir = assets === undefined ? undefined : userPath(rt, assets);
    const speak = args.flag('speak');
    const fitTempo = fitTempoOf(args);
    if (fitTempo && !speak) throw new VideoCommandError('--fit-tempo changes the tempo of the spoken lines: give --speak too.');
    const before = await fillProblems(rt, pkg, plan, assetsDir ?? outDir, args.number('pace'), fitTempo);
    if (errorsIn(before).length) return refused(rt, 'The fill has ' + errorsIn(before).length + ' error(s); nothing was written. Correct them and run it again.', before);
    const r = await fillPackage(rt, pkg, { fill: plan, outDir, speak, ...(args.flag('keep-length') ? { hold: true } : {}), ...(fitTempo ? { fitTempo } : {}), ...(assetsDir ? { assetsDir } : {}) });
    if (!r.project) return refused(rt, 'The fill has ' + errorsIn(r.problems).length + ' error(s); nothing was written. Correct them and run it again.', r.problems);
    const written = ['video.json', STRUCTURE_FILE, FACTS_FILE, ...(r.spoken ? [VOICE_FILE, WORDS_FILE, 'assets/voice/'] : [])];
    printJson(rt, {
      ok: true, dir: outDir, project: rt.path.join(outDir, 'video.json'), written,
      segments: r.project.segments.length, tracks: r.project.tracks.length, frames: r.project.segments.reduce((n, s) => n + (s.frames ?? 0), 0),
      ...(r.spoken ? { spoken: r.spoken } : {}), problems: r.problems, notes: r.notes,
      next: 'popost video check ' + outDir + ' --layout',
    });
  }),
);

const test = command(
  'swap tests: the template filled several ways (generated fills of colours and lines of three lengths without --fills), each checked, rendered small, measured and scored against the template\'s structure; writes evidence.json',
  {
    positionals: [TEMPLATE],
    options: [
      { flag: '--fills', metavar: 'FILE', help: 'a JSON list of { "name", "fill", "assetsDir"? }' },
      { flag: '--work', metavar: 'DIR', help: 'where each fill\'s project and render go (default: template-test/<name> in the work directory)' },
      { flag: '--scale', kind: 'number', help: 'render scale (default: the longer side about 320 pixels)' },
    ],
  },
  looping(async (args, rt) => {
    const dir = userPath(rt, args.req('template-dir'));
    const pkg = await loadTemplate(rt, dir);
    const fillsFile = args.string('fills');
    const fills = fillsFile ? ((await readUserJson(rt, fillsFile)) as SwapFill[]) : generatedFills(pkg);
    if (!Array.isArray(fills)) throw new VideoCommandError('The fills ' + fillsFile + ' are not a list: write a JSON list of { "name", "fill", "assetsDir"? }.');
    const given = args.string('work');
    const work = given ? userPath(rt, given) : rt.path.join(workDir(rt), 'template-test', pkg.template.name.replace(/[^\w.-]+/g, '-'));
    const scale = args.number('scale');
    const e = await swapTest(rt, {
      templateDir: dir, fills, workDir: work,
      ...(scale === undefined ? {} : { scale }),
      // A fill takes a while: a person watching sees which one, on stderr; stdout keeps the one JSON document.
      onFill: (name, done, total) => rt.stderr('fill ' + name + ' (' + done + '/' + total + ')\n'),
    });
    printJson(rt, {
      ok: true, evidence: rt.path.join(dir, FILES.evidence), work,
      passed: e.fills.filter((f) => f.passed).length, fills: e.fills.length, seconds: e.seconds, best: e.best, margin: e.margin,
      results: e.fills.map((f) => ({ name: f.name, passed: f.passed, stage: f.stage, ...(f.scores ? { structure: f.scores.structure, transitions: f.scores.transitions } : {}), seconds: f.seconds, reason: f.reason })),
    });
  }),
);

export const templateCommands: Commands = { save, see, show, check, fill, test };

