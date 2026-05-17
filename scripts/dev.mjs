import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

if (isWindows) {
  const child = spawn("cmd.exe", ["/d", "/s", "/c", "scripts\\dev.cmd"], {
    cwd: root,
    stdio: "inherit"
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    }
    process.exit(code ?? 1);
  });
} else {
  const env = withCargoPath(process.env);
  ensureCommand("cargo", env, [
    "Rust/Cargo is required for Tauri development.",
    "Install Rust with rustup, then open a new terminal and run `pnpm dev` again."
  ]);
  ensureCommand("pnpm", env, [
    "pnpm is required to start SkillAnvil.",
    "Install pnpm or enable it through Corepack, then run `pnpm install`."
  ]);

  const pnpm = spawn("pnpm", ["tauri", "dev"], {
    cwd: root,
    env,
    stdio: "inherit"
  });
  pnpm.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    }
    process.exit(code ?? 1);
  });
}

function withCargoPath(env) {
  const next = { ...env };
  const cargoBin = env.HOME ? join(env.HOME, ".cargo", "bin") : "";
  if (cargoBin && existsSync(cargoBin)) {
    next.PATH = `${cargoBin}:${env.PATH ?? ""}`;
  }
  return next;
}

function ensureCommand(command, env, messageLines) {
  const result = spawnSync("which", [command], {
    env,
    stdio: "ignore"
  });
  if (result.status !== 0) {
    console.error(messageLines.join("\n"));
    process.exit(1);
  }
}
