/** `popost page check`: every problem it lists, the output shape, and the `--page` list. */
import { describe, expect, it } from 'vitest';
import { selectPages } from '../src/render/page-select';
import { checkPages } from '../src/workflow/page-check';
import { runCli, type TestRuntime } from '../src/testing/memory';
import { newProject, newRuntime, pageHtml, PNG_1X1 } from './workflow-helpers';

const LINK = '<link rel="stylesheet" href="../css/serif-a.css">';

/** Project `P` with one page that has `html`, optionally with an installed font. */
const projectWith = async (html: string, font = false) => {
  const rt = await newRuntime();
  const project = await newProject(rt, 'P');
  if (font) {
    project.manifest.fonts = [{ id: 'serif-a', cssFamily: 'Family serif-a', cssPath: 'css/serif-a.css' }];
    await rt.fs.writeFile('/work/P/css/serif-a.css', '/* font */');
  }
  await project.writePageHtml('p1', html);
  return { rt, project };
};

const codes = async (html: string, font = false): Promise<string[]> => {
  const { project } = await projectWith(html, font);
  return (await checkPages(project, ['p1'])).map((problem) => problem.code);
};

describe('page check: what it finds', () => {
  it('a clean page has no problems', async () => {
    expect(await codes(pageHtml())).toEqual([]);
  });

  it('an unclosed <style>, and a stray </style>', async () => {
    expect(await codes(pageHtml().replace('</style>', ''))).toContain('style-unclosed');
    expect(await codes(pageHtml().replace('<style>', ''))).toContain('style-stray-close');
  });

  it('text that is a tag that lost its "<"', async () => {
    const lostLink = pageHtml().replace('</head>', 'link rel="stylesheet" href="../css/x.css">\n</head>');
    expect(await codes(lostLink)).toContain('lost-bracket');
    const lostCloser = pageHtml().replace('</style>', '</style>\n/style>');
    expect(await codes(lostCloser)).toContain('lost-bracket');
    // ordinary copy and CSS are not mistaken for it
    expect(await codes(pageHtml('Use a link rel attribute, then div > span'))).toEqual([]);
  });

  it('missing or stale font links, with a hint that the CLI restores them', async () => {
    const { project } = await projectWith(pageHtml(), true);
    const [problem] = await checkPages(project, ['p1']);
    expect(problem).toMatchObject({ page: 'p1', code: 'font-links' });
    expect(problem!.fix).toContain('popost render');
    await project.writePageHtml('p1', pageHtml().replace('</head>', `${LINK}</head>`));
    expect(await checkPages(project, ['p1'])).toEqual([]);
    await project.writePageHtml('p1', pageHtml().replace('</head>', '<link rel="stylesheet" href="../css/fonts.css"></head>'));
    expect((await checkPages(project, ['p1'])).map((p) => p.code)).toEqual(expect.arrayContaining(['font-links', 'missing-file']));
  });

  it('local files that do not exist: src, href and css url()', async () => {
    const html = pageHtml('x', true).replace('</div></body>', '<div style="background:url(../assets/bg.jpg)"></div></div></body>');
    const { rt, project } = await projectWith(html);
    const found = await checkPages(project, ['p1']);
    expect(found.map((p) => p.message)).toEqual([
      'src "../assets/local.png" points to a file that is not in the project',
      'url() "../assets/bg.jpg" points to a file that is not in the project',
    ]);
    await rt.fs.writeFile('/work/P/assets/bg.jpg', PNG_1X1);
    await project.addAssetBytes(PNG_1X1, 'local.png');
    expect(await checkPages(project, ['p1'])).toEqual([]);
  });

  it('ignores remote, data and anchor references here, and flags a path that leaves the project', async () => {
    const html = pageHtml().replace('</div></body>', '<img src="data:image/png;base64,AAAA"><a href="#top">a</a><img src="../../outside.png"></div></body>');
    expect(await codes(html)).toEqual(['missing-file']);
  });

  it('duplicate data-layer-id', async () => {
    const { project } = await projectWith(pageHtml().replace('</div></body>', '<div data-layer-id="title"></div></div></body>'));
    expect(await checkPages(project, ['p1'])).toMatchObject([{ code: 'duplicate-layer-id', message: 'data-layer-id "title" is used 2 times' }]);
  });

  it('a page without a root, a script and a remote URL (from the audit scan), and a missing page file', async () => {
    expect(await codes('<!doctype html><html><head></head><body><main>x</main></body></html>')).toEqual(['no-canvas-root']);
    const scripted = pageHtml().replace('</body>', '<script>1</script><img src="https://example.com/a.png"></body>');
    expect(await codes(scripted)).toEqual(['script-present', 'external-ref']);
    const { rt, project } = await projectWith(pageHtml());
    await rt.fs.rm(project.pageHtmlPath('p1'));
    expect(await checkPages(project, ['p1'])).toMatchObject([{ code: 'page-unreadable' }]);
  });

  it('a fragment page that lost its head is fine except for the links', async () => {
    const fragment = '<style>.page{width:1080px}</style><div class="page" data-layer-id="a">x</div>';
    expect(await codes(fragment)).toEqual([]);
    expect(await codes(fragment, true)).toEqual(['font-links']);
  });
});

const run = async (rt: TestRuntime, ...args: string[]) => {
  const result = await runCli(rt, ['page', 'check', '--dir', 'P', ...args]);
  return { code: result.code, out: rt.json() };
};

describe('page check: the command', () => {
  it('prints clean, the pages checked and every problem with its page and a fix hint', async () => {
    const { rt, project } = await projectWith(pageHtml());
    await project.addPage('p2', 'Two');
    await project.writePageHtml('p2', pageHtml().replace('</style>', ''));
    expect(await run(rt)).toMatchObject({ code: 0, out: { ok: true, clean: false, checked: ['p1', 'p2'] } });
    const { out } = await run(rt);
    const [problem] = out.problems as Record<string, string>[];
    expect(Object.keys(problem!).sort()).toEqual(['code', 'fix', 'message', 'page']);
    expect(problem).toMatchObject({ page: 'p2', code: 'style-unclosed' });
    expect(problem!.fix).toContain('</style>');
    expect(await run(rt, '--page', 'p1')).toMatchObject({ code: 0, out: { clean: true, checked: ['p1'], problems: [] } });
  });

  it('takes a list of pages and answers an unknown one with exit 2', async () => {
    const { rt, project } = await projectWith(pageHtml());
    await project.addPage('p2', 'Two');
    await project.addPage('p3', 'Three');
    expect((await run(rt, '--page', 'p3,p1')).out).toMatchObject({ checked: ['p3', 'p1'] });
    expect(await run(rt, '--page', 'p1,p9')).toMatchObject({ code: 2, out: { ok: false, error: 'ProjectError: 页不存在: p9' } });
  });

  it('is listed in the help, and page add / ls still work', async () => {
    const { rt } = await projectWith(pageHtml());
    const help = await runCli(rt, ['page', '--help', '--dir', 'P']);
    expect(help.stdout).toContain('check');
    expect(help.stdout).toContain('--page');
    expect((await runCli(rt, ['page', 'ls', '--dir', 'P'])).code).toBe(0);
  });

  it('selectPages: a list keeps its order and drops repeats', async () => {
    const { project } = await projectWith(pageHtml());
    await project.addPage('p2', 'Two');
    expect(selectPages(project, 'p2, p1,p2')).toEqual(['p2', 'p1']);
  });
});
