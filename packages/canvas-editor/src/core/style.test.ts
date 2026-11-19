import { describe, expect, it } from 'vitest';
import { getStyleValue, isSafeStyleValue, isValidPropName, mergeStyle, normalizeProp, parseStyle } from './style';

describe('parseStyle', () => {
  it('reads declarations with exact ranges', () => {
    const css = 'color: red;  Font-Size:12px ;--Brand: #fff';
    const decls = parseStyle(css);
    expect(decls.map((d) => [d.name, d.value, d.important])).toEqual([
      ['color', 'red', false],
      ['Font-Size', '12px', false],
      ['--Brand', '#fff', false],
    ]);
    for (const d of decls) expect(css.slice(d.start, d.end)).toBe(css.slice(d.start, d.end).trim());
    expect(css.slice(decls[0].valueStart, decls[0].valueEnd)).toBe('red');
    expect(css.slice(decls[1].start, decls[1].end)).toBe('Font-Size:12px');
  });
  it('handles !important in its spellings', () => {
    const [a, b, c] = parseStyle('color:red!important; top: 1px ! IMPORTANT ; left:2px');
    expect([a.value, a.important]).toEqual(['red', true]);
    expect([b.value, b.important]).toEqual(['1px', true]);
    expect(c.important).toBe(false);
  });
  it('keeps semicolons inside quotes, url() and parentheses', () => {
    const css = `background:url(data:image/png;base64,AAA=); content:"a;b"; font-family:'x;y', serif; width:calc(1px + (2px))`;
    expect(parseStyle(css).map((d) => d.name)).toEqual(['background', 'content', 'font-family', 'width']);
    expect(parseStyle(css)[0].value).toBe('url(data:image/png;base64,AAA=)');
    expect(parseStyle(css)[2].value).toBe(`'x;y', serif`);
  });
  it('ignores comments and respects escaped quotes', () => {
    const css = `/* a;b */ color: red /* x;y */; content: "q\\";x"; /* only */`;
    const decls = parseStyle(css);
    expect(decls.map((d) => d.name)).toEqual(['color', 'content']);
    expect(decls[1].value).toBe('"q\\";x"');
  });
  it('skips chunks that are not declarations', () => {
    expect(parseStyle('garbage; color:red; :nope; 1bad:x').map((d) => d.name)).toEqual(['color']);
    expect(parseStyle('')).toEqual([]);
    expect(parseStyle('  ;; ')).toEqual([]);
  });
  it('treats an unterminated string/comment as the rest of the value without crashing', () => {
    expect(() => parseStyle('color:red; content:"oops; top:1px')).not.toThrow();
    expect(() => parseStyle('a:b; /* open')).not.toThrow();
  });
});

describe('mergeStyle: replace and add', () => {
  it('replaces only the value of an existing declaration', () => {
    expect(mergeStyle('color: red;  top:1px', { top: '5px' })).toBe('color: red;  top:5px');
    expect(mergeStyle('COLOR: red', { color: 'blue' })).toBe('COLOR: blue');
  });
  it('leaves untouched declarations byte-identical (weird spacing, comments, quotes)', () => {
    const css = `  color :red ;/*c*/ background:url('a;b.png')  ; top:1px`;
    const out = mergeStyle(css, { top: '2px' });
    expect(out).toBe(`  color :red ;/*c*/ background:url('a;b.png')  ; top:2px`);
    expect(mergeStyle(css, {})).toBe(css);
  });
  it('appends new declarations as "; prop: value"', () => {
    expect(mergeStyle('color:red', { top: '1px' })).toBe('color:red; top: 1px');
    expect(mergeStyle('', { top: '1px' })).toBe('top: 1px');
    expect(mergeStyle('   ', { top: '1px' })).toBe('top: 1px');
    expect(mergeStyle('color:red', { top: '1px', left: '2px' })).toBe('color:red; top: 1px; left: 2px');
  });
  it('keeps a trailing semicolon style when appending', () => {
    expect(mergeStyle('color:red;', { top: '1px' })).toBe('color:red; top: 1px;');
    expect(mergeStyle('color:red; ', { top: '1px' })).toBe('color:red; top: 1px; ');
  });
  it('lower-cases new names but not custom properties', () => {
    expect(mergeStyle('', { 'Font-Size': '12px' })).toBe('font-size: 12px');
    expect(mergeStyle('', { '--Gap': '4px' })).toBe('--Gap: 4px');
    expect(normalizeProp(' --X ')).toBe('--X');
    expect(mergeStyle('--Gap: 1px', { '--gap': '2px' })).toBe('--Gap: 1px; --gap: 2px');
  });
  it('does not reformat values', () => {
    expect(mergeStyle('', { background: 'URL( x.png )  no-repeat' })).toBe('background: URL( x.png )  no-repeat');
  });
  it('keeps an existing !important unless the new value has its own', () => {
    expect(mergeStyle('color:red !important', { color: 'blue' })).toBe('color:blue !important');
    expect(mergeStyle('color:red !important', { color: 'blue !important' })).toBe('color:blue !important');
    expect(mergeStyle('color:red !important', { color: 'blue!important' })).toBe('color:blue!important');
    expect(mergeStyle('color:red', { color: 'blue !important' })).toBe('color:blue !important');
  });
  it('replaces the effective (last) duplicate and drops earlier ones', () => {
    expect(mergeStyle('color:red; top:1px; color:blue', { color: 'green' })).toBe('top:1px; color:green');
  });
  it('replaces inside values containing semicolons in url()', () => {
    expect(mergeStyle('background:url(a;b); top:1px', { background: 'none' })).toBe('background:none; top:1px');
  });
});

describe('mergeStyle: removal', () => {
  it('removes a middle declaration with its separator', () => {
    expect(mergeStyle('a:1; b:2; c:3', { b: null })).toBe('a:1; c:3');
  });
  it('removes the first declaration', () => {
    expect(mergeStyle('a:1; b:2; c:3', { a: null })).toBe('b:2; c:3');
  });
  it('removes the last declaration with the preceding separator', () => {
    expect(mergeStyle('a:1; b:2; c:3', { c: null })).toBe('a:1; b:2');
  });
  it('keeps a trailing semicolon when removing the last declaration', () => {
    expect(mergeStyle('a:1; b:2;', { b: null })).toBe('a:1;');
    expect(mergeStyle('a:1; b:2; ', { b: null })).toBe('a:1; ');
  });
  it('removes everything cleanly', () => {
    expect(mergeStyle('a:1', { a: null })).toBe('');
    expect(mergeStyle('a:1;', { a: null })).toBe('');
    expect(mergeStyle('a:1; b:2', { a: null, b: null })).toBe('');
    expect(mergeStyle('a:1; b:2; c:3', { a: null, c: null })).toBe('b:2');
  });
  it('treats an empty string as removal and ignores absent properties', () => {
    expect(mergeStyle('a:1; b:2', { a: '' })).toBe('b:2');
    expect(mergeStyle('a:1', { zzz: null })).toBe('a:1');
    expect(mergeStyle('', { zzz: null })).toBe('');
  });
  it('removes all duplicates and works with !important and url()', () => {
    expect(mergeStyle('a:1; b:2 !important; a:3', { a: null })).toBe('b:2 !important');
    expect(mergeStyle('x:url(a;b); y:1', { x: null })).toBe('y:1');
  });
  it('leaves comments and garbage chunks in place', () => {
    expect(mergeStyle('/*k*/ a:1; junk; b:2', { a: null })).toBe('junk; b:2');
    expect(mergeStyle('a:1; junk; b:2', { b: null })).toBe('a:1; junk');
  });
  it('combines removal, replacement and addition in one call', () => {
    expect(mergeStyle('a:1; b:2; c:3', { a: null, b: '9', d: '4' })).toBe('b:9; c:3; d: 4');
  });
});

describe('helpers', () => {
  it('reads the effective value', () => {
    expect(getStyleValue('color:red; color:blue', 'COLOR')).toBe('blue');
    expect(getStyleValue('color:red !important', 'color')).toBe('red !important');
    expect(getStyleValue('a:1', 'b')).toBeNull();
  });
  it('validates property names', () => {
    for (const ok of ['color', 'Font-Size', '--x', '--my var'.replace(' ', ''), '-webkit-box']) expect(isValidPropName(ok)).toBe(true);
    for (const bad of ['', '1a', 'a b', 'a:b', 'a;b']) expect(isValidPropName(bad)).toBe(false);
  });
  it('accepts values that stay inside one declaration', () => {
    for (const ok of ['red', 'url(data:a;b)', '"a;b"', 'calc(1px + (2px))', "'x;y', serif", '12px !important']) {
      expect(isSafeStyleValue(ok)).toBe(true);
    }
    for (const bad of ['red; top:1px', 'red}', 'a)', '"open', '/* open', 'x\\', '{a}']) expect(isSafeStyleValue(bad)).toBe(false);
  });
});
