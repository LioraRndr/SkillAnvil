# Harness Skill 读取机制与 SkillAnvil 适配

核对日期：2026-10-02。范围来自用户给定的三档名单，按具有不同目录的客户端拆分为 35 个条目：33 个具有已确认的原生目录，Aider 为手动读取，WorkBuddy 为客户端导入。新版 Kimi Code 与旧版 Python kimi-cli 分列。

这是路径与机制调研，不包含热度、star 数、产品更名或维护状态的排名核验。路径来自官方文档、官方源码以及必要的安装器源码交叉核对；不能将本机文件存在等同于云端或其他版本已加载。

## 目录约定

- `~` 表示运行 harness 的系统用户主目录，项目路径相对实际项目根目录。
- 表格中用户目录的第一条是 SkillAnvil 默认同步目标，其余为扫描目录。优先写入品牌原生目录；具有明确通用目录机制的工具使用 `.agents`。
- SkillAnvil 不自动遍历磁盘寻找项目。需要管理项目 Skill 时，把该项目 Skill 目录的**绝对路径**加到设置中，并按需要将其放在第一条。
- 云端、容器、远程 SSH 和 WSL 各有文件系统。同步到 Windows 主目录不会自动让这些环境读取；需要仓库 Skill、目录挂载、客户端同步或该环境内安装。
- 工具允许通过插件、配置或启动参数扩展目录，表格没有把所有可配置路径误写成默认路径。SkillAnvil 没有解析各家所有配置文件；自定义配置必须补入实际目录。
- 本次以目录包 `<skill>/SKILL.md` 作为跨工具同步格式。Kimi Code 等工具还支持根目录 `.md` 单文件，SkillAnvil 当前不会把这些单文件当作独立 Skill 扫描或转换。

## 逐项核对

每个产品名链接到核对的官方说明。兼容路径同样依赖工具版本与设置，不代表所有版本都会同时加载。

### 第一档：主流默认

| Harness / 官方来源 | 用户目录（第一条为默认同步目标） | 项目目录 | 读取与刷新机制 |
|---|---|---|---|
| [Claude Code](https://code.claude.com/docs/en/skills) | `$CLAUDE_CONFIG_DIR/skills` | `.claude/skills` | 启动时发现名称和描述，相关时加载正文；可用 /技能名。项目和插件有独立作用域，云端需要仓库技能或账号同步。 |
| [Cursor](https://prod.cursor.com/docs/skills) | `~/.cursor/skills`<br>`~/.agents/skills`<br>`~/.claude/skills`<br>`~/.codex/skills` | `.agents/skills`<br>`.cursor/skills`<br>`.claude/skills`<br>`.codex/skills` | 启动时自动发现，按任务加载。远端和 Cloud Agent 需提交项目技能或使用 Cursor 的同步功能。 |
| [GitHub Copilot](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills) | `~/.copilot/skills`<br>`~/.agents/skills` | `.github/skills`<br>`.agents/skills`<br>`.claude/skills` | CLI、IDE Agent 和云端均支持；本机用户目录只作用于本机，云端使用仓库技能。CLI 项目同名技能优先。 |
| [Codex](https://developers.openai.com/codex/skills) | `~/.agents/skills`<br>`$CODEX_HOME/skills` | `.agents/skills`<br>`.codex/skills` | 启动时发现并按需读取；可用 $技能名。共享目录与旧 Codex 目录并列扫描，远端运行需在对应环境安装。 |
| [Antigravity IDE](https://antigravity.google/docs/skills) | `~/.gemini/config/skills`<br>`~/.gemini/antigravity/skills` | `.agents/skills`<br>`.agent/skills` | 2.0 使用 .gemini/config；旧 IDE 全局目录仍兼容。自动调用或 /技能名，在 Customizations 查看。 |
| [Antigravity CLI](https://antigravity.google/docs/skills) | `~/.gemini/antigravity-cli/skills` | `.agents/skills`<br>`.agent/skills` | CLI 的全局目录独立于 IDE；启动时转成 /技能名，插件技能由 agy plugin 管理。 |
| [Devin Desktop](https://docs.devin.ai/desktop/cascade/skills) | `$XDG_CONFIG_HOME/devin/skills`<br>`~/.codeium/windsurf/skills`<br>`~/.agents/skills` | `.devin/skills`<br>`.windsurf/skills`<br>`.agents/skills` | Cascade 按需读取，支持 @技能名；旧 Windsurf 目录继续兼容。这些本地目录不代表 Devin 云端可见。 |
| [Devin CLI](https://docs.devin.ai/cli/extensibility/skills/overview) | `$XDG_CONFIG_HOME/devin/skills`<br>`~/.codeium/windsurf/skills`<br>`~/.agents/skills` <br>Windows 原生：`$APPDATA/devin/skills`<br>`~/.codeium/windsurf/skills`<br>`~/.agents/skills` | `.devin/skills`<br>`.windsurf/skills`<br>`.agents/skills` | CLI 支持 SKILL.md；Windows 原生全局配置使用 APPDATA，Windsurf 其他发布通道目录可手动添加。 |

### 第二档：开源与终端 Agent

| Harness / 官方来源 | 用户目录（第一条为默认同步目标） | 项目目录 | 读取与刷新机制 |
|---|---|---|---|
| [OpenCode](https://opencode.ai/docs/skills/) | `$XDG_CONFIG_HOME/opencode/skills`<br>`~/.agents/skills`<br>`~/.claude/skills` | `.opencode/skills`<br>`.agents/skills`<br>`.claude/skills` | 原生 skill 工具按需读取；项目目录从工作目录向 Git 根查找。permission.skill 或禁用 skill 工具会影响可用性。 |
| [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/skills) | `$DSH_HOME/skills`<br>`$DSH_AGENTS_HOME/skills` | `.dsh/skills`<br>`.agents/skills` | 需要启用 filesystem skill provider 与 skill consumer；项目原生目录优先。目录包只扫描直接子目录，也支持根目录 .md 单文件，配置可覆盖 home 和额外目录。 |
| [Gemini CLI](https://geminicli.com/docs/cli/skills/) | `~/.agents/skills`<br>`~/.gemini/skills` | `.agents/skills`<br>`.gemini/skills` | activate_skill 按需激活，客户端可能要求确认；项目优先，同作用域 .agents 优先。用 /skills list 和 /skills reload 检查。 |
| [Pi](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md) | `~/.pi/agent/skills`<br>`~/.agents/skills` | `.pi/skills`<br>`.agents/skills` | 递归发现 SKILL.md，按需 read；用 /skill:名称 显式调用，/reload 刷新。额外路径由 settings 或 --skill 指定。 |
| [OpenHands](https://docs.openhands.dev/overview/skills) | `~/.agents/skills`<br>`~/.openhands/skills` | `.agents/skills`<br>`.openhands/skills` | 当前推荐 .agents，旧 .openhands 兼容；项目优先。远端或 Docker 需要技能目录位于实际 backend 内；Canvas 还需启用对应技能。 |
| [Cline](https://docs.cline.bot/customization/skills) | `~/.cline/skills` | `.cline/skills`<br>`.clinerules/skills`<br>`.claude/skills` | 通过 use_skill 按需读取，也可 /技能名；在 Skills 面板确认启用。官方文档注明同名全局技能优先。 |
| [Goose](https://github.com/block/goose/blob/main/documentation/docs/guides/context-engineering/using-skills.md) | `~/.agents/skills`<br>`$XDG_CONFIG_HOME/goose/skills`<br>`~/.claude/skills` | `.agents/skills`<br>`.goose/skills`<br>`.claude/skills` | Skills 扩展按需加载；当前推荐 .agents，旧配置目录兼容。Recipe 与 SKILL.md 是不同的机制。 |
| [Aider](https://aider.chat/docs/usage/conventions.html) | 无已确认的自动扫描目录 | 无已确认的自动扫描目录 | 官方确认的是 aider --read <路径>/SKILL.md 或 /read；未确认原生自动发现技能目录。请在 Aider 显式加载文件。 |
| [Warp](https://docs.warp.dev/agents/capabilities/skills) | `~/.agents/skills`<br>`~/.warp/skills`<br>`~/.claude/skills`<br>`~/.codex/skills`<br>`~/.cursor/skills`<br>`~/.gemini/skills`<br>`~/.copilot/skills`<br>`~/.factory/skills`<br>`~/.github/skills`<br>`~/.opencode/skills` | `.agents/skills`<br>`.warp/skills`<br>`.claude/skills`<br>`.codex/skills`<br>`.cursor/skills`<br>`.gemini/skills`<br>`.copilot/skills` | 按 cwd 向仓库根发现，支持 /技能名。自动解析同名技能时全局优先；本机文件不会作为 Warp Drive 云对象同步。 |
| [Kilo Code](https://kilo.ai/docs/customize/skills) | `~/.kilo/skills`<br>`~/.agents/skills` | `.kilo/skills`<br>`.agents/skills` | 启动或 /reload 发现，项目优先；Claude 目录需启用兼容配置。skills.paths 可添加额外目录。 |
| [Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/users/features/skills/) | `~/.qwen/skills` | `.qwen/skills` | Skill 工具按需读取，/skills 打开列表与启用开关，/技能名 显式运行；name 和 description 必填。 |
| [Grok Build](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/08-skills.md) | `$GROK_HOME/skills`<br>`~/.agents/skills`<br>`~/.claude/skills`<br>`~/.cursor/skills` | `.grok/skills`<br>`.agents/skills`<br>`.claude/skills`<br>`.cursor/skills` | 启动发现，按名称去重，项目优先。Claude/Cursor 兼容可关闭；grok inspect 检查来源，额外目录由 skills.paths 配置。 |

### 第三档：其他与国内产品

| Harness / 官方来源 | 用户目录（第一条为默认同步目标） | 项目目录 | 读取与刷新机制 |
|---|---|---|---|
| [Kiro](https://kiro.dev/docs/skills/) | `~/.kiro/skills` | `.kiro/skills` | 当前 IDE/CLI 按需读取，项目优先；旧 CLI 自定义 Agent 需在 resources 中配置 skill:// 路径。云端只使用仓库技能。 |
| [TRAE 国际版](https://docs.trae.ai/ide/skills) | `~/.trae/skills` | `.trae/skills` | IDE 技能通过 SKILL.md 管理。国际版和国内版使用不同的用户目录，客户端需启用对应技能。 |
| [TRAE 国内版](https://docs.trae.cn/cli_skills) | `~/.trae-cn/skills` | `.trae/skills` | 国内版用户目录为 .trae-cn，项目目录仍是 .trae；名称含中文的 IDE 技能不能直接被 CLI 识别。 |
| [TRAE CLI](https://docs.trae.cn/cli_skills) | `~/.traecli/skills`<br>`~/.trae-cn/skills` | `.traecli/skills`<br>`.trae/skills` | CLI 原生目录为 .traecli，兼容国内 IDE 目录。创建或更新后重启，再用 /skills 检查。 |
| [Qoder](https://docs.qoder.com/cli/Skills) | `~/.qoder/skills` | `.qoder/skills` | 自动调用或 /技能名。CLI 用 /skills reload 刷新；官方文档注明同名用户技能优先。QoderWork 另用 .qoderwork。 |
| [CodeBuddy](https://www.codebuddy.ai/docs/cli/skills) | `~/.codebuddy/skills` | `.codebuddy/skills` | CLI 自动按任务调用，支持项目、用户和插件技能；插件更新用 /reload-plugins。CLI 的 CODEBUDDY_CONFIG_DIR 可改全局目录，请补入实际路径。WorkBuddy 是独立产品。 |
| [Kimi Code CLI](https://moonshotai.github.io/kimi-code/en/customization/skills) | `$KIMI_CODE_HOME/skills`<br>`~/.agents/skills` | `.kimi-code/skills`<br>`.agents/skills` | 新版 Kimi Code：项目 > 用户 > extra_skill_dirs > 内置技能。用户目录随 KIMI_CODE_HOME 变化；目录包与根目录 .md 单文件均支持。旧版 Python kimi-cli 请选独立条目。 |
| [Kimi CLI（旧版 Python）](https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/customization/skills.md) | `~/.kimi/skills`<br>`~/.config/agents/skills`<br>`~/.agents/skills`<br>`~/.claude/skills`<br>`~/.codex/skills` | `.kimi/skills`<br>`.agents/skills`<br>`.claude/skills`<br>`.codex/skills` | 品牌组默认合并 kimi、claude、codex，kimi 同名优先；通用组在 .config/agents 与 .agents 中取首个存在目录。--skills-dir 会覆盖自动发现。 |
| [Junie](https://junie.jetbrains.com/docs/agent-skills.html) | `~/.junie/skills`<br>`~/.agents/skills` | `.junie/skills`<br>`.agents/skills` | IDE/CLI 支持，项目同名优先；/skills 查看启用状态。其他厂商目录是导入建议，不等于默认自动加载。 |
| [Zencoder / Zenflow](https://docs.zencoder.ai/features/skills) | `~/.agents/skills`<br>`~/.zencoder/skills` | `.agents/skills`<br>`.claude/skills`<br>`.zencoder/skills` | 当前推荐 .agents，旧 .zencoder 仍兼容；按描述加载，并可通过 paths 缩小适用范围。 |
| [OpenClaw](https://docs.openclaw.ai/tools/skills) | `~/.openclaw/skills` | `skills` | 通用 Agent：workspace/skills 优先于用户和内置技能；还会按依赖与配置过滤。自定义 workspace 必须添加真实 skills 路径。 |
| [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/) | `$HERMES_HOME/skills` | `.hermes/skills`<br>`.agents/skills` | 原生目录递归加载；共享目录需配置 skills.external_dirs。项目技能要通过信任检查，各 profile 的 HERMES_HOME 独立。 |
| [ZCode](https://zcode.z.ai/en/docs/skill) | `~/.zcode/skills` | `.zcode/skills` | 在设置中刷新并启用，自动匹配描述；支持复制或符号链接导入。远端 SSH/WSL 需要 Sync Skill。 |
| [WorkBuddy](https://www.codebuddy.ai/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Practice-Cases/Create-Skills) | 无已确认的自动扫描目录 | 无已确认的自动扫描目录 | 官方确认内置技能、社区导入及自然语言创建。尚未找到稳定的自动扫描目录说明；请从客户端技能栏导入，并以实际安装位置配置自定义 Agent。 |
| [Roo Code（兼容）](https://github.com/RooCodeInc/Roo-Code) | `~/.roo/skills` | `.roo/skills` | 保留旧版目录管理；模式相关技能需添加真实 skills-<mode> 路径。项目维护状态与最新客户端能力需单独核对。 |

## 需要区分的情况

### Kimi Code 新旧版本

本机 `kimi --version` 返回 `0.41.0`，`kimi --help` 指向新版 `MoonshotAI/kimi-code` 文档。新版原生路径是 `$KIMI_CODE_HOME/skills`，默认 `~/.kimi-code/skills`；旧 Python `kimi-cli` 使用 `.kimi` 及其兼容发现逻辑。不能把旧版路径说明直接套到新版，两个条目分别配置、分别启用。新版项目作用域高于用户、额外目录与内置技能，根目录单文件和目录包的要求也有差别。[新版官方说明](https://moonshotai.github.io/kimi-code/en/customization/skills)、[旧版官方源码文档](https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/customization/skills.md)。

### IDE、CLI 与通用 Agent

- Codex 当前官方文档以 `.agents/skills` 为主要本地发现位置，支持从 cwd 到仓库根的多层项目作用域。`.codex/skills` 作为已有安装的兼容扫描目录保留；不能据此认定所有新版本都读取该旧目录。[官方读取范围](https://learn.chatgpt.com/docs/build-skills)。

- Antigravity IDE 与 CLI 的用户目录不同；新版 IDE 配置目录与旧 IDE 目录保留在同一条目中扫描。
- Devin Desktop 与 Devin CLI 分列。CLI 在 Windows 使用 `%APPDATA%/devin/skills`，其他系统按 XDG 配置目录；本地目录不会直接进入 Devin 云端工单环境。
- TRAE 国际 IDE、国内 IDE、CLI 分列；项目目录和用户目录的命名不能混用。国际版文档页面部分内容通过脚本加载，路径另由 [Vercel 官方 Skills 安装器映射](https://github.com/vercel-labs/skills/blob/main/src/agents.ts)交叉核对，具体版本仍需客户端确认。
- Kiro 当前 Skills 功能与旧 CLI 自定义 Agent 的 `resources: skill://...` 要分开看。QoderWork 不是 Qoder IDE/CLI 的相同目录配置。
- Goose Recipe 与 SKILL.md 不同；OpenClaw 的实际 `workspace/skills`、Hermes profile 目录和项目信任设置要按用户运行环境配置。
- Aider 官方 `--read`/`/read` 可以把文件作为约定载入，但未确认原生 Skill 自动发现。因此目录提供手动读取说明，不制造 `.aider/skills` 默认路径。
- CodeBuddy CLI 可通过 `CODEBUDDY_CONFIG_DIR` 改变全局配置目录。该变量不在 SkillAnvil 内置展开名单中，使用自定义位置时应填写 `<实际配置目录>/skills` 的绝对路径。[官方安装说明](https://www.codebuddy.ai/docs/cli/installation)。
- WorkBuddy 已确认有技能创建与导入流程，但未找到稳定、公开的原生自动扫描目录规范。目录提供客户端导入说明，允许用户在确认实际位置后添加自定义 Agent。

### 环境变量

SkillAnvil 仅展开内置路径变量：`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`XDG_CONFIG_HOME`、`DSH_HOME`、`DSH_AGENTS_HOME`、`GROK_HOME`、`HERMES_HOME`、`KIMI_CODE_HOME`、`APPDATA`。未设置时分别回退到标准用户目录；相对值不会作为环境覆盖使用。不会读取任意 `$API_KEY` 一类变量。设置中的绝对路径不受这些默认值替换。

DeepSeek Harness 还可通过配置定义 `dshHome`、`agentsHome` 和额外目录，并需要启用 filesystem provider / consumer；仅创建文件不能替代运行时启用。[配置目录](https://deepseek-harness.github.io/deepseek-harness/en/reference/config-catalog)、[filesystem provider 源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/src/index.ts)。

## SkillAnvil 实现

1. `src/agent-catalog.json` 同时驱动 Rust 默认配置与前端目录，防止两端分别维护路径造成漂移。三档分组、搜索、路径说明、项目作用域及官方文档入口集中展示；Aider / WorkBuddy 显示相应状态。
2. 只有仍与旧版内置数组完全一致的路径会更新为新的默认数组。用户自定义路径、顺序、启用状态、名字和分类保留。该迁移只更新配置，不移动或删除旧目录里的文件。
3. 对需要直接子目录发现的 harness，嵌套源包如 `gstack/qa/SKILL.md` 同步为目标根下 `qa/SKILL.md`，避免复制成功却不能被工具发现。Claude、Codex、Pi、Grok 和 Hermes 保留递归布局；自定义 Agent 保留原布局。
4. 平铺同步要求可移植的 frontmatter：`name` 为 1–64 个小写字母、数字或单连字符，且与被扫描的 Skill 名一致；`description` 非空且最多 1024 字。部分 harness 原生限制更宽，这里是跨工具同步约束。源文件不会被自动改写。
5. 安装器创建的目录链接（Windows junction / symlink）可以扫描，重叠扫描根通过规范路径去重。源包根链接可解析复制，包内任意链接或特殊文件仍拒绝复制。多个 Agent 指向同一物理包时同步跳过，避免覆盖自身。
6. 同步先复制到相邻暂存目录，再替换旧目录；失败尝试恢复旧目录。恢复失败会报告备份位置，备份移入回收站失败会保留并报告。暂存和备份目录不进入 Skill 列表。一次多个目标按目标逐一写入，不是跨全部目标的数据库事务；后续目标发生 IO 错误时前面的目标可能已成功。
7. 官方说明只允许目录中固定的 HTTPS URL，原有 GitHub 链接继续可用。IPC 不允许任意新域名或文档 URL 携带新的跳转参数。

同步只复制所选 Skill 的目录和其中资源。若技能依赖包目录之外的脚本或同级技能，还需在目标环境安装原始技能包。

SkillAnvil 展示扫描到的文件，不复刻每个 harness 的同名覆盖规则、启用开关或项目信任逻辑。要确认实际激活的是哪份技能，仍需使用对应工具的技能列表；禁止将目录扫描成功写作全部 harness 运行成功。

## Logo 与分发

新增 Logo 都随应用离线打包，运行时无图标 CDN 请求。优先使用 [LobeHub Icons](https://icons.lobehub.com/) 的 `@lobehub/icons-static-svg@1.95.1`，下载包经过 SHA-512 完整性核验，并检查 SVG 不含脚本、事件处理器或外部资源引用。

| 来源 | 本次新增文件 | 许可 / 来源说明 |
|---|---|---|
| LobeHub | cursor、githubcopilot、devin、deepseek、geminicli、pi、qwen、grok | MIT；版本固定 1.95.1 |
| [Aider 官方](https://github.com/Aider-AI/aider/blob/main/aider/website/assets/logo.svg) | aider.svg | Apache-2.0，完整许可随应用分发 |
| [Simple Icons](https://github.com/simple-icons/simple-icons/blob/develop/icons/warp.svg) | warp.svg | CC0；产品商标仍属品牌方 |
| [ZCode 官方网站](https://zcode.z.ai/en/docs/skill) | zcode.png | 官网产品标识 |
| [WorkBuddy 官方网站](https://www.codebuddy.cn/work) | workbuddy.svg | 官网链接的产品标识 |

既有图标保留；深色主题对黑色单色图标提高对比度。第三方来源及许可位于 `public/third-party-notices.txt` 和 `public/licenses/aider-Apache-2.0.txt`，随前端构建分发。

## 验证与边界

| 验证项 | 结果 / 范围 |
|---|---|
| Rust 回归测试 | PASS，37 项，含目录迁移、环境变量、新旧 Kimi、平铺同步、共享目录、Windows junction、失败保留旧副本及官方文档 URL 范围 |
| 目录 / 图标 / 许可契约测试 | PASS，3 项；`node --test scripts/agent-catalog.test.mjs` |
| OpenCode 实际 loader | PASS；`opencode debug skill --pure` 返回 224 项，144 项来自 `.agents`、79 项来自 `.claude`，仅输出数量、不输出私有 Skill 正文。临时隔离日志/缓存目录，没有模型调用 |
| Kimi 当前版本 | PASS；已读取本机 0.41.0 帮助并对照新版官方文档；未调用模型或执行技能正文 |
| 设置界面交互 | PASS；分组、搜索、图标加载、新旧 Kimi、文档按钮、手动/导入状态、浅色/深色显示；使用浏览器 API fixture，不是原生 Tauri 或真实用户数据库验收 |
| 桌面开发门禁 | PASS；`pnpm typecheck`、`pnpm build`、`cargo fmt -- --check`、`cargo test`、`cargo check` |
| Git diff | PASS；`git diff --check` |
| 编译告警 | 最后一次 Rust 测试编译出现一次增量缓存目录权限告警（os error 5）；测试仍为 37/37 通过，随后 cargo check 通过，无失败门禁 |
| 所有 harness 的完整实机运行 | NOT_RUN；没有安装、登录或运行全部 harness，Aider / WorkBuddy 仍需各自手动入口 |
| macOS / Linux 原生桌面 | NOT_RUN；本机仅为 Windows。平台目录选择通过 Rust 测试核对，不等于跨平台启动测试 |

复查目录数据时运行：

```powershell
node --test scripts/agent-catalog.test.mjs
pnpm.cmd typecheck
pnpm.cmd build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
git diff --check
```

界面交互测试先运行 `pnpm.cmd vite:dev --host 127.0.0.1`，在已安装 Playwright 的环境执行 `node scripts/agent-directory-ui.test.mjs`。Windows 默认使用本机 Edge，可用 `SKILLANVIL_BROWSER_CHANNEL` 选择浏览器；Playwright 位于独立依赖环境时通过 `SKILLANVIL_PLAYWRIGHT_MODULE` 指定模块路径；设置 `SKILLANVIL_UI_SCREENSHOT_DIR` 可输出浅色/深色测试截图。测试用 API fixture 代替本地数据库，不应描述为原生运行证据。

## 本次工作区

基于已有脏工作树在 `main` 分支修改，起始提交为 `69da3e5`（v0.1.4）。保留用户已有的 landing 修改、`.vscode/` 和根目录 Logo 文件；未改版本号、依赖、landing 或发布配置。没有提交、推送、Tag、Release 或 landing 部署。
