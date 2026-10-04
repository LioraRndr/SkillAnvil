import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const catalog = JSON.parse(readFileSync(new URL("src/agent-catalog.json", root), "utf8"));
const iconModule = readFileSync(new URL("src/agentCatalog.ts", root), "utf8");
const iconFiles = new Map([...iconModule.matchAll(/(\w+): "([\w.-]+\.(?:svg|png))"/g)].map((match) => [match[1], match[2]]));

test("the shared catalog has unique ids, explicit loading scope and valid documentation", () => {
  assert.equal(new Set(catalog.map((entry) => entry.id)).size, catalog.length);
  for (const entry of catalog) {
    assert.match(entry.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok([1, 2, 3].includes(entry.tier), entry.id);
    assert.ok(["native", "manual", "import"].includes(entry.status), entry.id);
    assert.equal(typeof entry.flatSync, "boolean", entry.id);
    assert.equal(typeof entry.enabled, "boolean", entry.id);
    assert.ok(entry.name && entry.loading && Array.isArray(entry.projectPaths), entry.id);
    const docs = new URL(entry.docs);
    assert.equal(docs.protocol, "https:", entry.id);
    assert.equal(docs.username + docs.password, "", entry.id);
    if (entry.status === "native") {
      assert.ok(entry.paths.length > 0, entry.id);
      for (const path of [...entry.paths, ...(entry.pathsWindows ?? [])]) {
        assert.match(path, /^(?:~\/|\$[A-Z_]+\/)/, entry.id);
        assert.ok(!path.split("/").includes(".."), entry.id);
      }
    } else {
      assert.deepEqual(entry.paths, [], entry.id);
      assert.equal(entry.enabled, false, entry.id);
    }
  }
});

test("every catalog entry has an offline, passive logo asset", () => {
  for (const entry of catalog) {
    const file = iconFiles.get(entry.icon);
    assert.ok(file, `missing icon mapping for ${entry.id}`);
    const bytes = readFileSync(new URL(`src/assets/${file}`, root));
    if (file.endsWith(".png")) {
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", file);
    } else {
      const svg = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      assert.match(svg, /<svg\b/, file);
      assert.doesNotMatch(svg, /<script\b|<foreignObject\b|\bon\w+\s*=|(?:href|src)\s*=\s*["'](?:https?:|javascript:)/i, file);
    }
  }
});

test("logo notices and the Aider license ship as public assets", () => {
  const notice = readFileSync(new URL("public/third-party-notices.txt", root), "utf8");
  assert.match(notice, /LobeHub MIT License/);
  assert.match(notice, /Simple Icons, CC0/);
  assert.match(notice, /licenses\/aider-Apache-2\.0\.txt/);
  const license = readFileSync(new URL("public/licenses/aider-Apache-2.0.txt", root), "utf8");
  assert.match(license, /Apache License/);
  assert.match(license, /Version 2\.0/);
});
