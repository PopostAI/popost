/**
 * A character of the user's popost.ai library as the anchor of `popost video materials`: GET /characters/{id} against
 * the in-memory platform of the image tests. No network, no real key.
 */
import { describe, expect, it } from 'vitest';
import { cli, err, everythingWritten, KEY, newScene, ok, ORIGIN, tinyPng } from '../image-helpers';
import { DEFAULT_KEY_ENV, PopostClient } from '../../src/providers/api';
import { characterAnchor } from '../../src/video/generate/character';

const FACE = tinyPng([180, 140, 120]);
const MIA = { id: 'ch_1', name: 'Mia', description: 'a barista in her twenties, short dark hair', kind: 'custom', status: 'ready', imageUrl: ORIGIN + '/files/mia.png' };

const scene = async () => {
  const s = await newScene({ files: { '/work/project/requests.json': JSON.stringify([{ file: 'assets/a.mp4', prompt: 'she pours milk' }]) } });
  s.stub.files.set('mia.png', FACE);
  s.stub.set('GET', '/characters/ch_1', () => ok(MIA));
  s.stub.set('GET', '/characters/ch_new', () => ok({ ...MIA, id: 'ch_new', status: 'generating', imageUrl: null }));
  s.stub.set('GET', '/characters/ch_other', () => err(404, 'NOT_FOUND', 'No such character'));
  const client = new PopostClient(s.rt, { baseUrl: undefined, keyEnv: DEFAULT_KEY_ENV, timeoutSec: 60 });
  return { ...s, client };
};

describe('video materials --character', () => {
  it('reads the character with the account\'s key and puts its picture into the project\'s assets', async () => {
    const { rt, stub, client } = await scene();
    const anchor = await characterAnchor(rt, client, 'ch_1', '/work/project');
    expect(anchor).toEqual({ file: 'assets/character-ch_1.png', person: { name: 'Mia', description: 'a barista in her twenties, short dark hair' } });
    expect(await rt.fs.readFile('/work/project/assets/character-ch_1.png')).toEqual(FACE);
    const asked = stub.calls('GET', '/characters/ch_1');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.headers.authorization).toBe('Bearer ' + KEY);
    // The picture comes from the signed link without the key.
    const picture = stub.requests.find((r) => r.path === '/files/mia.png');
    expect(picture?.headers.authorization).toBeUndefined();
    expect((await rt.fs.readdir('/work/project/assets')).sort()).toEqual(['character-ch_1.png']);
  });

  it('refuses a character without a picture and one that is not the user\'s, and leaves nothing behind', async () => {
    const { rt, client } = await scene();
    await expect(characterAnchor(rt, client, 'ch_new', '/work/project')).rejects.toThrow(/has no picture to use yet \(its status is "generating"\).*--anchor-image/);
    await expect(characterAnchor(rt, client, 'ch_other', '/work/project')).rejects.toThrow(/NOT_FOUND|No such character/);
    expect((await rt.fs.stat('/work/project/assets/character-ch_new.png')) === null).toBe(true);
  });

  it('refuses a picture a generator cannot take', async () => {
    const { rt, stub, client } = await scene();
    stub.files.set('mia.png', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    await expect(characterAnchor(rt, client, 'ch_1', '/work/project')).rejects.toThrow(/not a JPEG, PNG or WebP picture/);
    expect(await rt.fs.readdir('/work/project/assets')).toEqual([]);
  });

  it('the command names the failure in one JSON document, takes one anchor option at a time, and prints no key', async () => {
    const { rt } = await scene();
    const env = { ...rt.env, POPOST_GEN_CMD: 'gen' };
    const run = (...argv: string[]) => cli({ ...rt, env }, 'video', 'materials', '/work/project/requests.json', '--out', '/work/project', ...argv);
    const missing = await run('--character', 'ch_other');
    expect(missing.code).not.toBe(0);
    expect(JSON.stringify(missing.data)).toMatch(/The character ch_other could not be used/);
    const both = await run('--character', 'ch_1', '--no-anchor');
    expect(JSON.stringify(both.data)).toMatch(/Give one of --anchor-image, --character and --no-anchor/);
    const notPicture = await run('--anchor-image', '/work/project/requests.json');
    expect(JSON.stringify(notPicture.data)).toMatch(/--anchor-image is a PNG, JPEG or WebP picture that exists/);
    expect((await everythingWritten(rt)).join('\n')).not.toContain(KEY);
  });
});
