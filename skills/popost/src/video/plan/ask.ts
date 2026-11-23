/**
 * askFill: a model writes a fill for a template, the program checks it with the template's own rules, and what is
 * wrong goes back to the model as a list of places and fixes. Whatever the model answers, a fill leaves here only
 * when checkFill has no error for it.
 */
import type { Runtime } from '../../runtime';
import { checkFill } from '../template/check';
import type { RetargetPlan } from '../retarget/index';
import type { TemplatePackage } from '../template/types';
import type { Problem } from '../types';
import { error } from '../project/check-common';
import type { MaterialRequest } from '../generate/index';
import { unmark } from '../retarget/marks';
import { spokenChars } from '../retarget/pace';
import { BUDGET_SLACK, lineBudgets } from '../voice/pace';
import { splitGenerated, type GenerateOptions } from './generated';
import type { PlanMaterial } from './materials';
import type { Message, Model, ModelUsage } from './model';
import { planMessages, repairMessage } from './prompt';

export const DEFAULT_ATTEMPTS = 3;

/** The end of the JSON object that starts at text[start], or -1. Braces inside strings do not count. */
const objectEnd = (text: string, start: number): number => {
  let depth = 0, inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) { if (c === '\\') i++; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
};

/**
 * The JSON object of an answer. Models wrap it: in a code fence, after a sentence, after their reasoning in
 * <think> tags. The first object that parses is taken.
 */
export const extractJson = (answer: string): { value?: unknown; problem?: Problem } => {
  const text = answer.replace(/<think>[\s\S]*?<\/think>/g, '');
  for (let at = text.indexOf('{'); at >= 0; at = text.indexOf('{', at + 1)) {
    const end = objectEnd(text, at);
    if (end < 0) break;
    try { return { value: JSON.parse(text.slice(at, end + 1)) as unknown }; } catch { /* try the next brace */ }
  }
  return { problem: error('(answer)', text.includes('{') ? 'The answer holds no complete JSON object (a bracket or a quote is not closed, or a comma is missing).' : 'The answer holds no JSON object.', 'Answer with one JSON object: {"shots": [...], "captions": [...]}.') };
};

/** A fill may name only files that are among the materials. */
const unknownFiles = (fill: RetargetPlan, materials: PlanMaterial[]): Problem[] => {
  const known = new Map(materials.map((m) => [m.file, m.kind]));
  const names = (kind: PlanMaterial['kind']): string => materials.filter((m) => m.kind === kind).map((m) => m.file).join(', ') || 'none';
  return fill.shots.flatMap((s, k): Problem[] => {
    const key = 'footage' in s ? 'footage' : 'picture' in s ? 'picture' : undefined;
    if (!key) return [];
    const file = (s as Record<string, unknown>)[key];
    if (typeof file !== 'string' || known.get(file) === key) return [];
    return [error('shots[' + k + '].' + key, known.has(file) ? '"' + file + '" is a ' + known.get(file) + ', not a ' + key + '.' : '"' + file + '" is not among the materials.', 'Use one of: ' + names(key) + '; or fill this shot with a card or a color.')];
  });
};

export interface PlanAttempt {
  answer: string;
  /** Everything checkFill said about this answer (errors and warnings). */
  problems: Problem[];
  ms: number;
  usage?: ModelUsage;
}

export interface PlanResult {
  /** The fill that passed, or undefined when no attempt did. */
  fill?: RetargetPlan;
  attempts: PlanAttempt[];
  /** The first answer passed. */
  first: boolean;
  model: string;
  /** With "generate" shots: the clips to make before the fill can be built (src/generate makeMaterials). */
  requests?: MaterialRequest[];
}

export interface AskOptions {
  pkg: TemplatePackage;
  /** TEMPLATE.md of the template. */
  card: string;
  brief: string;
  model: Model;
  materials?: PlanMaterial[];
  /** Where the materials are: with it, files are looked at (footage long enough for its shot). */
  assetsDir?: string;
  attempts?: number;
  language?: string;
  /** Allow shots filled by { "generate": "..." }, within these limits. */
  generate?: GenerateOptions;
  /** What each shot of the source showed, by position (a person's or a vision model's notes). */
  shotNotes?: string[];
  /**
   * The most characters each line may have, by position (lineBudgets of the voice that will speak them), and the
   * pace they were made from, for the message. A longer line is refused before anything is spoken.
   */
  budgets?: { max: number[]; pace: number; tempo?: number };
  /**
   * Pictures of the product as data URLs (pictureUrl), in the order a generated clip calls them @image1, @image2:
   * the model that writes the fill sees what it is writing about.
   */
  productPictures?: string[];
}

/**
 * The budget of every caption line for a voice that says `pace` characters a second; undefined without a pace or without
 * beats. With a tempo cap (--fit-tempo) a line may be sped up that much to fit its beat, so it holds that much more.
 */
export const paceBudgets = (pkg: TemplatePackage, pace: number | undefined, tempo?: number): AskOptions['budgets'] => {
  const beatSeconds = (pkg.slots.captions?.lines ?? []).map((l) => l.seconds);
  const faster = tempo && tempo > 1 ? tempo : undefined;
  return pace && beatSeconds.length ? { max: lineBudgets(beatSeconds, pace * (faster ?? 1)), pace, ...(faster ? { tempo: faster } : {}) } : undefined;
};

/** Lines the voice cannot say inside their beat. A hand-written fill is held to the same budgets (template check --pace). */
export const budgetProblems = (pkg: TemplatePackage, fill: RetargetPlan, b: AskOptions['budgets']): Problem[] => {
  if (!b) return [];
  return (fill.captions ?? []).flatMap((line, i): Problem[] => {
    const max = b.max[i], n = spokenChars(unmark(line).text).length;
    const seconds = pkg.slots.captions?.lines[i]?.seconds;
    if (max === undefined || n <= max * BUDGET_SLACK) return [];
    const speed = b.pace + ' a second' + (b.tempo ? ', sped up at most ' + b.tempo + ' times' : '');
    return [error('captions[' + i + ']', 'The line has ' + n + ' characters; beat ' + i + ' lasts ' + seconds + ' s and the voice says about ' + speed + ', so it holds ' + max + '.', 'Say the same in ' + max + ' characters or fewer.')];
  });
};

const judge = async (rt: Runtime, o: AskOptions, answer: string): Promise<{ fill?: RetargetPlan; problems: Problem[]; requests?: MaterialRequest[] }> => {
  const parsed = extractJson(answer);
  if (parsed.problem) return { problems: [parsed.problem] };
  const split = o.generate ? splitGenerated(parsed.value, o.pkg, o.generate) : { fill: parsed.value, requests: [], shots: [] as number[], problems: [] as Problem[] };
  if (split.problems.length) return { problems: split.problems };
  const fill = split.fill as RetargetPlan;
  // A clip that is still to be made is not on disk yet: what checkFill says about its file does not apply.
  const toMake = new Set(split.shots.map((k) => 'shots[' + k + '].footage'));
  const problems = (await checkFill(rt, o.pkg, fill, o.assetsDir ? { dir: o.assetsDir } : {})).filter((p) => !toMake.has(p.at));
  if (problems.some((p) => p.level === 'error')) return { problems };
  const known = [...(o.materials ?? []), ...split.requests.map((r): PlanMaterial => ({ file: r.file, kind: 'footage' }))];
  const all = [...problems, ...(o.materials ? unknownFiles(fill, known) : []), ...budgetProblems(o.pkg, fill, o.budgets)];
  return all.some((p) => p.level === 'error') ? { problems: all } : { fill, problems: all, ...(split.requests.length ? { requests: split.requests } : {}) };
};

export const askFill = async (rt: Runtime, o: AskOptions): Promise<PlanResult> => {
  const messages: Message[] = planMessages({
    card: o.card, slots: o.pkg.slots, brief: o.brief, materials: o.materials ?? [], ...(o.language ? { language: o.language } : {}),
    ...(o.generate ? { generate: { product: (o.generate.images?.length ?? 0) > 0 } } : {}), ...(o.shotNotes ? { shotNotes: o.shotNotes } : {}), ...(o.budgets ? { budgets: o.budgets.max } : {}),
  });
  const asked = messages[1];
  if (o.productPictures?.length && asked && typeof asked.content === 'string') {
    messages[1] = { role: 'user', content: [
      { type: 'text', text: asked.content + '\n\nThe ' + o.productPictures.length + ' picture' + (o.productPictures.length === 1 ? '' : 's') + ' below show' + (o.productPictures.length === 1 ? 's' : '') + ' the product (@image1' + (o.productPictures.length > 1 ? ' to @image' + o.productPictures.length : '') + '). Look at ' + (o.productPictures.length === 1 ? 'it' : 'them') + ' before you write: what it is, its colour, how it is used.' },
      ...o.productPictures.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
    ] };
  }
  const attempts: PlanAttempt[] = [];
  const limit = Math.max(1, o.attempts ?? DEFAULT_ATTEMPTS);
  for (let i = 0; i < limit; i++) {
    const started = Date.now();
    const reply = await o.model.ask(messages);
    const { fill, problems, requests } = await judge(rt, o, reply.text);
    attempts.push({ answer: reply.text, problems, ms: Date.now() - started, ...(reply.usage ? { usage: reply.usage } : {}) });
    if (fill) return { fill, attempts, first: i === 0, model: o.model.name, ...(requests ? { requests } : {}) };
    messages.push({ role: 'assistant', content: reply.text }, { role: 'user', content: repairMessage(problems.filter((p) => p.level === 'error')) });
  }
  return { attempts, first: false, model: o.model.name };
};
