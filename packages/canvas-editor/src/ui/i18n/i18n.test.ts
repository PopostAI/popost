import { describe, expect, it } from 'vitest';
import type { NoticeKey } from '../../contracts';
import { ERROR_NO_PAGES } from '../../app/controller';
import { createT, dictionaries, errorText, NOTICE_TEXT, noticeText } from './index';

const NOTICE_KEYS: NoticeKey[] = [
  'saveFailed', 'editRejected', 'resetDone', 'resetUnavailable', 'downloadDone', 'downloadFailed', 'fontFailed', 'imageFailed', 'textOverflow',
];

describe('i18n', () => {
  it('zh and en define the same non-empty keys', () => {
    expect(Object.keys(dictionaries.zh).sort()).toEqual(Object.keys(dictionaries.en).sort());
    for (const lang of ['zh', 'en'] as const) {
      for (const [key, value] of Object.entries(dictionaries[lang])) expect(value, `${lang}:${key}`).not.toBe('');
    }
  });

  it('keeps placeholders identical across languages', () => {
    const names = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(dictionaries.en) as Array<keyof typeof dictionaries.en>) {
      expect(names(dictionaries.zh[key]), key).toEqual(names(dictionaries.en[key]));
    }
  });

  it('maps every notice key and the no-pages error', () => {
    expect(Object.keys(NOTICE_TEXT).sort()).toEqual([...NOTICE_KEYS].sort());
    const t = createT('en');
    for (const key of NOTICE_KEYS) expect(noticeText(t, { kind: 'info', key })).toBe(t(NOTICE_TEXT[key]));
    expect(noticeText(t, { kind: 'error', key: 'saveFailed', detail: 'boom' })).toBe('Save failed: boom');
    expect(errorText(createT('zh'), ERROR_NO_PAGES)).toBe(dictionaries.zh['error.no-pages']);
    expect(errorText(t, 'Network down')).toBe('Network down');
    expect(errorText(t, null)).toBe('');
  });

  it('keeps the owner\'s cloud copy word for word, and a readable text for every failure code', () => {
    expect(dictionaries.en['cloud.save']).toBe('Save to Cloud');
    expect(dictionaries.en['cloud.tooltip']).toBe('Manage all your assets on the Popost website');
    expect(dictionaries.zh['cloud.save']).toBe('保存到云端');
    expect(dictionaries.zh['cloud.tooltip']).toBe('在popost网页端管理你的所有资产');
    for (const lang of ['zh', 'en'] as const) {
      const keys = Object.keys(dictionaries[lang]).filter((key) => key.startsWith('cloud.error.')).sort();
      expect(keys, lang).toEqual(['cloud.error.DECK_INVALID', 'cloud.error.LOCAL_SAVE_FAILED', 'cloud.error.NETWORK', 'cloud.error.RATE_LIMITED', 'cloud.error.STORAGE_FULL', 'cloud.error.UNAUTHORIZED', 'cloud.error.generic']);
    }
  });

  it('fills placeholders', () => {
    expect(createT('en')('pages.counter', { n: 2, total: 5 })).toBe('2 / 5');
    expect(createT('zh')('pill.selected', { n: 3 })).toBe('已选 3 个');
  });
});
