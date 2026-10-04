# 已安装 Agent 检测

在「设置 → Agent 目录」点击「检测已安装 Agent」，查看证据并选择客户端，然后点击「一键启用」。已启用的 Agent 保持启用，已有 Skill 路径、分类、标签和翻译配置保留。

## 检测范围

- 命令：本进程 PATH（最多 128 项）及常用的用户 bin、npm、Cargo、Bun 和 Kimi 安装目录。只检查本地绝对路径，不执行客户端、不访问账号或模型接口。
- 桌面应用：Windows 常见用户／系统安装位置、macOS Applications 内的应用包、部分 Linux 固定安装位置。macOS 包需有 Info.plist 和可执行文件；Unix 命令需有执行权限。
- VS Code 系列插件：检查 `.vscode`、`.vscode-insiders`、`.cursor`、`.kiro`、`.trae`、`.trae-cn`、`.windsurf`、`.antigravity` 的 extensions。通过 package.json 的 publisher/name 与入口文件核验，排除 `.obsolete` 标记的版本；每个目录最多 512 项，每份清单最多 256 KiB。
- 仅有品牌配置目录时显示「仅发现配置目录」，不会默认选中。共享 `.agents/skills` 与其他品牌的兼容路径不能作为安装证据。

安装映射保存在 `src/agent-installations.json`，与 `src/agent-catalog.json` 的 35 个产品条目一一对应。命令、桌面包和插件是不同的证据；无需在本机安装全部产品来使用目录。

当前有核验映射的 VS Code 插件包括 Claude Code、Codex、GitHub Copilot、Cline、Kilo、Roo 和 Zencoder。Qoder／CodeBuddy 的插件和 JetBrains 独立插件目录不通过推测的插件 ID 自动识别；相应 CLI 或常见桌面应用仍可检测。

## 启用与数据保护

界面只默认勾选已找到安装证据、具有原生目录、当前未启用的 Agent。Aider 需要手动读取，WorkBuddy 需要客户端导入，检测到应用后也不会创建未经确认的同步目录。

启用接口只接收 Agent ID，不接受客户端报告或整份设置。后端重新检测，验证所有所选 ID 和最新配置中的绝对 Skill 路径，再在 SQLite 写事务中修改 enabled。任何 ID 无效都使整批失败；重复 ID 幂等；已启用 Agent 不写回。返回设置中的密钥按原有规则遮盖，数据库保留原值。

检测与启用不会创建 Skill 目录或复制技能，启用成功后才按已有配置刷新 Skill 列表。启用不注册快捷键，避免其他正在运行的实例占用快捷键影响此操作。

## 实际限制

- 安装证据不代表能成功启动、已登录、订阅可用、插件已启用或技能已加载。
- 自定义安装位置且未加入 PATH、JetBrains 插件、商店安装、便携应用、容器、WSL、SSH 和云端环境可能漏检。可在目录中手动启用并配置实际 Skill 路径。
- Kimi 新旧 CLI、Antigravity IDE/CLI 和 Pi/Hermes 等同名命令使用路径／启动脚本标记区分；无法确认身份时保守跳过。
- npm 包目录与命令 shim 同时存在才接受 stock npm shim；此检查不替代完整运行验证。
- 只有 Windows 做本次桌面实测；macOS/Linux 安装位置以静态映射和文件夹 fixture 验证，Unix 权限测试需在 Unix 运行。

## 验证

Rust 测试使用独立临时目录与 SQLite，包括配置残留、共享根、空／相对 PATH、过期 npm shim、版本区分、插件身份／入口／卸载标记／大小限制、桌面包、无效路径、原子失败、重复 ID、设置保留和密钥遮盖。

浏览器测试 `scripts/agent-installation-ui.test.mjs` 使用内存 API fixture，验证默认选中、排除项、取消全选、部分启用、后端拒绝、检测失败、空结果、刷新列表、窄布局，以及大量 Agent 时仍能看到设置入口。它不写本机数据库，也不是原生启用 smoke test。

运行浏览器测试前启动 `pnpm.cmd dev` 或 `pnpm.cmd vite:dev --host 127.0.0.1`。Playwright 位于独立环境时设置 `SKILLANVIL_PLAYWRIGHT_MODULE`；Windows 默认使用 Edge。

## 标识核验来源

- [GitHub Copilot 官方 Marketplace](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot)
- [Cline 官方 Marketplace](https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev)
- [Kilo 插件 package.json](https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-vscode/package.json)
- [Roo 插件 package.json](https://github.com/RooCodeInc/Roo-Code/blob/main/src/package.json)
- [Zencoder 官方 Marketplace](https://marketplace.visualstudio.com/items?itemName=zencoderai.zencoder)
- [Antigravity CLI 官方仓库](https://github.com/google-antigravity/antigravity-cli)
- [DeepSeek Harness CLI 的 bin 映射](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/package.json)
- [Pi CLI package.json](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/package.json)
- [Junie 官方插件说明](https://junie.jetbrains.com/docs/junie-ide-plugin.html)

## 2026-10-02 验收记录

- PASS：typecheck、前端 build、cargo fmt --check、44 项 Rust 测试、cargo check、3 项目录／资源测试、两个浏览器交互测试、git diff --check。
- PASS：实际 Windows 开发版点击检测，识别 12 个：Claude Code、Cursor、Codex、Antigravity IDE／CLI、OpenCode、DeepSeek Harness、Gemini CLI、Grok Build、Kiro、Kimi Code CLI、OpenClaw。原有 4 个启用项保留，8 个未启用项预选。仅配置目录的 9 项单独显示。
- PASS：浏览器内存 fixture 中完成部分启用并刷新列表；独立 SQLite 测试确认批量启用的原子保存、幂等及原配置保留。
- NOT_RUN：没有点击本机一键启用，未改变用户真实的 Agent 启用状态。没有在 macOS/Linux 实机执行。
- 既有运行限制：安装版同时在后台时占用 Ctrl+Shift+K，开发版启动会报告快捷键注册失败；此功能的启用接口不重新注册快捷键。开发重编译曾出现增量缓存权限告警（os error 5），后续必跑门禁全部成功。
- 代码仍在原 `main` 的未提交工作树，基线 `69da3e5`。本轮修改安装映射、检测后端、设置/API/类型、检测界面和侧栏滚动、交互测试及本文档；未修改 landing、版本号、依赖或用户既有杂项文件。没有提交、push、Tag、Release 或部署。
