import { describe, expect, it } from 'vitest';
import { DECK, DECK_CRLF, FONT_DATA_URI } from './test-fixtures';
import { MAX_DOCUMENT_BYTES, NO_SLIDE_MESSAGE, UNSAFE_MESSAGE, exceedsLimit, validateDeck, validateSource } from './validate';

/** Verbatim copy of the rules in `src/lib/popost.ts` (DOMParser based), used as a parity oracle. */
function referenceValidateDeck(html: string): number {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (!doc.querySelector('.slide')) throw new Error('图文内容需要包含 .slide 结构');
  if (
    doc.querySelector('script,iframe,object,embed,base,form,meta[http-equiv="refresh"]') ||
    [...doc.querySelectorAll('*')].some((e) =>
      [...e.attributes].some(
        (a) => /^on/i.test(a.name) || (['href', 'src', 'xlink:href'].includes(a.name) && /^\s*javascript:/i.test(a.value)),
      ),
    )
  ) {
    throw new Error('仅允许静态图文 HTML，不允许脚本或嵌入内容');
  }
  return doc.querySelectorAll('.slide').length;
}

const outcome = (fn: () => number): string => {
  try {
    return String(fn());
  } catch (e) {
    return (e as Error).message;
  }
};

const wrap = (body: string, head = ''): string => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

const CASES: Record<string, string> = {
  deck: DECK,
  deckCrlf: DECK_CRLF,
  noSlide: wrap('<div class="post">x</div>'),
  slideSubstring: wrap('<div class="slides">x</div>'),
  slideInList: wrap('<div class="a slide b">x</div>'),
  twoSlides: wrap('<div class="slide"></div><div class="slide"></div>'),
  nestedSlide: wrap('<div class="slide"><div class="slide"></div></div>'),
  script: wrap('<div class="slide"></div><script>1</script>'),
  iframe: wrap('<div class="slide"></div><iframe></iframe>'),
  object: wrap('<div class="slide"></div><object></object>'),
  embed: wrap('<div class="slide"></div><embed>'),
  base: wrap('<div class="slide"></div>', '<base href="/">'),
  form: wrap('<div class="slide"><form></form></div>'),
  metaRefresh: wrap('<div class="slide"></div>', '<meta http-equiv="refresh" content="1">'),
  metaOtherHttpEquiv: wrap('<div class="slide"></div>', '<meta http-equiv="content-type" content="text/html">'),
  onclick: wrap('<div class="slide" onclick="x()"></div>'),
  onUpper: wrap('<div class="slide" ONCLICK="x()"></div>'),
  dataOn: wrap('<div class="slide" data-onclick="x"></div>'),
  jsHref: wrap('<div class="slide"><a href="javascript:x()">a</a></div>'),
  jsHrefSpace: wrap('<div class="slide"><a href="  JavaScript:x()">a</a></div>'),
  jsTabbed: wrap('<div class="slide"><a href="java\tscript:x()">a</a></div>'),
  jsSrc: wrap('<div class="slide"><img src="javascript:x()"></div>'),
  jsXlink: wrap('<div class="slide"><svg><a xlink:href="javascript:x()"><text>a</text></a></svg></div>'),
  jsOtherAttr: wrap('<div class="slide"><a data-href="javascript:x()" title="javascript:x()">a</a></div>'),
  jsAction: wrap('<div class="slide"><div action="javascript:x()"></div></div>'),
  httpUrls: wrap('<div class="slide"><img src="http://example.com/a.png"><a href="https://x">a</a></div>'),
  dataUrls: wrap(`<div class="slide"></div>`, `<style>@font-face{src:url(${FONT_DATA_URI})}</style>`),
  noscriptPlain: wrap('<div class="slide"></div><noscript><p>x</p></noscript>'),
  noscriptScript: wrap('<div class="slide"></div><noscript><script>1</script></noscript>'),
  templateScript: wrap('<div class="slide"></div><template><script>1</script></template>'),
  templateSlide: wrap('<template><div class="slide"></div></template>'),
  doctypeUpperSlide: wrap('<div class="Slide">x</div>'),
  empty: '',
  fragment: '<div class="slide">x</div>',
};

/**
 * Cases where happy-dom's DOMParser (our oracle) deviates from real browsers; the expectations below
 * are the browser behaviour that `src/lib/popost.ts` has in production.
 */
describe('validateDeck: browser semantics', () => {
  it('finds scripts inside SVG', () => {
    expect(() => validateDeck(wrap('<div class="slide"></div><svg><script>1</script></svg>'))).toThrow(UNSAFE_MESSAGE);
  });
  it('matches http-equiv="refresh" case-insensitively', () => {
    expect(() => validateDeck(wrap('<div class="slide"></div>', '<meta http-equiv="Refresh" content="1">'))).toThrow(UNSAFE_MESSAGE);
  });
  it('decodes character references in attribute values before checking javascript:', () => {
    expect(() => validateDeck(wrap('<div class="slide"><a href="&#106;avascript:x()">a</a></div>'))).toThrow(UNSAFE_MESSAGE);
    expect(() => validateDeck(wrap('<div class="slide"><a href="&#x6A;avascript&colon;x()">a</a></div>'))).toThrow(UNSAFE_MESSAGE);
  });
  it('matches .slide case-insensitively in quirks mode only (no doctype)', () => {
    expect(validateDeck('<div class="Slide">x</div>')).toBe(1);
    expect(() => validateDeck(wrap('<div class="Slide">x</div>'))).toThrow(NO_SLIDE_MESSAGE);
  });
  it('does not reject a stylesheet link', () => {
    expect(validateDeck(wrap('<div class="slide"></div>', '<link rel="stylesheet" href="x.css">'))).toBe(1);
  });
});

describe('validateDeck: parity with src/lib/popost.ts', () => {
  for (const [name, html] of Object.entries(CASES)) {
    it(name, () => {
      expect(outcome(() => validateDeck(html))).toBe(outcome(() => referenceValidateDeck(html)));
    });
  }
});

describe('validateDeck', () => {
  it('returns the number of .slide elements', () => {
    expect(validateDeck(DECK)).toBe(2);
    expect(validateDeck(wrap('<div class="slide"><div class="slide"></div></div>'))).toBe(2);
  });
  it('throws the exact Chinese messages', () => {
    expect(() => validateDeck(wrap('<p>x</p>'))).toThrow(new Error('图文内容需要包含 .slide 结构'));
    expect(() => validateDeck(wrap('<div class="slide"></div><script></script>'))).toThrow(new Error('仅允许静态图文 HTML，不允许脚本或嵌入内容'));
    expect(NO_SLIDE_MESSAGE).toBe('图文内容需要包含 .slide 结构');
    expect(UNSAFE_MESSAGE).toBe('仅允许静态图文 HTML，不允许脚本或嵌入内容');
  });
  it('reports a missing slide before unsafe content', () => {
    expect(() => validateDeck(wrap('<script></script>'))).toThrow(NO_SLIDE_MESSAGE);
  });
  it('does not reject style, data URLs, external URLs or noscript without scripts', () => {
    for (const name of ['httpUrls', 'dataUrls', 'noscriptPlain', 'jsOtherAttr']) expect(() => validateDeck(CASES[name])).not.toThrow();
  });
  it('treats an empty document as having no slide', () => {
    expect(() => validateDeck('')).toThrow(NO_SLIDE_MESSAGE);
  });
});

describe('validateSource (code panel rules)', () => {
  it('accepts a good deck and reports the slide count', () => {
    expect(validateSource(DECK)).toEqual({ ok: true, slides: 2 });
    expect(validateSource(DECK_CRLF)).toEqual({ ok: true, slides: 2 });
  });
  it('rejects empty and whitespace-only documents', () => {
    expect(validateSource('')).toEqual({ ok: false, code: 'empty' });
    expect(validateSource(' \n\t ')).toEqual({ ok: false, code: 'empty' });
  });
  it('requires a .slide', () => {
    expect(validateSource('<p>x</p>')).toEqual({ ok: false, code: 'no-slide' });
  });
  it('flags unsafe content', () => {
    for (const name of ['script', 'iframe', 'object', 'embed', 'base', 'form', 'metaRefresh', 'onclick', 'jsHref', 'jsXlink']) {
      expect(validateSource(CASES[name]), name).toEqual({ ok: false, code: 'unsafe' });
    }
  });
  it('caps the size at 60 MiB (bytes, not characters)', () => {
    expect(MAX_DOCUMENT_BYTES).toBe(60 * 1024 * 1024);
    expect(validateSource('<div class="slide">' + 'a'.repeat(MAX_DOCUMENT_BYTES))).toEqual({ ok: false, code: 'too-large' });
    // 21 MiB of 3-byte characters is under the character limit but over the byte limit
    const cjk = '春'.repeat(21 * 1024 * 1024);
    expect(cjk.length).toBeLessThan(MAX_DOCUMENT_BYTES);
    expect(validateSource(cjk)).toEqual({ ok: false, code: 'too-large' });
  });
  it('measures the limit in UTF-8 bytes exactly', () => {
    expect(exceedsLimit('abcd', 4)).toBe(false);
    expect(exceedsLimit('abcde', 4)).toBe(true);
    expect(exceedsLimit('春', 3)).toBe(false);
    expect(exceedsLimit('春', 2)).toBe(true);
    expect(exceedsLimit('😀', 4)).toBe(false);
    expect(exceedsLimit('😀', 3)).toBe(true);
    expect(exceedsLimit('', 0)).toBe(false);
  });
  it('checks emptiness before size and size before structure', () => {
    expect(validateSource('x'.repeat(MAX_DOCUMENT_BYTES + 1))).toEqual({ ok: false, code: 'too-large' });
  });
});
