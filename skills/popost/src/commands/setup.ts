/**
 * `popost setup --dir P --spec setup.json`: the deterministic setup steps (init, settings, pages, references, fonts, plan,
 * image prepare, image quote) from one spec file, in one call. Nothing is generated or charged. The steps themselves are
 * in `setup/`; this module is the command line around them.
 */
import { withArgs, type CommandSpec } from '../args';
import { printJson } from '../core/util';
import type { CommandMain } from '../runtime';
import { runSetup } from '../setup/run';

const DESCRIPTION = `Set a project up from one spec file instead of init, settings, page add, reference, font install, plan, image prepare and image quote one by one. Nothing is generated and nothing is charged: the output lists the quotes and their total.

The spec is JSON; relative paths are relative to the spec file (keep it outside a project directory that does not exist yet). The whole spec is checked first: every problem is reported together and nothing is changed. Then the steps run in this order and stop at the first failure (the output names the step and the ones that are done): init, settings, pages, references, fonts, plan, images (image prepare), quote (image quote). Run the same command again after a fix: what is already done is skipped (existing pages, references with the same file/role/page, installed font roles, image jobs with the same request; a quoted job is never replaced).

fields (all optional except where noted):
  brief       the project brief; required only when the project does not exist yet
  mode        original (default) | strict (reproduction); fixed once the project exists
  width, height   canvas of the first page and of the pages added (default 1080 x 1350)
  pages       3  or  ["p1","p2","p3"]: all the pages; the missing ones are added (a new project starts with p1)
  settings    { "platform": tiktok|xiaohongshu|instagram|douyin|x, "language": "en", "channel": official|host|custom, "model": "..." }
  references  [{ "file": "inputs/ref-1.jpg", "role": layout|style|identity|content (default layout), "page": "p1" }]
  fonts       ["latin-inter-tight", ...]: font role ids (popost font list); cjk-* roles only for copy that has Chinese text (the export repeats a page's font CSS on every page)
  plan        "series-plan.json": the series plan (popost plan); its pages must be the project's pages
  images      [{ "id": "scene-bed", "promptFile": "prompts/scene-bed.md", "aspect": "9:16", "purpose": material (default)|composition, "ref": "identity" }]
              ref: layout|identity|style|content|all, or a picture path, or a list of them (as image prepare --ref); a composition job has no id
  quote       true by default when images are given: quote every prepared job; false only prepares them

example:
  {
    "brief": "Cozy bedroom set for a winter sale", "mode": "original", "width": 1080, "height": 1920, "pages": 3,
    "settings": { "platform": "tiktok", "language": "en", "channel": "official" },
    "references": [{ "file": "inputs/ref-1.jpg", "role": "layout", "page": "p1" }, { "file": "inputs/product.jpg", "role": "identity" }],
    "fonts": ["latin-inter-tight", "latin-poppins"],
    "plan": "series-plan.json",
    "images": [{ "id": "scene-bed", "promptFile": "prompts/scene-bed.md", "aspect": "9:16", "purpose": "material", "ref": "identity" }]
  }

output: {"ok": true, "steps": [{"step": "init", "status": "done|skipped", "detail": "..."}, ...], "warnings": ["only when there are some: e.g. a cjk-* font role installed for copy that is not Chinese"], "quotes": [{"id", "quoteId", "credits", ...}], "totalCredits": "60", "next": "..."}
failure: {"ok": false, "problems": [...]} for the spec check, or {"ok": false, "failedStep", "error", "steps": [the steps that are done]}; exit code 2 (1 when the platform refused a quote)
after it: the user confirms the plan and the cost first; then popost image run --dir P --all-quoted --confirm, and write the pages while the pictures generate.`;

const SPEC: CommandSpec = {
  prog: 'popost setup',
  description: DESCRIPTION,
  options: [
    { flag: '--dir', required: true, help: 'the project directory (created when it does not exist)' },
    { flag: '--spec', required: true, help: 'the spec file (JSON)' },
    { flag: '--config', help: 'private provider config for image prepare and quote (as image quote --config)' },
    { flag: '--accept-unknown-cost', kind: 'flag', help: 'bring-your-own-key services with an unknown price (as image quote)' },
  ],
};

export const main: CommandMain = (argv, rt) =>
  withArgs(argv, SPEC, rt, async (args) => {
    const { document, code } = await runSetup(rt, {
      dir: args.req('dir'),
      specPath: args.req('spec'),
      config: args.string('config'),
      acceptUnknownCost: args.flag('accept-unknown-cost'),
    });
    printJson(rt, document, true);
    return code;
  });
