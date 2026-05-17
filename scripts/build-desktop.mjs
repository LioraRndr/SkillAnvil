import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = withCargoPath(process.env);
const bundleTarget = process.argv[2];

ensureCommand("cargo", env, [
  "Rust/Cargo is required to build the Tauri desktop app.",
  "Install Rust with rustup, then open a new terminal and run `pnpm build:desktop` again."
]);
ensureCommand("pnpm", env, [
  "pnpm is required to build SkillAnvil.",
  "Install pnpm or enable it through Corepack, then run `pnpm install`."
]);

const args = ["tauri", "build"];
if (bundleTarget) {
  args.push("--bundles", bundleTarget);
} else if (process.platform === "darwin") {
  args.push("--bundles", "app");
}

run("pnpm", args, { cwd: root, env });

function run(command, args, options) {
  const result = spawnSync(resolveCommand(command), args, {
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

function resolveCommand(command) {
  if (process.platform === "win32" && command === "pnpm") {
    return "pnpm.cmd";
  }
  return command;
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
  const lookup = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookup, [resolveCommand(command)], {
    env,
    stdio: "ignore"
  });
  if (result.status !== 0) {
    console.error(messageLines.join("\n"));
    process.exit(1);
  }
}
