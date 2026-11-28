/**
 * saveTemplate: a described reference (measure.json, text.json, transcript.json as "describe" writes them) becomes a
 * template directory of text files. The same inputs always give the same files, byte for byte. loadTemplate reads one
 * back and says what is wrong when it cannot.
 */
import { createHash } from 'node:crypto';
import type { Runtime } from '../../runtime';
import type { Inset } from '../describe/inset';
import type { Measure, Problem, Unrecovered } from '../types';
import { droppedFrom, droppedShots, droppedTexts, endAt, withReading } from '../elements/carry';
import type { Elements } from '../elements/types';
import { withCaptionRoles } from '../elements/caption-roles';
import type { Transcript } from '../speech/types';
import { factsOfSpeech, kindRanges, type SpeechFile } from '../describe/speech-kind';
import type { TextTrack } from '../text/types';
import { error, warning } from '../project/check-common';
import { estimateCapacity, measureCapacities, type Band } from './capacity';
import { cardBudget, templateCard } from './card';
import { shotTexts } from './facts';
import { referenceFingerprint } from './fingerprint';
import { slotsOf } from './slots';
import { cardLayout, sourceBeats, startsOf, templateFrom } from './structure';
import { barPlaces, titlePlaces } from '../retarget/titles';
import { FILES, SLOTS_FORMAT, TEMPLATE_FORMAT, TEMPLATE_VERSION, TEXT_FORMAT, type Capacity, type ReferenceTextFile, type Slots, type Template, type TemplatePackage } from './types';

/** JSON with the keys of every object sorted, so that a hash does not depend on the order a file was written in. */
const canonical = (v: unknown): string =>
  Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
    : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}'
    : JSON.stringify(v) ?? 'null';

/** A content hash of a measurement: the first 16 hex digits of the SHA-256 of its canonical JSON. */
export const measureHash = (m: Measure): string => 'sha256:' + createHash('sha256').update(canonical(m)).digest('hex').slice(0, 16);

export const jsonText = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';

/** Measures every box a fill writes text into (the caption band, a card's title and lines) on one page. */
const measureBands = async (rt: Runtime, bands: Band[]): Promise<Capacity[]> =>
  measureCapacities(rt, bands).catch((e: unknown) => bands.map((b) => ({ ...estimateCapacity(b), method: 'estimated: the measurement failed (' + (e instanceof Error ? e.message : String(e)).split('\n')[0] + ')' })));

const capacitiesOf = async (rt: Runtime, t: Template): Promise<{ capacity?: Capacity; card?: Slots['card']; problems: Problem[] }> => {
  const c = t.captions;
  const card = cardLayout(t);
  const bands = [...(c ? [{ canvas: t.canvas, box: c.box, style: c.style }] : []), ...(card ? [card.title, card.line] : [])];
  const measured = await measureBands(rt, bands);
  const capacity = c ? measured[0] : undefined;
  const [title, line] = measured.slice(c ? 1 : 0);
  const problems: Problem[] = [];
  if (!c) problems.push(warning('captions', 'The reference has no beats (no caption was read and no speech was heard), so the template has no caption slots.', 'Describe the reference with a text reader (POPOST_OCR_CMD) and a transcriber (POPOST_ASR_CMD) to keep its lines.'));
  if (measured.some((m) => !m.measured)) problems.push(warning('slots', 'The text capacities are estimates (' + (measured.find((m) => !m.measured)?.method ?? '') + ').', 'Save again where Chrome is available (POPOST_CHROME) to measure them.'));
  if (capacity && (capacity.cjk < 1 || capacity.latin < 1)) problems.push(error('slots.captions.capacity', 'The caption band holds ' + capacity.cjk + ' full-width and ' + capacity.latin + ' Latin characters: no line fits.', 'Check the reference\'s caption cues (text.json): their size and position make the band.'));
  return { ...(capacity ? { capacity } : {}), ...(card && title && line ? { card: { title, line, lines: card.lines } } : {}), problems };
};

export interface SaveOptions {
  measure: Measure;
  text?: TextTrack;
  transcript?: Transcript;
  /** The frame around the content, when describe found one (inset.json). */
  inset?: Inset;
  name: string;
  /** Where it came from, for people; never a file name of a private data set. Default: the name. */
  label?: string;
  outDir: string;
  /**
   * The reading of the frames (elements.json, already checked) and the directory describe wrote, which holds its
   * pictures. measure: the measurement its shot numbers refer to, when the measure above has its shots cut in parts
   * (--max-shot); by default the measure above.
   */
  reading?: { elements: Elements; dir: string; measure?: Measure };
  /** What was not recovered of the reference: describe's list (unrecovered.json) and what the reader added. Kept in the template. */
  unrecovered?: Unrecovered[];
  /**
   * The record of the speech's kind (speech.json, confirmed): the beats follow it and the template keeps the kinds.
   * Without it (a reference described before the record existed) every heard word is a line, as before.
   */
  speech?: SpeechFile;
}

/** The kinds of the speech that reach the template: the phrases that lie before the end, when shots were dropped there. */
const kindsUntil = (speech: SpeechFile | undefined, end: number | undefined): ReturnType<typeof kindRanges> =>
  kindRanges(speech)?.filter((k) => end === undefined || k.start < end);

/** The inputs of a template: as given, or ending where the shots the reading drops whole at the end begin. */
const sourceOf = (o: SaveOptions): { measure: Measure; text?: TextTrack; transcript?: Transcript; from?: number } => {
  const numbered = o.reading?.measure ?? o.measure;
  const text = o.text && o.reading ? withCaptionRoles(o.text, o.reading.elements, numbered) : o.text;
  const given = { measure: o.measure, ...(text ? { text } : {}), ...(o.transcript ? { transcript: o.transcript } : {}) };
  const from = o.reading ? droppedFrom(o.reading.elements, numbered.shots.length) : undefined;
  const end = from === undefined ? undefined : numbered.shots[from]?.start;
  return end === undefined || from === undefined ? given : { ...endAt(given, end), from };
};

export const saveTemplate = async (rt: Runtime, o: SaveOptions): Promise<{ problems: Problem[] }> => {
  const src = sourceOf(o);
  const m = src.measure;
  const kinds = kindsUntil(o.speech, src.from === undefined ? undefined : m.source.frames);
  const made = templateFrom({ measure: m, ...(src.text ? { text: src.text } : {}), ...(src.transcript ? { transcript: src.transcript } : {}), ...(o.inset ? { inset: o.inset } : {}), name: o.name, label: o.label ?? o.name, hash: measureHash(m), ...(kinds ? { kinds } : {}) });
  if (o.speech) made.speech = factsOfSpeech(o.speech);
  const fingerprint = src.from === undefined ? undefined : referenceFingerprint(o.reading?.measure ?? o.measure);
  if (fingerprint) made.source.fingerprint = fingerprint;
  // The reading: each shot's elements, an effect of its own as "custom" with the picture of its frames (a path from the template directory).
  const reading = o.reading;
  const numbered = reading?.measure ?? o.measure;
  const picture = (file: string): string => rt.path.relative(o.outDir, rt.path.join(reading?.dir ?? '', file));
  const dropped = reading && src.from !== undefined ? droppedShots(reading.elements, numbered, src.from) : [];
  const read0 = reading ? { ...withReading(made, m, numbered, reading.elements, picture), ...(dropped.length ? { dropped } : {}) } : made;
  const template = o.unrecovered?.length ? { ...read0, unrecovered: o.unrecovered } : read0;
  const { capacity, card: cardSlot, problems } = await capacitiesOf(rt, template);
  // The same beats templateFrom kept, with their wording, and the text with the roles the speech gave it.
  const read = sourceBeats(m, src.text, src.transcript, kinds);
  const words = titlePlaces(m, read.text).map((xs) => xs.map((x) => x.text));
  const tplBar = barPlaces(m, read.text);
  const slots = slotsOf(template, capacity, { ...(read.text ? { text: read.text } : {}), ...(src.transcript ? { transcript: src.transcript } : {}), ...(cardSlot ? { card: cardSlot } : {}), beats: read.beats, words, ...(tplBar ? { bar: tplBar.texts } : {}) });
  const card = templateCard(template, slots, { ...(read.text ? { text: read.text } : {}), sourceFps: m.source.fps, picture: (p) => rt.path.relative(rt.cwd, rt.path.resolve(o.outDir, p)) });
  if (card.tokens > cardBudget(template)) problems.push(warning(FILES.card, FILES.card + ' is about ' + card.tokens + ' tokens, over the ' + cardBudget(template) + ' aimed at, even with one line per shot.', 'Nothing to do for a long reference; a model reads slots.json for the rest.'));
  const starts = startsOf(template);
  const short = template.shots.flatMap((s, k) => (s.frames < 3 ? [warning('shots[' + k + ']', 'Shot ' + (k + 1) + ' is ' + s.frames + ' frame(s) long: probably a flash or a misread change, kept as measured.', 'Look at the reference around frame ' + (starts[k] ?? 0) + '; a fill may give it a colour.')] : []));
  await rt.fs.mkdir(o.outDir);
  await rt.fs.writeFile(rt.path.join(o.outDir, FILES.template), jsonText(template));
  await rt.fs.writeFile(rt.path.join(o.outDir, FILES.slots), jsonText(slots));
  await rt.fs.writeFile(rt.path.join(o.outDir, FILES.card), card.text);
  // The reference's own words, kept apart from the structure; a save without them must not leave an earlier save's.
  // With the words of the platform's and the author's layers, which a re-make never shows (shots dropped whole included).
  const never = reading ? droppedTexts(reading.elements, numbered, o.text) : [];
  const text: ReferenceTextFile | undefined = src.text ? { format: TEXT_FORMAT, version: TEMPLATE_VERSION, shots: shotTexts(m, src.text), ...(never.length ? { dropped: never } : {}) } : undefined;
  if (text) await rt.fs.writeFile(rt.path.join(o.outDir, FILES.text), jsonText(text));
  else await rt.fs.rm(rt.path.join(o.outDir, FILES.text));
  // Evidence belongs to the template it was measured on; a new save makes it stale.
  await rt.fs.rm(rt.path.join(o.outDir, FILES.evidence));
  return { problems: [...problems, ...short] };
};

/** A template directory that cannot be read as one. The message says what to do. */
export class TemplateError extends Error {
  override name = 'TemplateError';
}

const readJson = async (rt: Runtime, file: string, what: string): Promise<unknown> => {
  const text = await rt.fs.readText(file).catch(() => { throw new TemplateError('No ' + what + ' at ' + file + '. Make a template with: popost video template save <reference-dir> --out <template-dir> --name <name>.'); });
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new TemplateError(file + ' is not valid JSON (' + (e instanceof Error ? e.message : String(e)) + '). Save the template again.');
  }
};

export const loadTemplate = async (rt: Runtime, dir: string): Promise<TemplatePackage> => {
  const template = (await readJson(rt, rt.path.join(dir, FILES.template), FILES.template)) as Template;
  const slots = (await readJson(rt, rt.path.join(dir, FILES.slots), FILES.slots)) as Slots;
  if (template?.format !== TEMPLATE_FORMAT || slots?.format !== SLOTS_FORMAT)
    throw new TemplateError(dir + ' does not hold a template (template.json "format" is ' + JSON.stringify(template?.format) + '). Use a directory written by: popost video template save.');
  if (template.version !== TEMPLATE_VERSION || slots.version !== TEMPLATE_VERSION)
    throw new TemplateError('The template in ' + dir + ' is version ' + template.version + '; this engine reads version ' + TEMPLATE_VERSION + '. Save it again from its reference.');
  if (!Array.isArray(template.shots) || template.shots.length !== slots.shots?.length)
    throw new TemplateError('template.json and slots.json in ' + dir + ' do not agree on the shots. Save the template again.');
  // Optional: a template saved without a text reader, or before the file existed, has none, and one that does not fit is left out.
  const text = await rt.fs.readText(rt.path.join(dir, FILES.text)).then((t) => JSON.parse(t) as ReferenceTextFile).catch(() => undefined);
  const shown = text?.format === TEXT_FORMAT && Array.isArray(text.shots) && text.shots.length === template.shots.length ? text.shots : undefined;
  const never = shown && Array.isArray(text?.dropped) ? text.dropped.filter((x) => typeof x === 'string') : [];
  return { template, slots, dir, ...(shown ? { text: shown } : {}), ...(never.length ? { dropped: never } : {}) };
};
