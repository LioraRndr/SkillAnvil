# SkillAnvil

SkillAnvil is a Tauri 2 desktop workbench for managing local Coding Agent Skill
directories. It scans the skill folders of agents like Claude Code, Codex,
Antigravity, and others; lets you browse, edit, tag, clone, and sync skills
across agents; tracks edit history with snapshots; traces a skill's upstream
provenance against the public registry; and can translate a `SKILL.md` through
your own OpenAI-compatible or Anthropic-native endpoint.

## Features

- **Unified skill management** across many local Coding Agents from one window
- **Markdown editing** with encoding-aware reads/writes (UTF-8, UTF-8 BOM, GBK)
- **Cross-agent sync** with content-hash status (same / different / missing)
- **Snapshots** of edits with one-click restore
- **Provenance tracing** against the public skill registry, with content match
- **BYO translation** (bring your own endpoint) with streaming output
- **Tray + global shortcut** for instant access

## Stack

- Tauri 2.x + Rust backend
- React + TypeScript + Vite frontend
- SQLite via `rusqlite`
- Markdown editing via `ink-mde`

## Development

Install JavaScript dependencies:

```sh
pnpm install
```

Run frontend checks:

```sh
pnpm typecheck
pnpm build
```

Run the desktop app after the native toolchain for your OS is available:

```sh
pnpm dev
```

On macOS and Linux, `pnpm dev` runs `pnpm tauri dev` directly and automatically adds `~/.cargo/bin` to `PATH` when that directory exists.

On Windows, `pnpm dev` delegates to `scripts\dev.cmd`, which automatically loads Visual Studio Build Tools and adds Rustup's Cargo directory to `PATH`.

Run the full local check (typecheck, frontend build, `cargo fmt --check`, `cargo check`):

```sh
pnpm check:desktop
```

## macOS Native Toolchain

Install:

- Xcode Command Line Tools: `xcode-select --install`
- Rust through Rustup
- pnpm, or enable it through Corepack

Then run:

```sh
pnpm install
pnpm dev
```

Build the macOS app bundle with:

```sh
pnpm build:desktop
```

Build a distributable DMG from a normal macOS desktop session with:

```sh
pnpm build:desktop:dmg
```

## Windows Native Toolchain

Rust is installed through Rustup. Tauri also needs the MSVC linker from Visual Studio Build Tools with the C++ workload. If `cargo check` reports `link.exe not found`, install:

- Visual Studio Build Tools 2022
- Workload: Desktop development with C++
- Windows SDK

Then open a new terminal and run:

```powershell
cargo check
```

from `src-tauri`.

## Encoding Rule

Before editing an existing file, confirm its current encoding. File writes preserve the existing encoding when possible; unknown encodings or detected mojibake are rejected by the Rust file API.

## Privacy & Network

SkillAnvil is local-first. It only makes outbound network requests in these cases:

- **Check for updates** — queries the GitHub Releases API for this repository.
- **Provenance tracing** (user-initiated) — sends a skill's *name* to the public
  registry (`skills.sh`) and may fetch a candidate `SKILL.md` from
  `raw.githubusercontent.com` to compare content. No file contents are uploaded.
- **Translation** (user-initiated, opt-in) — sends the document you choose to
  translate to the endpoint you configure in Settings. Nothing is sent until you
  fill in an endpoint, key, and model and trigger a translation.

Your translation API key and all other settings are stored locally in an
unencrypted SQLite database inside your OS application-data directory. Treat that
file as you would any local credential store.

## License

[MIT](LICENSE) © SkillAnvil contributors
