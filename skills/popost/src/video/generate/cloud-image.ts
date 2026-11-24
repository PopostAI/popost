/**
 * Pictures for the built-in generator (cloud.ts), on the platform's image path, as `popost image run` uses it: the
 * picture is priced (POST /images/quote) and made (POST /images/generations) only with the user's agreement to the
 * price, under an idempotency key derived from the request and with the agreed price as its maxCredits. The model
 * comes from POPOST_IMAGE_MODEL (unset: the platform's default), never from the request. The picture is written in the
 * format the extension of the output file asks for, converted with ffmpeg when the platform made another one.
 */
import { sha256File } from '../../core/util';
import type { JsonRecord } from '../../providers/base';
import { AmbiguousSubmitError } from '../../providers/errors';
import { PopostProvider, type PopostQuote } from '../../providers/popost';
import type { Runtime } from '../../runtime';
import { runFfmpegOk } from '../media/ffmpeg';
import { agreeToPrice, GenerateError, requestKey, RETRY_HINT, type CloudSettings } from './cloud';
import type { GenerateRequest } from './index';

const PICTURE_TYPES: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** POPOST_IMAGE_MODEL is the user's own choice: it may differ from a default the private config pins. */
const withModel = (config: JsonRecord, model: string): JsonRecord => ({
  ...config,
  providerOverrides: [...(Array.isArray(config.providerOverrides) ? config.providerOverrides : []), { provider: 'popost', model }],
});

/** Moves the picture of the task to out, in the format out asks for. */
const place = async (rt: Runtime, provider: PopostProvider, taskId: string, out: string, wanted: string): Promise<void> => {
  const dir = out + '.parts';
  try {
    const [first] = await provider.materialize(taskId, dir);
    const from = typeof first?.localPath === 'string' ? first.localPath : undefined;
    if (!from) throw new GenerateError('popost.ai made the picture (task ' + taskId + ') but gave no file of it. Try again later.');
    if (first?.mimeType === wanted) return await rt.fs.rename(from, out);
    const converted = rt.programs
      ? await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-i', from, '-frames:v', '1', ...(wanted === 'image/jpeg' ? ['-q:v', '2'] : []), out]).then(() => true, () => false)
      : false;
    if (converted) return;
    // Nothing here converts it: the picture is kept as it was made (browsers and ffmpeg read a picture by its bytes).
    await rt.fs.rename(from, out);
    rt.stderr('note: popost.ai made a ' + String(first?.mimeType) + ' picture and it could not be converted here; ' + rt.path.basename(out) + ' holds it as it was made.\n');
  } finally {
    await rt.fs.rm(dir);
  }
};

/** Makes the picture a request asks for at out, on popost.ai; resolves with the credits it was charged. */
export const makePicture = async (rt: Runtime, s: CloudSettings, config: JsonRecord, request: GenerateRequest, out: string): Promise<{ credits?: number }> => {
  if (request.videos?.length || request.audios?.length) throw new GenerateError('A picture is made from reference pictures only; this request also names clips or sounds. Nothing was sent.', 2);
  const wanted = PICTURE_TYPES[rt.path.extname(out).toLowerCase()];
  if (!wanted) throw new GenerateError('A picture is written as .png, .jpg or .webp; "' + rt.path.basename(out) + '" is none of them. Nothing was sent.', 2);
  const provider = new PopostProvider(rt, { config: s.imageModel ? withModel(config, s.imageModel) : config });
  const aspect = request.aspect ?? '1:1';
  const refs = await Promise.all((request.images ?? []).map(async (value) => ({ kind: 'local', value, sha256: await sha256File(rt, value) })));
  const quote = (await provider.quote({ model: s.imageModel ?? null, aspect, count: 1, refs })) as PopostQuote;
  agreeToPrice(s, { credits: quote.totalCredits, model: quote.model, aspectRatio: aspect, balance: quote.balance });
  const key = requestKey('image', { model: s.imageModel ?? null, prompt: request.prompt, aspect, images: refs.map((r) => r.sha256) });
  const made = await provider
    .submit(request.prompt, { aspect, refs, model: quote.model, count: 1, options: { idempotencyKey: key, maxCredits: String(quote.totalCredits) } })
    .catch((error: unknown) => {
      if (error instanceof AmbiguousSubmitError) throw new GenerateError('The picture was asked for, but whether it was made is unknown. ' + RETRY_HINT);
      throw error;
    });
  await place(rt, provider, String(made.taskId), out, wanted);
  return { credits: typeof made.costCredits === 'number' ? made.costCredits : quote.totalCredits };
};
