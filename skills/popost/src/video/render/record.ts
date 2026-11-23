/**
 * The record of renders and reviews: one small JSON file per project under reviews/ of the work directory (work.ts).
 * Each `popost video render` adds what it wrote; each `popost video compare` of a render adds which render it compared
 * and its worst shots. From it compare counts the review rounds and names the shots that stayed worst, and render says
 * when the render before it was never compared. A rule in a document gets skipped once a video seems good enough; a
 * count the tools keep, printed where the agent reads, does not.
 *
 * A round is one state of the project's picture that was compared: renders whose picture files hash the same are one
 * state, so rendering again without a change (at another scale, say) and comparing does not make a new round. The
 * record is best effort: a record that is missing or cannot be read is an empty one, a render whose file was deleted
 * since is only a path in it, and only the latest entries are kept.
 */
import { isFile, isInside, relPosix, sha256, walkFiles, writeAtomic } from '../../core/util';
import type { Runtime } from '../../runtime';
import { reviewsDir } from '../work';

/** Entries kept per project: a video is reviewed in a handful of rounds, so this holds many sessions. */
const KEEP = 40;
/** Shot scores (0..1) this close in two rounds are the same: fixing what made a shot worst moves its score further. */
export const SIMILAR = 0.05;
/** Hex digits kept of a hash: enough to tell a project's renders apart, short enough to keep the record small. */
const HASH = 16;
/** Rounds the review asks for at least, and at most (references/video.md, step 7). */
export const ROUNDS = { least: 2, most: 4 } as const;
/** Sound only: a voice spoken again rewrites these and changes nothing in the picture. */
const SOUND = /\.(m4a|mp3|wav|aac|ogg|oga|opus|flac)$/i;
const SOUND_KINDS = new Set(['audio', 'voice', 'speech']);
/** Where the pictures of a project come from besides video.json: its materials, its scenes and the scripts they load. */
const PICTURE_DIRS = ['assets', 'scenes', 'lib'];

export interface RenderEntry {
  /** The video written (absolute), a hash of its bytes, the hash of the project's picture files, when (ISO). */
  out: string;
  video: string;
  picture: string;
  at: string;
}

export interface WorstShot { shot: number; score: number; by: string }

export interface CompareEntry {
  at: string;
  /** The render compared: the hash of its bytes as it was rendered, and the state of the project it shows. */
  video: string;
  picture: string;
  /** The file given to compare, the reference and a hash of it, the text files when given (all absolute). */
  file: string;
  reference: string;
  referenceHash: string;
  referenceText?: string;
  otherText?: string;
  worst: WorstShot[];
  /** The mean score of all shots: worst always names a few shots, and one above the mean is not a difference to chase. */
  mean?: number;
}

interface ProjectRecord { project: string; renders: RenderEntry[]; compares: CompareEntry[] }

const isString = (v: unknown): v is string => typeof v === 'string';
const isRender = (v: unknown): v is RenderEntry => {
  const r = v as Partial<RenderEntry> | null;
  return !!r && isString(r.out) && isString(r.video) && isString(r.picture) && isString(r.at);
};
const isCompare = (v: unknown): v is CompareEntry => {
  const c = v as Partial<CompareEntry> | null;
  return !!c && isString(c.at) && isString(c.video) && isString(c.picture) && isString(c.reference) && isString(c.referenceHash) && Array.isArray(c.worst);
};

/** A record file as it was written, or undefined when it is missing or is not one (it is then started again). */
const readRecord = async (rt: Runtime, file: string): Promise<ProjectRecord | undefined> => {
  try {
    const v = JSON.parse(await rt.fs.readText(file)) as Partial<ProjectRecord>;
    if (!isString(v.project) || !Array.isArray(v.renders) || !Array.isArray(v.compares)) return undefined;
    return { project: v.project, renders: v.renders.filter(isRender), compares: v.compares.filter(isCompare) };
  } catch {
    return undefined;
  }
};

const writeRecord = (rt: Runtime, file: string, r: ProjectRecord): Promise<void> =>
  writeAtomic(rt, file, JSON.stringify({ project: r.project, renders: r.renders.slice(-KEEP), compares: r.compares.slice(-KEEP) }) + '\n');

/** A path with its links resolved where the file system has them, so that two ways to name a file are one. */
const real = async (rt: Runtime, p: string): Promise<string> => {
  const abs = rt.path.resolve(rt.cwd, p);
  return rt.fs.realpath ? rt.fs.realpath(abs).catch(() => abs) : abs;
};

/** One file per project, named so that a person can tell which: the folder's name and a hash of its whole path. */
const recordFile = (rt: Runtime, project: string): string =>
  rt.path.join(reviewsDir(rt), (rt.path.basename(project).replace(/[^\w.-]+/g, '-').slice(0, 40) || 'project') + '-' + sha256(project).slice(0, 12) + '.json');

const fileHash = async (rt: Runtime, file: string): Promise<string> => sha256(await rt.fs.readFile(file)).slice(0, HASH);

/** The files video.json names that show something: materials that are not sound only (with words files) and scenes. */
const namedPictureFiles = async (rt: Runtime, root: string): Promise<string[]> => {
  try {
    const p = JSON.parse(await rt.fs.readText(rt.path.join(root, 'video.json'))) as { materials?: { kind?: string; file?: unknown; words?: unknown }[]; segments?: { base?: { scene?: unknown } }[] };
    const materials = (p.materials ?? []).flatMap((m) => [...(SOUND_KINDS.has(m.kind ?? '') ? [] : [m.file]), m.words]);
    const scenes = (p.segments ?? []).map((s) => s.base?.scene);
    return [...materials, ...scenes].filter(isString).filter((f) => isInside(rt, root, f)).map((f) => relPosix(rt, root, rt.path.resolve(root, f)));
  } catch {
    return [];
  }
};

/**
 * A hash of the project's files that change the picture: video.json, the files it names, and every file under assets/,
 * scenes/ and lib/ (a scene loads pictures and scripts by its own paths), sound files left out. The frame cache, the
 * project's notes and renders written into it do not count.
 */
export const pictureHash = async (rt: Runtime, projectDir: string): Promise<string> => {
  const root = rt.path.resolve(rt.cwd, projectDir);
  const walked = (await Promise.all(PICTURE_DIRS.map((d) => walkFiles(rt, rt.path.join(root, d))))).flat().map((f) => relPosix(rt, root, f));
  const files = [...new Set(['video.json', ...(await namedPictureFiles(rt, root)), ...walked])].filter((f) => !SOUND.test(f)).sort();
  const lines = await Promise.all(files.map(async (f) => f + ' ' + (await fileHash(rt, rt.path.join(root, f)).catch(() => '-'))));
  return sha256(lines.join('\n')).slice(0, HASH);
};

/** A path as short as it can be told: against the working directory when it lies inside it. */
const shown = (rt: Runtime, abs: string): string => (isInside(rt, rt.cwd, abs) ? relPosix(rt, rt.cwd, abs) || '.' : abs);

/** "17:03": when a render was written, in the clock of the machine. */
const clock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};

/** The compare to run on a render: with the reference (and text files) the last compare of the project used. */
const compareCommand = async (rt: Runtime, out: string, last: CompareEntry | undefined): Promise<string> => {
  // Before the first compare: the name references/video.md gives the reference in step 1, when it is there.
  const fallback = rt.path.join(rt.cwd, 'reference.mp4');
  const reference = last && (await isFile(rt, last.reference)) ? shown(rt, last.reference) : (await isFile(rt, fallback)) ? 'reference.mp4' : '<reference video>';
  const compare = 'popost video compare ' + reference + ' ' + out;
  if (!last?.referenceText || !last.otherText || !(await isFile(rt, last.referenceText))) return 'Compare it with the reference: ' + compare;
  const otherText = shown(rt, last.otherText);
  return 'Read its text, then compare it with the reference: popost video text ' + out + ' --out ' + otherText + ', then ' + compare + ' --reference-text ' + shown(rt, last.referenceText) + ' --other-text ' + otherText;
};

export interface RenderReview {
  /** Set when the render before this one, of the same project, showed another state and was never compared. */
  warning?: string;
  next: string;
}

/** Records a render of the project into out (as the user typed both) and says what comes next. */
export const reviewRender = async (rt: Runtime, projectDir: string, out: string): Promise<RenderReview> => {
  const project = await real(rt, projectDir);
  const file = recordFile(rt, project);
  const found = await readRecord(rt, file);
  const record = found?.project === project ? found : { project, renders: [], compares: [] };
  const outAbs = await real(rt, out);
  const entry: RenderEntry = { out: outAbs, video: await fileHash(rt, outAbs), picture: await pictureHash(rt, projectDir), at: rt.now().toISOString() };
  const before = record.renders.at(-1);
  const uncompared = before && before.picture !== entry.picture && !record.compares.some((c) => c.video === before.video) ? before : undefined;
  await writeRecord(rt, file, { ...record, renders: [...record.renders, entry] });
  const next = await compareCommand(rt, out, record.compares.at(-1));
  return { ...(uncompared ? { warning: 'the last render (' + shown(rt, uncompared.out) + ' at ' + clock(uncompared.at) + ') was not compared with the reference: run compare before changing more' } : {}), next };
};

export interface StillWorst {
  shot: number;
  /** The first round of the run of rounds in which the shot was among the worst with a similar score, and that score. */
  since: number;
  then: number;
  now: number;
  by: string;
}

export interface CompareReview {
  round: number;
  /** This state of the project was compared before, by another render of it: the round does not advance. */
  again: boolean;
  stillWorst: StillWorst[];
}

/** The render of a project that a file is: by its bytes (it may have moved), else the latest render written there. */
const findRender = async (rt: Runtime, video: string, path: string): Promise<{ file: string; record: ProjectRecord; render: RenderEntry } | undefined> => {
  const dir = reviewsDir(rt);
  const names = (await rt.fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.json'));
  const records = (await Promise.all(names.map(async (n) => {
    const record = await readRecord(rt, rt.path.join(dir, n));
    return record ? [{ file: rt.path.join(dir, n), record }] : [];
  }))).flat();
  const latest = (test: (r: RenderEntry) => boolean) =>
    records.flatMap(({ file, record }) => record.renders.filter(test).map((render) => ({ file, record, render }))).sort((a, b) => a.render.at.localeCompare(b.render.at)).at(-1);
  return latest((r) => r.video === video) ?? latest((r) => r.out === path);
};

/** The project directory a render was made from, when the file is a render the record knows. */
export const projectOf = async (rt: Runtime, file: string): Promise<string | undefined> => {
  const real_ = await real(rt, file);
  return (await findRender(rt, await fileHash(rt, real_), real_))?.record.project;
};

/** The round of the last compare, and the shots that stayed worst with a similar score since an earlier round. */
export const roundsOf = (compares: readonly CompareEntry[]): CompareReview => {
  const current = compares.at(-1);
  if (!current) return { round: 0, again: false, stillWorst: [] };
  const order: string[] = [];
  for (const c of compares) if (!order.includes(c.picture)) order.push(c.picture);
  const roundOf = (c: CompareEntry): number => order.indexOf(c.picture) + 1;
  const round = roundOf(current);
  const earlier = compares.slice(0, -1);
  // The latest compare of each earlier round against the same reference: shot numbers are the reference's.
  const latest = new Map<number, CompareEntry>();
  for (const c of earlier) if (c.referenceHash === current.referenceHash && roundOf(c) < round) latest.set(roundOf(c), c);
  const stillWorst = current.worst.filter((w) => current.mean === undefined || w.score < current.mean).flatMap((w): StillWorst[] => {
    let since: { round: number; score: number } | undefined;
    for (let r = round - 1; r >= 1; r--) {
      const before = latest.get(r)?.worst.find((x) => x.shot === w.shot);
      if (!before || Math.abs(before.score - w.score) > SIMILAR) break;
      since = { round: r, score: before.score };
    }
    return since ? [{ shot: w.shot, since: since.round, then: since.score, now: w.score, by: w.by }] : [];
  });
  return { round, again: earlier.some((c) => c.picture === current.picture && c.video !== current.video), stillWorst };
};

const LOOK = 'look at each worst shot at full size (its look command: popost video look … --at …), fix it or write it down with its reason in the delivery notes';

/** What the round asks, for compare's next. */
export const roundNext = (r: CompareReview | undefined): string => {
  if (!r) {
    return LOOK.charAt(0).toUpperCase() + LOOK.slice(1) + ', render again and compare again: at least ' + ROUNDS.least + ' rounds. Rounds are counted only for a video popost video render wrote from this working directory (or with the same POPOST_VIDEO_WORK), and this one is not in its record.';
  }
  const again = r.again ? 'Still round ' + r.round + ': this render shows the project as it was when it was compared in round ' + r.round + ' (no file that changes the picture changed). ' : '';
  const rounds = [...new Set(r.stillWorst.map((s) => s.since))];
  const many = r.stillWorst.length > 1;
  const still = r.stillWorst.length
    ? ' ' + rounds.map((k) => 'Still worst since round ' + k + ': ' + r.stillWorst.filter((s) => s.since === k).map((s) => 'shot ' + s.shot + ' (' + s.then + ' then, ' + s.now + ' now)').join(', ')).join('; ')
      + '. Fix ' + (many ? 'them' : 'it') + ' or write down why ' + (many ? 'they stay' : 'it stays') + '.'
    : '';
  if (r.round < ROUNDS.least) return again + 'Round ' + r.round + ' of at least ' + ROUNDS.least + ': ' + LOOK + ', render again and compare again.' + still;
  if (r.round < ROUNDS.most) return again + 'Round ' + r.round + ' (at least ' + ROUNDS.least + ', at most ' + ROUNDS.most + '): ' + LOOK + '.' + still + ' When every worst shot is written down, deliver this render; after a fix, render again and compare again (round ' + (r.round + 1) + ').';
  return again + 'Round ' + r.round + ', the last asked for: ' + LOOK + '.' + still + ' Deliver this render with the notes; a fix needs one more render and compare.';
};

export interface CompareInput {
  /** The video compared and the reference, absolute; the text files when given. */
  file: string;
  reference: string;
  referenceText?: string;
  otherText?: string;
  worst: readonly WorstShot[];
  /** The mean score of all shots of the compare. */
  mean: number;
}

/** Records a compare of a render and says which round it is; undefined when the file is no render in the record. */
export const reviewCompare = async (rt: Runtime, c: CompareInput): Promise<CompareReview | undefined> => {
  const file = await real(rt, c.file);
  const [video, referenceHash] = await Promise.all([fileHash(rt, file), fileHash(rt, c.reference)]);
  const found = await findRender(rt, video, file);
  if (!found) return undefined;
  const entry: CompareEntry = {
    at: rt.now().toISOString(), video: found.render.video, picture: found.render.picture, file, reference: await real(rt, c.reference), referenceHash,
    ...(c.referenceText && c.otherText ? { referenceText: await real(rt, c.referenceText), otherText: await real(rt, c.otherText) } : {}),
    worst: c.worst.map((w) => ({ shot: w.shot, score: w.score, by: w.by })), mean: c.mean,
  };
  const compares = [...found.record.compares, entry];
  await writeRecord(rt, found.file, { ...found.record, compares });
  return roundsOf(compares);
};
