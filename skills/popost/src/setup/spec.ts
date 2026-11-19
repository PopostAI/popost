/**
 * The `popost setup` spec: a JSON document that says what the deterministic setup steps should produce. `parseSpec` checks
 * its shape (unknown keys, types, enum values) and reports every problem it finds instead of stopping at the first; what
 * needs the disk (files that must exist, page ids, font roles) is checked in `check.ts`.
 */
import { MAX_CANVAS, MODES, type Mode } from '../core/project';
import { JOB_ID } from '../images/jobs';
import { REF_ROLES } from '../images/references';
import { CHANNELS, PLATFORMS, type SettingsChange } from '../workflow/settings';

export const MAX_PAGES = 50;
export const PURPOSES = ['material', 'composition'] as const;
export type Purpose = (typeof PURPOSES)[number];
export type RefRole = (typeof REF_ROLES)[number];

/** Every entry of a list remembers where it stood in the spec, so that a problem names the right one. */
interface Positioned {
  readonly index: number;
}

export interface ReferenceEntry extends Positioned {
  readonly file: string;
  readonly role: RefRole;
  readonly page?: string;
}

export interface ImageEntry extends Positioned {
  /** The job id; `composition` for the composition job. */
  readonly id: string;
  readonly promptFile: string;
  readonly aspect?: string;
  readonly purpose: Purpose;
  /** Role names (`identity`, `all`, …) and picture paths, as `image prepare --ref` takes them. */
  readonly ref: readonly string[];
}

export interface Spec {
  readonly brief?: string;
  readonly mode?: Mode;
  readonly width?: number;
  readonly height?: number;
  /** A page count (p1…pN) or the explicit page ids. */
  readonly pages?: number | readonly string[];
  readonly settings?: SettingsChange;
  readonly references: readonly ReferenceEntry[];
  readonly fonts: readonly string[];
  readonly plan?: string;
  readonly images: readonly ImageEntry[];
  readonly quote?: boolean;
}

export interface ParsedSpec {
  readonly spec: Spec;
  /** The document is not a spec at all, so there is nothing more to check. */
  readonly unusable?: boolean;
  /** Every shape problem, as `where: what is wrong`. */
  readonly problems: readonly string[];
}

type Obj = Record<string, unknown>;
type Report = (where: string, message: string) => void;

const SPEC_KEYS = ['brief', 'mode', 'width', 'height', 'pages', 'settings', 'references', 'fonts', 'plan', 'images', 'quote'];
const SETTINGS_KEYS = ['platform', 'language', 'channel', 'model'];
const REFERENCE_KEYS = ['file', 'role', 'page'];
const IMAGE_KEYS = ['id', 'promptFile', 'aspect', 'purpose', 'ref'];
const ASPECT = /^[1-9][0-9]{0,2}:[1-9][0-9]{0,2}$/;
const SAFE_PAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const at = (base: string, key: string): string => (base ? `${base}.${key}` : key);
const quoted = (values: readonly string[]): string => values.map((value) => `"${value}"`).join(', ');

const noExtraKeys = (obj: Obj, allowed: readonly string[], base: string, report: Report): void => {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) report(at(base, key), `unknown key (allowed: ${allowed.join(', ')})`);
};

const readString = (obj: Obj, key: string, base: string, report: Report, required = false): string | undefined => {
  const value = obj[key];
  if (value === undefined) {
    if (required) report(at(base, key), 'required');
    return undefined;
  }
  if (typeof value !== 'string' || !value.trim()) {
    report(at(base, key), 'must be a non-empty string');
    return undefined;
  }
  return value;
};

const readEnum = <T extends string>(obj: Obj, key: string, allowed: readonly T[], base: string, report: Report): T | undefined => {
  const value = readString(obj, key, base, report);
  if (value === undefined) return undefined;
  if (allowed.includes(value as T)) return value as T;
  report(at(base, key), `"${value}" is not one of ${quoted(allowed)}`);
  return undefined;
};

/** Hosts call the two modes by what the user picked: replicating references is `strict`, creating from a brief is `original`. */
const MODE_ALIASES: Readonly<Record<string, Mode>> = { replicate: 'strict', reproduce: 'strict', create: 'original' };

const readMode = (obj: Obj, report: Report): Mode | undefined => {
  const alias = typeof obj.mode === 'string' ? MODE_ALIASES[obj.mode.trim().toLowerCase()] : undefined;
  return alias ?? readEnum(obj, 'mode', MODES, '', report);
};

const readInt = (obj: Obj, key: string, base: string, report: Report, min: number, max: number): number | undefined => {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
  report(at(base, key), `must be a whole number from ${min} to ${max}`);
  return undefined;
};

const readBool = (obj: Obj, key: string, report: Report): boolean | undefined => {
  const value = obj[key];
  if (value !== undefined && typeof value !== 'boolean') report(key, 'must be true or false');
  return typeof value === 'boolean' ? value : undefined;
};

const readPages = (value: unknown, report: Report): Spec['pages'] => {
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 1 && value <= MAX_PAGES) return value;
    report('pages', `a page count must be a whole number from 1 to ${MAX_PAGES}`);
    return undefined;
  }
  if (!Array.isArray(value) || !value.length) {
    report('pages', 'must be a page count (3) or a list of page ids (["p1","p2","p3"])');
    return undefined;
  }
  const ids = value.filter((id): id is string => typeof id === 'string' && SAFE_PAGE_ID.test(id));
  if (ids.length !== value.length) report('pages', 'page ids are letters, digits, _ and - (at most 64)');
  const twice = ids.find((id, index) => ids.indexOf(id) !== index);
  if (twice) report('pages', `page id "${twice}" is listed twice`);
  if (value.length > MAX_PAGES) report('pages', `at most ${MAX_PAGES} pages`);
  return ids.length === value.length && !twice ? ids : undefined;
};

const readSettings = (value: unknown, report: Report): SettingsChange | undefined => {
  if (value === undefined) return undefined;
  if (!isObj(value)) {
    report('settings', 'must be an object');
    return undefined;
  }
  noExtraKeys(value, SETTINGS_KEYS, 'settings', report);
  return {
    platform: readEnum(value, 'platform', PLATFORMS, 'settings', report),
    language: readString(value, 'language', 'settings', report),
    channel: readEnum(value, 'channel', CHANNELS, 'settings', report),
    model: readString(value, 'model', 'settings', report),
  };
};

const readFonts = (value: unknown, report: Report): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((role) => typeof role === 'string' && role.trim())) {
    report('fonts', 'must be a list of font role ids (popost font list)');
    return [];
  }
  const roles = (value as string[]).map((role) => role.trim());
  const twice = roles.find((role, index) => roles.indexOf(role) !== index);
  if (twice) report('fonts', `"${twice}" is listed twice`);
  return [...new Set(roles)];
};

const readReference = (value: unknown, base: string, report: Report): Omit<ReferenceEntry, 'index'> | null => {
  if (!isObj(value)) {
    report(base, 'must be an object like {"file": "inputs/a.jpg", "role": "layout"}');
    return null;
  }
  noExtraKeys(value, REFERENCE_KEYS, base, report);
  const file = readString(value, 'file', base, report, true);
  const role = readEnum(value, 'role', REF_ROLES, base, report) ?? 'layout';
  const page = readString(value, 'page', base, report);
  return file === undefined ? null : { file, role, ...(page === undefined ? {} : { page }) };
};

const readRefs = (value: unknown, base: string, report: Report): string[] => {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  if (!list.length || !list.every((ref) => typeof ref === 'string' && ref.trim())) {
    report(at(base, 'ref'), 'must be a role (layout, identity, style, content, all), a picture path, or a list of them');
    return [];
  }
  return list as string[];
};

const readImage = (value: unknown, base: string, report: Report): Omit<ImageEntry, 'index'> | null => {
  if (!isObj(value)) {
    report(base, 'must be an object like {"id": "hero", "promptFile": "prompts/hero.md", "aspect": "9:16"}');
    return null;
  }
  noExtraKeys(value, IMAGE_KEYS, base, report);
  const purpose = readEnum(value, 'purpose', PURPOSES, base, report) ?? 'material';
  const named = readString(value, 'id', base, report, purpose === 'material');
  if (named !== undefined && !JOB_ID.test(named)) report(at(base, 'id'), `"${named}" is not a valid id (letters, digits, _ and -, at most 64)`);
  if (purpose === 'material' && named === 'composition') report(at(base, 'id'), '"composition" is reserved for the composition job');
  if (purpose === 'composition' && named !== undefined && named !== 'composition') report(at(base, 'id'), 'the composition job is always called "composition": leave id out');
  const promptFile = readString(value, 'promptFile', base, report, true);
  const aspect = readString(value, 'aspect', base, report);
  if (aspect !== undefined && !ASPECT.test(aspect)) report(at(base, 'aspect'), `"${aspect}" must be W:H, for example 1:1, 3:4 or 9:16`);
  const ref = readRefs(value.ref, base, report);
  if (promptFile === undefined || (purpose === 'material' && named === undefined)) return null;
  return { id: purpose === 'composition' ? 'composition' : named!, promptFile, ...(aspect === undefined ? {} : { aspect }), purpose, ref };
};

/** The entries of `value` that are valid, each read by `read`; every invalid one is reported by its position. */
const readList = <T>(value: unknown, key: string, report: Report, read: (item: unknown, base: string, report: Report) => T | null): (T & Positioned)[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    report(key, 'must be a list');
    return [];
  }
  const entries = value.map((item, index) => {
    const entry = read(item, `${key}[${index}]`, report);
    return entry === null ? null : { ...entry, index };
  });
  return entries.filter((entry): entry is T & Positioned => entry !== null);
};

const reportRepeatedJobs = (images: readonly ImageEntry[], report: Report): void => {
  const ids = images.map((image) => image.id);
  const twice = ids.find((id, index) => ids.indexOf(id) !== index);
  if (twice) report('images', `job id "${twice}" is used twice`);
};

export const parseSpec = (raw: unknown): ParsedSpec => {
  const problems: string[] = [];
  const report: Report = (where, message) => void problems.push(`${where}: ${message}`);
  if (!isObj(raw)) {
    report('spec', 'must be a JSON object (see popost setup --help)');
    return { spec: { references: [], fonts: [], images: [] }, problems, unusable: true };
  }
  noExtraKeys(raw, SPEC_KEYS, '', report);
  const images = readList(raw.images, 'images', report, readImage);
  reportRepeatedJobs(images, report);
  const spec: Spec = {
    brief: readString(raw, 'brief', '', report),
    mode: readMode(raw, report),
    width: readInt(raw, 'width', '', report, 1, MAX_CANVAS),
    height: readInt(raw, 'height', '', report, 1, MAX_CANVAS),
    pages: readPages(raw.pages, report),
    settings: readSettings(raw.settings, report),
    references: readList(raw.references, 'references', report, readReference),
    fonts: readFonts(raw.fonts, report),
    plan: readString(raw, 'plan', '', report),
    images,
    quote: readBool(raw, 'quote', report),
  };
  return { spec, problems };
};
