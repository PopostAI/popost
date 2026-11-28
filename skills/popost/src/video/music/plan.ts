/**
 * The music plan of a video, from the reading of its reference (references/video-sound.md, rules R2, R4 and R5). One
 * music source at any moment: by default one bed for the whole video, the user's own file first, else one generated
 * track when the reference has music, else none. A clip makes music of its own only under a stated exception (R4)
 * that the plan records with what it rests on, and that is shown to the user with the plan and its price. What the
 * reading says decides; a plan that departs from it (music where the reference has none, none where it has some)
 * rests on the user's own words.
 *
 * Generated music can be unavailable (no account, or the platform's generator switched off: its quote answers
 * UPSTREAM_ERROR with HTTP 503 and charges nothing). The plan then has no generated bed and says so in one line; the
 * user's own file still works, and nothing waits for the generator or asks it again.
 */
import { PopostApiError } from '../../providers/errors';
import type { Runtime } from '../../runtime';
import { connected, quoteMusicTrack, type MusicQuote } from '../hosted-api';
import { BASIS_MEANS, CLIP_MUSIC_BASES, isClipMusicBasis, type ClipMusicBasis } from '../sound/modes';
import { isSoundFile, SOUND_FILE, type SoundFacts } from '../sound/reading';
import { FACTS_FILE } from '../template/facts';
import { loadTemplate } from '../template/save';
import type { ClipMusicException, MusicPlan } from './provenance';

/** The exceptions by letter, as video-sound.md lists them: a to g. */
export const BASIS_LETTERS: Readonly<Record<string, ClipMusicBasis>> = Object.fromEntries(CLIP_MUSIC_BASES.map((b, i) => [String.fromCharCode(97 + i), b]));
/** Exceptions that hold for the whole video, not one clip: one continuous clip (a), and music that changes by segment everywhere (b for "all"). */
export const WHOLE_VIDEO = 'all';
const WHOLE_ONLY: readonly ClipMusicBasis[] = ['single-clip'];

/** A basis named by its letter (a..g) or its name; undefined for anything else. */
export const basisOf = (text: string): ClipMusicBasis | undefined => {
  const t = text.trim().toLowerCase();
  return BASIS_LETTERS[t] ?? (isClipMusicBasis(t) ? t : undefined);
};

export const letterOf = (b: ClipMusicBasis): string => String.fromCharCode(97 + CLIP_MUSIC_BASES.indexOf(b));

/** The recorded exception that lets this clip carry music: its own, else one for the whole video. */
export const exceptionFor = (list: readonly ClipMusicException[] | undefined, file: string): ClipMusicException | undefined =>
  (list ?? []).find((c) => c.clip === file) ?? (list ?? []).find((c) => c.clip === WHOLE_VIDEO);

/** Whether the video has no bed at all because of an exception: one continuous clip, or music by segment over the whole video. */
export const noBedByException = (list: readonly ClipMusicException[] | undefined): ClipMusicException | undefined =>
  (list ?? []).find((c) => c.clip === WHOLE_VIDEO && (c.basis === 'single-clip' || c.basis === 'per-segment'));

/** Why an exception cannot be recorded as asked, or undefined. */
export const exceptionProblem = (basis: ClipMusicBasis, clip: string): string | undefined =>
  WHOLE_ONLY.includes(basis) && clip !== WHOLE_VIDEO ? '(' + letterOf(basis) + ') ' + basis + ' holds for the whole video: write --clip-music ' + WHOLE_VIDEO + '.' : undefined;

/** The plan with one exception added (or replacing the one recorded for the same clip). A no-bed exception leaves the video without a bed. */
export const withException = (plan: MusicPlan, e: ClipMusicException): MusicPlan => {
  const clipMusic = [...(plan.clipMusic ?? []).filter((c) => c.clip !== e.clip), e];
  if (!noBedByException(clipMusic) || plan.music !== 'generated') return { ...plan, clipMusic };
  const { style: _style, ...rest } = plan;
  return { ...rest, music: 'none', clipMusic };
};

export const withoutException = (plan: MusicPlan, clip: string): MusicPlan => {
  const clipMusic = (plan.clipMusic ?? []).filter((c) => c.clip !== clip);
  const { clipMusic: _old, ...rest } = plan;
  return clipMusic.length ? { ...rest, clipMusic } : rest;
};

/** One line per exception, for the user: the clip, the basis by letter and name, what it means, what it rests on. */
export const exceptionLines = (list: readonly ClipMusicException[] | undefined): string[] =>
  (list ?? []).map((c) => (c.clip === WHOLE_VIDEO ? 'the whole video' : c.clip) + ': (' + letterOf(c.basis) + ') ' + c.basis + ', ' + BASIS_MEANS[c.basis] + '. On record: "' + c.why + '"');

/** The reading of the reference's sound: its facts and where they were read, or undefined when none is at hand. */
export interface Reading { facts: SoundFacts; from: string; seconds?: number }

const fromDescribe = async (rt: Runtime, dir: string): Promise<Reading | undefined> => {
  const file = dir.endsWith('.json') ? dir : rt.path.join(dir, SOUND_FILE);
  const data = await rt.fs.readText(file).then((t) => JSON.parse(t) as unknown, () => undefined);
  return isSoundFile(data) ? { facts: data.facts, from: file, ...(data.measured ? { seconds: data.measured.seconds } : {}) } : undefined;
};

const fromTemplate = async (rt: Runtime, dir: string): Promise<Reading | undefined> => {
  const pkg = await loadTemplate(rt, dir).catch(() => undefined);
  const t = pkg?.template;
  return t?.sound ? { facts: t.sound, from: rt.path.join(dir, 'template.json'), seconds: t.frames / t.canvas.fps } : undefined;
};

/**
 * The reading for a project: the directory or file given (what describe wrote, a sound.json, or a template), else the
 * template the project was filled from (reference.facts.json names it).
 */
export const readingFor = async (rt: Runtime, project: string, given?: string): Promise<Reading | undefined> => {
  if (given !== undefined) return (await fromDescribe(rt, given)) ?? (await fromTemplate(rt, given));
  const facts = await rt.fs.readText(rt.path.join(project, FACTS_FILE)).then((t) => JSON.parse(t) as { template?: { dir?: unknown } }, () => undefined);
  const dir = typeof facts?.template?.dir === 'string' ? rt.path.resolve(project, facts.template.dir) : undefined;
  return dir ? fromTemplate(rt, dir) : undefined;
};

/** Generated music: its quote for a length, or why there is none now (no account; the generator is off or failed: HTTP 503). */
export type MusicOffer = { available: true; quote: MusicQuote } | { available: false; why: string };

export const UNAVAILABLE_NOW = 'Generated music is not available on popost.ai right now (nothing was charged): the plan has no generated bed. The user\'s own music file still works (popost video music own).';
export const NO_ACCOUNT = 'Generated music needs a connected popost.ai account (popost auth login): without one the plan has no generated bed. The user\'s own music file still works (popost video music own).';

/**
 * Whether an error of the music quote means the generator is off or out of reach. The quote never calls the generator,
 * so any UPSTREAM_ERROR on it (the platform answers 503 when music is switched off) says so, and so does a gateway's own
 * error page in front of the platform (a 502, 503 or 504 that is not the platform's envelope).
 */
export const musicUnavailable = (e: unknown): boolean =>
  e instanceof PopostApiError &&
  (e.code === 'UPSTREAM_ERROR' || (e.code === 'BAD_RESPONSE' && [502, 503, 504].includes(e.status ?? 0)));

/** Asks once for the price of `seconds` of music; a 503 is an answer (unavailable), never retried. Other refusals are thrown. */
export const musicOffer = async (rt: Runtime, seconds: number): Promise<MusicOffer> => {
  if (!connected(rt)) return { available: false, why: NO_ACCOUNT };
  try {
    return { available: true, quote: await quoteMusicTrack(rt, seconds) };
  } catch (e) {
    if (musicUnavailable(e)) return { available: false, why: UNAVAILABLE_NOW };
    throw e;
  }
};

/** What the reading proposes: a bed (generated, or the user's file when there is one), none, or ask (it cannot tell). */
export type Proposal = { music: 'generated' | 'own' | 'none'; style?: string; says: string } | { music: 'ask'; says: string };

/**
 * The default plan (R2, R5): the user's own file first; else a generated bed when the reference has music and the
 * generator answers; else none. A reading that cannot tell (likely, unknown) proposes nothing until someone listens or
 * the user says.
 */
export const proposal = (o: { reading?: Reading; ownFile: boolean; offer?: MusicOffer }): Proposal => {
  const music = o.reading?.facts.music;
  if (o.ownFile) return { music: 'own', says: 'Music: the user\'s own file, as the one bed of the video.' };
  if (music === 'no') return { music: 'none', says: 'Music: none, as in the reference. A track is added only on the user\'s own words (--music generated|own --asked "<their words>").' };
  if (music !== 'yes') return { music: 'ask', says: 'Music: the reading cannot tell whether the reference has music (' + (music ?? 'no reading') + '). Ask the user, or run describe with the sound analysis; until then no music is planned.' };
  if (o.offer && !o.offer.available) return { music: 'none', says: 'Music: the reference has music, but ' + o.offer.why.charAt(0).toLowerCase() + o.offer.why.slice(1) };
  const style = o.reading?.facts.style;
  const price = o.offer?.available ? ' About ' + o.offer.quote.credits + ' credits' + (o.offer.quote.model ? ' (' + o.offer.quote.model + ')' : '') + '.' : '';
  return { music: 'generated', ...(style ? { style } : {}), says: 'Music: one generated bed under the whole video' + (style ? ', in the reference\'s style: ' + style : '') + '; every clip is asked for without music.' + price };
};

/**
 * Why a chosen plan departs from the reading without the user's words (R5), or undefined. own is always allowed (the
 * user's file goes first).
 */
export const departure = (music: MusicPlan['music'], reading: Reading | undefined, asked: string | undefined): string | undefined => {
  if (asked?.trim() || music === 'own' || !reading) return undefined;
  if (music === 'generated' && reading.facts.music === 'no') return 'The reference has no music (' + reading.from + '), and music follows the reading, not taste (video-sound.md, R5). Record generated music only on the user\'s own words: --asked "<their words>".';
  if (music === 'none' && reading.facts.music === 'yes') return 'The reference has music (' + reading.from + '): its plan is one bed (video-sound.md, R2). Record none only when the user said so: --asked "<their words>".';
  return undefined;
};
