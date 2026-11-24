/**
 * A character of the user's popost.ai character library as the anchor of a video's clips: GET /characters/{id} on the
 * Open API (the account and address every platform command uses) answers its name, its description and a short-lived
 * signed link to its picture. The picture is downloaded into the project, where the generator reads it as a reference
 * picture like any other file; nothing else of the character is kept.
 */
import { downloadResult, EXTENSIONS, sniffImageMime, type PopostClient } from '../../providers/api';
import { isRecord } from '../../providers/base';
import type { Runtime } from '../../runtime';
import { GenerateError } from './cloud';
import type { AnchorPicture } from './index';

const MAX_PICTURE_BYTES = 20 * 1024 * 1024;
/** What a model takes as a reference picture. */
const TAKEN = ['image/png', 'image/jpeg', 'image/webp'];

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** The file name of a character's picture in the project: its id, held to letters, digits, - and _. */
const fileName = (id: string, ext: string): string => 'character-' + id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) + ext;

/**
 * Reads the character and puts its picture at <project>/assets/character-<id>.<ext>. A character that is still being
 * made, failed or has no picture is refused with what to do; so is an id that is not the user's (NOT_FOUND from the API).
 */
export const characterAnchor = async (rt: Runtime, client: PopostClient, id: string, projectDir: string): Promise<AnchorPicture> => {
  const data = await client.request('GET', '/characters/' + encodeURIComponent(id));
  if (!isRecord(data) || typeof data.id !== 'string') throw new GenerateError('popost.ai answered without the character ' + id + '. Try again later.');
  const url = text(data.imageUrl);
  if (data.status !== 'ready' || !url)
    throw new GenerateError('The character ' + (text(data.name) ?? id) + ' has no picture to use yet (its status is ' + JSON.stringify(data.status ?? null) + '). Open it on popost.ai, wait until it is ready or make it again, then run this again; or give a picture with --anchor-image.', 2);
  const dir = rt.path.join(projectDir, 'assets');
  await rt.fs.mkdir(dir);
  const partial = rt.path.join(dir, fileName(id, '.partial'));
  try {
    const bytes = await downloadResult(rt, url, partial, MAX_PICTURE_BYTES, 120, { what: 'the picture of the character', retry: 'run the command again: it asks for a new link' });
    const mime = sniffImageMime(bytes.subarray(0, 16));
    if (!mime || !TAKEN.includes(mime)) throw new GenerateError('The picture of the character ' + (text(data.name) ?? id) + ' is not a JPEG, PNG or WebP picture, so a generator cannot take it. Give a picture with --anchor-image.', 2);
    const file = 'assets/' + fileName(id, EXTENSIONS[mime] ?? '.png');
    await rt.fs.rename(partial, rt.path.join(projectDir, file));
    const name = text(data.name), description = text(data.description);
    return { file, person: { ...(name ? { name } : {}), ...(description ? { description } : {}) } };
  } finally {
    await rt.fs.rm(partial);
  }
};
