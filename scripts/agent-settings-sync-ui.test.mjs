// Deferred API responses reproduce sidebar lag and stale scans without using the user's database.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SKILLANVIL_PLAYWRIGHT_MODULE || "playwright");
const catalog = JSON.parse(readFileSync(new URL("../src/agent-catalog.json", import.meta.url), "utf8"));
const fixture = `
let settings = {
  theme: "dark", shortcut: "Ctrl+Shift+K", minimizeToTray: true, snapshotsEnabled: true,
  customTags: [], provenanceAgentId: null,
  translation: { protocol: "openai", baseUrl: "", apiKey: "", model: "", targetLang: "zh-CN" },
  customAgents: ${JSON.stringify(catalog.filter(entry => entry.status === "native").map(entry => ({
    id: entry.id, name: entry.name, paths: entry.paths, icon: entry.icon, builtin: true,
    enabled: entry.id === "claude-code", categories: [],
  })))}
};
window.__pendingScans = [];
window.__savedSettings = settings;
window.__saveCount = 0;
export const api = {
  getSettings: async () => settings,
  updateSettings: async next => {
    window.__saveCount++;
    if (window.__rejectSave) throw new Error("保存设置失败：测试快捷键被占用");
    settings = next; window.__savedSettings = settings; return settings;
  },
  scanAgents: async () => {
    const agents = settings.customAgents.filter(agent => agent.enabled).map(agent => ({
      id: agent.id, name: agent.name, icon: agent.icon, skillDirPaths: agent.paths, detectedAt: ""
    }));
    const result = { agents, skills: [], scanErrors: [] };
    if (window.__deferScans) return new Promise(resolve => window.__pendingScans.push(() => resolve(result)));
    return result;
  },
  detectInstalledAgents: async () => ["qwen-code", "kimi-code-cli"].map(id => ({
    agentId: id, name: settings.customAgents.find(agent => agent.id === id).name,
    status: "installed", canEnable: true, enabled: false, evidence: [{ kind: "command", path: "C:/fixture/agent.exe" }]
  })),
  enableInstalledAgents: async ids => {
    if (window.__deferEnable) await new Promise(resolve => { window.__finishEnable = resolve; });
    settings = { ...settings, customAgents: settings.customAgents.map(agent => ids.includes(agent.id) ? { ...agent, enabled: true } : agent) };
    window.__savedSettings = settings;
    return { settings, enabledAgentIds: ids };
  },
  getProvenance: async () => [], setWindowTheme: async () => {},
  checkForUpdates: async () => ({ hasUpdate: false, currentVersion: "0.1.4", latestVersion: "0.1.4" }),
};`;
const browser = await chromium.launch({ headless: true, channel: process.env.SKILLANVIL_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const failures = [];
  page.on("pageerror", error => failures.push(error.message));
  await page.route("**/src/api.ts*", route => route.fulfill({ contentType: "application/javascript", body: fixture }));
  await page.goto(process.env.SKILLANVIL_UI_URL || "http://127.0.0.1:1420/", { waitUntil: "networkidle" });
  const nav = page.locator(".nav-section.grow");
  const qwen = nav.locator(".agent-name", { hasText: "Qwen Code" });
  await nav.locator(".agent-name", { hasText: "Claude Code" }).waitFor();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.locator(".agent-chip").filter({ hasText: "Qwen Code" }).click();
  const toggle = page.locator(".agent-detail").getByRole("checkbox", { name: "启用", exact: true });

  // A successful save updates the sidebar before an intentionally blocked disk scan returns.
  await page.evaluate(() => { window.__deferScans = true; });
  await toggle.check();
  await page.waitForFunction(() => window.__pendingScans.length === 1);
  await qwen.waitFor({ state: "visible", timeout: 2000 });
  assert.equal(await page.evaluate(() => window.__savedSettings.customAgents.find(agent => agent.id === "qwen-code").enabled), true);

  // Disable while the enable scan is still pending; completing scans in reverse order must not resurrect it.
  await toggle.uncheck();
  await page.waitForFunction(() => window.__pendingScans.length === 2);
  await qwen.waitFor({ state: "detached", timeout: 2000 });
  await page.evaluate(() => window.__pendingScans[1]());
  await page.evaluate(() => window.__pendingScans[0]());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await qwen.count(), 0);
  assert.equal(await toggle.isChecked(), false);

  // A rejected manual save restores the switch and leaves the confirmed sidebar untouched.
  await page.evaluate(() => { window.__rejectSave = true; });
  await toggle.click();
  await page.getByText("保存设置失败：测试快捷键被占用", { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector(".agent-detail input[type=checkbox]").checked);
  assert.equal(await qwen.count(), 0);
  assert.equal(await page.evaluate(() => window.__savedSettings.customAgents.find(agent => agent.id === "qwen-code").enabled), false);

  // Batch enable shares the same immediate update, including its completion notice while scans are pending.
  await page.evaluate(() => { window.__rejectSave = false; });
  const panel = page.getByRole("region", { name: "已安装 Agent 检测" });
  await panel.getByRole("button", { name: "检测已安装 Agent", exact: true }).click();
  await panel.getByRole("button", { name: "一键启用 (2)", exact: true }).click();
  await page.waitForFunction(() => window.__pendingScans.length === 3);
  await qwen.waitFor({ state: "visible", timeout: 2000 });
  await nav.locator(".agent-name", { hasText: "Kimi Code CLI" }).waitFor({ timeout: 2000 });
  await panel.getByRole("status").filter({ hasText: "已启用 2 个 Agent" }).waitFor({ timeout: 2000 });
  assert.equal(await toggle.isChecked(), true);
  await page.evaluate(() => window.__pendingScans[2]());

  // A manual edit queued during batch enable must keep the newly enabled flags from the batch response.
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await panel.getByRole("button", { name: "检测已安装 Agent", exact: true }).click();
  await page.evaluate(() => { window.__deferEnable = true; window.__deferScans = true; });
  await panel.getByRole("button", { name: "一键启用 (2)", exact: true }).click();
  await page.waitForFunction(() => typeof window.__finishEnable === "function");
  await page.locator(".agent-chip").filter({ hasText: "Claude Code" }).click();
  await toggle.uncheck();
  assert.equal(await page.evaluate(() => window.__saveCount), 0, "manual save waits for the batch write");
  await page.evaluate(() => window.__finishEnable());
  await page.waitForFunction(() => window.__saveCount === 1);
  await qwen.waitFor({ state: "visible", timeout: 2000 });
  await nav.locator(".agent-name", { hasText: "Kimi Code CLI" }).waitFor({ timeout: 2000 });
  await nav.locator(".agent-name", { hasText: "Claude Code" }).waitFor({ state: "detached", timeout: 2000 });
  assert.equal(await page.evaluate(() => window.__savedSettings.customAgents.find(agent => agent.id === "qwen-code").enabled), true);
  assert.equal(await toggle.isChecked(), false);
  assert.deepEqual(failures, []);
  console.log("PASS: immediate manual/batch enable, disable before scan completion, stale scan rejection, failed-save rollback and concurrent edits preserving batch flags (browser API fixture).");
} finally { await browser.close(); }
