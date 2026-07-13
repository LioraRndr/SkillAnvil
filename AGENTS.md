# SkillAnvil Agent 开发与发布规范

本文件是 SkillAnvil 仓库中所有 AI Agent 的强制协作规范。项目主要由维护者与 AI Agent 共同开发；任何 Agent 在修改、提交、推送、打 Tag 或发布前，都必须遵循本文件。

`AGENTS.md` 必须纳入 Git，不得加入 `.gitignore`。这样新的 Agent 窗口和其他电脑在 clone/pull 后会自动获得同一套规范。

如果根目录存在 `AGENTS.local.md`，Agent 应在本文件之后读取它。该文件只允许保存机器专属路径、工具位置或证书位置，不得包含真实密钥，也不得降低本文件的安全和发布门禁。

## 1. 权限边界

- 读取、检查和运行测试可直接进行。
- 修改代码必须在用户要求的任务范围内。
- 未经用户明确要求，不得执行 `git commit`、`git push`、创建/推送 Tag、发布 GitHub Release 或部署 landing。
- 禁止 force push、`git reset --hard`、批量丢弃改动或删除用户文件，除非用户明确授权并已说明影响。
- 工作树中的既有改动和未跟踪文件默认属于用户。不得顺手暂存、格式化、移动或删除无关文件。
- 任何真实 API Key、签名私钥、密码、Token、证书私钥和 `.env` 文件都不得进入 Git、日志、构建产物或回复内容。

## 2. 开发前检查

开始任务前必须执行：

```powershell
git status --short --branch
git branch --show-current
git log -1 --oneline
```

如果开始新的代码迭代，且工作区干净、网络可用、目标基线确定：

```powershell
git switch main
git pull --rebase origin main
git switch -c codex/<short-task-name>
```

- Codex 默认使用 `codex/` 前缀；其他 Agent 若有平台强制前缀，遵循其平台规则。
- 若用户明确要求直接在当前分支或 `main` 上工作，可按用户要求执行。
- 工作区存在未提交或未跟踪内容时，不得直接 switch、pull、rebase、stash、清理或覆盖；先识别内容归属并保留，必要时报告用户。
- 离线、无远端、目标分支已存在或当前任务基于非 `main` 分支时，不机械执行上述三条命令；应使用当前已确认的正确基线，并在交付报告中说明。
- 发现远端和本地同时有提交时，优先使用普通 rebase/merge；不得用 force push 解决分叉。

## 3. 编码前置检查（强制）

对任何现有文件执行修改前：

1. 确认当前编码，例如 UTF-8、UTF-8 BOM 或 GBK。
2. 编码未确认时禁止写入，只能读取并报告。
3. 写回必须保持原编码，不得擅自转换。
4. 禁止对未知编码文件执行整文件重写。
5. 发现 `鑠版堪`、`濮煎`、`�` 等乱码特征时，立即停止修改并先处理编码问题。
6. 新建文本文件统一使用无 BOM 的 UTF-8，除非任务另有要求。

## 4. 实现原则

- 优先做最小、可验证、可回滚的修改。
- 文件读写、同步、删除、快照和数据库改动必须优先考虑数据不丢失、路径边界、符号链接、并发覆盖和失败回滚。
- Tauri IPC 的所有参数都视为不可信输入；Rust 后端必须再次验证，不能只依赖前端禁用按钮或表单校验。
- 联网请求必须设置连接/读取/总超时、响应大小上限，并防止凭据经明文 HTTP 或跨域重定向泄漏。
- 修复 Bug 或安全漏洞时必须增加能够复现原问题的回归测试。
- 不得为通过测试而删除、弱化或跳过既有断言。

## 5. 每次代码迭代后的必跑门禁

门禁按实际影响范围执行：修改桌面应用、根级前端、`src-tauri/`、依赖或相关构建配置时执行 5.1；修改 `landing/` 时执行 5.2；所有变更都执行 5.3。纯文档变更无需运行无关的桌面构建，但仍须检查文档、链接、格式及 Git diff。跨区域变更执行所有对应门禁。

### 5.1 桌面应用

```powershell
pnpm.cmd typecheck
pnpm.cmd build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

### 5.2 landing（修改 `landing/` 时）

```powershell
node --test landing/build-support.test.mjs
node landing/build-worker.mjs
```

### 5.3 Git 检查

```powershell
git diff --check
git status --short
```

要求：

- 任一必跑命令失败时，不得声称完成、不得 push、不得创建版本提交、不得打 Tag 或发布。仅当用户明确要求保留检查点时，才可提交普通 WIP commit，并必须在报告中列出失败门禁。
- 必须区分“本次改动导致的失败”和“仓库既有失败”，两者都要明确报告。
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` 当前作为强化检查；在历史告警清零后应升级为强制门禁。
- 修改安全相关构建配置时，应使用假 canary 验证密钥不会出现在 `dist/`，不得使用真实密钥测试。

## 6. 提交规范

只有用户明确要求提交时才执行。

1. 使用明确文件列表暂存，禁止无检查地执行 `git add .` 或 `git add -A`。
2. 暂存后检查：

```powershell
git diff --cached --check
git diff --cached --stat
git diff --cached --name-status
```

3. 确认未包含 `.vscode/`、临时图片、构建目录、日志、`.env`、密钥、个人路径或无关文件。
4. 提交信息使用 Conventional Commits，例如：

```text
fix: prevent unsafe skill sync paths
feat: add Kiro agent support
chore: release v0.1.4
docs: document release workflow
```

5. 提交后记录 Commit SHA，并再次检查 `git status --short --branch`。

## 7. 推送规范

只有用户明确要求 push 时才执行。

```powershell
git fetch origin
git rebase <confirmed-upstream>
<重新运行受影响的测试和构建>
git push -u origin <branch>
```

- `main` 或直接基于 `main` 的普通功能分支通常使用 `origin/main` 作为 `<confirmed-upstream>`；堆叠分支、维护分支或其他基线必须使用其真实上游。无法确定时停止并询问用户。
- 推送 `main` 前必须确认本地已包含最新 `origin/main`。
- rebase/merge 后必须重新运行关键测试，不能沿用重放前的结果。
- 禁止 `--force` 和 `--force-with-lease`，除非用户针对具体分支明确授权。
- TLS 或网络失败最多做有限重试；不得关闭证书验证。可临时切换可信 TLS 后端，但不得设置 `http.sslVerify=false`。
- 推送完成后必须确认本地 HEAD 与远端目标引用一致。

## 8. Pull Request 规范

默认推荐通过功能分支和 PR 合并：

- 标题采用 Conventional Commit 风格。
- 描述包含 Summary、Security/Data Impact、Test Plan 和已知限制。
- 涉及文件删除、同步、数据库、密钥、更新或发布链时，必须突出风险和回滚方式。
- 未经用户明确要求，Agent 不得自行合并 PR。

本项目虽为单人维护，但 PR 仍可作为变更记录和 CI 门禁；小改动是否直接推送 `main` 由用户决定。

## 9. 桌面版本发布流程

“代码已 push”不等于“用户已收到版本”。桌面用户只有在 GitHub Release 正式发布后才能获得新版本。

### 9.1 发布前版本同步

版本号必须同时更新：

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

如果 Cargo 更新了根包信息，同时提交 `src-tauri/Cargo.lock` 的对应变化。

版本规则：

- Bug/安全修复：patch，例如 `0.1.3 -> 0.1.4`
- 向后兼容功能：minor，例如 `0.1.x -> 0.2.0`
- 不兼容变更：明确说明迁移方式，并按项目阶段升级 major/minor

### 9.2 发布前完整验证

在已合并且最新的 `main` 上重新运行第 5 节全部适用门禁，并确认：

- 三个版本号一致。
- Release notes 已整理。
- 数据格式和 SQLite schema 兼容升级。
- 安装、启动、扫描、编辑、保存、同步、快照、翻译、更新检查至少完成一次 smoke test。
- 没有真实密钥进入 `dist/`、日志或 Git 历史。

### 9.3 创建版本提交与 Tag

只有用户明确要求发布具体版本时才能执行：

```powershell
git commit -m "chore: release vX.Y.Z"
git push origin main
git tag -a vX.Y.Z -m "SkillAnvil vX.Y.Z"
git push origin vX.Y.Z
```

- Tag 必须指向已推送且通过门禁的 `main` 提交。
- 不得移动或覆盖已推送的版本 Tag；错误 Tag 应停止并由用户决定处理方式。

### 9.4 GitHub Release

推送 `v*` Tag 会触发 `.github/workflows/release.yml`，构建 macOS、Windows 和 Linux 安装包，并创建 Draft Release。

Agent 必须明确说明 Release 当前处于：

- `draft`：用户尚不可见
- `published`：用户可见并可下载
- `failed`：工作流或某个平台产物失败

将 Draft Release 转为正式 Release 前必须人工确认：

- 三个平台构建成功。
- 文件名、版本、操作系统和架构正确。
- Release notes 准确。
- 安装包在干净环境完成基本启动测试。
- SHA-256、签名、公证、SBOM 和 provenance 状态已如实说明。

当前项目尚未完整接入 Windows Authenticode、macOS Developer ID/notarization 和应用内签名自动更新。因此 Agent 不得把未签名产物描述为“已完成可信生产发布”。推送会创建 Draft 的版本 Tag，以及把 Draft 转为正式 Release，均必须得到用户明确授权。

### 9.5 正式发布与发布后验证

人工核验通过且用户明确要求正式发布后，才可在 GitHub Release 页面执行 Publish，或使用等效的 GitHub CLI 操作把目标版本从 Draft 转为 Published。不得默认发布“最新的 Draft”，必须按用户指定的版本号操作。

发布后必须再次确认：

- Release 状态为 `published`，版本号和 Tag 完全一致。
- 三个平台的预期安装包均存在且可下载。
- Release notes、校验值以及签名/公证限制说明仍然准确。
- 对外更新入口指向本次正式 Release；若项目尚未具备可靠的自动更新链路，应明确告知用户需要手动下载安装。

只有以上检查通过，才能向用户报告“版本已正式发布”。报告中附 Release URL，并明确已验证和未验证的项目。

## 10. landing 发布流程

landing 与桌面 Release 是两条独立发布链。修改 landing 后：

```powershell
node --test landing/build-support.test.mjs
node landing/build-worker.mjs
```

- `landing/dist/` 是构建产物，不进入 Git。
- `SITES_DIST_DIR` 必须通过构建器安全检查；不得指向仓库根、父目录或包含未标记用户文件的目录。
- 部署到 Sites 或其他托管平台属于外部发布操作，必须由用户明确授权。
- 部署后检查首页、静态资源、下载链接、安全响应头、移动端布局和 GitHub Release 链接。
- 桌面版本发布后若 landing 展示版本或下载信息，必须同步更新并单独部署。

## 11. Agent 完成交付格式

每次交付必须报告：

1. 修改了什么。
2. 修改和未修改的文件范围。
3. 运行了哪些测试及结果。
4. 当前分支和 Commit SHA（若已提交）。
5. 是否已 push；推送到哪个远端分支。
6. 是否创建 Tag、Draft Release、正式 Release 或 landing 部署。
7. 剩余风险、既有失败和需要用户处理的事项。

不得使用模糊表述混淆以下状态：

```text
代码已修改
代码已测试
代码已提交
代码已推送
Tag 已推送
Draft Release 已生成
Release 已正式发布
landing 已部署
```

只有实际完成的状态才能声明成功。
