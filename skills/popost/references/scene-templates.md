# 场景 skill

用户点名场景或提供路径时定位实际 skill，读取 SKILL.md 全文，再读取当前场景引用的规则、样例与资产。不要只读 frontmatter 或拿平台关键词匹配。用户未指定时可以按内容召回候选，但由 Agent 读后判断。

把实际使用的内容组织、页面类型、字体、配色、图文关系、标志性布局、留白、素材规则、必需项与可变项写进 template-profile.json。形状见 `<skill>/assets/template-profile.example.json`，执行 template-profile --file F 记录来源哈希并挂到工程。profile 是约束说明，不是布局 JSON。普通 skill 无需原生 template.json；Agent 负责读懂并形成可执行规则。

创作的计划、内部参考联系表和素材提示消费该 profile；排版落实规则，审核再逐项核对。参考和场景可分工：原图给内容、场景给设计；忠实复刻时保留参考，场景提供兼容的字体/材质等。只有明确要求不可兼得才询问，requiresReview 表示 Agent 核对，不表示默认必须找用户批准。

场景的设计体系完整保留，模型、HTML、画布和下载由 popost 负责。场景原来的编辑器、Replay、导出页或发布行为不会自动加入任务。缺资源或难以转换的依赖真实报告，不偷偷换成泛用卡片。

测试夹具不发布为独立 skill。外部用户点名的已安装 skill 仍按其真实路径读取。

## Bundled community index

The `templates/community/` directory contains the published recipes. Their original preview pages are not in the package: each `template.json` lists them as public image URLs. The schema-versioned `index.json` is also consumed by the website.

To choose a template, read `<skill>/templates/community/README.md` once: it lists all templates grouped by category, with the zh / en name, a link to the template's `SKILL.md` (the folder name is the template id) and a one-line "use when" in both languages. You can also grep it or `index.json` for a product word in Chinese or English. Shortlist 1-3 candidates by product type and by what the post shows, read each candidate's `SKILL.md` and the linked references in full, then pick one or decide that none fits (then design directly). Choosing does not apply a template, generate media, or change a project. When the user has already chosen a template, follow that choice directly.

`popost template search --query "防水鞋" --platform tiktok --category shoes --limit 5` is an optional keyword shortcut over the same index. Its results are only candidates (each has its revision and `skillPath`); it can miss paraphrases and the other language, so when it finds nothing useful, read the README instead of guessing keywords.

`README.md` is generated from `index.json`: after the index changes, run `node tools/build-template-catalog.mjs` in the Skill directory (a test fails when it is out of date).
