import { createContext, createElement, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { Notice, NoticeKey } from '../../contracts';
import { en } from './en';
import type { MessageKey } from './en';
import { zh } from './zh';

export type Lang = 'zh' | 'en';
export type { MessageKey };
export type Vars = Record<string, string | number>;
export type TFunction = (key: MessageKey, vars?: Vars) => string;

export const dictionaries: Record<Lang, Record<MessageKey, string>> = { en, zh };

/** Translator for `lang`: replaces `{name}` placeholders; an unknown key falls back to English, then to the key. */
export function createT(lang: Lang): TFunction {
  const dict = dictionaries[lang];
  return (key, vars) => {
    const text = dict[key] ?? en[key] ?? key;
    return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : text;
  };
}

const I18nContext = createContext<{ lang: Lang; t: TFunction }>({ lang: 'en', t: createT('en') });

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  const value = useMemo(() => ({ lang, t: createT(lang) }), [lang]);
  return createElement(I18nContext.Provider, { value }, children);
}

export const useT = (): TFunction => useContext(I18nContext).t;
export const useLang = (): Lang => useContext(I18nContext).lang;

/** Every controller notice key has a text; keep this table total (the type enforces it). */
export const NOTICE_TEXT: Record<NoticeKey, MessageKey> = {
  saveFailed: 'notice.saveFailed',
  editRejected: 'notice.editRejected',
  resetDone: 'notice.resetDone',
  resetUnavailable: 'notice.resetUnavailable',
  downloadDone: 'notice.downloadDone',
  downloadFailed: 'notice.downloadFailed',
  fontFailed: 'notice.fontFailed',
  imageFailed: 'notice.imageFailed',
  textOverflow: 'notice.textOverflow',
};

export function noticeText(t: TFunction, notice: Notice): string {
  const base = t(NOTICE_TEXT[notice.key]);
  return notice.detail ? `${base}: ${notice.detail}` : base;
}

/** Text for `EditorSnapshot.error`: a known key (`no-pages`) is translated, anything else is shown raw. */
export function errorText(t: TFunction, error: string | null): string {
  if (!error) return '';
  const key = `error.${error}` as MessageKey;
  return key in en ? t(key) : error;
}
