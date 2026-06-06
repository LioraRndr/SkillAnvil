# SkillAnvil

[English](README.md) · **简体中文**

SkillAnvil 是一款基于 Tauri 2 的桌面工作台，用于管理本地的 Coding Agent Skill
目录。它会扫描 Claude Code、Codex、Antigravity 等 Agent 的 skill 文件夹；让你浏览、
编辑、打标签、克隆，并在不同 Agent 之间同步 skill；用快照记录编辑历史；对照公共注册表
追溯 skill 的上游来源；还能通过你自己的 OpenAI 兼容或 Anthropic 原生接口翻译 `SKILL.md`。

## 功能特性

- **统一管理** —— 在一个窗口里管理多个本地 Coding Agent 的 skill
- **Markdown 编辑** —— 编码感知的读写（UTF-8、UTF-8 BOM、GBK）
- **跨 Agent 同步** —— 基于内容哈希的状态判定（相同 / 不同 / 缺失）
- **快照** —— 记录每次编辑，一键还原
- **来源溯源** —— 对照公共 skill 注册表，并做内容比对
- **自带翻译接口（BYO）** —— 流式输出
- **托盘 + 全局快捷键** —— 随时唤起

## 安装

从 [Releases 页面](https://github.com/LioraRndr/SkillAnvil/releases) 下载对应平台的安装包：

| 平台 | 文件 |
|------|------|
| macOS（Apple Silicon + Intel） | `SkillAnvil_<版本>_universal.dmg` |
| Windows | `SkillAnvil_<版本>_x64-setup.exe` 或 `SkillAnvil_<版本>_x64_en-US.msi` |
| Linux | `SkillAnvil_<版本>_amd64.AppImage`、`.deb` 或 `.rpm` |

> **说明：** 发布的安装包目前**未做代码签名**，所以首次打开时系统会弹出安全提示。这是未签名
> 软件的正常现象，按下面的步骤即可放行。

### macOS

1. 打开 DMG，把 **SkillAnvil** 拖进 **应用程序（Applications）**。
2. 首次打开会被拦截，提示 *“SkillAnvil 已损坏，无法打开”* 或 *“无法打开，因为
   Apple 无法检查其是否包含恶意软件”*。在终端执行一次以下命令清除隔离标记，然后正常打开：

   ```sh
   xattr -dr com.apple.quarantine /Applications/SkillAnvil.app
   ```

   或者：先尝试打开，再到 **系统设置 → 隐私与安全性**，点击 **仍要打开**。

### Windows

直接运行 `.exe` 或 `.msi`。若 SmartScreen 弹出 *“Windows 已保护你的电脑”*，
点击 **更多信息 → 仍要运行**。

### Linux

- **AppImage：** `chmod +x SkillAnvil_*.AppImage`，然后运行。
- **deb：** `sudo apt install ./SkillAnvil_*_amd64.deb`
- **rpm：** `sudo dnf install ./SkillAnvil-*.x86_64.rpm`

## 技术栈

- Tauri 2.x + Rust 后端
- React + TypeScript + Vite 前端
- 通过 `rusqlite` 使用 SQLite
- 通过 `ink-mde` 编辑 Markdown

## 开发

安装 JavaScript 依赖：

```sh
pnpm install
```

运行前端检查：

```sh
pnpm typecheck
pnpm build
```

在准备好对应操作系统的原生工具链后，运行桌面应用：

```sh
pnpm dev
```

在 macOS 和 Linux 上，`pnpm dev` 会直接运行 `pnpm tauri dev`，并在 `~/.cargo/bin` 目录存在时自动将其加入 `PATH`。

在 Windows 上，`pnpm dev` 会委托给 `scripts\dev.cmd`，它会自动加载 Visual Studio Build Tools，并把 Rustup 的 Cargo 目录加入 `PATH`。

运行完整的本地检查（typecheck、前端构建、`cargo fmt --check`、`cargo check`）：

```sh
pnpm check:desktop
```

## macOS 原生工具链

安装：

- Xcode 命令行工具：`xcode-select --install`
- 通过 Rustup 安装 Rust
- pnpm，或通过 Corepack 启用

然后运行：

```sh
pnpm install
pnpm dev
```

构建 macOS 应用包：

```sh
pnpm build:desktop
```

在正常的 macOS 桌面会话中构建可分发的 DMG：

```sh
pnpm build:desktop:dmg
```

## Windows 原生工具链

Rust 通过 Rustup 安装。Tauri 还需要来自 Visual Studio Build Tools 的 MSVC 链接器以及 C++ 工作负载。如果 `cargo check` 报告 `link.exe not found`，请安装：

- Visual Studio Build Tools 2022
- 工作负载：使用 C++ 的桌面开发
- Windows SDK

然后打开新终端，在 `src-tauri` 目录下运行：

```powershell
cargo check
```

## 编码规则

编辑已有文件前，先确认其当前编码。文件写入会尽可能保留原有编码；未知编码或检测到的乱码会被 Rust 文件 API 拒绝。

## 隐私与网络

SkillAnvil 以本地优先（local-first）为原则，仅在以下情况发起对外网络请求：

- **检查更新** —— 查询本仓库的 GitHub Releases API。
- **来源溯源**（用户主动触发）—— 将 skill 的*名称*发送到公共注册表
  （`skills.sh`），并可能从 `raw.githubusercontent.com` 拉取候选的 `SKILL.md`
  用于内容比对。不会上传任何文件内容。
- **翻译**（用户主动触发、需手动开启）—— 将你选择翻译的文档发送到你在设置中配置的
  接口。在你填写接口、密钥和模型并触发翻译之前，不会发送任何内容。

你的翻译 API 密钥及其他所有设置，都以**明文**形式存储在操作系统应用数据目录下的本地
SQLite 数据库中。请像对待任何本地凭据一样对待该文件。

## 许可证

[MIT](LICENSE) © SkillAnvil contributors
