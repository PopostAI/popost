/** Font links in pages: `withFontLinks` for every page shape, and what `linkInstalledFonts` / `font install` report. */
import { describe, expect, it } from 'vitest';
import { FONT_LINK, installedFontLinks, linkInstalledFonts, withFontLinks } from '../src/fonts/project-fonts';
import { createTestRuntime, runCli } from '../src/testing/memory';
import { demoRole, mountLibrary } from './font-helpers';
import { newProject, newRuntime } from './workflow-helpers';

const LINK = '<link rel="stylesheet" href="../css/serif-a.css">';
const FRAGMENT = '<style>.page{width:10px}</style><div class="page" data-layer-id="a">x</div>';

describe('withFontLinks', () => {
  it('puts the links before </head>', () => {
    expect(withFontLinks('<html><head><meta charset="utf-8"></head><body></body></html>', LINK)).toBe(
      `<html><head><meta charset="utf-8">${LINK}</head><body></body></html>`,
    );
  });

  it('a page without </head> but with <body gets them before <body', () => {
    expect(withFontLinks('<!doctype html><html><style>a{}</style><body class="x"><div></div></body></html>', LINK)).toBe(
      `<!doctype html><html><style>a{}</style>${LINK}<body class="x"><div></div></body></html>`,
    );
  });

  it('a fragment page gets them before its first tag, after a doctype or comment', () => {
    expect(withFontLinks(FRAGMENT, LINK)).toBe(`${LINK}${FRAGMENT}`);
    expect(withFontLinks(`<!-- a<b -->\n${FRAGMENT}`, LINK)).toBe(`<!-- a<b -->\n${LINK}${FRAGMENT}`);
    expect(withFontLinks('plain text', LINK)).toBe(`${LINK}plain text`);
  });

  it('an open <head> that was never closed, or a bare <html>, gets them inside', () => {
    expect(withFontLinks('<head><style>a{}</style><div></div>', LINK)).toBe(`<head>${LINK}<style>a{}</style><div></div>`);
    expect(withFontLinks('<html><div></div>', LINK)).toBe(`<html>${LINK}<div></div>`);
  });

  it.each([
    ['head', '<html><head></head><body></body></html>'],
    ['body only', '<body><div></div></body>'],
    ['fragment', FRAGMENT],
  ])('is idempotent (%s): a page with exactly these links comes back identical', (_name, html) => {
    const once = withFontLinks(html, LINK);
    expect(withFontLinks(once, LINK)).toBe(once);
    expect(once.match(FONT_LINK)).toHaveLength(1);
  });

  it('replaces the links the page had, also stale or guessed ones', () => {
    const stale = '<head><link rel="stylesheet" href="../css/fonts.css"><link rel="stylesheet" href="../css/old.css" /></head>';
    expect(withFontLinks(stale, LINK)).toBe(`<head>${LINK}</head>`);
    expect(withFontLinks(stale, '')).toBe('<head></head>');
  });
});

const libraryRuntime = async () => {
  const base = await newRuntime();
  const rt = createTestRuntime({ fs: base.fs, env: {} });
  await mountLibrary(rt, [demoRole('serif-a'), demoRole('sans-b', 1)], true);
  return rt;
};

describe('linkInstalledFonts', () => {
  it('reports the pages it changed and leaves a page that is already right alone', async () => {
    const rt = await newRuntime();
    const project = await newProject(rt, 'P');
    await project.addPage('p2', 'Two');
    await project.addPage('p3', 'Three');
    expect(await linkInstalledFonts(project)).toEqual({ linked: [] });
    project.manifest.fonts = [{ id: 'serif-a', cssFamily: 'Family serif-a', cssPath: 'css/serif-a.css' }];
    expect(await linkInstalledFonts(project)).toEqual({ linked: ['p1', 'p2', 'p3'] });
    await project.writePageHtml('p2', FRAGMENT);
    expect(await linkInstalledFonts(project)).toEqual({ linked: ['p2'] });
    expect(await project.readPageHtml('p2')).toBe(`${LINK}${FRAGMENT}`);
    expect(await linkInstalledFonts(project, ['p1', 'p3'])).toEqual({ linked: [] });
  });

  it('only touches the pages asked for, and skips a font the page embeds itself', async () => {
    const rt = await newRuntime();
    const project = await newProject(rt, 'P');
    await project.addPage('p2', 'Two');
    project.manifest.fonts = [{ id: 'serif-a', cssFamily: 'Family serif-a', cssPath: 'css/serif-a.css' }];
    await project.writePageHtml('p2', `<style>@font-face { font-family: 'Family serif-a'; src: url(x.woff2); }</style>${FRAGMENT}`);
    expect(await linkInstalledFonts(project, ['p2'])).toEqual({ linked: [] });
    expect(await linkInstalledFonts(project, ['p1'])).toEqual({ linked: ['p1'] });
    expect(installedFontLinks(project, await project.readPageHtml('p2'))).toBe('');
  });

  it('names a page it could not handle instead of skipping it silently', async () => {
    const rt = await newRuntime();
    const project = await newProject(rt, 'P');
    project.manifest.fonts = [{ id: 'serif-a', cssFamily: 'Family serif-a', cssPath: 'css/serif-a.css' }];
    await rt.fs.rm(project.pageHtmlPath('p1'));
    const report = await linkInstalledFonts(project);
    expect(report.linked).toEqual([]);
    expect(report.failed).toMatchObject([{ page: 'p1' }]);
  });
});

describe('font install output', () => {
  it('lists the pages it linked, also the ones that lost their <head>', async () => {
    const rt = await libraryRuntime();
    const project = await newProject(rt, 'P');
    await project.addPage('p2', 'Two');
    await project.writePageHtml('p2', FRAGMENT);
    expect((await runCli(rt, ['font', 'install', '--dir', 'P', '--roles', 'serif-a'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, links: LINK, fontLinks: { linked: ['p1', 'p2'] } });
    expect(await project.readPageHtml('p2')).toBe(`${LINK}${FRAGMENT}`);

    await project.writePageHtml('p1', FRAGMENT);
    await runCli(rt, ['font', 'install', '--dir', 'P', '--roles', 'serif-a']);
    expect(rt.json()).toMatchObject({ fontLinks: { linked: ['p1'] } });
  });

  it('a directory that is not a project fails with one actionable line', async () => {
    const rt = await libraryRuntime();
    await rt.fs.mkdir('/work/fx');
    expect((await runCli(rt, ['font', 'install', '--dir', 'fx', '--roles', 'serif-a'])).code).toBe(1);
    const error = String(rt.json().error);
    expect(error).toContain('not a v2 project');
    expect(error).toContain('popost setup');
    expect(error).not.toContain('\n');
  });
});
