import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertSafeOutputRoot,
  buildMarkerContent,
  buildMarkerName,
  securityHeaders,
} from "./build-support.mjs";

async function withTempTree(run) {
  const base = path.join(os.tmpdir(), `skillanvil-build-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(base, { recursive: true });
  try {
    await run(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("rejects filesystem roots, source roots, and source ancestors", async () => {
  await withTempTree(async (base) => {
    const workspace = path.join(base, "workspace");
    const source = path.join(workspace, "landing");
    await mkdir(source, { recursive: true });

    await assert.rejects(assertSafeOutputRoot(source, path.parse(source).root));
    await assert.rejects(assertSafeOutputRoot(source, workspace));
    await assert.rejects(assertSafeOutputRoot(source, source));
    await assert.rejects(assertSafeOutputRoot(source, path.join(source, "assets")));
  });
});

test("allows only empty or explicitly marked external output directories", async () => {
  await withTempTree(async (base) => {
    const source = path.join(base, "workspace", "landing");
    const emptyOutput = path.join(base, "empty-output");
    const occupiedOutput = path.join(base, "occupied-output");
    await mkdir(source, { recursive: true });
    await mkdir(emptyOutput, { recursive: true });
    await mkdir(occupiedOutput, { recursive: true });
    await writeFile(path.join(occupiedOutput, "keep.txt"), "user data", "utf8");

    assert.equal(await assertSafeOutputRoot(source, emptyOutput), emptyOutput);
    await assert.rejects(assertSafeOutputRoot(source, occupiedOutput));

    await writeFile(path.join(occupiedOutput, buildMarkerName), buildMarkerContent, "utf8");
    assert.equal(await assertSafeOutputRoot(source, occupiedOutput), occupiedOutput);
  });
});

test("defines a restrictive static-site security policy", () => {
  assert.match(securityHeaders["Content-Security-Policy"], /script-src 'none'/);
  assert.match(securityHeaders["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.equal(securityHeaders["X-Content-Type-Options"], "nosniff");
  assert.equal(securityHeaders["X-Frame-Options"], "DENY");
});
