import { describe, expect, it } from 'vitest';
import { parse } from 'parse5';

describe('toolchain', () => {
  it('parses HTML with source locations', () => {
    const doc = parse('<p class="a">hi</p>', { sourceCodeLocationInfo: true });
    const html = doc.childNodes.find((n) => n.nodeName === 'html');
    expect(html).toBeDefined();
  });
});
