/**
 * A reading carried into a template: each shot's layout, the layers whose look a re-make keeps, the places for the new
 * subject (by id), the platform's and the author's layers it drops, the captions' style, the marks, and a change in
 * that is an effect of its own as "custom" with its description and the picture of its frames. A shot dropped whole at
 * the end (the platform's end card) leaves the measurement before the template is made of it, so every part of the
 * template (beats, words, slots, text) ends where the re-make ends. Pure.
 */
import { shotSheetFile, transitionFile } from '../describe/frames';
import { shownIn } from '../describe/kind';
import type { Transcript } from '../speech/types';
import type { DroppedShot, Template, TemplateEffect, TemplateElements, TemplateLayer, TemplateShot } from '../template/types';
import type { TextTrack } from '../text/types';
import type { Box, Measure } from '../types';
import { covered, measuredLabel } from './check';
import { isDropped, type Elements, type Layer, type ShotReading } from './types';

/** A screen or footage layer this large (share of the frame) makes a shot full-frame footage or a recording. */
export const FULL_FRAME = 0.8;
/** In a designed shot every picture is smaller than this share of the frame. */
export const DESIGNED = 0.6;
/** A layer holds a text when it covers this share of the text's box. */
const HOLDS = 0.5;

const area = (b: Box): number => b[2] * b[3];
const tidy = (text: string): string => text.replace(/\s+/g, ' ').trim();
const PICTURES: readonly string[] = ['screen', 'footage', 'picture', 'product', 'person'];

/** Full-frame footage or a recording, a designed picture, or neither clearly. */
export const frameOf = (layers: readonly Layer[], layout: string): 'full' | 'designed' | undefined => {
  const shown = layers.filter((l) => !isDropped(l.role));
  if (/\bfull[- ]?(frame|screen)\b/i.test(layout) || shown.some((l) => (l.kind === 'screen' || l.kind === 'footage') && area(l.box) >= FULL_FRAME)) return 'full';
  if (/record|footage|film|camera|video/i.test(layout)) return undefined;
  const grounded = shown.some((l) => l.kind === 'ground' || l.kind === 'frame');
  return grounded && shown.filter((l) => PICTURES.includes(l.kind)).every((l) => area(l.box) < DESIGNED) ? 'designed' : undefined;
};

/** The first shot (from 0) of the run of dropped shots at the end, or undefined when the reading drops none there. */
export const droppedFrom = (e: Elements, shots: number): number | undefined => {
  let k = shots;
  while (k > 1 && e.shots.find((s) => s.shot === k)?.drop) k--;
  return k < shots ? k : undefined;
};

/** A measurement (and its text and speech) ending at frame end: the shots before it, the text and the words on screen or said before it. */
export const endAt = (o: { measure: Measure; text?: TextTrack; transcript?: Transcript }, end: number): { measure: Measure; text?: TextTrack; transcript?: Transcript } => {
  const m = o.measure;
  const step = Math.max(1, m.rhythm.step);
  const measure: Measure = {
    ...m,
    source: { ...m.source, frames: end, duration: end / m.source.fps },
    shots: m.shots.filter((s) => s.start < end).map((s) => ({ ...s, end: Math.min(s.end, end), events: s.events.filter((e) => e.start < end) })),
    boundaries: m.boundaries.filter((b) => b.frame < end),
    rhythm: { ...m.rhythm, change: m.rhythm.change.slice(0, Math.ceil(end / step)) },
  };
  const text = o.text ? { ...o.text, cues: o.text.cues.filter((c) => c.start < end).map((c) => ({ ...c, end: Math.min(c.end, end) })) } : undefined;
  const transcript = o.transcript ? { ...o.transcript, words: o.transcript.words.filter((w) => w.start < end).map((w) => ({ ...w, end: Math.min(w.end, end) })) } : undefined;
  return { measure, ...(text ? { text } : {}), ...(transcript ? { transcript } : {}) };
};

/** The shots dropped whole at the end, for the template's note. */
export const droppedShots = (e: Elements, m: Measure, from: number): DroppedShot[] =>
  m.shots.slice(from).map((s) => ({
    shot: s.index + 1, seconds: [Number((s.start / m.source.fps).toFixed(2)), Number((s.end / m.source.fps).toFixed(2))],
    reason: e.shots.find((x) => x.shot === s.index + 1)?.drop ?? '',
  }));

const kept = (l: Layer): TemplateLayer => ({
  id: l.id, kind: l.kind, box: l.box, look: l.look, ...(l.content ? { content: l.content } : {}),
  ...(l.enters ? { enters: l.enters } : {}), ...(l.moves ? { moves: l.moves } : {}), ...(l.leaves ? { leaves: l.leaves } : {}),
});

/** What the template keeps of one shot's reading. runsOn: false for a part of a shot cut in two that does not end it. */
export const shotElements = (s: ShotReading, runsOn = true): TemplateElements => {
  const frame = frameOf(s.layers, s.layout);
  return {
    layout: s.layout, ...(s.job ? { job: s.job } : {}), ...(frame ? { frame } : {}),
    design: s.layers.filter((l) => l.role === 'design').map(kept),
    content: s.layers.filter((l) => l.role === 'content').map(kept),
    dropped: s.layers.flatMap((l) => (isDropped(l.role) ? [{ id: l.id, kind: l.kind, role: l.role, ...(l.content ? { content: l.content } : {}) }] : [])),
    ...(s.captions ? { captions: { base: s.captions.base, ...(s.captions.highlight ? { highlight: s.captions.highlight } : {}), ...(s.captions.reveal ? { reveal: s.captions.reveal } : {}) } } : {}), ...(s.emphasis?.length ? { emphasis: s.emphasis } : {}),
    ...(s.rebuild ? { rebuild: s.rebuild } : {}), ...(s.sameEffectAsNext && runsOn ? { runsOn: true as const } : {}),
  };
};

/**
 * The effect into shot k (from 0) of the measurement the reading numbers, when the reading saw one: its length on the
 * template's clock (ratio: template frames per source frame), which scene draws it, and its picture (picture: the path
 * the template keeps for a file describe wrote).
 */
export const shotEffect = (e: Elements, m: Measure, k: number, ratio: number, picture: (file: string) => string): TemplateEffect | undefined => {
  const t = e.shots.find((s) => s.shot === k + 1)?.transitionIn;
  const b = m.boundaries[k - 1];
  if (k === 0 || !b || t?.kind !== 'custom') return undefined;
  const span = b.kind === 'cut' ? Math.round((t.seconds ?? 0) * m.source.fps) : b.end - b.start - 1;
  const frames = Math.max(2, Math.round(span * ratio));
  const by = e.shots.find((s) => s.shot === k)?.sameEffectAsNext ? 'before' : 'this';
  return {
    transition: 'custom', frames, description: t.description ?? '', picture: picture(b.kind === 'cut' ? shotSheetFile(k + 1) : transitionFile(k + 1)),
    measured: b.kind === 'cut' ? 'cut' : measuredLabel(b) + ' ' + Math.round((b.end - b.start - 1) * ratio) + 'f', by,
  };
};

/**
 * The words of the platform's and the author's layers as the text reader read them: every watermark, and every line
 * a platform or creator layer of its shot holds (shots dropped whole included). A re-make never shows them.
 */
export const droppedTexts = (e: Elements, m: Measure, text: TextTrack | undefined): string[] => {
  if (!text) return [];
  const out = new Set<string>();
  for (const c of text.cues) {
    const line = tidy(c.text);
    if (!line || c.role === 'caption') continue;
    const held = m.shots.some((s) => shownIn(c, s, text.step) && (e.shots.find((x) => x.shot === s.index + 1)?.layers ?? []).some((l) => isDropped(l.role) && covered(c.box, l.box) >= HOLDS));
    if (c.role === 'watermark' || held) out.add(line);
  }
  return [...out];
};

/**
 * A template with the reading carried into its shots. m: the measurement the template was made of; numbered: the one
 * the reading's shot numbers refer to (m, unless shots were cut in parts: each part then has its shot's elements, the
 * first part its effect, the last its motion that runs on). picture: the path the template keeps for a file describe
 * wrote. A shot with an effect of its own loses its preset: the engine cuts there, and a scene draws it.
 */
export const withReading = (t: Template, m: Measure, numbered: Measure, e: Elements, picture: (file: string) => string): Template => {
  const ratio = t.canvas.fps / numbered.source.fps;
  const shots = t.shots.map((shot, k): TemplateShot => {
    const x = m.shots[k];
    const j = x ? numbered.shots.findIndex((s) => s.start <= x.start && x.start < s.end) : -1;
    const whole = numbered.shots[j];
    const r = e.shots.find((s) => s.shot === j + 1);
    if (!x || !whole || !r) return shot;
    const first = x.start === whole.start;
    const effect = first ? shotEffect(e, numbered, j, ratio, picture) : undefined;
    const { in: _measured, ...rest } = shot;
    const read = first ? r.transitionIn : undefined;
    // Visual corrections must survive saving: otherwise a cut read from the pictures silently becomes the
    // measured fade again. Keep measured parameters only when they describe the same transition kind.
    const corrected = read && read.kind !== 'custom' ? read.kind === 'cut' ? rest : {
      ...rest,
      in: { ...(shot.in?.transition === read.kind ? shot.in : {}), transition: read.kind,
        frames: read.seconds === undefined ? shot.in?.frames ?? 2 : Math.max(2, Math.round(read.seconds * t.canvas.fps)) },
    } : shot;
    return { ...(effect ? rest : corrected), elements: shotElements(r, x.end === whole.end), ...(effect ? { effect } : {}) };
  });
  return { ...t, shots };
};
