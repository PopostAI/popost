/**
 * The contract of a template (slots.json): one slot per shot (which fills it accepts; for footage, how much the clip
 * must supply), one per beat (how many characters fit; what the source said or showed there), and the optional
 * voice and colours.
 */
import { UNSURE, type Beat } from '../describe/beats';
import { paceOf } from '../speech/index';
import type { Transcript } from '../speech/types';
import type { TextTrack } from '../text/types';
import { barBox, wordBox } from '../retarget/titles';
import { charsOf, estimateCapacity } from './capacity';
import { footageNeed } from './structure';
import { CARD_MIN_SECONDS, SLOTS_FORMAT, TEMPLATE_VERSION, type Capacity, type CaptionSlot, type FillKind, type ShotSlot, type Slots, type SourceKind, type Template, type TemplateShot, type WordSlot } from './types';

const r2 = (v: number): number => Math.round(v * 100) / 100;

const ORDER: Record<SourceKind, FillKind[]> = {
  footage: ['footage', 'picture', 'color', 'card'],
  picture: ['picture', 'footage', 'color', 'card'],
  colour: ['color', 'card', 'picture', 'footage'],
};

/**
 * What a shot accepts: footage, a picture or a colour always (the structure holds with any of them; the first in the
 * list is closest to the source), a card only in a shot long enough to read one, and a scene, which draws the whole
 * shot whatever filled it in the source, last.
 */
export const acceptsOf = (source: SourceKind, frames: number, fps: number): FillKind[] =>
  [...ORDER[source].filter((k) => k !== 'card' || frames >= CARD_MIN_SECONDS * fps), 'scene'];

/** What the source said or showed in each beat, and how sure the readers were (src/describe/beats.ts Beat). */
type SourceBeat = Pick<Beat, 'text' | 'confidence'>;

const captionSlots = (tpl: Template, cap: Capacity, beats: SourceBeat[], pace: Slots['voice']['pace']): CaptionSlot[] =>
  (tpl.captions?.beats ?? []).map((b, i) => {
    const seconds = r2((b.end - b.start) / tpl.canvas.fps);
    const line = beats[i]?.text.trim();
    return {
      at: 'captions[' + i + ']', beat: [b.start, b.end], seconds, max: { cjk: cap.cjk, latin: cap.latin },
      ...(line ? { example: { text: line, chars: charsOf(line).length } } : {}),
      ...(b.shown === false ? { shown: false as const } : {}),
      ...((beats[i]?.confidence ?? 1) < UNSURE ? { unsure: true as const } : {}),
      ...(pace ? { spoken: Math.round(pace.charactersPerSecond * seconds) } : {}),
    };
  });

/** The places of a shot's laid-on words; texts: what the source laid in each. */
const wordSlots = (tpl: Template, s: TemplateShot, k: number, texts: string[] = []): WordSlot[] =>
  (s.words ?? []).map((p, j) => {
    const { box, size } = wordBox(p);
    const cap = estimateCapacity({ canvas: tpl.canvas, box, style: { size } });
    const was = texts[j]?.trim();
    return { at: 'shots[' + k + '].words[' + j + ']', seconds: r2((p.to - p.from) / tpl.canvas.fps), max: { cjk: cap.cjk, latin: cap.latin }, ...(was ? { example: { text: was, chars: charsOf(was).length } } : {}) };
  });

/**
 * The contract of a template. o.words: what the source laid in each shot's places (retarget/titles.ts titlePlaces).
 * o.beats: the source's beats with their wording (sourceBeats), in the order of the
 * template's; without them a slot's example is the caption line of the same position, as before beats existed.
 */
/** The bar's slot: a word per place, with what the source said there and about how many characters fit between its neighbours. */
const barSlot = (tpl: Template, texts: string[] = []): Slots['bar'] => {
  const bar = tpl.bar;
  if (!bar) return undefined;
  const words = bar.places.map((_p, j) => {
    const { box, size } = barBox(bar.places, j);
    const cap = estimateCapacity({ canvas: tpl.canvas, box, style: { size } });
    const was = texts[j]?.trim();
    return { max: { cjk: cap.cjk, latin: cap.latin }, ...(was ? { example: { text: was, chars: charsOf(was).length } } : {}) };
  });
  return { at: 'bar', words, marked: bar.marked };
};

export const slotsOf = (tpl: Template, capacity: Capacity | undefined, o: { text?: TextTrack; transcript?: Transcript; card?: Slots['card']; beats?: SourceBeat[]; words?: string[][]; bar?: string[] } = {}): Slots => {
  const fps = tpl.canvas.fps;
  const shots = tpl.shots.map((s, k): ShotSlot => {
    const need = footageNeed(tpl, k);
    const words = wordSlots(tpl, s, k, o.words?.[k]);
    return { at: 'shots[' + k + ']', frames: s.frames, seconds: r2(s.frames / fps), source: s.source, accepts: acceptsOf(s.source, s.frames, fps), footage: { frames: need, seconds: r2(need / fps) }, ...(words.length ? { words } : {}) };
  });
  const pace = paceOf(o.transcript);
  const beats = o.beats ?? (o.text?.cues ?? []).filter((c) => c.role === 'caption').sort((a, b) => a.start - b.start).map((c) => ({ text: c.text, confidence: c.confidence }));
  const c = tpl.captions;
  return {
    format: SLOTS_FORMAT, version: TEMPLATE_VERSION, template: tpl.name, shots,
    ...(c && capacity ? { captions: { box: c.box, size: c.style.size ?? 0, capacity, lines: captionSlots(tpl, capacity, beats, pace) } } : {}),
    ...(o.card ? { card: o.card } : {}),
    ...(tpl.bar ? { bar: barSlot(tpl, o.bar) } : {}),
    voice: {
      optional: true, keys: ['voice', 'speed', 'say'],
      note: 'With speech (template fill --speak) every line is spoken and its beat takes the spoken length (a beat with shown: false is spoken and not drawn); the pauses between beats stay and every shot moves with the beat it falls in. Shots then get longer or shorter, so give footage some room.',
      ...(pace ? { pace } : {}),
    },
    colours: { optional: true, keys: ['captionColor', 'captionOutline'], defaults: { captionColor: '#ffffff', captionOutline: '#111111' } },
  };
};
