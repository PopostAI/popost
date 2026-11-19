/** Shared fixtures for the cloud-save tests (not a test file itself). */
import { Project } from '../src/core/project';
import type { DeckSession } from '../src/deck/types';
import { createServiceState } from '../src/editor/server';
import type { ServiceState } from '../src/editor/http-types';
import { SKILL_ROOT, type TestRuntime } from '../src/testing/memory';
import { EDITOR_INDEX } from './editor-helpers';
import { newScene, tinyPng, type Scene, type SceneOptions } from './image-helpers';

export const RED = tinyPng([200, 0, 0]);
export const BLUE = tinyPng([0, 0, 200]);

/** What the converter would write for the project: one `.slide` per page, naming the pictures given. */
export const deckDocument = (images: readonly string[], extra = ''): string =>
  '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
  `<div class="slide" data-popost-page="p1" data-popost-width="300" data-popost-height="400" style="width:300px;height:400px">${extra}` +
  images.map((name) => `<img src="../assets/${name}" alt="">`).join('') +
  '</div></body></html>';

/** A converter that needs no browser: the document is whatever `html()` returns when the export runs. */
export const fakeSession =
  (html: () => string): DeckSession =>
  (fn) =>
    fn({
      compile: async () => html(),
      split: async () => {
        throw new Error('not used');
      },
      baseline: async () => {
        throw new Error('not used');
      },
    });

export interface CloudScene extends Scene {
  readonly project: Project;
  /** Replace the document the next export produces. */
  document: string;
  readonly session: DeckSession;
}

/** A scene with the platform stub and a one-page project `P` (300x400) whose assets are `a.png`, `b.png` (same bytes) and `c.png`. */
export const cloudScene = async (options: SceneOptions = {}): Promise<CloudScene> => {
  const scene = await newScene(options);
  const project = await Project.create(scene.rt, 'P', 'Cloud test brief', 'original', 300, 400);
  await project.addAssetBytes(RED, 'a.png');
  await project.addAssetBytes(RED, 'b.png');
  await project.addAssetBytes(BLUE, 'c.png');
  const state = { ...scene, project, document: deckDocument(['a.png', 'b.png', 'c.png']) } as CloudScene & { document: string };
  return Object.assign(state, { session: fakeSession(() => state.document) });
};

/** The runtime with a recording clock-free `sleep`, for the rate-limit waits. */
export const withSleep = (rt: TestRuntime, waited: number[]): TestRuntime => ({
  ...rt,
  sleep: async (ms: number) => void waited.push(ms),
});

export interface CloudEditorOptions extends SceneOptions {
  readonly enabled?: boolean;
  readonly now?: () => Date;
  readonly debounceMs?: number;
}

export interface CloudEditor extends CloudScene {
  readonly state: ServiceState;
}

/** The editor service state over a cloud scene: the platform stub behind `rt.fetch`, the fake editor build, a fake converter. */
export const cloudEditor = async (options: CloudEditorOptions = {}): Promise<CloudEditor> => {
  const scene = await cloudScene(options);
  await scene.rt.fs.writeFile(`${SKILL_ROOT}/assets/canvas/index.html`, EDITOR_INDEX);
  const rt: TestRuntime = options.now ? { ...scene.rt, now: options.now } : scene.rt;
  const state = createServiceState(rt, scene.project.root, { session: scene.session, enabled: options.enabled, debounceMs: options.debounceMs });
  return Object.assign(scene, { rt, state }) as unknown as CloudEditor;
};

/** Let queued promise work (the background push) run until `done()` holds. */
export const settled = async (done: () => Promise<boolean> | boolean, what = 'the background push'): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if (await done()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
};
