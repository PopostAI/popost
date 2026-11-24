import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anchorIndex, anchorSentence, checkRequests, commandGenerator, ConfirmNeeded, makeMaterials, type Generator, type GenerateRequest } from '../../src/video/generate/index';
import { createDiskRuntime } from '../../src/testing/disk';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';

const rt = await createDiskRuntime();
const ffmpeg = await hasFfmpeg(rt);
let root = '';
beforeAll(async () => { root = await mkdtemp(path.join(tmpdir(), 'loop-generate-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); await rt.cleanup(); });

/** A generator that writes a file of its own and counts what it was asked. */
const counting = (credits = 45): Generator & { asked: { kind: string; request: GenerateRequest }[] } => {
  const asked: { kind: string; request: GenerateRequest }[] = [];
  return {
    asked,
    make: async (kind, request, out) => {
      asked.push({ kind, request });
      if (request.prompt.includes('refuse')) throw new Error('over the spending limit; it was not sent');
      await writeFile(out, kind + ':' + request.prompt);
      return { credits: kind === 'video' ? credits : 20 };
    },
  };
};

describe('generate: the requests', () => {
  it('names what is wrong before anything is paid for', async () => {
    const dir = path.join(root, 'check');
    await mkdir(dir, { recursive: true });
    expect((await checkRequests(rt, {}, dir))[0]).toMatchObject({ at: '(root)' });
    const problems = await checkRequests(rt, [
      { file: 'assets/a.mp4', prompt: 'a desk', seconds: 5, aspect: '16:9' },
      { file: '../out.mp4', prompt: 'x' },
      { file: 'assets/a.mp4', prompt: 'again' },
      { file: 'assets/b.gif', prompt: 'x' },
      { file: 'assets/c.png', prompt: ' ', seconds: 2.5, aspect: 'wide', images: ['missing.png'] },
      { file: 'assets/d.mp4', prompt: 'x', aspect: 'adaptive', videos: ['missing.mp4'], audios: ['missing.mp3'] },
    ], dir);
    expect(problems.map((p) => p.at)).toEqual(['[1].file', '[2].file', '[3].file', '[4].prompt', '[4].seconds', '[4].aspect', '[4].images[0]', '[5].videos[0]', '[5].audios[0]']);
    expect(problems.at(-1)?.message).toContain('The reference sound "missing.mp3" does not exist');
    expect(problems[0]?.message).toContain('outside the project directory');
    expect(await checkRequests(rt, [{ file: 'assets/a.mp4', prompt: 'a desk', seconds: 5, aspect: '4:3' }], dir)).toEqual([]);
  });
});

describe('generate: making materials', () => {
  it('makes what is missing, keeps what exists, and writes what each one shows', async () => {
    const dir = path.join(root, 'make');
    const generator = counting();
    const requests = [
      { file: 'assets/desk.mp4', prompt: 'a tidy desk, slow push-in', seconds: 5, aspect: '16:9' as const, note: 'a desk with a laptop' },
      { file: 'assets/logo.png', prompt: 'a red logo on white' },
    ];
    const first = await makeMaterials(rt, { requests, dir, generator });
    expect(first.problems).toEqual([]);
    expect(first.materials.map((m) => [m.file, m.kind, m.made, m.credits])).toEqual([['assets/desk.mp4', 'video', true, 45], ['assets/logo.png', 'image', true, 20]]);
    expect(first.credits).toBe(65);
    expect(generator.asked[0]?.request).toEqual({ prompt: 'a tidy desk, slow push-in', seconds: 5, aspect: '16:9' });
    expect(JSON.parse(await readFile(path.join(dir, 'materials.json'), 'utf8'))).toEqual({ 'assets/desk.mp4': 'a desk with a laptop', 'assets/logo.png': 'a red logo on white' });
    // Asking again costs nothing: both files are there.
    const again = await makeMaterials(rt, { requests: [...requests, { file: 'assets/new.png', prompt: 'a blue square' }], dir, generator });
    expect(again.materials.map((m) => m.made)).toEqual([false, false, true]);
    expect(again.credits).toBe(20);
    expect(generator.asked).toHaveLength(3);
    expect(existsSync(path.join(dir, 'assets', 'new.png.partial.png'))).toBe(false);
  });

  it('reports a request that fails and goes on with the others; nothing half-written stays', async () => {
    const dir = path.join(root, 'fail');
    const r = await makeMaterials(rt, { requests: [{ file: 'assets/a.png', prompt: 'please refuse this' }, { file: 'assets/b.png', prompt: 'a green field' }], dir, generator: counting() });
    expect(r.materials.map((m) => [m.file, m.made, m.error !== undefined])).toEqual([['assets/a.png', false, true], ['assets/b.png', true, false]]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]?.message).toContain('over the spending limit');
    expect(existsSync(path.join(dir, 'assets', 'a.png'))).toBe(false);
    expect(JSON.parse(await readFile(path.join(dir, 'materials.json'), 'utf8'))).toEqual({ 'assets/b.png': 'a green field' });
  });

  it.skipIf(!ffmpeg)('measures a clip it made', async () => {
    const dir = path.join(root, 'clip');
    const generator: Generator = { make: async (_kind, _request, out) => { await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=90x160:rate=30:duration=2', '-pix_fmt', 'yuv420p', out]); return {}; } };
    const r = await makeMaterials(rt, { requests: [{ file: 'assets/t.mp4', prompt: 'a test pattern' }], dir, generator });
    expect(r.materials[0]).toEqual({ file: 'assets/t.mp4', kind: 'video', made: true, seconds: 2, motionAmount: expect.any(Number) });
    // The pattern's counter and its moving bar change a little of the picture: more than a still, far less than footage.
    expect(r.materials[0]?.motionAmount).toBeGreaterThan(0.2);
    expect(r.materials[0]?.motionAmount).toBeLessThan(3);
  });
});

describe('generate: one person in every clip', () => {
  const requests = [
    { file: 'assets/gen-01.mp4', prompt: 'Close-up of a hand on the fabric of @image1', images: ['assets/product.png'] },
    { file: 'assets/gen-02.mp4', prompt: 'A woman holds @image1 up and smiles', images: ['assets/product.png'] },
    { file: 'assets/gen-03.mp4', prompt: 'She turns to show the fit' },
    { file: 'assets/logo.png', prompt: 'a red logo' },
  ];

  it('chooses the first clip that is not a close-up to be followed', () => {
    expect(anchorIndex(requests)).toBe(1);
    expect(anchorIndex([requests[0]!])).toBe(0);
    expect(anchorIndex([requests[3]!])).toBe(-1);
    // A clip that opted out is never the one the others follow.
    expect(anchorIndex([requests[0]!, { ...requests[1]!, anchor: false }, requests[2]!])).toBe(2);
  });

  it.skipIf(!ffmpeg)('makes that clip first and gives a frame of it to the other clips, without being asked; --no-anchor gives it to none', async () => {
    const asked: { kind: string; request: GenerateRequest }[] = [];
    const generator: Generator = {
      make: async (kind, request, out) => {
        asked.push({ kind, request });
        if (kind === 'video') await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=90x160:rate=30:duration=1', '-pix_fmt', 'yuv420p', out]);
        else await writeFile(out, 'picture');
        return {};
      },
    };
    const dir = path.join(root, 'anchor');
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    await writeFile(path.join(dir, 'assets', 'product.png'), 'p');
    const r = await makeMaterials(rt, { requests, dir, generator });
    expect(r.problems).toEqual([]);
    expect(r.anchor).toEqual({ picture: 'assets/anchor.jpg', from: 'clip' });
    // Four files were asked for and four were made: the anchor is one of the clips, never an extra one.
    expect(asked).toHaveLength(4);
    expect(r.materials.map((m) => [m.file, m.anchor === true])).toEqual([['assets/gen-02.mp4', true], ['assets/gen-01.mp4', false], ['assets/gen-03.mp4', false], ['assets/logo.png', false]]);
    expect(existsSync(path.join(dir, 'assets', 'anchor.jpg'))).toBe(true);
    const sent = (file: string): GenerateRequest | undefined => asked[r.materials.findIndex((m) => m.file === file)]?.request;
    expect(sent('assets/gen-02.mp4')).toEqual({ prompt: 'A woman holds @image1 up and smiles', images: [path.join(dir, 'assets', 'product.png')] });
    expect(sent('assets/gen-01.mp4')).toEqual({ prompt: 'Close-up of a hand on the fabric of @image1 ' + anchorSentence(2, 'clip'), images: [path.join(dir, 'assets', 'product.png'), path.join(dir, 'assets', 'anchor.jpg')] });
    expect(sent('assets/gen-03.mp4')).toEqual({ prompt: 'She turns to show the fit ' + anchorSentence(1, 'clip'), images: [path.join(dir, 'assets', 'anchor.jpg')] });
    expect(sent('assets/logo.png')).toEqual({ prompt: 'a red logo' });
    // The notes are the prompts as they were written, not as they were sent.
    expect((JSON.parse(await readFile(path.join(dir, 'materials.json'), 'utf8')) as Record<string, string>)['assets/gen-03.mp4']).toBe('She turns to show the fit');
    const plain: GenerateRequest[] = [];
    const off = path.join(root, 'no-anchor');
    await mkdir(path.join(off, 'assets'), { recursive: true });
    await writeFile(path.join(off, 'assets', 'product.png'), 'p');
    const none = await makeMaterials(rt, { requests: requests.slice(0, 3), dir: off, anchor: false, generator: { make: async (_k, request, out) => { plain.push(request); await writeFile(out, 'x'); return {}; } } });
    expect([none.problems, none.anchor]).toEqual([[], undefined]);
    expect(plain.map((q) => q.prompt)).toEqual(requests.slice(0, 3).map((q) => q.prompt));
    expect(existsSync(path.join(off, 'assets', 'anchor.jpg'))).toBe(false);
  });

  it('asks only for what a clip shares with the picture, so a clip of a product alone gets no person', () => {
    for (const s of [anchorSentence(1, 'clip'), anchorSentence(2, 'image')]) {
      expect(s).toContain('Whatever this clip shares with it (a person and their clothes, a product, a place) looks exactly as it does there');
      expect(s).toContain('add nothing from it that the description above does not ask for');
      expect(s).not.toMatch(/Keep the same person/);
    }
    const mia = anchorSentence(1, 'character', { name: 'Mia', description: 'a barista in her twenties,\n short dark hair' });
    expect(mia).toBe('@image1 is the person of this video (Mia: a barista in her twenties, short dark hair). When a person appears in this clip it is that person, with the same face, hair and build; add no person the description above does not ask for.');
  });

  it('a picture of the caller\'s is the anchor of every clip in the order asked; a request with "anchor": false stays out', async () => {
    const dir = path.join(root, 'given');
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    await writeFile(path.join(dir, 'assets', 'product.png'), 'p');
    await writeFile(path.join(dir, 'assets', 'mia.png'), 'm');
    const generator = counting();
    const list = [requests[0]!, requests[1]!, { ...requests[2]!, anchor: false }, requests[3]!];
    const r = await makeMaterials(rt, { requests: list, dir, generator, picture: { file: 'assets/mia.png', person: { name: 'Mia' } } });
    expect(r.problems).toEqual([]);
    expect(r.anchor).toEqual({ picture: 'assets/mia.png', from: 'character' });
    expect(r.materials.map((m) => [m.file, m.anchor === true])).toEqual(list.map((q) => [q.file, false]));
    expect(generator.asked.map((a) => a.request)).toEqual([
      { prompt: requests[0]!.prompt + ' ' + anchorSentence(2, 'character', { name: 'Mia' }), images: [path.join(dir, 'assets', 'product.png'), path.join(dir, 'assets', 'mia.png')] },
      { prompt: requests[1]!.prompt + ' ' + anchorSentence(2, 'character', { name: 'Mia' }), images: [path.join(dir, 'assets', 'product.png'), path.join(dir, 'assets', 'mia.png')] },
      { prompt: 'She turns to show the fit' },
      { prompt: 'a red logo' },
    ]);
    expect(existsSync(path.join(dir, 'assets', 'anchor.jpg'))).toBe(false);
    expect((await checkRequests(rt, [{ file: 'assets/x.mp4', prompt: 'x', anchor: 'no' }], dir)).map((p) => p.at)).toEqual(['[0].anchor']);
  });

  it('makes no clip that takes the anchor\'s frame while the anchor clip is not there: priced only when its price waits, not sent when it failed', async () => {
    const dir = path.join(root, 'waiting');
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    await writeFile(path.join(dir, 'assets', 'product.png'), 'p');
    const sent: GenerateRequest[] = [];
    const asking: Generator = {
      make: async (kind, request, out) => {
        sent.push(request);
        if (kind === 'video') throw new ConfirmNeeded({ credits: 25 }, 'It costs 25 credits.');
        await writeFile(out, 'picture');
        return {};
      },
    };
    const r = await makeMaterials(rt, { requests, dir, generator: asking });
    // The anchor clip's price waits for the user: the other clips are asked for their price only, so the total is whole.
    const product = path.join(dir, 'assets', 'product.png');
    expect(sent).toEqual([
      { prompt: 'A woman holds @image1 up and smiles', images: [product] },
      { prompt: 'Close-up of a hand on the fabric of @image1', images: [product], priceOnly: true },
      { prompt: 'She turns to show the fit', priceOnly: true },
      { prompt: 'a red logo' },
    ]);
    expect(r.materials.map((m) => [m.file, m.made, m.waiting === true, m.confirm?.credits])).toEqual([['assets/gen-02.mp4', false, false, 25], ['assets/gen-01.mp4', false, true, 25], ['assets/gen-03.mp4', false, true, 25], ['assets/logo.png', true, false, undefined]]);
    expect(r.toConfirm).toEqual({ credits: 75, materials: 3 });
    expect(r.problems.map((p) => p.at)).toEqual(['assets/gen-02.mp4', 'assets/gen-01.mp4', 'assets/gen-03.mp4']);
    // The anchor clip fails for good: the others are not sent at all, and one problem says why.
    const failed: GenerateRequest[] = [];
    const broken = await makeMaterials(rt, { requests: requests.slice(0, 3), dir: path.join(root, 'waiting'), generator: { make: async (_k, request) => { failed.push(request); throw new Error('the content was rejected'); } } });
    expect(failed.map((q) => q.prompt)).toEqual(['A woman holds @image1 up and smiles']);
    expect(broken.materials.map((m) => [m.file, m.waiting === true])).toEqual([['assets/gen-02.mp4', false], ['assets/gen-01.mp4', true], ['assets/gen-03.mp4', true]]);
    expect(broken.problems.map((p) => p.at)).toEqual(['assets/gen-02.mp4', 'assets/gen-02.mp4']);
    expect(broken.problems[1]?.message).toContain('2 clips wait for this one (assets/gen-01.mp4, assets/gen-03.mp4)');
    expect(broken.problems[1]?.fix).toContain('--no-anchor');
    expect(broken.toConfirm).toBeUndefined();
    // A generator that does not know "priceOnly" and makes the clip: it is kept and named.
    const eager: Generator = { make: async (_k, request, out) => { if (!request.priceOnly) throw new ConfirmNeeded({ credits: 25 }, 'It costs 25 credits.'); await writeFile(out, 'clip'); return { credits: 25 }; } };
    const loose = await makeMaterials(rt, { requests: requests.slice(1, 3), dir: path.join(root, 'waiting'), generator: eager });
    expect(loose.materials.map((m) => [m.file, m.made, m.unanchored === true])).toEqual([['assets/gen-02.mp4', false, false], ['assets/gen-03.mp4', true, true]]);
    expect(loose.problems.map((p) => p.level + ' ' + p.at)).toEqual(['error assets/gen-02.mp4', 'warning assets/gen-03.mp4']);
  });
});

describe('generate: the command behind POPOST_GEN_CMD', () => {
  it('passes the kind, the request and the output file, and reads the credits from the last line', async () => {
    const script = path.join(root, 'fake-gen.mjs');
    await writeFile(script, "import fs from 'node:fs';\nconst [kind, req, out] = process.argv.slice(2);\nconst r = JSON.parse(fs.readFileSync(req, 'utf8'));\nif (r.prompt === 'fail') { console.error('Paid generation is off: no spending limit is set.'); process.exit(1); }\nfs.writeFileSync(out, kind + '|' + r.prompt + '|' + (r.seconds ?? ''));\nconsole.log('working');\nconsole.log(JSON.stringify({ credits: 45, task: '1' }));\n");
    await chmod(script, 0o755);
    expect(commandGenerator({ ...rt, env: { ...rt.env, POPOST_GEN_CMD: undefined } })).toBeUndefined();
    const generator = commandGenerator({ ...rt, env: { ...rt.env, POPOST_GEN_CMD: process.execPath + ' ' + script } });
    const out = path.join(root, 'made.mp4');
    expect(await generator?.make('video', { prompt: 'a desk', seconds: 5 }, out)).toEqual({ credits: 45 });
    expect(await readFile(out, 'utf8')).toBe('video|a desk|5');
    await expect(generator?.make('image', { prompt: 'fail' }, path.join(root, 'no.png'))).rejects.toThrow('Paid generation is off');
  });

  it('reads a price to agree to from exit code 3, and materials lists it with the total and makes nothing', async () => {
    const script = path.join(root, 'asking-gen.mjs');
    await writeFile(script, "console.log(JSON.stringify({ confirm: { credits: 25, model: 'm', seconds: 5 } }));\nconsole.error('This costs 25 credits and nothing was charged.');\nprocess.exit(3);\n");
    const generator = commandGenerator({ ...rt, env: { ...rt.env, POPOST_GEN_CMD: process.execPath + ' ' + script } });
    if (!generator) throw new Error('no generator');
    const asked = await generator.make('video', { prompt: 'a desk', seconds: 5 }, path.join(root, 'asked.mp4')).catch((e: unknown) => e);
    expect(asked).toBeInstanceOf(ConfirmNeeded);
    expect(asked).toMatchObject({ confirm: { credits: 25, model: 'm', seconds: 5 }, message: 'This costs 25 credits and nothing was charged.' });
    const dir = path.join(root, 'asking');
    const r = await makeMaterials(rt, { requests: [{ file: 'assets/a.mp4', prompt: 'a desk', seconds: 5 }, { file: 'assets/b.mp4', prompt: 'a chair', seconds: 5 }], dir, generator });
    expect(r.materials.map((m) => [m.made, m.confirm?.credits])).toEqual([[false, 25], [false, 25]]);
    expect([r.credits, r.toConfirm]).toEqual([0, { credits: 50, materials: 2 }]);
    expect(r.problems[0]?.message).toContain('Nothing was charged');
    expect(existsSync(path.join(dir, 'assets', 'a.mp4'))).toBe(false);
  });
});
