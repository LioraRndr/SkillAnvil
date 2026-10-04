// Interaction test with an in-memory API fixture. Never writes a user's database.
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SKILLANVIL_PLAYWRIGHT_MODULE || "playwright");
const catalog = JSON.parse(readFileSync(new URL("../src/agent-catalog.json", import.meta.url), "utf8"));
const settings = {
  theme: "dark", shortcut: "Ctrl+Shift+K", minimizeToTray: true,
  customAgents: catalog.filter((entry) => entry.status === "native").map((entry) => ({
    id: entry.id, name: entry.name, paths: entry.id === "qwen-code" ? ["D:/user skills"] : entry.paths,
    enabled: entry.id === "claude-code", builtin: true, icon: entry.icon,
    categories: entry.id === "qwen-code" ? [{ id: "keep", name: "保留分类", skillNames: ["example"] }] : [],
  })), snapshotsEnabled: true, customTags: [], provenanceAgentId: null,
  translation: { protocol: "openai", baseUrl: "", apiKey: "", model: "", targetLang: "zh-CN" },
};
const report = [
  ...["claude-code", "qwen-code", "kimi-code-cli", "aider"].map((id) => ({
    agentId: id, name: catalog.find((entry) => entry.id === id).name,
    status: "installed", enabled: id === "claude-code", canEnable: id !== "aider",
    evidence: [{ kind: "command", path: `C:/fixture/very-long-installation-path/${id}/bin/agent.cmd` }],
  })),
  { agentId: "opencode", name: "OpenCode", status: "configured", enabled: false, canEnable: false,
    evidence: [{ kind: "config", path: "C:/fixture/.config/opencode" }] },
];
const fixture = `
let settings = ${JSON.stringify(settings)};
let report = ${JSON.stringify(report)};
window.__scanCount = 0;
export const api = {
  getSettings: async () => settings,
  updateSettings: async (next) => { settings = next; return settings; },
  detectInstalledAgents: async () => {
    if (window.__mode === "detect-error") throw new Error("检测失败，请重试");
    return window.__mode === "empty" ? [] : report;
  },
  enableInstalledAgents: async (ids) => {
    window.__enableRequest = ids;
    if (window.__mode === "reject") throw new Error("安装状态已变化，请重新检测");
    const enabledAgentIds = [];
    settings = { ...settings, customAgents: settings.customAgents.map((agent) => {
      if (ids.includes(agent.id) && !agent.enabled) { enabledAgentIds.push(agent.id); return { ...agent, enabled: true }; }
      return agent;
    }) };
    window.__savedSettings = settings;
    return { settings, enabledAgentIds };
  },
  scanAgents: async () => {
    window.__scanCount++;
    return { agents: settings.customAgents.filter((agent) => agent.enabled).map((agent) => ({
      id: agent.id, name: agent.name, icon: agent.icon, skillDirPaths: agent.paths, detectedAt: ""
    })), skills: [], scanErrors: [] };
  },
  getProvenance: async () => [], setWindowTheme: async () => {},
  checkForUpdates: async () => ({ hasUpdate: false, currentVersion: "0.1.4", latestVersion: "0.1.4" }),
  openUrl: async () => {},
};`;
const browser = await chromium.launch({ headless: true, channel: process.env.SKILLANVIL_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.route("**/src/api.ts*", (route) => route.fulfill({ contentType: "application/javascript", body: fixture }));
  await page.goto(process.env.SKILLANVIL_UI_URL || "http://127.0.0.1:1420/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const panel = page.getByRole("region", { name: "已安装 Agent 检测" });
  await panel.getByRole("button", { name: "检测已安装 Agent", exact: true }).click();
  await panel.getByText("发现 4 个已安装 Agent", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("checkbox", { name: "启用 Claude Code", exact: true }).isDisabled(), true);
  assert.equal(await panel.getByRole("checkbox", { name: "启用 Aider", exact: true }).isDisabled(), true);
  assert.equal(await panel.getByRole("checkbox", { name: "启用 Qwen Code", exact: true }).isChecked(), true);
  assert.equal(await panel.getByRole("checkbox", { name: "启用 Kimi Code CLI", exact: true }).isChecked(), true);
  assert.equal(await panel.getByRole("checkbox", { name: "启用 OpenCode", exact: true }).count(), 0);
  await panel.locator("summary").click();
  assert.match(await panel.locator("details").innerText(), /历史残留/);
  await panel.getByRole("button", { name: "取消全选", exact: true }).click();
  assert.equal(await panel.getByRole("button", { name: "一键启用 (0)", exact: true }).isDisabled(), true);
  await panel.getByRole("button", { name: "全选可启用", exact: true }).click();

  // Server rejection must leave every enabled state unchanged.
  await page.evaluate(() => { window.__mode = "reject"; });
  await panel.getByRole("button", { name: "一键启用 (2)", exact: true }).click();
  await panel.getByRole("alert").filter({ hasText: "安装状态已变化" }).waitFor();
  assert.equal(await panel.getByRole("checkbox", { name: "启用 Qwen Code", exact: true }).isDisabled(), false);
  assert.equal(await page.evaluate(() => window.__savedSettings), undefined);
  await panel.getByRole("checkbox", { name: "启用 Kimi Code CLI", exact: true }).uncheck();
  await page.evaluate(() => { window.__mode = "success"; });
  const scansBefore = await page.evaluate(() => window.__scanCount);
  await panel.getByRole("button", { name: "一键启用 (1)", exact: true }).click();
  await panel.getByRole("status").filter({ hasText: "已启用 1 个 Agent" }).waitFor();
  const saved = await page.evaluate(() => window.__savedSettings);
  assert.deepEqual(await page.evaluate(() => window.__enableRequest), ["qwen-code"]);
  assert.equal(saved.customAgents.find((agent) => agent.id === "qwen-code").enabled, true);
  assert.deepEqual(saved.customAgents.find((agent) => agent.id === "qwen-code").paths, ["D:/user skills"]);
  assert.deepEqual(saved.customAgents.find((agent) => agent.id === "qwen-code").categories, settings.customAgents.find((agent) => agent.id === "qwen-code").categories);
  assert.equal(saved.customAgents.find((agent) => agent.id === "kimi-code-cli").enabled, false);
  assert.equal(saved.customAgents.find((agent) => agent.id === "claude-code").enabled, true);
  assert.equal(await page.evaluate(() => window.__scanCount > 1), true);
  assert.equal(await page.evaluate((before) => window.__scanCount > before, scansBefore), true);
  assert.equal(await panel.getByRole("checkbox", { name: "启用 Qwen Code", exact: true }).isDisabled(), true);
  await page.setViewportSize({ width: 760, height: 1100 });
  assert.equal(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
  if (process.env.SKILLANVIL_UI_SCREENSHOT_DIR) {
    mkdirSync(process.env.SKILLANVIL_UI_SCREENSHOT_DIR, { recursive: true });
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(process.env.SKILLANVIL_UI_SCREENSHOT_DIR, "agent-installation-fixture.png") });
  }
  await page.evaluate(() => { window.__mode = "detect-error"; });
  await panel.getByRole("button", { name: "重新检测", exact: true }).click();
  await panel.getByRole("alert").filter({ hasText: "检测失败" }).waitFor();
  assert.equal(await panel.locator(".agent-installation-row").count(), 0);
  await page.evaluate(() => { window.__mode = "empty"; });
  await panel.getByRole("button", { name: "检测已安装 Agent", exact: true }).click();
  await panel.getByText("发现 0 个已安装 Agent", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("button", { name: /一键启用/ }).count(), 0);

  // Many enabled agents must scroll within the sidebar without hiding Settings.
  await page.route("**/src/api.ts*", (route) => route.fulfill({ contentType: "application/javascript", body:
    fixture + '\nsettings.customAgents = settings.customAgents.map(agent => ({ ...agent, enabled: true }));' }));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload({ waitUntil: "networkidle" });
  const sidebarSettings = page.locator(".sidebar-actions").getByRole("button", { name: "设置", exact: true });
  const settingsBounds = await sidebarSettings.boundingBox();
  assert.ok(settingsBounds && settingsBounds.y + settingsBounds.height <= 720, "Settings must remain within the window");
  assert.equal(await page.locator(".nav-section.grow").evaluate(element => element.scrollHeight > element.clientHeight), true);
  await sidebarSettings.click();
  await page.getByRole("region", { name: "已安装 Agent 检测" }).waitFor();
  assert.deepEqual(failures, []);
  console.log("PASS: installed selection, already-enabled/manual/config exclusions, empty state, failure recovery, selective enable, settings preservation, refresh and narrow layout (browser API fixture).");
} finally { await browser.close(); }
