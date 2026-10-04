// Browser interaction checks with an explicit API fixture. This does not
// exercise a native Tauri shell or write to a user's SkillAnvil database.
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
    id: entry.id, name: entry.name, paths: entry.pathsWindows ?? entry.paths,
    enabled: entry.enabled, builtin: true, icon: entry.icon, categories: [],
  })),
  snapshotsEnabled: true, customTags: [], provenanceAgentId: null,
  translation: { protocol: "openai", baseUrl: "", apiKey: "", model: "", targetLang: "zh-CN" },
};
const fixture = `
let settings = ${JSON.stringify(settings)};
export const api = {
  getSettings: async () => settings,
  updateSettings: async (next) => { settings = next; return settings; },
  scanAgents: async () => ({ agents: [], skills: [], scanErrors: [] }),
  getProvenance: async () => [], setWindowTheme: async () => {},
  checkForUpdates: async () => ({ hasUpdate: false, currentVersion: "0.1.4", latestVersion: "0.1.4" }),
  openUrl: async (url) => { window.__lastDocumentationUrl = url; },
};`;

const browser = await chromium.launch({ headless: true, channel: process.env.SKILLANVIL_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.route("**/src/api.ts*", (route) => route.fulfill({ contentType: "application/javascript", body: fixture }));
  await page.goto(process.env.SKILLANVIL_UI_URL || "http://127.0.0.1:1420/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const directory = page.locator(".custom-agent-panel").filter({ has: page.locator(".agent-directory-search") });
  await directory.waitFor();
  assert.equal(await directory.locator(".agent-chip").count(), catalog.length);
  assert.equal(await directory.locator(".agent-directory-group").count(), 3);
  await directory.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => [...document.querySelectorAll(".agent-chip img")].every((img) => img.complete && img.naturalWidth > 0));

  const search = page.getByRole("textbox", { name: "搜索 Agent" });
  await search.fill("Kimi");
  assert.equal(await directory.locator(".agent-chip").count(), 2);
  await directory.getByRole("button", { name: "Kimi Code CLI", exact: true }).click();
  assert.match(await directory.locator(".agent-detail textarea").inputValue(), /^\$KIMI_CODE_HOME\/skills/);
  assert.match(await directory.locator(".agent-loading-guide").innerText(), /\.kimi-code\/skills/);
  await directory.getByRole("button", { name: "官方说明 ↗", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__lastDocumentationUrl), catalog.find((entry) => entry.id === "kimi-code-cli").docs);

  await search.fill("APPDATA");
  assert.equal(await directory.locator(".agent-chip").count(), 1);
  await search.fill("WorkBuddy");
  await directory.getByRole("button", { name: "WorkBuddy 客户端导入", exact: true }).click();
  assert.equal(await directory.locator(".agent-detail").count(), 0);
  assert.match(await directory.locator(".agent-loading-guide").innerText(), /客户端技能栏导入/);
  await search.fill("Aider");
  await directory.locator(".agent-chip").click();
  assert.equal(await directory.locator(".agent-detail").count(), 0);
  assert.match(await directory.locator(".agent-loading-guide").innerText(), /--read/);
  await search.fill("no-such-harness-123");
  assert.match(await directory.locator(".agent-directory-empty").innerText(), /没有匹配/);
  await search.fill("");
  await directory.getByRole("button", { name: "Kimi Code CLI", exact: true }).click();
  await directory.scrollIntoViewIfNeeded();
  assert.equal(await directory.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
  const monoLogo = directory.locator(".agent-icon-mono").first();
  assert.match(await monoLogo.evaluate((element) => getComputedStyle(element).filter), /invert\(1\)/);
  if (process.env.SKILLANVIL_UI_SCREENSHOT_DIR) {
    mkdirSync(process.env.SKILLANVIL_UI_SCREENSHOT_DIR, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 1450 });
    await directory.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(process.env.SKILLANVIL_UI_SCREENSHOT_DIR, "agent-directory-dark.png") });
    await page.getByRole("button", { name: "深色", exact: true }).click();
    await page.getByRole("option", { name: "浅色", exact: true }).click();
    await directory.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(process.env.SKILLANVIL_UI_SCREENSHOT_DIR, "agent-directory-light.png") });
  }
  assert.deepEqual(failures, []);
  console.log("PASS: directory grouping, offline logos, search, Kimi variants, documentation action, manual/import guidance, layout and dark logo contrast (browser API fixture).");
} finally {
  await browser.close();
}
