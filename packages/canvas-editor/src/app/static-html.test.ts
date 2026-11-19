import { describe, expect, it } from 'vitest';
import { exportFileName, makeStaticHtml, STATIC_CSP } from './static-html';

const META = `<meta http-equiv="Content-Security-Policy" content="${STATIC_CSP}">`;

describe('makeStaticHtml', () => {
  it('removes scripts, embeds, handlers and javascript urls and adds a CSP', () => {
    const out = makeStaticHtml(
      `<!doctype html><html onload="x()"><head><title>T</title><base href="/"><script>1</script></head>` +
        `<body><noscript>n</noscript><iframe src="a"></iframe><frame><object></object><embed>` +
        `<a href=" JavaScript:alert(1)" onclick="y()">l</a><form action="javascript:z()"></form>` +
        `<img src="data:image/png;base64,AA" formaction="javascript:q"><p class="slide" style="color:red">Hi</p>` +
        `<template><script>2</script><b onclick="w()">t</b></template></body></html>`,
    );
    expect(out.startsWith(`<!DOCTYPE html>\n<html><head>${META}<title>T</title>`)).toBe(true);
    for (const bad of ['<script', '<base', 'noscript', 'iframe', '<frame', '<object', '<embed', 'onload', 'onclick', 'javascript:']) {
      expect(out.toLowerCase()).not.toContain(bad);
    }
    expect(out).toContain('<p class="slide" style="color:red">Hi</p>');
    expect(out).toContain('src="data:image/png;base64,AA"');
    expect(out).toContain('<b>t</b>');
  });

  it('keeps an existing CSP meta, any letter case', () => {
    const out = makeStaticHtml(`<html><head><meta http-equiv="content-security-policy" content="default-src *"></head><body></body></html>`);
    expect(out.match(/<meta /g)).toHaveLength(1);
    expect(out).toContain('default-src *');
    expect(out.startsWith('<!DOCTYPE')).toBe(false);
  });

  it('keeps ordinary href/src and non-script content intact', () => {
    const out = makeStaticHtml(`<body><a href="https://x.test/a?b=1" target="_blank">x</a><svg><a xlink:href="javascript:1"><text>t</text></a></svg></body>`);
    expect(out).toContain('href="https://x.test/a?b=1"');
    expect(out).not.toContain('javascript');
    expect(out).toContain('<text>t</text>');
  });
});

describe('exportFileName', () => {
  it('uses the document name', () => {
    expect(exportFileName('My post')).toBe('My post.html');
    expect(exportFileName('a/b:c.html')).toBe('a-b-c.html');
    expect(exportFileName('')).toBe('index.html');
    expect(exportFileName(null)).toBe('index.html');
  });
});
