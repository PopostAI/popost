/**
 * `popost video source`: a README and a page read for their pictures, colours and links, against a stubbed network;
 * and the warning of the checks when a project uses none of the pictures its sources gave.
 */
import { describe, expect, it } from 'vitest';
import { cli, tinyPng } from '../image-helpers';
import { createTestRuntime } from '../../src/testing/memory';
import { collectSource, INVENTORY_FILE } from '../../src/video/source/collect';
import { hexOf, isBadge, isLogo, ownHosts, readSource, svgColours } from '../../src/video/source/read';
import { sourcePictureProblems } from '../../src/video/source/used';
import type { Project } from '../../src/video/types';

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40"><rect fill="#FF5A36" width="40" height="40"/><path fill="#ff5a36" d="M0 0h4v4z"/><text fill="#111111">acme</text><circle stroke="rgb(20, 80, 200)" r="3"/></svg>';
const README = [
  '<p align="center"><img src="https://static.acme.test/brand/logo.svg" alt="Acme logo" width="120"></p>',
  '',
  '# Acme Studio',
  '[![build](https://img.shields.io/badge/build-passing-green.svg)](https://github.com/acme/studio/actions) ![npm](https://badge.fury.io/js/acme.svg)',
  '',
  'Make posts in 3 steps. Visit [the site](https://acme.test/pricing) or read [the docs](https://docs.acme.test).',
  '',
  '## The editor',
  '<img src="https://static.acme.test/shots/editor.png" alt="The canvas editor with a post open">',
  '![Export dialog](./docs/export.png "Export")',
  '',
  '```md',
  '![not a picture](https://static.acme.test/shots/in-code.png)',
  '```',
  '',
  '## Community',
  '<img src="https://tracker.test/pixel.gif" alt=""> Join us on [Discord](https://discord.gg/acme) and [a friend\'s blog](https://someone-else.test/post).',
].join('\n');

const png = (n: number) => tinyPng([n, n, n], 8);
const FILES: Record<string, [string, Uint8Array | string]> = {
  'https://raw.githubusercontent.com/acme/studio/main/README.md': ['text/plain; charset=utf-8', README],
  'https://static.acme.test/brand/logo.svg': ['image/svg+xml', LOGO],
  'https://static.acme.test/shots/editor.png': ['image/png', png(10)],
  'https://raw.githubusercontent.com/acme/studio/main/docs/export.png': ['image/png', png(20)],
  'https://tracker.test/pixel.gif': ['image/png', tinyPng([0, 0, 0], 1)],
  'https://acme.test/': ['text/html', '<html><head><title>Acme</title><meta name="theme-color" content="#0A84FF"><link rel="icon" href="/favicon.png"><meta property="og:image" content="https://acme.test/social.png"><style>.x{}</style></head><body><h1>Acme</h1><script>var a = 7;</script><p>Posts in 3 steps.</p><img src="/hero.png" alt="Hero"><a href="/pricing">Pricing</a><a href="https://x.com/acme">X</a></body></html>'],
  'https://acme.test/favicon.png': ['image/png', png(30)],
  'https://acme.test/social.png': ['image/png', png(40)],
  'https://acme.test/hero.png': ['image/png', png(50)],
};
const scene = () => {
  const asked: string[] = [];
  const rt = createTestRuntime({
    fetchHandler: (request) => {
      asked.push(request.url);
      const hit = FILES[request.url];
      return hit ? new Response(hit[1] as BodyInit, { status: 200, headers: { 'content-type': hit[0] } }) : new Response('no', { status: 404 });
    },
  });
  return { rt, asked };
};

describe('reading a source', () => {
  it('finds pictures in tags and in Markdown, each under its heading, and nothing inside fenced code', () => {
    const r = readSource(README, { markdown: true });
    expect(r.title).toBe('Acme Studio');
    expect(r.pictures.map((p) => [p.src.split('/').pop(), p.alt, p.heading])).toEqual([
      ['logo.svg', 'Acme logo', ''], ['build-passing-green.svg', 'build', 'Acme Studio'], ['acme.svg', 'npm', 'Acme Studio'],
      ['editor.png', 'The canvas editor with a post open', 'The editor'], ['export.png', 'Export dialog', 'The editor'], ['pixel.gif', '', 'Community'],
    ]);
    expect(r.links.map((l) => l.url)).toEqual(['https://github.com/acme/studio/actions', 'https://acme.test/pricing', 'https://docs.acme.test', 'https://discord.gg/acme', 'https://someone-else.test/post']);
    expect(r.text).toBe(README);
  });

  it('tells badges, logos, colours and the product\'s own hosts from the addresses', () => {
    expect([isBadge(new URL('https://img.shields.io/npm/v/x.svg'), ''), isBadge(new URL('https://github.com/a/b/actions/workflows/ci.yml/badge.svg'), ''), isBadge(new URL('https://static.acme.test/shots/editor.png'), 'The editor')]).toEqual([true, true, false]);
    expect([isLogo('https://a.test/brand/logo.svg', ''), isLogo('https://a.test/x.png', 'Acme logo'), isLogo('https://a.test/editor.png', 'The editor')]).toEqual([true, true, false]);
    expect(svgColours(LOGO)).toEqual([{ hex: '#ff5a36', uses: 2, neutral: false }, { hex: '#1450c8', uses: 1, neutral: false }, { hex: '#111111', uses: 1, neutral: true }]);
    expect([hexOf('#0A8'), hexOf('rgb(1,2,3)'), hexOf('red')]).toEqual(['#00aa88', '#010203', undefined]);
    expect(ownHosts(['acme.test', 'docs.acme.test', 'discord.gg', 'someone-else.test', 'github.com'], { page: 'raw.githubusercontent.com', pictureHosts: ['static.acme.test'], names: ['acme', 'studio'] })).toEqual(['acme.test', 'docs.acme.test']);
    expect(ownHosts(['getacme.io', 'other.test'], { pictureHosts: [], names: ['acme'] })).toEqual(['getacme.io']);
  });
});

describe('popost video source', () => {
  it('saves the text, downloads the pictures with the logo first, leaves badges and pixels out, and follows no link', async () => {
    const { rt, asked } = scene();
    const r = await cli(rt, 'video', 'source', 'https://raw.githubusercontent.com/acme/studio/main/README.md', '--out', '/work/project/source');
    expect(r.code).toBe(0);
    expect(r.data.pictures.map((p: { file: string; says: string; heading: string; format: string; width: number; height: number; logo?: boolean }) => [p.file, p.says, p.heading, p.format, p.width, p.height, p.logo === true])).toEqual([
      ['project/source/pictures/readme/01-logo.svg', 'Acme logo', '', 'svg', 120, 40, true],
      ['project/source/pictures/readme/02-editor.png', 'The canvas editor with a post open', 'The editor', 'png', 8, 8, false],
      ['project/source/pictures/readme/03-export.png', 'Export dialog', 'The editor', 'png', 8, 8, false],
    ]);
    expect(r.data.skipped).toEqual({ badges: 2, pixels: 1, overLimit: 0, failed: [] });
    expect(r.data.colours).toEqual([{ hex: '#ff5a36', from: 'pictures/readme/01-logo.svg' }, { hex: '#1450c8', from: 'pictures/readme/01-logo.svg' }, { hex: '#111111', from: 'pictures/readme/01-logo.svg', neutral: true }]);
    expect(r.data.site).toEqual({ hosts: ['acme.test'], links: [{ url: 'https://acme.test/pricing', text: 'the site' }, { url: 'https://docs.acme.test/', text: 'the docs' }] });
    expect(r.data.otherHosts).toEqual(['github.com', 'discord.gg', 'someone-else.test']);
    // The page and the pictures it references, nothing else: no badge, no linked page.
    expect(asked.sort()).toEqual(['https://raw.githubusercontent.com/acme/studio/main/README.md', 'https://raw.githubusercontent.com/acme/studio/main/docs/export.png', 'https://static.acme.test/brand/logo.svg', 'https://static.acme.test/shots/editor.png', 'https://tracker.test/pixel.gif']);
    expect(await rt.fs.readText('/work/project/source/readme.md')).toBe(README);
    expect(new TextDecoder().decode(await rt.fs.readFile('/work/project/source/pictures/readme/01-logo.svg'))).toBe(LOGO);
    expect((JSON.parse(await rt.fs.readText('/work/project/source/' + INVENTORY_FILE)) as { sources: unknown[] }).sources).toHaveLength(1);
  });

  it('reads a page: its text without scripts, its icon and preview picture last, its theme colour; a second source joins the inventory', async () => {
    const { rt } = scene();
    await collectSource(rt, { source: 'https://raw.githubusercontent.com/acme/studio/main/README.md', outDir: '/work/project/source' });
    const page = await collectSource(rt, { source: 'https://acme.test/', outDir: '/work/project/source', maxPictures: 2 });
    expect(page.pictures.map((p) => [p.file, p.kind])).toEqual([['pictures/acme/01-hero.png', 'img'], ['pictures/acme/02-favicon.png', 'icon']]);
    expect(page.skipped.overLimit).toBe(1);
    expect(page.colours).toEqual([{ hex: '#0a84ff', from: 'theme-color' }]);
    expect(await rt.fs.readText('/work/project/source/acme.txt')).toBe('Acme\nPosts in 3 steps.\nPricing X\n');
    expect(page.otherHosts).toEqual(['x.com']);
    const again = await collectSource(rt, { source: 'https://acme.test/', outDir: '/work/project/source' });
    expect(again.pictures).toHaveLength(3);
    expect((JSON.parse(await rt.fs.readText('/work/project/source/' + INVENTORY_FILE)) as { sources: { source: string }[] }).sources.map((s) => s.source)).toEqual(['https://raw.githubusercontent.com/acme/studio/main/README.md', 'https://acme.test/']);
  });

  it('reads a local file with the pictures beside it, and says what it could not fetch', async () => {
    const rt = createTestRuntime({ files: { '/work/in/README.md': '# Local\n![Shot](shots/a.png)\n![Out](../secret.png)\n![Gone](gone.png)', '/work/in/shots/a.png': png(60), '/work/secret.png': png(70) } });
    const entry = await collectSource(rt, { source: '/work/in/README.md', outDir: '/work/project/source' });
    expect(entry.pictures.map((p) => [p.file, p.from])).toEqual([['pictures/readme/01-a.png', 'shots/a.png']]);
    expect(entry.skipped.failed).toEqual([{ from: '../secret.png', why: 'outside the directory of the source' }, { from: 'gone.png', why: 'no such file' }]);
    const bad = await cli(scene().rt, 'video', 'source', 'https://acme.test/missing', '--out', '/work/p/source');
    expect(bad.code).toBe(2);
    expect(bad.data.error).toMatch(/could not be fetched \(HTTP 404\)/);
    const plain = await cli(scene().rt, 'video', 'source', 'http://acme.test/', '--out', '/work/p/source');
    expect(plain.data.error).toContain('fetched over https');
  });
});

describe('the pictures of the sources in the checks', () => {
  const project = (extra: Partial<Project> = {}): Project => ({ version: 1, canvas: { width: 1280, height: 720, fps: 30 }, materials: [], segments: [{ id: 's1', frames: 30, base: { scene: 'scenes/a.html' } }], tracks: [], ...extra });
  const collected = async (scenes: Record<string, string> = {}) => {
    const { rt } = scene();
    await collectSource(rt, { source: 'https://raw.githubusercontent.com/acme/studio/main/README.md', outDir: '/work/project/source' });
    for (const [file, html] of Object.entries(scenes)) await rt.fs.writeFile('/work/project/' + file, html);
    return rt;
  };

  it('warns when the sources gave pictures and nothing of the project shows one', async () => {
    const rt = await collected({ 'scenes/a.html': '<div class="fake-editor">an editor drawn in HTML</div>' });
    const problems = await sourcePictureProblems(rt, '/work/project', project());
    expect(problems.map((p) => p.level + ' ' + p.at)).toEqual(['warning source']);
    expect(problems[0]?.message).toContain('The sources gave 3 pictures (source/pictures/readme/01-logo.svg, source/pictures/readme/02-editor.png, source/pictures/readme/03-export.png) and no scene, picture or footage of the project uses any of them');
    expect(problems[0]?.fix).toContain('Never draw an imitation of its interface');
  });

  it('is content with a scene that shows one, a material that names one, or a copy of one under another name; and without sources', async () => {
    const inScene = await collected({ 'scenes/a.html': '<img src="../source/pictures/readme/02-editor.png">' });
    expect(await sourcePictureProblems(inScene, '/work/project', project())).toEqual([]);
    const named = await collected();
    expect(await sourcePictureProblems(named, '/work/project', project({ materials: [{ id: 'image-1', kind: 'image', file: 'assets/01-logo.svg' }] }))).toEqual([]);
    const copied = await collected();
    await copied.fs.writeFile('/work/project/assets/ui.png', await copied.fs.readFile('/work/project/source/pictures/readme/02-editor.png'));
    expect(await sourcePictureProblems(copied, '/work/project', project({ materials: [{ id: 'image-1', kind: 'image', file: 'assets/ui.png' }] }))).toEqual([]);
    expect(await sourcePictureProblems(createTestRuntime(), '/work/project', project())).toEqual([]);
  });
});
