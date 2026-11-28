/**
 * The popost.ai task of a project: the headers of every Open API request made in a project (its id, its title,
 * the agent's session) and none outside one, the id kept in the project, and `popost usage --dir P`, against the
 * in-memory platform of the image tests. No network, no real key.
 */
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args';
import { Project } from '../src/core/project';
import { PopostClient } from '../src/providers/api';
import { cleanTitle, dirArg, inProject, projectTask, TASK_FILE } from '../src/providers/task';
import type { FetchHandler, TestRuntime } from '../src/testing/memory';
import { briefTitle, captionTitle, firstWords, videoTitle } from '../src/video/commands/shared';
import { cli, ok, newScene, type PopostStub, type Recorded } from './image-helpers';

const TASK = /^[A-Za-z0-9_-]{8,64}$/;
const taskOf = (r: Recorded | undefined) => ({ task: r?.headers['x-popost-task'], title: r?.headers['x-popost-task-title'], session: r?.headers['x-popost-agent-session'] });
const decoded = (r: Recorded | undefined): string | undefined => (r?.headers['x-popost-task-title'] === undefined ? undefined : decodeURIComponent(r.headers['x-popost-task-title']));

/** A GET /me in `dir`'s project (or none), and the request as the platform got it. */
const me = async (rt: TestRuntime, stub: { requests: Recorded[] }, dir?: string): Promise<Recorded | undefined> => {
  await new PopostClient(dir ? inProject(rt, dir) : rt).request('GET', '/me');
  return stub.requests.at(-1);
};

/** The platform answers the usage of any task: nothing spent yet. */
const anyTask =
  (stub: PopostStub): FetchHandler =>
  (request) => {
    const id = new URL(request.url).pathname.match(/\/usage\/tasks\/([^/]+)$/)?.[1];
    if (id) stub.set('GET', '/usage/tasks/' + id, () => ok({ id, credits: 0, items: [] }));
    return stub.fetch(request);
  };

const sceneWithMe = async (env: Record<string, string> = {}) => {
  const s = await newScene({ env, fetchHandler: anyTask });
  s.stub.set('GET', '/me', () => ok({ user: { name: 'u' }, credits: { balance: 100 } }));
  return s;
};

const stored = async (rt: TestRuntime, dir: string) => JSON.parse(await rt.fs.readText(dir + '/' + TASK_FILE));

describe('the task headers', () => {
  it('a video project gets an id the first time a request is sent in it, the same every run, and its folder name as the title', async () => {
    const { rt, stub } = await sceneWithMe();
    await rt.fs.mkdir('/work/launch-teaser');
    const first = await me(rt, stub, '/work/launch-teaser');
    const stored = JSON.parse(await rt.fs.readText('/work/launch-teaser/' + TASK_FILE));
    expect(stored.id).toMatch(TASK);
    expect(stored.id.length).toBeGreaterThanOrEqual(16);
    expect(taskOf(first)).toEqual({ task: stored.id, title: 'launch-teaser', session: undefined });
    // Found again from the file, without the cache of this process: the same id, and the file is left as it was.
    const before = await rt.fs.readText('/work/launch-teaser/' + TASK_FILE);
    expect(await projectTask(rt, { dir: '/work/launch-teaser', kind: 'video' }, true)).toMatchObject({ id: stored.id, kind: 'video' });
    expect(await rt.fs.readText('/work/launch-teaser/' + TASK_FILE)).toBe(before);
    expect(taskOf(await me(rt, stub, '/work/launch-teaser')).task).toBe(stored.id);
    // A title of its own in the task file.
    await rt.fs.writeFile('/work/launch-teaser/' + TASK_FILE, JSON.stringify({ ...stored, title: 'Spring launch teaser' }));
    expect(await projectTask(rt, { dir: '/work/launch-teaser', kind: 'video' }, true)).toMatchObject({ id: stored.id, title: 'Spring launch teaser' });
  });

  it('none outside a project, and none for a folder that is not one', async () => {
    const { rt, stub } = await sceneWithMe({ CODEX_THREAD_ID: 'thread-1' });
    expect(taskOf(await me(rt, stub))).toEqual({ task: undefined, title: undefined, session: undefined });
    await rt.fs.mkdir('/work/notes');
    await new PopostClient(inProject(rt, '/work/notes', 'found')).request('GET', '/me');
    expect(taskOf(stub.requests.at(-1)).task).toBeUndefined();
    expect(await rt.fs.stat('/work/notes/production')).toBeNull();
    // popost account and popost video voice list are not in a project.
    await cli(rt, 'account');
    expect(stub.requests.at(-1)?.path).toBe('/api/open/v1/me');
    expect(taskOf(stub.requests.at(-1)).task).toBeUndefined();
  });

  it('an image project uses its projectId and its brief, also on image quote and run', async () => {
    const { rt, stub } = await newScene({ files: { '/work/prompt.txt': 'a soft gradient ground' } });
    const project = await Project.create(rt, 'poster', 'Autumn sale\nfor the cafe', 'original');
    const image = (...args: string[]) => cli(rt, 'image', ...args, '--dir', 'poster');
    await image('prepare', '--prompt-file', '/work/prompt.txt', '--aspect', '3:4');
    const quote = await image('quote');
    expect(quote.code, JSON.stringify(quote.data)).toBe(0);
    expect((await image('run', '--quote-id', quote.data.quote.quoteId, '--confirm')).code).toBe(0);
    for (const call of [stub.calls('POST', '/images/quote')[0], stub.calls('POST', '/images/generations')[0]])
      expect({ ...taskOf(call), title: decoded(call) }).toEqual({ task: project.manifest.projectId, title: 'Autumn sale for the cafe', session: undefined });
    expect(await rt.fs.stat('/work/poster/' + TASK_FILE)).toBeNull();
  });

  it('encodes the title, cuts it to 100 characters and drops control characters; a title that cannot be encoded is left out', async () => {
    const { rt, stub } = await sceneWithMe();
    const long = '春季新品发布 🚀 '.repeat(20);
    await rt.fs.mkdir('/work/v/production');
    await rt.fs.writeFile('/work/v/' + TASK_FILE, JSON.stringify({ id: 'abcdefgh12345678', title: 'Line one\n\tline two\u0007 ' + long }));
    const sent = await me(rt, stub, '/work/v');
    const title = decoded(sent)!;
    expect(sent?.headers['x-popost-task-title']).toMatch(/^[A-Za-z0-9%\-_.!~*'()]+$/);
    expect(title.startsWith('Line one line two 春季新品发布 🚀 春季')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(100);
    expect([...title].length).toBeLessThanOrEqual(100);
    expect(title).not.toMatch(/\p{Cc}/u);
    expect(cleanTitle('\u0000\n ')).toBeUndefined();
    await rt.fs.mkdir('/work/w/production');
    await rt.fs.writeFile('/work/w/' + TASK_FILE, JSON.stringify({ id: 'abcdefgh87654321', title: 'broken \ud800 half' }));
    expect(taskOf(await me(rt, stub, '/work/w'))).toEqual({ task: 'abcdefgh87654321', title: undefined, session: undefined });
  });

  it('sends a valid CODEX_THREAD_ID as the agent session and leaves an invalid one out', async () => {
    for (const [value, sent] of [['019a5c3e-7f2b-7c41-9d1e-2b3c4d5e6f70', '019a5c3e-7f2b-7c41-9d1e-2b3c4d5e6f70'], ['thread 1', undefined], ['x'.repeat(101), undefined], ['', undefined]] as const) {
      const { rt, stub } = await sceneWithMe({ CODEX_THREAD_ID: value });
      await rt.fs.mkdir('/work/v');
      expect(taskOf(await me(rt, stub, '/work/v')).session).toBe(sent);
    }
  });

  it('never changes an id once there: one that does not fit is not replaced and sends no task', async () => {
    const { rt, stub } = await sceneWithMe();
    await rt.fs.mkdir('/work/v/production');
    await rt.fs.writeFile('/work/v/' + TASK_FILE, JSON.stringify({ id: 'bad id' }));
    expect(taskOf(await me(rt, stub, '/work/v')).task).toBeUndefined();
    expect(JSON.parse(await rt.fs.readText('/work/v/' + TASK_FILE))).toEqual({ id: 'bad id' });
  });

  it('a video project keeps the title of its first request, what that command was about, else its folder name', async () => {
    const { rt, stub } = await sceneWithMe();
    await rt.fs.mkdir('/work/v');
    const hinted = (dir: string, title?: string) => new PopostClient(inProject(rt, dir, 'video', title)).request('GET', '/me');
    await hinted('/work/v', 'Desk lamp unboxing');
    const first = await stored(rt, '/work/v');
    expect(first).toEqual({ id: expect.stringMatching(TASK), title: 'Desk lamp unboxing' });
    // A later command about something else does not rename the line.
    await hinted('/work/v', 'Another brief');
    expect(decoded(stub.requests.at(-1))).toBe('Desk lamp unboxing');
    expect(await stored(rt, '/work/v')).toEqual(first);
    // Without anything to go by: the folder's name, kept as well.
    await rt.fs.mkdir('/work/w');
    await hinted('/work/w');
    await hinted('/work/w', 'Later brief');
    expect(decoded(stub.requests.at(-1))).toBe('w');
    expect((await stored(rt, '/work/w')).title).toBe('w');
  });

  it('takes what a video command is about from the reference file (not "reference"), a brief or a fill', async () => {
    const { rt } = await newScene({
      files: {
        '/work/brief.md': '\n  Spring launch of the   Aero desk lamp, for TikTok shoppers who work late at night and need light\nsecond line',
        '/work/fill.json': JSON.stringify({ shots: [], captions: ['', 'The *brightest* lamp', 'more'] }),
      },
    });
    const args = (...argv: string[]) =>
      parseArgs(argv, { prog: 't', positionals: [{ name: 'video', required: false }], options: [{ flag: '--brief' }, { flag: '--fill' }] });
    expect(await videoTitle(args('clips/Aero lamp launch.mp4'), rt)).toBe('Aero lamp launch');
    expect(await videoTitle(args('reference.mp4'), rt)).toBeUndefined();
    expect(await videoTitle(args('ref/Reference.MOV'), rt)).toBeUndefined();
    expect(await briefTitle('brief')(args('--brief', 'brief.md'), rt)).toBe('Spring launch of the Aero desk lamp, for TikTok shoppers who');
    expect(await briefTitle('brief')(args('--brief', 'A lamp for night owls'), rt)).toBe('A lamp for night owls');
    expect(await captionTitle('fill')(args('--fill', 'fill.json'), rt)).toBe('The brightest lamp');
    expect(firstWords('春季新品发布'.repeat(20))).toHaveLength(60);
    expect(firstWords(' \n ')).toBeUndefined();
  });

  it('reads --dir from a command line', () => {
    expect(dirArg(['quote', '--dir', 'P'])).toBe('P');
    expect(dirArg(['--dir=Q', 'quote'])).toBe('Q');
    expect(dirArg(['--dir', '--other'])).toBeUndefined();
    expect(dirArg(['--', '--dir', 'P'])).toBeUndefined();
    expect(dirArg(['--directory', 'P'])).toBeUndefined();
  });
});

describe('popost usage --dir', () => {
  const usageScene = async () => {
    const s = await newScene();
    const project = await Project.create(s.rt, 'poster', 'Autumn sale', 'original');
    const id = project.manifest.projectId;
    const answer = { id, title: 'Autumn sale', credits: 37, items: [{ kind: 'image', credits: 24, count: 2, model: 'stub-model-a' }, { kind: 'link', credits: 13, count: 1 }, { kind: 'link' }, { credits: 1 }, 'nonsense'] };
    s.stub.set('GET', '/usage/tasks/' + id, () => ok(answer));
    return { ...s, id };
  };

  it('prints the task, its title, the credits and the items, with headers of the project; --budget adds what is left', async () => {
    const { rt, stub, id } = await usageScene();
    const r = await cli(rt, 'usage', '--dir', 'poster');
    expect(r.code).toBe(0);
    expect(r.data).toEqual({ ok: true, task: id, title: 'Autumn sale', credits: 37, items: [{ kind: 'image', credits: 24, count: 2, model: 'stub-model-a' }, { kind: 'link', credits: 13, count: 1 }] });
    expect(taskOf(stub.calls('GET', '/usage/tasks/' + id)[0]).task).toBe(id);
    const left = await cli(rt, 'usage', '--dir', 'poster', '--budget', '50');
    expect(left.data.budget).toMatchObject({ agreed: 50, spent: 37, left: 13 });
    expect((await cli(rt, 'usage', '--dir', 'poster', '--budget', '20')).data.budget).toMatchObject({ left: 0 });
  });

  it('lists a generated music track as an item of kind music, with its seconds', async () => {
    const { rt, stub, id } = await usageScene();
    stub.set('GET', '/usage/tasks/' + id, () => ok({ id, credits: 78, items: [{ kind: 'image', credits: 24, count: 2 }, { kind: 'music', credits: 54, count: 1, seconds: 30 }] }));
    const r = await cli(rt, 'usage', '--dir', 'poster', '--budget', '100');
    expect(r.data.items).toEqual([{ kind: 'image', credits: 24, count: 2 }, { kind: 'music', credits: 54, count: 1, seconds: 30 }]);
    expect(r.data.budget).toMatchObject({ spent: 78, left: 22 });
    // A kind this version does not know yet is listed as it is, not dropped and not an error.
    stub.set('GET', '/usage/tasks/' + id, () => ok({ id, credits: 5, items: [{ kind: 'later', credits: 5 }] }));
    expect((await cli(rt, 'usage', '--dir', 'poster')).data.items).toEqual([{ kind: 'later', credits: 5 }]);
    expect((await cli(rt, 'usage', '--help')).stdout).toContain('music');
  });

  it('says clearly when the connected popost.ai does not report task usage (404)', async () => {
    const { rt, stub, id } = await usageScene();
    stub.clear('GET', '/usage/tasks/' + id);
    const r = await cli(rt, 'usage', '--dir', 'poster');
    expect(r.code).toBe(1);
    expect(r.data).toMatchObject({ ok: false, code: 'USAGE_NOT_AVAILABLE', task: id, error: expect.stringContaining('does not report what a task has cost yet') });
    expect(r.stderr).toBe('');
  });

  it('a video project without a task yet costs nothing and asks nothing; a folder that is not a project is refused', async () => {
    const { rt, stub } = await newScene();
    await rt.fs.mkdir('/work/clip/production');
    await rt.fs.writeFile('/work/clip/production/approved-clips.json', JSON.stringify({ plan: [], clips: [{ key: 'video-1', what: 'a desk', credits: 25, by: 'plan', at: 'x' }] }));
    const r = await cli(rt, 'usage', '--dir', '/work/clip', '--budget', '60');
    expect(r.data).toMatchObject({ ok: true, task: null, title: 'clip', credits: 0, items: [], budget: { agreed: 60, spent: 0, left: 60, agreedClips: { count: 1, credits: 25 } } });
    expect(stub.requests).toHaveLength(0);
    await rt.fs.mkdir('/work/empty');
    const no = await cli(rt, 'usage', '--dir', '/work/empty');
    expect([no.code, no.data.code]).toEqual([2, 'NOT_A_PROJECT']);
    expect((await cli(rt, 'usage', '--dir', '/work/missing')).data.code).toBe('NOT_A_PROJECT');
  });

  it('--title names a video project: it makes the id, a later --title changes only the title, and the next request sends it', async () => {
    const { rt, stub } = await sceneWithMe();
    const first = await cli(rt, 'usage', '--dir', 'promo', '--title', 'Coffee grinder for TikTok');
    expect(first.code, JSON.stringify(first.data)).toBe(0);
    const made = await stored(rt, '/work/promo');
    expect(made).toEqual({ id: expect.stringMatching(TASK), title: 'Coffee grinder for TikTok' });
    expect(first.data).toMatchObject({ ok: true, task: made.id, title: 'Coffee grinder for TikTok', credits: 0, items: [] });
    expect(decoded(stub.calls('GET', '/usage/tasks/' + made.id).at(-1))).toBe('Coffee grinder for TikTok');
    expect(decoded(await me(rt, stub, '/work/promo'))).toBe('Coffee grinder for TikTok');
    const again = await cli(rt, 'usage', '--dir', 'promo', '--title', '咖啡磨豆机 · 抖音', '--budget', '40');
    expect(again.data).toMatchObject({ ok: true, task: made.id, title: '咖啡磨豆机 · 抖音', budget: { agreed: 40, left: 40 } });
    expect(await stored(rt, '/work/promo')).toEqual({ id: made.id, title: '咖啡磨豆机 · 抖音' });
    // The next request of this process, whose project was seen before, carries the new title.
    const next = await me(rt, stub, '/work/promo');
    expect({ ...taskOf(next), title: decoded(next) }).toEqual({ task: made.id, title: '咖啡磨豆机 · 抖音', session: undefined });
    // Free: only the usage itself and /me were asked.
    expect(new Set(stub.requests.map((r) => r.method + ' ' + r.path.replace(made.id, '<id>')))).toEqual(new Set(['GET /api/open/v1/usage/tasks/<id>', 'GET /api/open/v1/me']));
    const empty = await cli(rt, 'usage', '--dir', 'promo', '--title', '\n\t');
    expect([empty.code, empty.data.code]).toEqual([2, 'BAD_TITLE']);
  });

  it('an explicit --title beats the fallback of a video project and the brief of an image project', async () => {
    const { rt, stub } = await sceneWithMe();
    await rt.fs.mkdir('/work/v');
    await new PopostClient(inProject(rt, '/work/v', 'video', 'Aero lamp launch')).request('GET', '/me');
    const { id } = await stored(rt, '/work/v');
    await cli(rt, 'usage', '--dir', 'v', '--title', 'Aero lamp for TikTok');
    await new PopostClient(inProject(rt, '/work/v', 'video', 'Aero lamp launch')).request('GET', '/me');
    expect({ ...taskOf(stub.requests.at(-1)), title: decoded(stub.requests.at(-1)) }).toEqual({ task: id, title: 'Aero lamp for TikTok', session: undefined });
    // An image project: the override goes into its task file, its id stays its projectId.
    const project = await Project.create(rt, 'poster', 'Autumn sale', 'original');
    const r = await cli(rt, 'usage', '--dir', 'poster', '--title', 'Cafe poster for Instagram');
    expect(r.data).toMatchObject({ ok: true, task: project.manifest.projectId, title: 'Cafe poster for Instagram' });
    expect(await stored(rt, '/work/poster')).toEqual({ title: 'Cafe poster for Instagram' });
    expect(decoded(await me(rt, stub, '/work/poster'))).toBe('Cafe poster for Instagram');
  });

  it('is listed by popost --help', async () => {
    const { rt } = await newScene();
    const r = await cli(rt, '--help');
    expect(r.stdout).toContain('usage (what a project has cost');
  });
});
