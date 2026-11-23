/**
 * `popost video` commands that turn a project into pictures and a video: check, frame, render, capture, preview, and
 * the group scene (check, write). Each prints one JSON document. A project with errors prints its problems with
 * exit code 2; paths in the output are as the user typed them.
 */
import { printJson } from '../../core/util';
import type { Runtime } from '../../runtime';
import { readUserJson, readUserText } from '../../workflow/io';
import { CaptureError, capturePage, outlinePage, stillPage, type CaptureStep } from '../capture/index';
import { buildPage } from '../compile/index';
import { envModel, type Model } from '../plan/model';
import { openPreview, PreviewInputError } from '../preview/index';
import { checkLayout, renderFrame, renderVideo, RenderRangeError } from '../render/index';
import { reviewRender } from '../render/record';
import { ProjectError } from '../render/session';
import type { SceneText } from '../scene/author';
import { checkScenes, shotFileName } from '../scene/check';
import { addLibrary, LIBRARIES, LibraryError } from '../scene/library';
import { writeScenes } from '../scene/write';
import { readFacts } from '../template/facts';
import { captionSizeProblems } from '../template/project';
import { projectReadingProblems, projectSceneSources, readingOfFacts } from '../elements/findings';
import type { Problem } from '../types';
import { command, userPath, VideoCommandError, type Body, type Commands } from './shared';

const PROJECT = { name: 'project-dir', help: 'the directory that holds video.json' } as const;
const SCALE = { flag: '--scale', kind: 'number', help: 'size of the picture against the canvas, for example 0.5' } as const;

const errorsIn = (problems: readonly Problem[]): number => problems.filter((p) => p.level === 'error').length;

/**
 * The failures of the making half that the caller can fix: a project with errors (printed with its problems), a frame
 * the video does not have, a capture plan that cannot be recorded, a preview input that is not what it should be.
 */
const making = (body: Body): Body => async (args, rt) => {
  try {
    return await body(args, rt);
  } catch (error) {
    if (error instanceof ProjectError) {
      printJson(rt, { ok: false, error: error.message, problems: error.problems });
      return 2;
    }
    if (error instanceof RenderRangeError || error instanceof CaptureError || error instanceof PreviewInputError) throw new VideoCommandError(error.message);
    throw error;
  }
};

const check = command(
  'check video.json: the schema, the rules, the files, and, in a project template fill made, the captions\' size against the reference\'s; --layout also opens the page and reports text that does not fit its box',
  { positionals: [PROJECT], options: [{ flag: '--layout', kind: 'flag', help: 'measure the text in the page too (needs Chrome)' }] },
  making(async (args, rt) => {
    const dir = args.req('project-dir');
    const page = await buildPage(rt, dir);
    const layout = args.flag('layout') && page.resolved ? await checkLayout(rt, dir) : [];
    // The record template fill keeps in the project (template/facts.ts): a hand edit of the captions' style is held to the reference's size.
    const facts = page.project ? await readFacts(rt, userPath(rt, dir)) : undefined;
    const sizes = facts && page.project ? captionSizeProblems({ template: facts }, page.project) : [];
    // The reading of the reference's frames, kept in the record: an effect a preset replaced, the layout changed, the platform's words shown.
    const root = userPath(rt, dir);
    const reading = facts && page.project ? projectReadingProblems(readingOfFacts(facts, (p) => rt.path.relative(rt.cwd, rt.path.resolve(root, p))), page.project, await projectSceneSources(rt, root, page.project)) : [];
    const problems = [...page.problems, ...layout, ...sizes, ...reading];
    const errors = errorsIn(problems);
    printJson(rt, { ok: errors === 0, frames: page.resolved?.frames ?? 0, segments: page.resolved?.segments.length ?? 0, items: page.resolved?.items.length ?? 0, errors, problems });
    return errors ? 2 : 0;
  }),
);

const frame = command(
  'draw one frame of the project as a PNG',
  { positionals: [PROJECT], options: [{ flag: '--frame', kind: 'int', required: true, help: 'the frame number, from 0' }, { flag: '--out', required: true, help: 'the PNG to write' }, SCALE] },
  making(async (args, rt) => {
    const out = args.req('out');
    const n = args.number('frame') ?? 0;
    const scale = args.number('scale');
    const r = await renderFrame(rt, { projectDir: args.req('project-dir'), frame: n, out, ...(scale === undefined ? {} : { scale }) });
    printJson(rt, { ok: true, out, frame: n, width: r.width, height: r.height });
  }),
);

const render = command(
  'render the project to an MP4: frames drawn in Chrome, encoded with ffmpeg with the sound mixed in; next names the compare to run, and a warning says when the render before it was never compared',
  {
    positionals: [PROJECT],
    options: [
      { flag: '--out', required: true, help: 'the MP4 to write' },
      SCALE,
      { flag: '--pages', kind: 'int', help: 'Chrome pages that draw side by side (default: by the size of the job, or POPOST_RENDER_PAGES)' },
      { flag: '--no-reuse', kind: 'flag', help: 'take a screenshot of every frame, also of frames that did not change' },
    ],
  },
  making(async (args, rt) => {
    const out = args.req('out');
    const projectDir = args.req('project-dir');
    const scale = args.number('scale');
    const pages = args.number('pages');
    const r = await renderVideo(rt, { projectDir, out, ...(scale === undefined ? {} : { scale }), ...(pages === undefined ? {} : { pages }), ...(args.flag('no-reuse') ? { reuse: false } : {}) });
    // The record of renders counts the review rounds for compare; the render is done whatever becomes of it.
    const review = await reviewRender(rt, projectDir, out).catch((e: unknown) => ({ next: 'popost video compare <reference video> ' + out, note: 'The record of renders could not be written (' + (e instanceof Error ? e.message : String(e)) + '), so compare cannot count rounds.' }));
    printJson(rt, { ok: true, out, frames: r.frames, width: r.width, height: r.height, fps: r.fps, seconds: Number((r.ms / 1000).toFixed(1)), msPerFrame: Math.round(r.ms / r.frames), pages: r.pages, reused: r.reused, ...review });
  }),
);

/** "1280x720" -> [1280, 720]; the range is left to the capture's own check, which names it. */
const sizeOf = (text: string): [number, number] => {
  const m = /^(\d+)x(\d+)$/.exec(text.trim());
  if (!m) throw new VideoCommandError('--size takes the window size as WIDTHxHEIGHT in CSS pixels, for example 1280x720; got "' + text + '".');
  return [Number(m[1]), Number(m[2])];
};

const capture = command(
  'record a web page as footage, frame by frame, following a plan of steps that scroll, zoom, highlight, point, click and type; --outline lists its headings, the elements a plan can point at and what covers the window instead',
  {
    positionals: [{ name: 'url', help: 'http://, https:// or file:// address of the page' }],
    options: [
      { flag: '--out', help: 'the MP4 to write (needed unless --outline)' },
      { flag: '--size', default: '1280x720', help: 'window size in CSS pixels' },
      { flag: '--fps', kind: 'number', default: 30 },
      SCALE,
      { flag: '--zoom', kind: 'number', help: 'lay the page out this many times larger (1 to 4), as in a narrower window, so that its text is readable in the video; plan positions are in that window\'s pixels' },
      { flag: '--dark', kind: 'flag', help: 'ask the page for its dark colour scheme' },
      { flag: '--plan', help: 'a JSON list of steps: {"hold":30} {"scroll":{"to":"bottom","frames":90}} {"zoom":{"to":"css","frames":20}} {"highlight":{"to":"css"}} {"clear":10} {"point":{"to":"css"}} {"hover":"css"} {"click":"css"} {"type":{"into":"css","text":"..."}} {"pointer":"hide"} {"wait":800}; default: hold one second, scroll to the bottom in five, hold one' },
      { flag: '--hide', help: 'CSS selectors to remove first, separated by commas (a cookie banner, a language pop-up: --outline lists them as overlays)' },
      { flag: '--outline', kind: 'flag', help: 'list the headings with their positions in px, the elements a plan can point at (targets) and what covers the window (overlays), with selectors and boxes in page px' },
      { flag: '--still', metavar: 'PNG', help: 'write one picture of the page instead of a video, for a scene that shows it' },
      { flag: '--at', help: 'with --still: where the window sits, a selector or px from the top (default: the top)' },
      { flag: '--full-page', kind: 'flag', help: 'with --still: the whole page in one tall picture' },
      { flag: '--caption-band', kind: 'number', metavar: 'Y', help: 'the top of the video\'s caption band: a fraction of the height (the y of slots.captions.box) or pixels of the video; a zoom then ends with its element above the band when it can, and a highlight under the band is noted' },
    ],
  },
  making(async (args, rt) => {
    const [width, height] = sizeOf(args.string('size') ?? '1280x720');
    const hide = (args.string('hide') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const zoom = args.number('zoom');
    if (zoom !== undefined && !(zoom >= 1 && zoom <= 4)) throw new VideoCommandError('--zoom lays the page out that many times larger, from 1 to 4 (1.5 makes a 960x720 recording show the page as in a 640x480 window); got ' + zoom + '.');
    const scale = args.number('scale');
    const common = { url: args.req('url'), width, height, ...(args.flag('dark') ? { colorScheme: 'dark' as const } : {}), ...(hide.length ? { hide } : {}), ...(zoom === undefined ? {} : { zoom }) };
    if (args.flag('outline')) {
      const o = await outlinePage(rt, { ...common, ...(scale === undefined ? {} : { scale }) });
      printJson(rt, { ok: true, title: o.title, pageHeight: o.pageHeight, width: o.width, height: o.height, maxScroll: Math.max(0, o.pageHeight - o.height), stillScale: o.stillScale, text: o.text, sections: o.sections, targets: o.targets, overlays: o.overlays });
      return;
    }
    const still = args.string('still');
    if (still) {
      const at = args.string('at');
      const s = await stillPage(rt, { ...common, out: still, ...(scale === undefined ? {} : { scale }), ...(at === undefined ? {} : { at: /^\d+(\.\d+)?$/.test(at) ? Number(at) : at }), ...(args.flag('full-page') ? { fullPage: true } : {}) });
      printJson(rt, { ok: true, still, width: s.width, height: s.height, pageHeight: s.pageHeight, y: s.y, stillScale: s.stillScale, text: s.text, overlays: s.overlays, notes: s.notes });
      return;
    }
    const out = args.string('out');
    if (!out) throw new VideoCommandError('Missing --out <out.mp4>: the video to write. Or pass --outline to list what is on the page, or --still <out.png> for one picture of it.');
    const fps = args.number('fps') ?? 30;
    const planFile = args.string('plan');
    const steps = planFile ? ((await readUserJson(rt, planFile)) as CaptureStep[]) : [{ hold: fps }, { scroll: { to: 'bottom', frames: fps * 5 } }, { hold: fps }];
    const band = args.number('caption-band');
    // Pixels of the video (above 1) or a fraction of its height: what the template gives is a fraction.
    const captionBand = band === undefined ? undefined : band > 1 ? band / (height * (scale ?? 1)) : band;
    const r = await capturePage(rt, { ...common, out, fps, steps, ...(scale === undefined ? {} : { scale }), ...(captionBand === undefined ? {} : { captionBand }) });
    printJson(rt, { ok: true, out, frames: r.frames, width: r.width, height: r.height, fps: r.fps, pageHeight: r.pageHeight, seconds: Number((r.ms / 1000).toFixed(1)), text: r.text, notes: r.notes });
  }),
);

/** Waits until the host aborts the command; without a signal, until the process is stopped (Ctrl+C), like popost serve. */
const untilStopped = (rt: Runtime): Promise<void> =>
  new Promise<void>((resolve) => {
    if (rt.signal?.aborted) resolve();
    rt.signal?.addEventListener('abort', () => resolve(), { once: true });
  });

const preview = command(
  'the preview debugger on 127.0.0.1: any frame, the timeline, the measurements; --edit makes it an editor of video.json. Runs until stopped',
  {
    positionals: [PROJECT],
    options: [
      { flag: '--reference', help: 'the reference video, shown beside the stage' },
      { flag: '--measure', help: 'the measurement of the render (default: measure.json in the project)' },
      { flag: '--reference-measure', help: 'the measurement of the reference (default: reference.measure.json in the project)' },
      { flag: '--port', kind: 'int', help: 'default 4317, or any free port when it is taken; 0 for any free port' },
      { flag: '--edit', kind: 'flag', help: 'select, move, retime and retype in the page; each edit is checked, then written to video.json' },
    ],
  },
  making(async (args, rt) => {
    const projectDir = args.req('project-dir');
    const edit = args.flag('edit');
    const optional = { reference: args.string('reference'), measure: args.string('measure'), referenceMeasure: args.string('reference-measure'), port: args.number('port') };
    const given = Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined));
    const server = await openPreview(rt, { projectDir, ...given, ...(edit ? { edit: true } : {}) });
    printJson(rt, {
      ok: true, url: server.url, project: projectDir, mode: edit ? 'edit' : 'read-only',
      note: (edit ? 'Edits in the page are checked, then written to video.json; the first one keeps the file as it was in video.json.bak. ' : '')
        + 'It reloads when video.json, an asset or a measurement changes. Stop it with Ctrl+C.',
    });
    await untilStopped(rt);
    await server.close();
  }),
);

const sceneCheck = command(
  'open every scene of the project in the renderer: a script that fails, content outside the canvas, a marked place too small, nothing drawn, text that arrives too late, a nearly empty picture, numbers no file of the project holds; per scene the share of its middle picture that stands out from the ground (fill)',
  { positionals: [PROJECT], options: [{ flag: '--shots', help: 'a directory to keep three frames of each scene in (segment-NN-fFRAME.png, NN from 01); a warning names the one to open' }] },
  making(async (args, rt) => {
    const shotsDir = args.string('shots');
    const r = await checkScenes(rt, args.req('project-dir'), undefined, shotsDir ? { shotsDir } : {});
    const shots = shotsDir ? r.shots.map((s) => ({ ...s, file: rt.path.join(shotsDir, shotFileName(s.k, s.frame)) })) : [];
    if (shotsDir) await rt.fs.mkdir(userPath(rt, shotsDir));
    for (const s of shots) await rt.fs.writeFile(userPath(rt, s.file), s.png);
    const errors = errorsIn(r.problems);
    printJson(rt, { ok: errors === 0, opened: new Set(r.shots.map((s) => s.k)).size, errors, problems: r.problems, scenes: r.scenes, ...(shotsDir ? { shots: shots.map((s) => s.file) } : {}) });
    return errors ? 2 : 0;
  }),
);

/** The model POPOST_LLM_* names; a missing or broken setting is an error the user can fix. */
export const configuredModel = (rt: Runtime): Model => {
  let model: Model | undefined;
  try {
    model = envModel(rt);
  } catch (error) {
    throw new VideoCommandError(error instanceof Error ? error.message : String(error));
  }
  if (!model) throw new VideoCommandError('No model is configured. Set POPOST_LLM_URL, POPOST_LLM_MODEL and POPOST_LLM_KEY (a model that reads pictures).');
  return model;
};

/** --brief: the text itself, or a file that holds it. */
export const briefOf = async (rt: Runtime, given: string): Promise<string> => ((await rt.fs.stat(userPath(rt, given)))?.isFile ? readUserText(rt, given) : given);

/** "1,3" -> the segments 0 and 2. */
const onlyOf = (text: string | undefined): number[] | undefined => {
  if (text === undefined) return undefined;
  const list = text.split(',').map((x) => Number(x.trim()));
  if (list.some((n) => !Number.isInteger(n) || n < 1)) throw new VideoCommandError('--only takes segment numbers from 1, separated by commas, for example 1,3; got "' + text + '".');
  return list.map((n) => n - 1);
};

const sceneWrite = command(
  'a model writes the scene of every scene segment from frames of the reference at the segment\'s time, is sent the check\'s problems until it passes, then is shown its own frames beside the reference\'s. Needs POPOST_LLM_* (a model that reads pictures)',
  {
    positionals: [PROJECT],
    options: [
      { flag: '--reference', required: true, help: 'the reference video' },
      { flag: '--brief', required: true, help: 'the new subject: the text, or a file that holds it' },
      { flag: '--texts', help: 'texts a reader found in the reference (a JSON list of { text, from, to, box, role })' },
      { flag: '--only', help: 'segment numbers from 1 to write, for example 1,3 (default: every scene segment)' },
      { flag: '--offset', kind: 'number', default: 0, help: 'seconds of the reference where the project starts' },
      { flag: '--attempts', kind: 'int', default: 3, help: 'answers allowed until the check passes, each time a scene is (re)written' },
      { flag: '--rounds', kind: 'int', default: 1, help: 'times the model is shown its own frames beside the reference\'s' },
    ],
  },
  making(async (args, rt) => {
    const model = configuredModel(rt);
    const textsFile = args.string('texts');
    const only = onlyOf(args.string('only'));
    const r = await writeScenes(rt, {
      projectDir: args.req('project-dir'), reference: args.req('reference'), brief: await briefOf(rt, args.req('brief')), model,
      ...(textsFile ? { texts: (await readUserJson(rt, textsFile)) as SceneText[] } : {}), ...(only ? { only } : {}),
      offset: args.number('offset') ?? 0, attempts: args.number('attempts') ?? 3, rounds: args.number('rounds') ?? 1,
      // A shot takes minutes: a person watching sees which one, on stderr; stdout keeps the one JSON document.
      onStep: (what) => rt.stderr(what + '\n'),
    });
    const scenes = r.scenes.map((s) => ({
      segment: s.segment + 1, file: s.file, passed: s.passed, answers: s.steps.length,
      steps: s.steps.map((st) => ({ kind: st.kind, seconds: Number((st.ms / 1000).toFixed(1)), ...(st.usage ? { inputTokens: st.usage.input, outputTokens: st.usage.output } : {}), errors: st.errors, warnings: st.warnings })),
      problems: s.problems,
    }));
    const ok = r.scenes.every((s) => s.passed) && errorsIn(r.problems) === 0;
    printJson(rt, { ok, model: model.name, scenes, problems: r.problems });
    return ok ? 0 : 2;
  }),
);

export const makeCommands: Commands = { check, frame, render, capture, preview };

const sceneLibrary = command(
  'put a script file into the project for its scenes to load, under lib/ (' + Object.keys(LIBRARIES).join(', ') + '): gsap, the unchanged file of the installed package; screen, the Skill\'s helper that shows a still of a page under a camera, with highlight, pointer, click and typing',
  { positionals: [PROJECT], options: [{ flag: '--name', default: 'gsap', choices: Object.keys(LIBRARIES), help: 'which library: gsap (timelines) or screen (a still of a page driven by steps)' }] },
  async (args, rt) => {
    const typed = args.req('project-dir');
    try {
      const added = await addLibrary(rt, userPath(rt, typed), args.req('name'));
      printJson(rt, { ok: true, library: added.name, version: added.version, file: rt.path.join(typed, added.file), bytes: added.bytes, tag: added.tag, use: added.use, licence: added.licence,
        next: (added.name === 'screen'
          ? 'In a scene (a file in scenes/): an element that is the window onto the still, the tag, then popostScreen(...) as "use" shows (references/video-scenes.md, "A screen inside a scene").'
          : 'In a scene (a file in scenes/): load it with the tag, build one paused timeline, hand it over as "use" shows.') + ' Then: popost video scene check ' + typed });
    } catch (e) {
      if (e instanceof LibraryError) throw new VideoCommandError(e.message);
      throw e;
    }
  },
);

/** Command groups with commands of their own, e.g. `popost video scene check`. */
export const makeGroups: Readonly<Record<string, Commands>> = { scene: { check: sceneCheck, write: sceneWrite, library: sceneLibrary } };
