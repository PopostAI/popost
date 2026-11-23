/**
 * A model writes the scene of one shot. It is shown frames of the reference shot, the texts a reader found in it,
 * the customer's brief and the contract of a scene (references/video-scenes.md, in short), and answers with one HTML
 * file. The program checks the file (the static rules, then opened in the renderer) and sends the problems back; when
 * it passes, the model is shown frames of its own scene beside the reference's and corrects what differs most.
 * The loop is the same for a strong and a weak model; only the number of turns it takes differs.
 */
import type { Runtime } from '../../runtime';
import type { ContentPart, Message, Model, ModelUsage } from '../plan/model';
import { openRenderer } from '../render/index';
import { ProjectError } from '../render/session';
import type { Problem } from '../types';
import { checkScenes } from './check';
import { lookTimes, pictureUrl, pngUrl } from './pictures';

/** A text of the reference inside the shot: when it is on screen (seconds from the start of the shot) and where. */
export interface SceneText { text: string; from: number; to: number; box: number[]; role?: string }

export interface WriteSceneOptions {
  /** The project directory, as the user typed it (against rt.cwd). */
  projectDir: string;
  /** Index of the segment whose scene is written, and the scene's path in the project. */
  segment: number;
  file: string;
  canvas: { width: number; height: number; fps: number };
  /** Frames of the segment. */
  frames: number;
  /** The reference video and the seconds of this shot in it. */
  reference: { video: string; start: number; end: number };
  brief: string;
  model: Model;
  texts?: SceneText[];
  /** The project carries this library as lib/gsap.min.js: the prompt says how a scene uses it. */
  library?: 'gsap';
  /** A scene already written for this video: this one keeps its look (colours, type, characters). */
  earlier?: { file: string; html: string };
  /** Answers allowed until the check has no error, each time the scene is (re)written. Default 3. */
  attempts?: number;
  /** Times the model is shown its own frames beside the reference's. Default 1. */
  rounds?: number;
  /** Reference frames shown. Default 6. */
  pictures?: number;
  onStep?: (what: string) => void;
}

export interface SceneStep { kind: 'write' | 'repair' | 'review'; ms: number; usage?: ModelUsage; errors: number; warnings: number; problems: string[] }
export interface WriteSceneResult { file: string; passed: boolean; steps: SceneStep[]; problems: Problem[] }

const RULES = [
  'A scene is ONE complete HTML page that fills the canvas for one shot. html and body are exactly the canvas size, margin 0, overflow hidden. Everything is inline (style, SVG, script); nothing comes from the network.',
  'Motion is on the engine\'s clock, counted in seconds from the start of the shot. The renderer draws frames in any order, so a frame must depend on its time only.',
  'NOT allowed: setTimeout, setInterval, requestAnimationFrame, Date.now, performance.now, Math.random, CSS transition, <video>, <audio>, <iframe>, fetch, anything from the network.',
  'Mark every text that belongs to the subject (titles, labels, card texts, numbers) with data-slot="a-short-name"; leave a little room in its box.',
  'Chinese text uses font-family "Noto Sans CJK SC", sans-serif. There are no picture files: draw icons, arrows and characters with HTML, CSS and inline SVG.',
];
const CSS_MOTION = 'Write motion as CSS animations (@keyframes) with animation-delay and animation-fill-mode: both, as if they played from the start of the shot; the engine pauses them and sets their time.';
const GSAP_MOTION = [
  'Motion uses GSAP 3 (core only), already in the project. In the page: <script src="../lib/gsap.min.js"></script>, then in an inline script:',
  '  gsap.config({ force3D: false });',
  '  var tl = gsap.timeline({ paused: true });   // every tween goes on tl at its time in seconds from the start of the shot',
  '  ...',
  '  window.__timelines = { main: tl };',
  'The engine pauses tl and seeks it for every frame. Never start a tween outside tl. Three things that go wrong: (1) tl.fromTo and tl.from show their start values from second 0: hide the element with tl.set(el, { autoAlpha: 0 }, 0) or immediateRender: false when it should not be seen before its entrance; (2) do not put transformOrigin in a tween, set it in CSS; (3) a rotation written in CSS transform is lost when a tween scales the element: set it with gsap.set(el, { rotation: -3 }). CSS animations may be used too where they are simpler.',
].join('\n');

const system = (o: WriteSceneOptions): string => [
  'You write the HTML scene of one shot of a motion-graphics video. You are shown frames of a reference shot. Re-create its LAYOUT and its MOTION as closely as you can; the words and the subject are new (the brief).',
  ...RULES,
  o.library === 'gsap' ? GSAP_MOTION : CSS_MOTION,
  'Answer with the complete HTML file inside one ```html fence and nothing else. Keep the file compact (about 300 lines at most): an answer that is cut off is lost.',
].join('\n');

const textLines = (texts: SceneText[] | undefined): string[] =>
  texts?.length ? ['Texts a reader found in the reference shot (seconds in the shot; box = x, y, width, height as fractions of the frame):',
    ...texts.slice(0, 30).map((t) => '- ' + t.from.toFixed(1) + '-' + t.to.toFixed(1) + ' s  [' + t.box.map((v) => v.toFixed(2)).join(', ') + ']' + (t.role ? ' ' + t.role : '') + ': "' + t.text + '"'), ''] : [];

const brief = (o: WriteSceneOptions): string => [
  'Canvas ' + o.canvas.width + 'x' + o.canvas.height + ' CSS pixels. The shot lasts ' + (o.frames / o.canvas.fps).toFixed(2) + ' s (' + o.frames + ' frames at ' + o.canvas.fps + ' fps): everything happens inside that time.',
  '', 'The customer\'s brief (the new subject):', o.brief.trim(), '',
  ...textLines(o.texts),
  'Write new wording for every text, about as long as the one it replaces, telling the brief\'s story with the reference\'s narrative move for this shot. Leave out the reference\'s watermark, account name and platform logo. Draw captions of the reference inside the scene too, at their times.',
  // The first real run kept the first shot's dark ground in a shot whose reference is light: what carries over is the
  // style of the parts, not the palette of the shot.
  ...(o.earlier ? ['', 'An earlier shot of the same video is already written (' + o.earlier.file + '). Reuse its type, its card and label styles and its characters, so that the video is one piece. Take the GROUND and the colours of THIS shot from this shot\'s reference frames: a video often alternates dark and light shots.', '```html', o.earlier.html.slice(0, 14_000), '```'] : []),
  '', 'The frames of the reference shot follow, in order, each with its time in the shot.',
].join('\n');

const referencePictures = async (rt: Runtime, o: WriteSceneOptions): Promise<{ parts: ContentPart[]; times: number[] }> => {
  const times = lookTimes(o.reference.start, o.reference.end, o.pictures ?? 6);
  const parts: ContentPart[] = [];
  for (const t of times) {
    parts.push({ type: 'text', text: 'Reference, ' + (t - o.reference.start).toFixed(1) + ' s:' });
    parts.push({ type: 'image_url', image_url: { url: await pictureUrl(rt, rt.path.resolve(rt.cwd, o.reference.video), 512, t) } });
  }
  return { parts, times: times.map((t) => t - o.reference.start) };
};

/** The HTML file of an answer: the fenced block, or the page itself when the model left the fence out. */
export const extractHtml = (answer: string): string | undefined => {
  const text = answer.replace(/<think>[\s\S]*?<\/think>/g, '');
  const fenced = text.match(/```(?:html)?\s*\n([\s\S]*?)```/i)?.[1];
  const page = fenced ?? text.match(/<!doctype html[\s\S]*<\/html>/i)?.[0] ?? text.match(/<html[\s\S]*<\/html>/i)?.[0];
  return page && /<body[\s>]/i.test(page) ? page.trim() + '\n' : undefined;
};

const listed = (problems: Problem[]): string =>
  problems.map((p) => '- ' + p.level.toUpperCase() + ': ' + p.message + (p.fix ? ' Fix: ' + p.fix : '')).join('\n');

/** The scene file's absolute path. */
const sceneFile = (rt: Runtime, o: WriteSceneOptions): string => rt.path.resolve(rt.cwd, o.projectDir, o.file);

/** Writes the answer's page to the scene file and checks it. An answer without a page is one problem. */
const land = async (rt: Runtime, o: WriteSceneOptions, answer: string): Promise<Problem[]> => {
  const html = extractHtml(answer);
  const at = 'segments[' + o.segment + '].base.scene';
  if (!html) return [{ level: 'error', at, message: /<html|<!doctype/i.test(answer) ? 'The answer was cut off before </html>, or has no <body>.' : 'The answer holds no HTML page.', fix: 'Answer with the complete HTML file inside one ```html fence. If it was cut off, write a shorter page: simpler drawings, fewer elements.' }];
  await rt.fs.writeFile(sceneFile(rt, o), html);
  // The customer's brief is where the figures of a written scene come from.
  const checked = await checkScenes(rt, o.projectDir, [o.segment], { sources: [o.brief] });
  const mine = checked.problems.filter((p) => p.at.startsWith(at));
  // Nothing was opened: the project has an error somewhere else. That is not a scene that passed.
  const elsewhere = checked.problems.find((p) => p.level === 'error' && !p.at.startsWith(at));
  if (!checked.shots.length && elsewhere && !mine.some((p) => p.level === 'error')) {
    throw new ProjectError('The scene could not be opened because the project has another error (' + elsewhere.at + ': ' + elsewhere.message + '). Correct the project first; the model was not at fault.', [elsewhere]);
  }
  return mine;
};

/** Frames of the scene as it is now, at the same moments as the reference's. */
const ownPictures = async (rt: Runtime, o: WriteSceneOptions, times: number[], start: number): Promise<ContentPart[]> => {
  const renderer = await openRenderer(rt, o.projectDir);
  try {
    const parts: ContentPart[] = [];
    for (const t of times) {
      const frame = Math.min(start + o.frames - 1, start + Math.round(t * o.canvas.fps));
      parts.push({ type: 'text', text: 'Yours, ' + t.toFixed(1) + ' s:' });
      parts.push({ type: 'image_url', image_url: { url: await pngUrl(rt, await renderer.frame(frame), 512) } });
    }
    return parts;
  } finally {
    await renderer.close();
  }
};

export const writeScene = async (rt: Runtime, o: WriteSceneOptions & { /** First frame of the segment in the project. */ start: number }): Promise<WriteSceneResult> => {
  const steps: SceneStep[] = [];
  const attempts = Math.max(1, o.attempts ?? 3);
  const ref = await referencePictures(rt, o);
  const opening: Message = { role: 'user', content: [{ type: 'text', text: brief(o) }, ...ref.parts] };
  let answer = '';
  let problems: Problem[] = [];
  /** Asks, lands the answer, and repairs until the check has no error or the attempts are used up. */
  const settle = async (messages: Message[], kind: SceneStep['kind']): Promise<boolean> => {
    for (let i = 0; i < attempts; i++) {
      const started = Date.now();
      o.onStep?.(i === 0 ? kind : 'repair');
      const reply = await o.model.ask(messages);
      answer = reply.text;
      problems = await land(rt, o, answer);
      const errors = problems.filter((p) => p.level === 'error');
      steps.push({ kind: i === 0 ? kind : 'repair', ms: Date.now() - started, ...(reply.usage ? { usage: reply.usage } : {}), errors: errors.length, warnings: problems.length - errors.length, problems: problems.map((p) => p.level + ': ' + p.message.slice(0, 200)) });
      // Warnings (text that does not fit, content outside the canvas) are worth one repair too, on the first answer.
      const toFix = errors.length ? errors : i === 0 ? problems : [];
      if (!toFix.length) return true;
      messages.push({ role: 'assistant', content: answer }, { role: 'user', content: 'The scene has ' + toFix.length + ' problem(s). Correct them, change nothing else, and answer with the complete HTML file again.\n' + listed(toFix) });
    }
    return !problems.some((p) => p.level === 'error');
  };
  let passed = await settle([{ role: 'system', content: system(o) }, opening], 'write');
  for (let round = 0; passed && round < (o.rounds ?? 1); round++) {
    const mine = await ownPictures(rt, o, ref.times, o.start);
    const kept = await rt.fs.readText(sceneFile(rt, o));
    const review: Message = { role: 'user', content: [
      { type: 'text', text: 'Here are frames of YOUR scene at the same moments as the reference frames above. Compare them pair by pair. In at most five short lines, name what differs most for a viewer: something missing, in the wrong place, the wrong size or colour, entering at the wrong time or in the wrong way. Then answer with the complete corrected HTML file inside one ```html fence. Keep what already matches.' },
      ...mine,
    ] };
    const ok = await settle([{ role: 'system', content: system(o) }, opening, { role: 'assistant', content: '```html\n' + kept + '```' }, review], 'review');
    if (!ok) {
      // A review that broke the scene is taken back: the version that passed stays.
      await rt.fs.writeFile(sceneFile(rt, o), kept);
      problems = (await checkScenes(rt, o.projectDir, [o.segment], { sources: [o.brief] })).problems.filter((p) => p.at.startsWith('segments[' + o.segment + '].base.scene'));
      break;
    }
  }
  passed = !problems.some((p) => p.level === 'error');
  await rt.fs.writeFile(sceneFile(rt, o) + '.steps.json', JSON.stringify({ model: o.model.name, passed, steps }, null, 1) + '\n');
  return { file: o.file, passed, steps, problems };
};
