import type { FontPalette, FontRole } from '../contracts';

/** A palette role as published in `palette.json`; only the fields the editor consumes. */
export interface PaletteRole extends FontRole {
  weights?: string;
  cssPath?: string;
  licensePath?: string;
  package?: string;
  packageVersion?: string;
}

export const PALETTE_LOAD_ERROR = '公共字体库无法读取';
export const MENU_ERROR_LABEL = '字体库加载失败';
export const UNKNOWN_FONT_ERROR = '该字体不在公共字体库中';

/** Parse a palette response body; the `roles` array is the catalog. */
export function parsePalette(data: unknown): FontPalette {
  const roles = (data as { roles?: unknown } | null)?.roles;
  if (!Array.isArray(roles)) throw new Error(PALETTE_LOAD_ERROR);
  return { roles: roles as PaletteRole[] };
}

export async function loadPalette(url: string | URL, fetchImpl: typeof fetch = fetch): Promise<FontPalette> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(PALETTE_LOAD_ERROR);
  return parsePalette(await response.json());
}

export const BROWSER_PALETTE_PATH = 'palette.json';
export const LOCAL_PALETTE_URL = '/api/font-palette';

/** Default browser font library: `<site base>/fonts/popost/`, resolved from the editor page (`<base>/canvas/`). */
export function defaultLibraryBase(): URL {
  return new URL('../fonts/popost/', document.baseURI);
}

/* ------------------------------------------------------------------------------------------ */
/* Menu model                                                                                  */
/* ------------------------------------------------------------------------------------------ */

export interface FontMenuOption {
  /** Option text. */
  label: string;
  /** Option value = role.family. */
  value: string;
  /** Option tooltip: `group · weights · OFL-1.1`. */
  title: string;
  /** `data-font-id`. */
  fontId: string;
}

export interface FontMenuGroup {
  label: string;
  options: FontMenuOption[];
}

export function menuLabel(role: FontRole): string {
  const familyLabel = role.family.replace(' Variable', '');
  return role.label.toLowerCase() === familyLabel.toLowerCase() ? familyLabel : `${role.label} · ${familyLabel}`;
}

function menuOption(role: PaletteRole): FontMenuOption {
  return {
    label: menuLabel(role),
    value: role.family,
    title: `${role.group} · ${role.weights} · OFL-1.1`,
    fontId: role.id,
  };
}

/** Roles grouped by `role.group` (default "Fonts"); groups and options keep palette order. */
export function buildFontMenu(roles: readonly PaletteRole[]): FontMenuGroup[] {
  const groups = new Map<string, FontMenuGroup>();
  for (const role of roles) {
    const label = role.group || 'Fonts';
    let group = groups.get(label);
    if (!group) {
      group = { label, options: [] };
      groups.set(label, group);
    }
    group.options.push(menuOption(role));
  }
  return [...groups.values()];
}

/** Fill `<select id="tb-font">` from the menu model (`value=family`, `data-font-id`). */
function makeOption(label: string, value: string): HTMLOptionElement {
  const option = document.createElement('option');
  option.text = label;
  option.value = value;
  return option;
}

export function renderFontSelect(select: HTMLSelectElement, menu: readonly FontMenuGroup[]): void {
  select.replaceChildren();
  for (const group of menu) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group.label;
    for (const item of group.options) {
      const option = makeOption(item.label, item.value);
      option.title = item.title;
      option.dataset.fontId = item.fontId;
      optgroup.append(option);
    }
    select.append(optgroup);
  }
}

/** Populate the font select from a (possibly failing) palette load; never throws. */
export async function initFontSelect(select: HTMLSelectElement, palette: () => Promise<FontPalette>): Promise<void> {
  select.disabled = true;
  try {
    renderFontSelect(select, buildFontMenu((await palette()).roles));
    select.disabled = false;
  } catch (error) {
    select.replaceChildren(makeOption(MENU_ERROR_LABEL, ''));
    select.title = error instanceof Error ? error.message : String(error);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Selection: CJK fallback and font-family stack                                               */
/* ------------------------------------------------------------------------------------------ */

const CJK_RANGE = /[㐀-鿿]/u;

export function containsCJK(text: string): boolean {
  return CJK_RANGE.test(text);
}

export function cjkFallbackId(roleId: string): 'cjk-sans' | 'cjk-sans-tc' {
  return roleId.endsWith('-tc') ? 'cjk-sans-tc' : 'cjk-sans';
}

export interface FontSelection {
  role: PaletteRole;
  /** CJK fallback role, when the text needs one and it differs from `role`. */
  fallback: PaletteRole | null;
  /** Roles whose CSS must be embedded: `[role]` or `[role, fallback]`. */
  needed: PaletteRole[];
  /** CSS `font-family` value for the selected element. */
  stack: string;
}

/** `"family", "fallback family", generic` */
export function fontFamilyStack(role: FontRole, fallback: FontRole | null): string {
  const parts = [`"${role.family}"`];
  if (fallback) parts.push(`"${fallback.family}"`);
  parts.push(role.fallback || 'sans-serif');
  return parts.join(', ');
}

/** Resolve the picked family into the roles to embed and the font-family stack. `bodyText` is the document text. */
export function selectFont(roles: readonly PaletteRole[], family: string, bodyText: string): FontSelection {
  const role = roles.find((r) => r.family === family);
  if (!role) throw new Error(UNKNOWN_FONT_ERROR);
  const candidate = roles.find((r) => r.id === cjkFallbackId(role.id)) ?? null;
  const fallback = containsCJK(bodyText) && candidate && candidate.id !== role.id ? candidate : null;
  return { role, fallback, needed: fallback ? [role, fallback] : [role], stack: fontFamilyStack(role, fallback) };
}
