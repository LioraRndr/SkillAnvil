// Tab regression checks with an in-memory API fixture. Never touches a user's
// skills or database. Reproduces: a double click (or a second click while the
// file is still loading) opened the same skill twice, and picking another file
// in the file tree opened yet another tab for the same skill.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SKILLANVIL_PLAYWRIGHT_MODULE || "playwright");
const catalog = JSON.parse(readFileSync(new URL("../src/agent-catalog.json", import.meta.url), "utf8"));
const roots = { "claude-code": "/fixture/.claude/skills", codex: "/fixture/.agents/skills" };
const settings = {
  theme: "dark", shortcut: "Ctrl+Shift+K", minimizeToTray: true, snapshotsEnabled: true,
  customTags: [], provenanceAgentId: null,
  translation: { protocol: "openai", baseUrl: "", apiKey: "", model: "", targetLang: "zh-CN" },
  customAgents: catalog.filter((entry) => entry.status === "native").map((entry) => ({
    id: entry.id, name: entry.name, paths: entry.paths, icon: entry.icon, builtin: true,
    enabled: entry.id in roots, categories: [],
  })),
};
const files = [
  { relativePath: "SKILL.md", isDir: false, size: 10, updatedAt: "" },
  { relativePath: "references", isDir: true, size: 0, updatedAt: "" },
  { relativePath: "references/notes.md", isDir: false, size: 10, updatedAt: "" },
];
const skill = (agentId, name) => ({
  id: `${agentId}-${name}`, name, displayName: name, description: `${name} fixture`, version: "1.0.0",
  dirPath: `${roots[agentId]}/${name}`, agentId, source: "local", localModified: false, starred: false,
  tags: [], files, updatedAt: "",
});
const skills = [skill("claude-code", "brainstorming"), skill("claude-code", "pdf"), skill("codex", "pdf")];
const fixture = `
let settings = ${JSON.stringify(settings)};
const skills = ${JSON.stringify(skills)};
const roots = ${JSON.stringify(roots)};
const contents = new Map();
let stamp = 0;
window.__saves = [];
window.__reads = 0;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const api = {
  getSettings: async () => settings,
  updateSettings: async (next) => { settings = next; return settings; },
  scanAgents: async () => ({
    agents: Object.keys(roots).map((id) => ({ id, name: id, icon: "", skillDirPaths: [roots[id]], detectedAt: "" })),
    skills, scanErrors: [],
  }),
  getProvenance: async () => [], traceProvenance: async () => [], setWindowTheme: async () => {},
  checkForUpdates: async () => ({ hasUpdate: false, currentVersion: "0.1.4", latestVersion: "0.1.4" }),
  readSkillFile: async (skillId, relativePath) => {
    window.__reads++;
    await delay(400);
    const key = skillId + "::" + relativePath;
    if (!contents.has(key)) contents.set(key, "# " + relativePath + " of " + skillId + "\\n\\nBody.\\n");
    return { content: contents.get(key), encoding: "UTF-8", updatedAt: "t" + stamp };
  },
  saveSkillFile: async (skillId, relativePath, content) => {
    window.__saves.push([skillId, relativePath, content]);
    contents.set(skillId + "::" + relativePath, content);
    stamp++;
    return { content, encoding: "UTF-8", updatedAt: "t" + stamp };
  },
  getSkill: async (id) => skills.find((item) => item.id === id),
  getSkills: async () => skills,
  getSyncTargets: async () => [],
  getSnapshots: async () => [],
};`;

const browser = await chromium.launch({ headless: true, channel: process.env.SKILLANVIL_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.route("**/src/api.ts*", (route) => route.fulfill({ contentType: "application/javascript", body: fixture }));
  await page.goto(process.env.SKILLANVIL_UI_URL || "http://127.0.0.1:1420/", { waitUntil: "networkidle" });
  const tabs = page.locator(".tab-bar .tab:not(.home-tab)");
  const card = (name) => page.locator(".skill-card").filter({ has: page.locator("h2", { hasText: new RegExp(`^${name}$`) }) }).first();
  const visibleEditor = page.locator(".markdown-editor-host:not(.is-hidden) .cm-content");

  // 1. A double click, then a third click while the file is still loading, opens one tab.
  await card("brainstorming").waitFor();
  await card("brainstorming").dblclick();
  await card("brainstorming").click({ force: true }).catch(() => {});
  await page.waitForTimeout(700);
  assert.equal(await tabs.count(), 1, "double click must not open the same skill twice");

  // 2. Re-opening from the overview focuses the existing tab.
  await page.locator(".tab-bar .home-tab").click();
  await card("brainstorming").click();
  await page.waitForTimeout(600);
  assert.equal(await tabs.count(), 1, "opening an open skill again must focus its tab");
  await visibleEditor.waitFor();
  assert.match(await visibleEditor.innerText(), /SKILL\.md of claude-code-brainstorming/);

  // 3. Picking another file in the file tree stays inside the same tab.
  await page.locator(".file-tree-file-row", { hasText: "notes.md" }).click();
  await page.waitForTimeout(700);
  assert.equal(await tabs.count(), 1, "file tree navigation must not open a duplicate tab");
  assert.match(await visibleEditor.innerText(), /references\/notes\.md of claude-code-brainstorming/);

  // 4. Unsaved edits survive switching files and are written to their own file.
  await page.locator(".file-tree-file-row", { hasText: "SKILL.md" }).click();
  await page.waitForTimeout(300);
  await visibleEditor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("Edited line.");
  await page.locator(".file-tree-file-row", { hasText: "notes.md" }).click();
  await page.waitForTimeout(1500);
  await page.locator(".file-tree-file-row", { hasText: "SKILL.md" }).click();
  await page.waitForTimeout(300);
  assert.match(await visibleEditor.innerText(), /Edited line\./);
  const saves = await page.evaluate(() => window.__saves);
  assert.ok(saves.some(([id, file, content]) => id === "claude-code-brainstorming" && file === "SKILL.md" && content.includes("Edited line.")), "edit is saved to SKILL.md");
  assert.ok(!saves.some(([, file, content]) => file !== "SKILL.md" && content.includes("Edited line.")), "edit never leaks into another file");

  // 5. Same-named copies in different agents are different files: one tab each,
  //    and opening either one again does not add more.
  await page.locator(".tab-bar .home-tab").click();
  await card("pdf").click();
  await page.waitForTimeout(600);
  await page.locator(".nav-section.grow .agent-name", { hasText: "codex" }).first().click();
  await card("pdf").click();
  await page.waitForTimeout(600);
  assert.equal(await tabs.count(), 3);
  await page.locator(".tab-bar .home-tab").click();
  await card("pdf").click();
  await page.waitForTimeout(600);
  assert.equal(await tabs.count(), 3, "re-opening a same-named copy must reuse its tab");

  // 6. Closing with Ctrl+W flushes a pending edit before the tab goes away.
  await visibleEditor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Closing edit.");
  await page.keyboard.press("Control+w");
  await page.waitForTimeout(600);
  assert.equal(await tabs.count(), 2);
  const finalSaves = await page.evaluate(() => window.__saves);
  assert.ok(finalSaves.some(([id, , content]) => id === "codex-pdf" && content.includes("Closing edit.")), "closing flushes the pending save");

  assert.deepEqual(failures, []);
  console.log("PASS: double-click and in-flight re-open reuse the tab, file tree stays in one tab, edits survive file switches, same-named copies get one tab each, closing flushes pending saves (browser API fixture).");
} finally {
  await browser.close();
}
