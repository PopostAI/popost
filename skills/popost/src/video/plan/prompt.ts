/**
 * The prompt of the plan step: the template's card (TEMPLATE.md, one screen), the materials, the brief, and the shape
 * of the answer. A weak model does this well because nothing in the answer is a time: it writes two lists that line
 * up with the template by position, and the program does the rest.
 */
import type { Slots } from '../template/types';
import type { Problem } from '../types';
import { materialLines, type PlanMaterial } from './materials';
import type { ChatMessage } from './model';

export const SYSTEM = [
  'You fill a video template. The template fixes every length, cut, transition and caption time. You write only the content: what fills each shot and the words of each caption beat.',
  'Answer with one JSON object and nothing else: no explanation and no code fence.',
  'Write no times and no frame numbers, except "in" (the frame of a piece of footage to start from; 0 when unsure).',
  'Use only files that are listed under "Materials", spelled exactly as listed. Never invent a file.',
  '"zoom" of a picture is how much it grows per second (0.04 is a slow push in), not a scale.',
].join('\n');

export interface PromptInput {
  /** TEMPLATE.md. */
  card: string;
  slots: Slots;
  /** What the new video is about, in the user's words. */
  brief: string;
  materials: PlanMaterial[];
  /** The language of the captions, as a word a model understands ("Chinese", "English"). Default: the brief's language. */
  language?: string;
  /** Shots may be filled by { "generate": "..." }; product: reference pictures of the product go with every clip. */
  generate?: { product: boolean };
  /** What each shot of the source showed, by position. */
  shotNotes?: string[];
  /** The most characters each line may have, by position: what the voice says in that beat. */
  budgets?: number[];
  /**
   * The voice (and its speed) the writer of the fill puts into it: given when the agent writes the fill itself (plan
   * --dry --voice), since template fill --speak reads the voice from the fill. A model's fill gets them by program.
   */
  voice?: { name: string; speed?: number };
}

const indexes = (n: number): string => Array.from({ length: n }, (_, i) => i).join(' ');

/** The lines of the card that speak to a person at a terminal are left out. */
const cardForModel = (card: string): string => card.split('\n').filter((l) => !l.startsWith('- template check')).join('\n').trim();

const clip = (text: string, n: number): string => (Array.from(text).length > n ? Array.from(text).slice(0, n).join('') + '…' : text);

/**
 * The beats, one line each, numbered as "captions" indexes them. The card drops this list when it would not fit its
 * one screen (a long reference); the prompt has the room, and a model that sees every beat with its length and what
 * was said there writes lines that fit. Left out when the card has its own "## Beats" list.
 */
const beatLines = (o: PromptInput): string[] => {
  const lines = o.slots.captions?.lines ?? [];
  if (!lines.length || (!o.budgets && /^## Beats/m.test(o.card))) return [];
  return [
    o.budgets ? '## Limits of the lines' : '## Beats', '',
    'One line per beat: its place in "captions", how long it lasts' + (o.budgets ? ', the most characters the voice can say in it (spaces and punctuation are not counted),' : ',') + ' and what the source said or showed there.', '',
    ...lines.map((l, i) => '- captions[' + i + '] ' + l.seconds + ' s' + (o.budgets?.[i] !== undefined ? ', at most ' + o.budgets[i] + ' characters' : '') + (l.example ? ': "' + clip(l.example.text.replace(/"/g, "'"), 30) + '" (' + l.example.chars + ')' : '') +
      (l.shown === false ? ' (spoken only)' : '') + (l.speech === 'on-camera' ? ' (on camera)' : '') + (l.unsure ? ' (unsure)' : '')),
    '',
  ];
};

/** The keys of the voice as they are written into the fill: "voice": "v1", and "speed": 1.1 when one was given. */
const voiceKeys = (o: PromptInput): string[] =>
  o.voice ? ['"voice": ' + JSON.stringify(o.voice.name), ...(o.voice.speed !== undefined ? ['"speed": ' + o.voice.speed] : [])] : [];

const keysRule = (o: PromptInput): string => {
  const keys = voiceKeys(o);
  if (!keys.length) return '- Write "shots" and "captions" only. Leave out "voice", "speed" and every other optional key unless the brief gives its exact value.';
  return '- Write "shots", "captions" and ' + keys.join(' and ') + ', exactly so: template fill --speak speaks the lines with that voice. Leave out ' + (o.voice?.speed === undefined ? '"speed" and ' : '') + 'every other optional key unless the brief gives its exact value.';
};

const answerPart = (o: PromptInput): string[] => {
  const shots = o.slots.shots.length, beats = o.slots.captions?.lines.length ?? 0, cap = o.slots.captions?.capacity;
  return [
    '## Answer', '',
    '{"shots": [...]' + (beats ? ', "captions": [...]' : '') + voiceKeys(o).map((k) => ', ' + k).join('') + '}', '',
    '- "shots": exactly ' + shots + ' entries, for shots ' + indexes(shots) + ' in this order.',
    ...(beats ? ['- "captions": exactly ' + beats + ' strings, for beats ' + indexes(beats) + ' in this order' + (cap ? ', each at most ' + cap.cjk + ' full-width or ' + cap.latin + ' Latin characters' : '') + '. Together they read as one short script about the brief.',
      o.budgets
        ? '- Every line has its own limit, written above: the voice cannot say more in that beat, and a longer line is refused. Say less rather than squeeze: drop a detail, keep the point.'
        : '- Write each line about as long as the source\'s line of that beat (the number in brackets): a longer line makes the video longer when it is spoken.'] : []),
    ...(o.slots.captions?.lines.some((l) => l.shown === false) ? ['- A beat marked "spoken only" is said by the voice and not drawn; it still needs its line. "(unsure)" marks a source line that may be misheard.'] : []),
    ...(o.slots.captions?.lines.some((l) => l.speech === 'on-camera') ? ['- A beat marked "on camera" is said by a person in a generated clip, never by the voice-over: write the words that person says.'] : []),
    '- Captions are written in ' + (o.language ?? 'the language of the brief') + '.',
    keysRule(o),
    ...(o.generate ? [
      '- A shot may also be {"generate": "..."}: a clip is made from your words. Say in English what is seen, in one or two sentences: who or what, doing what, where, how the camera moves. No text on screen. Keep the people and the place the same from shot to shot by describing them the same way every time.' +
        (o.generate.product ? ' The product is the picture @image1: write "@image1" wherever the product appears.' : ''),
    ] : []),
    ...(o.materials.length ? ['- Prefer footage and pictures from the materials where they fit; use a card only where the reference has a graphic title or ending.'] : o.generate ? ['- There are no materials: use "generate" for shots that need footage; a card or color is allowed only where the reference itself uses a graphic plate.'] : ['- There are no materials: obtain the required footage, illustrations or product pictures before filling those shots. A card or color is allowed only for a reference graphic plate.']),
    '- Preserve the reference visual medium, rendering finish, camera path, reveal mechanism and transition carrier. Missing assets or a failed generation never authorize replacing a cinematic or character shot with flat cards, primitive geometry or another medium.',
  ];
};

/** The rules of a fill as the model is told them, one per line: the system message, then the shape of the answer. */
export const planRules = (o: PromptInput): string[] => [...SYSTEM.split('\n'), ...answerPart(o).filter((l) => l.startsWith('- '))];

export const planMessages = (o: PromptInput): ChatMessage[] => [
  { role: 'system', content: SYSTEM },
  { role: 'user', content: [
    cardForModel(o.card), '',
    '## Materials', '',
    ...(o.materials.length ? materialLines(o.materials) : ['(none)']), '',
    '## Brief', '',
    o.brief.trim(), '',
    ...beatLines(o),
    ...(o.shotNotes?.length ? ['## What the source showed', '', ...o.shotNotes.map((n, k) => '- shots[' + k + ']: ' + n.trim()), ''] : []),
    ...answerPart(o),
  ].join('\n') },
];

/** What the model is told when its answer has problems: each with its place and one way to fix it. */
export const repairMessage = (problems: Problem[]): string => [
  'The answer has ' + problems.length + ' problem' + (problems.length === 1 ? '' : 's') + '. Correct ' + (problems.length === 1 ? 'it' : 'them') + ', change nothing else, and answer with the whole JSON object again and nothing else.',
  ...problems.map((p) => '- ' + p.at + ': ' + p.message + (p.allowed ? ' Allowed: ' + p.allowed.join(', ') + '.' : '') + (p.fix ? ' Fix: ' + p.fix : '')),
].join('\n');
