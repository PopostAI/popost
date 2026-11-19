/**
 * `popost setup --dir P --spec setup.json`: the deterministic setup steps (init, settings, pages, references, fonts, plan,
 * image prepare, image quote) from one spec file, in one call. Nothing is generated or charged. The steps themselves are
 * in `setup/`; this module is the command line around them.
 */
import { withArgs, type CommandSpec } from '../args';
import { printJson } from '../core/util';
import type { CommandMain } from '../runtime';
import { runSetup } from '../setup/run';
import { msg } from '../i18n';

const EXAMPLE = `  {
    "brief": "Cozy bedroom set for a winter sale", "mode": "original", "width": 1080, "height": 1920, "pages": 3,
    "settings": { "platform": "tiktok", "language": "en", "channel": "official" },
    "references": [{ "file": "inputs/ref-1.jpg", "role": "layout", "page": "p1" }, { "file": "inputs/product.jpg", "role": "identity" }],
    "fonts": ["latin-inter-tight", "latin-poppins"],
    "plan": "series-plan.json",
    "images": [{ "id": "scene-bed", "promptFile": "prompts/scene-bed.md", "aspect": "9:16", "purpose": "material", "ref": "identity" }]
  }

`;

const description = (): string =>
  msg(
    `Set a project up from one spec file instead of init, settings, page add, reference, font install, plan, image prepare and image quote one by one. Nothing is generated and nothing is charged: the output lists the quotes and their total.

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
${EXAMPLE}output: {"ok": true, "steps": [{"step": "init", "status": "done|skipped", "detail": "..."}, ...], "warnings": ["only when there are some: e.g. a cjk-* font role installed for copy that is not Chinese"], "quotes": [{"id", "quoteId", "credits", ...}], "totalCredits": "60", "next": "..."}
failure: {"ok": false, "problems": [...]} for the spec check, or {"ok": false, "failedStep", "error", "steps": [the steps that are done]}; exit code 2 (1 when the platform refused a quote)
after it: the user confirms the plan and the cost first; then popost image run --dir P --all-quoted --confirm, and write the pages while the pictures generate.`,
    `用一个 spec 文件完成项目准备，不必逐个运行 init、settings、page add、reference、font install、plan、image prepare 和 image quote。不生成任何内容，也不扣费：输出列出各项报价及总额。

spec 是 JSON；相对路径以 spec 文件所在目录为准（项目目录还不存在时，spec 文件要放在它外面）。先检查整个 spec：所有问题一起报告，不做任何改动。然后按以下顺序执行各步骤，遇到第一个失败即停止（输出会写明失败的步骤和已完成的步骤）：init、settings、pages、references、fonts、plan、images（image prepare）、quote（image quote）。修好后再运行同一条命令：已完成的部分会跳过（已有的页面、file/role/page 相同的参考图、已安装的字体角色、请求相同的图片任务；已报价的任务永远不会被替换）。

字段（除注明外都可省略）：
  brief       项目简介；只有项目还不存在时必填
  mode        original（默认）| strict（复刻）；项目建好后不能再改
  width, height   第一页及新增页面的画布尺寸（默认 1080 x 1350）
  pages       3  或  ["p1","p2","p3"]：全部页面；缺少的会被添加（新项目从 p1 开始）
  settings    { "platform": tiktok|xiaohongshu|instagram|douyin|x, "language": "en", "channel": official|host|custom, "model": "..." }
  references  [{ "file": "inputs/ref-1.jpg", "role": layout|style|identity|content（默认 layout）, "page": "p1" }]
  fonts       ["latin-inter-tight", ...]：字体角色 id（popost font list）；cjk-* 角色只用于含中文的文案（导出时每一页都会重复该页的字体 CSS）
  plan        "series-plan.json"：series plan（popost plan）；它的页面必须与项目页面一致
  images      [{ "id": "scene-bed", "promptFile": "prompts/scene-bed.md", "aspect": "9:16", "purpose": material（默认）|composition, "ref": "identity" }]
              ref：layout|identity|style|content|all，或图片路径，或它们的列表（同 image prepare --ref）；composition 任务没有 id
  quote       给了 images 时默认为 true：为每个准备好的任务报价；false 只准备不报价

示例：
${EXAMPLE}output: {"ok": true, "steps": [{"step": "init", "status": "done|skipped", "detail": "..."}, ...], "warnings": ["只在有警告时出现：例如为非中文文案安装了 cjk-* 字体角色"], "quotes": [{"id", "quoteId", "credits", ...}], "totalCredits": "60", "next": "..."}
failure: spec 检查不通过时为 {"ok": false, "problems": [...]}，步骤失败时为 {"ok": false, "failedStep", "error", "steps": [已完成的步骤]}；退出码 2（平台拒绝报价时为 1）
之后：先让用户确认方案和费用；再运行 popost image run --dir P --all-quoted --confirm，生图期间写页面。`,
  );

const spec = (): CommandSpec => ({
  prog: 'popost setup',
  description: description(),
  options: [
    { flag: '--dir', required: true, help: msg('the project directory (created when it does not exist)', '项目目录（不存在时会创建）') },
    { flag: '--spec', required: true, help: msg('the spec file (JSON)', 'spec 文件（JSON）') },
    {
      flag: '--config',
      help: msg('private provider config for image prepare and quote (as image quote --config)', '供 image prepare 和 quote 使用的私有 provider 配置（同 image quote --config）'),
    },
    {
      flag: '--accept-unknown-cost',
      kind: 'flag',
      help: msg('bring-your-own-key services with an unknown price (as image quote)', '允许价格未知的自带 Key 服务（同 image quote）'),
    },
  ],
});

export const main: CommandMain = (argv, rt) =>
  withArgs(argv, spec(), rt, async (args) => {
    const { document, code } = await runSetup(rt, {
      dir: args.req('dir'),
      specPath: args.req('spec'),
      config: args.string('config'),
      acceptUnknownCost: args.flag('accept-unknown-cost'),
    });
    printJson(rt, document, true);
    return code;
  });
