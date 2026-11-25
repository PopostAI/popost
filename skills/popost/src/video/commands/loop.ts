/**
 * `popost video` commands that turn a reference into a new video: plan (a fill for a template, by a model or by the
 * agent itself with --dry), materials (clips and pictures from prompts), retarget (a plan on a described reference),
 * readback (a render read back against its project), look (pictures to open), and the groups template and eval. Each
 * prints one JSON document; problems a caller can fix come back with exit code 2.
 */
import type { PositionalSpec } from '../../args';
import { isFile, printJson } from '../../core/util';
import type { Runtime } from '../../runtime';
import { readUserJson, readUserText } from '../../workflow/io';
import { buildPage } from '../compile/index';
import { readback } from '../eval/readback';
import { runReadback } from '../eval/readback-run';
import { contrastByShot } from '../eval/contrast';
import { errorText } from '../../core/error-text';
import { scrub } from '../../providers/secrets';
import { characterAnchor } from '../generate/character';
import { checkRequests, commandGenerator, groupingAdvice, makeMaterials, NOTES, type AnchorPicture, type MaterialRequest } from '../generate/index';
import { platform } from './generate';
import { lookAt, secondMoments, shotMoments, type LookMoment } from '../look/index';
import { sheetsLike } from '../look/like';
import { probe } from '../media/ffmpeg';
import { measureVideo } from '../measure/index';
import { askFill, DEFAULT_ATTEMPTS, paceBudgets } from '../plan/ask';
import { listMaterials } from '../plan/materials';
import { envModel, type Model } from '../plan/model';
import { planMessages, planRules } from '../plan/prompt';
import { pictureUrl } from '../scene/pictures';
import { roughTokens } from '../describe/index';
import { reflowMeasure, retarget, type RetargetPlan } from '../retarget/index';
import { speakRetarget, VOICE_FILE, WORDS_FILE } from '../retarget/speak';
import { commandTranscriber } from '../speech/index';
import type { Transcript } from '../speech/types';
import { jsonText, loadTemplate } from '../template/save';
import { FILES, SHOTS_FILE } from '../template/types';
import { commandTextReader } from '../text/index';
import type { TextTrack } from '../text/types';
import type { Measure, Problem } from '../types';
import { commandSpeaker } from '../voice/index';
import { BUDGET_SLACK, measureVoicePace, scriptOfLanguage } from '../voice/pace';
import { workDir } from '../work';
import { evalCommands } from './eval';
import { FIT_TEMPO, fitTempoOf, looping } from './loop-shared';
import { briefOf } from './make';
import { command, userPath, VideoCommandError, type Commands } from './shared';
import { templateCommands } from './template';

const TEMPLATE: PositionalSpec = { name: 'template-dir', help: 'a directory written by template save' };
const TTS_HINT = 'set POPOST_TTS_CMD to a tool of yours (skills/popost/tools/video/ has examples)';
const OCR_HINT = 'set POPOST_OCR_CMD (skills/popost/tools/video/ocr-rapidocr/ocr.py explains one way)';

const errorsIn = (problems: readonly Problem[]): number => problems.filter((p) => p.level === 'error').length;
const optionalJson = <T>(rt: Runtime, file: string): Promise<T | undefined> => rt.fs.readText(file).then((t) => JSON.parse(t) as T, () => undefined);

/** What a shot of a fill can be, for whoever writes one by hand. */
const shotForms = (generate: boolean): Record<string, unknown> => ({
  footage: { footage: 'assets/clip.mp4', in: 0, speed: 1, fit: 'cover' },
  picture: { picture: 'assets/picture.webp', zoom: 0.04, fit: 'cover' },
  color: { color: '#101014' },
  card: { card: { title: 'a few words', lines: ['a line'] } },
  scene: { scene: 'scenes/shot-01.html', slots: { title: 'new words' }, note: 'an HTML page in the project that draws the whole shot (references/video-scenes.md); every shot takes one' },
  ...(generate ? { generate: { generate: 'what the clip shows, in English', note: 'the clip is made from these words (materials); with --product, @image1 is the product' } } : {}),
});

const planModel = (rt: Runtime): Model => {
  let model: Model | undefined;
  try {
    model = envModel(rt);
  } catch (error) {
    throw new VideoCommandError(error instanceof Error ? error.message : String(error));
  }
  if (!model) throw new VideoCommandError('No model is configured. Set POPOST_LLM_URL (an OpenAI-compatible base URL), POPOST_LLM_MODEL and POPOST_LLM_KEY, or use --dry to get everything needed to write the fill yourself.');
  return model;
};

/** The notes on what each shot of the source showed: --shots, else what template see wrote beside the template. */
const shotNotesOf = async (rt: Runtime, dir: string, given: string | undefined): Promise<string[] | undefined> => {
  const beside = rt.path.join(dir, SHOTS_FILE);
  const text = given !== undefined ? await readUserText(rt, given) : (await isFile(rt, beside)) ? await rt.fs.readText(beside) : undefined;
  return text?.split('\n').map((l) => l.trim()).filter(Boolean);
};

/** --voice without --pace: the voice is timed once, and the pace kept in the work directory. */
const voicePace = async (rt: Runtime, o: { voice?: string; speed?: number; pace?: number; language?: string; brief: string }): Promise<{ pace?: number; paceFile?: string }> => {
  if (o.pace !== undefined || !o.voice) return o.pace === undefined ? {} : { pace: o.pace };
  const speaker = commandSpeaker(rt);
  if (!speaker) throw new VideoCommandError('--voice times the voice by speaking a sentence, which needs a speaker: ' + TTS_HINT + ', or give --pace <characters a second>.');
  const paceFile = rt.path.join(workDir(rt), 'voice-pace.json');
  const pace = await measureVoicePace(rt, { speaker, voice: o.voice, ...(o.speed ? { speed: o.speed } : {}), script: scriptOfLanguage(o.language, o.brief), cacheFile: paceFile });
  return { pace, paceFile };
};

const plan = command(
  'a model writes the fill of a template from a brief; the answer is checked with the template\'s rules and sent back with its problems until it passes (POPOST_LLM_*). --dry calls no model and prints everything needed to write the fill yourself: the slots and their limits, the budgets, the rules, the materials and the request',
  {
    positionals: [TEMPLATE],
    options: [
      { flag: '--brief', required: true, help: 'what the new video is about: the text, or a file that holds it' },
      { flag: '--assets', metavar: 'DIR', help: 'the materials: footage and pictures, with a note on each in materials.json' },
      { flag: '--out', default: 'fill.json', metavar: 'FILE', help: 'the fill to write; <fill>.attempts.json and <fill>.requests.json go beside it' },
      { flag: '--attempts', kind: 'int', default: DEFAULT_ATTEMPTS, help: 'answers allowed until the fill passes' },
      { flag: '--language', help: 'the language of the captions, as a word a model understands, such as Chinese (default: the brief\'s)' },
      { flag: '--dry', kind: 'flag', help: 'call no model: print the slots, limits, budgets, rules, materials and the request as JSON' },
      { flag: '--generate', kind: 'flag', help: 'a shot may be {"generate": "what the clip shows"}: the clips to make go to <fill>.requests.json for materials' },
      { flag: '--max-seconds', kind: 'number', default: 5, help: 'the longest clip the generator makes' },
      { flag: '--product', help: 'pictures in --assets sent with every generated clip as @image1, @image2 …, separated by commas' },
      { flag: '--shots', metavar: 'FILE', help: 'one line per shot saying what the source showed (default: shots.txt beside the template)' },
      { flag: '--voice', help: 'the voice that will speak the lines: timed once (POPOST_TTS_CMD), every line gets the most characters it can say in its beat, and the fill names it' },
      { flag: '--speed', kind: 'number', help: 'the speed of that voice (1 is normal)' },
      { flag: '--pace', kind: 'number', help: 'characters a second of the voice, instead of timing it' },
      { ...FIT_TEMPO, help: 'the most a line may be sped up to fit its beat (template fill --fit-tempo, 1.12 is hardly heard): every budget grows by it' },
    ],
  },
  looping(async (args, rt) => {
    const dir = userPath(rt, args.req('template-dir'));
    const brief = await briefOf(rt, args.req('brief'));
    const pkg = await loadTemplate(rt, dir);
    const card = await rt.fs.readText(rt.path.join(dir, FILES.card));
    const assets = args.string('assets');
    const assetsDir = assets === undefined ? undefined : userPath(rt, assets);
    const materials = assetsDir ? await listMaterials(rt, assetsDir) : [];
    const language = args.string('language');
    const product = args.string('product');
    const maxSeconds = args.number('max-seconds') ?? 5;
    const generate = args.flag('generate') ? { minSeconds: Math.min(5, maxSeconds), maxSeconds, ...(product ? { images: product.split(',').map((p) => p.trim()) } : {}) } : undefined;
    const shotNotes = await shotNotesOf(rt, dir, args.string('shots'));
    const voice = args.string('voice');
    const speed = args.number('speed');
    const pace = args.number('pace');
    const timed = await voicePace(rt, { brief, ...(voice ? { voice } : {}), ...(speed ? { speed } : {}), ...(pace === undefined ? {} : { pace }), ...(language ? { language } : {}) });
    const tempo = fitTempoOf(args);
    const budgets = paceBudgets(pkg, timed.pace, tempo);
    const prompt = { card, slots: pkg.slots, brief, materials, ...(language ? { language } : {}), ...(generate ? { generate: { product: product !== undefined } } : {}), ...(shotNotes ? { shotNotes } : {}), ...(budgets ? { budgets: budgets.max } : {}) };
    const fillCommand = 'popost video template fill ' + dir + ' --fill <fill.json> --out <project-dir>' + (assetsDir ? ' --assets ' + assetsDir : '');
    if (args.flag('dry')) {
      // The agent writes this fill itself, and template fill --speak reads the voice from it: the rules say to put it in.
      const own = { ...prompt, ...(voice ? { voice: { name: voice, ...(speed ? { speed } : {}) } } : {}) };
      const messages = planMessages(own);
      const lines = pkg.slots.captions?.lines ?? [];
      printJson(rt, {
        ok: true, dry: true, template: dir, brief, ...(language ? { language } : {}),
        answer: { shots: pkg.slots.shots.length, captions: lines.length, ...(voice ? { voice } : {}), ...(voice && speed ? { speed } : {}) },
        slots: pkg.slots,
        ...(budgets ? { budgets: { pace: budgets.pace, ...(budgets.tempo ? { tempo: budgets.tempo } : {}), slack: BUDGET_SLACK, lines: budgets.max.map((max, i) => ({ at: 'captions[' + i + ']', seconds: lines[i]?.seconds, max })) } } : {}),
        rules: planRules(own), forms: shotForms(generate !== undefined), materials,
        ...(shotNotes ? { shotNotes: shotNotes.map((note, k) => ({ at: 'shots[' + k + ']', note })) } : {}),
        ...(generate ? { generate } : {}), ...(timed.paceFile ? { paceFile: timed.paceFile } : {}),
        messages, tokens: messages.reduce((n, m) => n + roughTokens(m.content), 0),
        next: 'write the fill, then check and build it: ' + fillCommand + (budgets ? ' --pace ' + budgets.pace : '') + (voice ? ' --speak' : '') + (tempo ? ' --fit-tempo ' + tempo : ''),
      });
      return;
    }
    const model = planModel(rt);
    const out = userPath(rt, args.string('out') ?? 'fill.json');
    const stem = out.replace(/\.json$/, '');
    // The model that writes the fill sees the product's pictures too.
    const productPictures = generate?.images && assetsDir ? await Promise.all(generate.images.map((p) => pictureUrl(rt, rt.path.join(assetsDir, p), 512))) : undefined;
    const r = await askFill(rt, {
      pkg, card, brief, model, materials, ...(assetsDir ? { assetsDir } : {}), attempts: args.number('attempts') ?? DEFAULT_ATTEMPTS, ...(language ? { language } : {}),
      ...(generate ? { generate } : {}), ...(shotNotes ? { shotNotes } : {}), ...(budgets ? { budgets } : {}), ...(productPictures ? { productPictures } : {}),
    });
    const attemptsFile = stem + '.attempts.json';
    await rt.fs.writeFile(attemptsFile, jsonText({ model: r.model, first: r.first, passed: r.fill !== undefined, attempts: r.attempts }));
    const attempts = r.attempts.map((t, i) => ({ attempt: i + 1, errors: errorsIn(t.problems), seconds: Number((t.ms / 1000).toFixed(1)), ...(t.usage ? { inputTokens: t.usage.input, outputTokens: t.usage.output } : {}), problems: t.problems }));
    if (!r.fill) {
      printJson(rt, { ok: false, error: 'No fill passed in ' + r.attempts.length + ' attempts (' + r.model + '). What each answer got wrong is in ' + attemptsFile + '.', model: r.model, attemptsFile, attempts });
      return 2;
    }
    // The voice and its speed are the caller's choice, not the model's: they go into the fill as given.
    const fill: RetargetPlan = { ...r.fill, ...(voice ? { voice } : {}), ...(speed ? { speed } : {}) };
    await rt.fs.writeFile(out, jsonText(fill));
    const requestsFile = stem + '.requests.json';
    if (r.requests?.length) await rt.fs.writeFile(requestsFile, jsonText(r.requests));
    printJson(rt, {
      ok: true, model: r.model, fill: out, attemptsFile, first: r.first, attempts, ...(timed.pace ? { pace: timed.pace } : {}), ...(timed.paceFile ? { paceFile: timed.paceFile } : {}),
      ...(r.requests?.length ? { requests: { file: requestsFile, clips: r.requests.length, seconds: r.requests.reduce((n, q) => n + (q.seconds ?? 0), 0), next: 'make them first: popost video materials ' + requestsFile + ' --out ' + (assetsDir ?? '<project-dir>') } } : {}),
      next: fillCommand.replace('<fill.json>', out) + ' --speak' + (tempo ? ' --fit-tempo ' + tempo : ''),
    });
  }),
);

const PICTURE_EXT = ['.png', '.jpg', '.jpeg', '.webp'];

/** --anchor-image: the caller's picture as a path in the project; a file from elsewhere is copied to assets/anchor-image.<ext>. */
const givenAnchor = async (rt: Runtime, dir: string, given: string): Promise<AnchorPicture> => {
  const from = userPath(rt, given);
  const ext = rt.path.extname(from).toLowerCase();
  if (!PICTURE_EXT.includes(ext) || !(await isFile(rt, from))) throw new VideoCommandError('--anchor-image is a PNG, JPEG or WebP picture that exists; "' + given + '" is not. Give the path of the picture every clip should keep to.');
  const inside = rt.path.relative(dir, from);
  if (inside && !inside.startsWith('..') && !rt.path.isAbsolute(inside)) return { file: inside.split(rt.path.sep).join('/') };
  const file = 'assets/anchor-image' + ext;
  await rt.fs.mkdir(rt.path.join(dir, 'assets'));
  await rt.fs.writeFile(rt.path.join(dir, file), await rt.fs.readFile(from));
  return { file };
};

/** --character: a character of the user's popost.ai library, its picture downloaded into the project. A key never reaches the message. */
const characterOf = async (rt: Runtime, dir: string, id: string): Promise<AnchorPicture> => {
  let secrets: string[] = [];
  try {
    const found = await platform(rt);
    secrets = found.secrets;
    return await characterAnchor(rt, found.client, id, dir);
  } catch (error) {
    throw new VideoCommandError('The character ' + id + ' could not be used: ' + scrub(errorText(error), secrets).replace(/\s*\n\s*/g, ' ').trim());
  }
};

const materials = command(
  'makes the clips and pictures a list asks for, from prompts; a file that exists is not made again, and what each shows goes to materials.json for plan. Two or more clips keep what they share the same through one reference picture (the anchor). Needs POPOST_GEN_CMD; --check only reads the list',
  {
    positionals: [{ name: 'requests', help: 'a JSON list of material requests: file, prompt, seconds, aspect, references; visible people list cast role ids from cast.json ([] for no people), and visible speech declares speech {mode,speaker,text,audio?}. New single-appearance people may be defined directly; recurring roles reuse a completed image. Frames/continues cannot be combined with references.' }],
    options: [
      { flag: '--out', required: true, metavar: 'DIR', help: 'the project directory the files go into' },
      { flag: '--check', kind: 'flag', help: 'only say what is wrong with the list; nothing is made' },
      { flag: '--anchor', kind: 'flag', help: 'the default for two or more clips: one of them is made first and a frame of it goes to the others as a reference picture, so that they keep the same person, product and place; given, it is done for a single clip too. A request with "anchor": false stays out' },
      { flag: '--no-anchor', kind: 'flag', help: 'no shared reference picture: every clip is made from its own request alone' },
      { flag: '--anchor-image', metavar: 'FILE', help: 'a picture of yours as the anchor of every clip (the person, the product); no clip is made first' },
      { flag: '--character', metavar: 'ID', help: 'a character of your popost.ai character library as the anchor: its picture is downloaded into the project and every clip keeps that person' },
    ],
  },
  async (args, rt) => {
    const requests = (await readUserJson(rt, args.req('requests'))) as MaterialRequest[];
    const dir = userPath(rt, args.req('out'));
    if (args.flag('check')) {
      const wrong = await checkRequests(rt, requests, dir, {selectedIdentity:!!(args.string('character')||args.string('anchor-image'))});
      // Advice on how the list is cut into calls is a warning: the list can be made as it is.
      printJson(rt, { ok: wrong.length === 0, requests: Array.isArray(requests) ? requests.length : 0, problems: [...wrong, ...groupingAdvice(requests)] });
      return wrong.length ? 2 : 0;
    }
    const [image, character, off] = [args.string('anchor-image'), args.string('character'), args.flag('no-anchor')];
    if ([image !== undefined, character !== undefined, off].filter(Boolean).length > 1) throw new VideoCommandError('Give one of --anchor-image, --character and --no-anchor: a video has one anchor picture, or none.');
    const generator = commandGenerator(rt);
    if (!generator) throw new VideoCommandError('No generator is configured: set POPOST_GEN_CMD to a tool of yours (skills/popost/tools/video/ has examples), or to "popost video generate" (popost.ai, paid in credits), or use --check.');
    const picture = image !== undefined ? await givenAnchor(rt, dir, image) : character !== undefined ? await characterOf(rt, dir, character) : undefined;
    const r = await makeMaterials(rt, {
      requests, dir, generator, ...(off ? { anchor: false } : args.flag('anchor') ? { anchor: true } : {}), ...(picture ? { picture } : {}),
      // A clip takes minutes: a person watching sees which one, on stderr; stdout keeps the one JSON document.
      onStep: (file, done, total) => rt.stderr(file + ' (' + (done + 1) + '/' + total + ')\n'),
    });
    printJson(rt, {
      ok: errorsIn(r.problems) === 0, dir, notes: rt.path.join(dir, NOTES),
      made: r.materials.filter((m) => m.made).length, kept: r.materials.filter((m) => !m.made && !m.error && !m.waiting).length, failed: r.materials.filter((m) => m.error).length,
      ...(r.materials.some((m) => m.waiting) ? { waiting: r.materials.filter((m) => m.waiting).length } : {}),
      credits: r.credits, ...(r.anchor ? { anchor: r.anchor } : {}), ...(r.toConfirm ? { toConfirm: r.toConfirm } : {}), materials: r.materials, problems: [...r.problems, ...groupingAdvice(requests)],
    });
    return errorsIn(r.problems) ? 2 : 0;
  },
);

const retargetCommand = command(
  'a new project on the structure of a described reference. The plan has no times: "shots" (what fills each shot) and "captions" (a line per beat), by position. --speak has the lines spoken (POPOST_TTS_CMD), re-flows the timing to them and writes the words of the voice',
  {
    positionals: [{ name: 'reference-dir', help: 'what popost video describe wrote' }],
    options: [
      { flag: '--plan', required: true, metavar: 'FILE', help: 'the plan: {"shots": [...], "captions": [...]}' },
      { flag: '--out', required: true, metavar: 'DIR', help: 'the project directory to write' },
      { flag: '--speak', kind: 'flag', help: 'speak the captions and re-flow the timing to them' },
      { flag: '--keep-length', kind: 'flag', help: 'with --speak: a beat keeps its reference length when its line is shorter' },
      FIT_TEMPO,
      { flag: '--language', help: 'what the voice speaks, such as zh, for the transcriber that times its words (POPOST_ASR_CMD)' },
    ],
  },
  async (args, rt) => {
    const fitTempo = fitTempoOf(args);
    if (fitTempo && !args.flag('speak')) throw new VideoCommandError('--fit-tempo changes the tempo of the spoken lines: give --speak too.');
    const ref = userPath(rt, args.req('reference-dir'));
    const outDir = userPath(rt, args.req('out'));
    const measure = await optionalJson<Measure>(rt, rt.path.join(ref, 'measure.json'));
    if (!measure) throw new VideoCommandError('No measure.json in ' + ref + '. Run: popost video describe <video> --out ' + ref);
    const text = await optionalJson<TextTrack>(rt, rt.path.join(ref, 'text.json'));
    const transcript = await optionalJson<Transcript>(rt, rt.path.join(ref, 'transcript.json'));
    const planFile = userPath(rt, args.req('plan'));
    const given = await optionalJson<RetargetPlan>(rt, planFile);
    if (!given) throw new VideoCommandError('The plan file ' + planFile + ' could not be read as JSON.');
    const reference = { measure, ...(text ? { text } : {}), ...(transcript ? { transcript } : {}) };
    const first = retarget({ ...reference, plan: given });
    if (!first.project) {
      printJson(rt, { ok: false, error: 'The plan has ' + errorsIn(first.problems) + ' error(s); nothing was written.', problems: first.problems, notes: first.notes });
      return 2;
    }
    await rt.fs.mkdir(outDir);
    const speaker = args.flag('speak') ? commandSpeaker(rt) : undefined;
    if (args.flag('speak') && !speaker) throw new VideoCommandError('--speak needs a speaker: ' + TTS_HINT + '.');
    const transcriber = commandTranscriber(rt);
    const language = args.string('language');
    const spoken = speaker ? await speakRetarget(rt, { input: { ...reference, plan: given }, outDir, speaker, ...(transcriber ? { transcriber } : {}), ...(language ? { language } : {}), ...(args.flag('keep-length') ? { hold: true } : {}), ...(fitTempo ? { fitTempo } : {}) }) : undefined;
    const r = spoken ? spoken.result : first;
    if (!r.project || (spoken && !r.timing)) {
      printJson(rt, { ok: false, error: 'The re-flowed project could not be built.', problems: r.problems, notes: r.notes });
      return 2;
    }
    // The reference on the re-flowed clock, under the name the preview and "compare" look for.
    if (spoken && r.timing) await rt.fs.writeFile(rt.path.join(outDir, 'reference.measure.json'), JSON.stringify(reflowMeasure(measure, r.timing.map, r.timing.total), null, 2) + '\n');
    await rt.fs.writeFile(rt.path.join(outDir, 'video.json'), JSON.stringify(r.project, null, 2) + '\n');
    const fps = r.project.canvas.fps;
    printJson(rt, {
      ok: true, dir: outDir, project: rt.path.join(outDir, 'video.json'),
      written: ['video.json', ...(spoken ? ['reference.measure.json', VOICE_FILE, WORDS_FILE, 'assets/voice/'] : [])],
      segments: r.project.segments.length, tracks: r.project.tracks.length,
      ...(spoken ? { spoken: { lines: spoken.lines.filter((l) => l.file).length, seconds: Number((spoken.lines.reduce((n, l) => n + l.frames, 0) / fps).toFixed(1)) } } : {}),
      problems: r.problems, notes: [...(spoken ? spoken.notes : []), ...r.notes], next: 'popost video check ' + outDir,
    });
  },
);

const readbackCommand = command(
  'reads a render with the text reader (POPOST_OCR_CMD) and the transcriber (POPOST_ASR_CMD, optional) and checks it against its project: is every caption legible, is every spoken line heard, do they line up, is the text of every shot large enough to read on a phone, does every caption stand out from what is behind it. Writes readback.json into the project',
  {
    positionals: [{ name: 'project-dir', help: 'the directory that holds video.json' }, { name: 'render', help: 'the video rendered from it' }],
    options: [{ flag: '--language', help: 'what the speech is in, such as zh (default: the transcriber detects it)' }],
  },
  async (args, rt) => {
    const dir = userPath(rt, args.req('project-dir'));
    const video = userPath(rt, args.req('render'));
    const page = await buildPage(rt, dir);
    if (!page.resolved) {
      printJson(rt, { ok: false, error: 'The project has errors; run popost video check ' + dir + ' first.', problems: page.problems });
      return 2;
    }
    const reader = commandTextReader(rt);
    if (!reader) throw new VideoCommandError('readback needs a text reader: ' + OCR_HINT + '.');
    if (!(await isFile(rt, video))) throw new VideoCommandError('There is no file at ' + video + '. Check the path; a relative one is read from ' + rt.cwd + '.');
    const transcriber = commandTranscriber(rt);
    const language = args.string('language');
    const { text, transcript, contrast, took } = await runReadback(rt, { dir, video, resolved: page.resolved, reader, ...(transcriber ? { transcriber } : {}), ...(language ? { language } : {}), write: (line) => rt.stderr(line + '\n') });
    const planned = await optionalJson<RetargetPlan>(rt, rt.path.join(dir, 'plan.json'));
    const voiced = page.resolved.audio.some((x) => x.id === 'sound');
    const r = readback(page.resolved, text, { contrast, ...(transcript && voiced ? { transcript, spokenTrack: 'captions', ...(planned?.say ? { say: planned.say } : {}) } : {}) });
    const file = rt.path.join(dir, 'readback.json');
    await rt.fs.writeFile(file, JSON.stringify(r, null, 2) + '\n');
    const errors = errorsIn(r.problems);
    printJson(rt, {
      ok: errors === 0, file, texts: r.lines.length, legible: r.legibleShare,
      ...(r.heardShare === undefined ? { speechChecked: false, ...(transcriber ? {} : { why: 'POPOST_ASR_CMD is not set' }) } : { speechChecked: true, heard: r.heardShare, meanLag: r.meanLag ?? 0 }),
      lines: r.lines.map((l) => ({ start: l.start, end: l.end, legible: l.legible, ...(l.heardScore === undefined ? {} : { heard: l.heardScore }), ...(l.lag === undefined ? {} : { lag: l.lag }), text: l.text })),
      textSizes: r.shots.filter((s) => s.lines).map((s) => ({ at: s.at, seconds: s.seconds, lines: s.lines, smallest: s.smallest, median: s.median })),
      captionContrast: contrastByShot(r.contrast),
      errors, problems: r.problems, took,
    });
    return errors ? 2 : 0;
  },
);

/** "1.5,4" -> [1.5, 4]. */
const secondsOf = (text: string): number[] => {
  const list = text.split(',').map((x) => Number(x.trim()));
  if (!list.length || list.some((n) => !Number.isFinite(n) || n < 0)) throw new VideoCommandError('--at takes seconds from 0, separated by commas, for example 1.5,4; got "' + text + '".');
  return list;
};

/** look --shots-like: describe's pictures of a reference made again of this video, to open beside the reference's. */
const lookLike = async (rt: Runtime, video: string, typed: string, out: string): Promise<void> => {
  const like = userPath(rt, typed);
  const m = await optionalJson<Measure>(rt, rt.path.join(like, 'measure.json'));
  if (!m) throw new VideoCommandError('No measure.json in ' + like + '. --shots-like takes what popost video describe wrote for the reference: popost video describe <reference> --out ' + like);
  const r = await sheetsLike(rt, video, m, out);
  printJson(rt, {
    ok: true, video, like, dir: out, scale: r.scale,
    pictures: r.sheets.map((s) => ({ file: s.file, frames: s.frames.length, from: s.seconds[0] ?? 0, to: s.seconds[s.seconds.length - 1] ?? 0 })),
    next: 'Open each beside the reference\'s picture of the same name in ' + like + ' (shots/NN-frames.jpg, transitions/NN.jpg, opening.jpg): the same frames, the same effects?',
    ...(r.notes.length ? { notes: r.notes } : {}),
  });
};

const look = command(
  'pictures of a video to open: three frames of every shot (shot-NN-a/-b/-c.jpg) and a sheet of them side by side (shot-NN.jpg), the shots read from --reference-dir or measured; or the frames at --at seconds (at-NN.jpg). --against puts each beside the other video\'s frame at the same share of its length, labelled A and B. --shots-like <describe dir> makes the pictures describe wrote of the reference (opening.jpg, shots/NN-frames.jpg, transitions/NN.jpg) of this video at the matching moments',
  {
    positionals: [{ name: 'video', help: 'a video file ffmpeg can read' }],
    options: [
      { flag: '--out', required: true, metavar: 'DIR', help: 'the directory to write the pictures into' },
      { flag: '--reference-dir', metavar: 'DIR', help: 'what popost video describe wrote for this video: its shots (default: the video is measured)' },
      { flag: '--at', help: 'seconds to show instead of the shots, separated by commas, for example 1.5,4' },
      { flag: '--against', help: 'another video (a re-creation and its reference): each picture shows both, A the first and B this one' },
      { flag: '--against-at', help: 'with --against and --at: the other video\'s seconds to show beside them, one for each of --at (default: the same share of its length); compare prints them' },
      { flag: '--width', kind: 'int', default: 480, help: 'width of one frame in pixels' },
      { flag: '--shots-like', metavar: 'DIR', help: 'what popost video describe wrote for the reference: writes its pictures (opening.jpg, shots/NN-frames.jpg, transitions/NN.jpg) of this video, a render of it, at the same share of its length, to open beside the reference\'s; frames as wide as the reference\'s' },
    ],
  },
  async (args, rt) => {
    const video = userPath(rt, args.req('video'));
    if (!(await isFile(rt, video))) throw new VideoCommandError('There is no file at ' + video + '. Check the path; a relative one is read from ' + rt.cwd + '.');
    const like = args.string('shots-like');
    if (like !== undefined) {
      if (['at', 'against', 'against-at', 'reference-dir'].some((o) => args.string(o) !== undefined)) throw new VideoCommandError('--shots-like makes the pictures of a describe directory; it takes no --at, --against, --against-at or --reference-dir.');
      await lookLike(rt, video, like, userPath(rt, args.req('out')));
      return;
    }
    const againstTyped = args.string('against');
    const against = againstTyped === undefined ? undefined : userPath(rt, againstTyped);
    if (against !== undefined && !(await isFile(rt, against))) throw new VideoCommandError('There is no file at ' + against + ' (--against).');
    const width = args.number('width') ?? 480;
    if (width < 16) throw new VideoCommandError('--width is the width of one frame in pixels, at least 16; got ' + width + '.');
    const at = args.string('at');
    const againstAt = args.string('against-at');
    if (againstAt !== undefined && (against === undefined || at === undefined)) throw new VideoCommandError('--against-at goes with --against and --at: one second of the other video for each of --at.');
    const refTyped = args.string('reference-dir');
    const p = await probe(rt, video);
    const notes: string[] = [];
    let moments: LookMoment[];
    let shotsFrom: string;
    if (at !== undefined) {
      moments = secondMoments(secondsOf(at), p.fps, p.frames);
      shotsFrom = '--at';
      if (againstAt !== undefined && against !== undefined) {
        const theirs = secondsOf(againstAt);
        if (theirs.length !== moments.length) throw new VideoCommandError('--against-at has ' + theirs.length + ' second(s) and --at ' + moments.length + ': give one for each.');
        const fps = (await probe(rt, against)).fps;
        moments = moments.map((m, i) => ({ ...m, against: Math.round((theirs[i] ?? 0) * fps) }));
      }
    } else if (refTyped !== undefined) {
      const ref = userPath(rt, refTyped);
      const m = await optionalJson<Measure>(rt, rt.path.join(ref, 'measure.json'));
      if (!m) throw new VideoCommandError('No measure.json in ' + ref + '. Run: popost video describe <video> --out ' + ref);
      // The shots are in frames of the described video; they are placed by their time in this one.
      const ratio = p.fps / m.source.fps;
      if (Math.abs(m.source.frames * ratio - p.frames) > 1) notes.push('The reference directory describes a video of ' + m.source.frames + ' frames at ' + m.source.fps + ' fps; this one has ' + p.frames + ' at ' + p.fps + '. Is it the same video?');
      moments = shotMoments(m.shots.map((s) => ({ start: Math.round(s.start * ratio), end: Math.round(s.end * ratio) })));
      shotsFrom = rt.path.join(ref, 'measure.json');
    } else {
      moments = shotMoments((await measureVideo(rt, video)).shots);
      shotsFrom = 'measured';
    }
    const dir = userPath(rt, args.req('out'));
    const r = await lookAt(rt, { video, outDir: dir, moments, width, ...(against ? { against } : {}) });
    printJson(rt, {
      ok: true, video, ...(against ? { against, sides: { A: video, B: against } } : {}), dir, width, shotsFrom,
      pictures: r.pictures, sheets: r.sheets, ...(notes.length ? { notes } : {}),
    });
  },
);

export const loopCommands: Commands = { plan, materials, retarget: retargetCommand, readback: readbackCommand, look };

/** Command groups with commands of their own, e.g. `popost video template fill`. */
export const loopGroups: Readonly<Record<string, Commands>> = { template: templateCommands, eval: evalCommands };
