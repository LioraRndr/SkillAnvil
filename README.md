# SkillAnvil

SkillAnvil is a Tauri 2 desktop workbench for managing local Coding Agent Skill directories.

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

Run the full local check:

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
