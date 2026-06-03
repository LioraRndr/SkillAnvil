import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

if (isWindows) {
  run("cmd.exe", ["/d", "/s", "/c", "scripts\\check.cmd"], { cwd: root });
  process.exit(0);
}

const env = withCargoPath(process.env);
ensureCommand("cargo", env, [
  "Rust/Cargo is required to check the Tauri desktop app.",
  "Install Rust with rustup, then open a new terminal and run `pnpm check:desktop` again."
]);
ensureCommand("pnpm", env, [
  "pnpm is required to check SkillAnvil.",
  "Install pnpm or enable it through Corepack, then run `pnpm install`."
]);

run("pnpm", ["typecheck"], { cwd: root, env });
run("pnpm", ["build"], { cwd: root, env });
run("cargo", ["fmt", "--", "--check"], { cwd: join(root, "src-tauri"), env });
run("cargo", ["check"], { cwd: join(root, "src-tauri"), env });

function run(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    stdio: "inherit"
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
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
