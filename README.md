# SkillAnvil

SkillAnvil is a Tauri 2 desktop workbench for managing local Coding Agent Skill directories.

## Stack

- Tauri 2.x + Rust backend
- React + TypeScript + Vite frontend
- SQLite via `rusqlite`
- Markdown editing via `ink-mde`

## Development

Install JavaScript dependencies:

```powershell
pnpm install
```

Run frontend checks:

```powershell
pnpm typecheck
pnpm build
```

Run the desktop app after Rust and Visual Studio C++ Build Tools are available:

```powershell
pnpm dev
```

On Windows, `pnpm dev` automatically loads Visual Studio Build Tools and adds Rustup's Cargo directory to `PATH`.

Run the full local check:

```powershell
pnpm check:desktop
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
