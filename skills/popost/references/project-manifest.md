# 工程权威与兼容

磁盘文件仍为 social-studio-project.json，schema= social-studio-project.v2；新建工程增加 workflowVersion=3，旧工程仍可加载。每页 pages/{id}.html 是唯一排版权威。编辑器 GET 注入 html 仅用于传输，POST 拆回文件；ZIP 同样携独立 HTML，不制造布局副本。

核心字段：pages[{id,name,htmlPath,width,height,role?}]、assets[{id,path,sha256,kind}]、fonts、sources、concept（`series prompt` 另记 grid、aspect）、projectId、platform、language、provider{channel,model}、revision。新增 seriesPlan 指向 series-plan.json，reviews 按页保存当前指纹与 PNG 哈希，seriesReview 绑定计划与整组页面指纹。

series-plan.json 的语义契约由 `plan` 命令校验，形状见 `<skill>/assets/series-plan.example.json`；template-profile 的必需字段由 `template-profile` 命令校验，形状见 `<skill>/assets/template-profile.example.json`。两者只记录内容和设计约束。

reference/ 存本地参考与唯一内部构图联系表；production/ 存任务与模型结果，编辑交付 ZIP 排除此类制作资料。exports/ 存 PNG、渲染凭证和项目 ZIP。用户私有 Provider 配置始终在工程之外。
