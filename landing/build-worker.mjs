import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSafeOutputRoot,
  buildMarkerContent,
  buildMarkerName,
  securityHeaders,
} from "./build-support.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const requestedOutRoot = process.env.SITES_DIST_DIR
  ? path.resolve(process.env.SITES_DIST_DIR)
  : path.join(root, "dist");
const outRoot = await assertSafeOutputRoot(root, requestedOutRoot);

const serverDir = path.join(outRoot, "server");
const clientDir = path.join(outRoot, "client");
const openAiDir = path.join(outRoot, ".openai");

const files = [
  { route: "/index.html", file: "index.html", contentType: "text/html; charset=utf-8", kind: "text" },
  { route: "/styles.css", file: "styles.css", contentType: "text/css; charset=utf-8", kind: "text" },
  { route: "/assets/skillanvil-logo.png", file: "assets/skillanvil-logo.png", contentType: "image/png", kind: "base64" },
  {
    route: "/assets/fonts/InstrumentSerif-Regular.woff2",
    file: "assets/fonts/InstrumentSerif-Regular.woff2",
    contentType: "font/woff2",
    kind: "base64",
  },
  {
    route: "/assets/fonts/NixieOne-Regular.woff2",
    file: "assets/fonts/NixieOne-Regular.woff2",
    contentType: "font/woff2",
    kind: "base64",
  },
  { route: "/screenshot.jpeg", file: "public/screenshot.jpeg", contentType: "image/jpeg", kind: "base64", optional: true },
];

await mkdir(outRoot, { recursive: true });
// Delete only directories owned by this builder. Never recursively delete an
// arbitrary SITES_DIST_DIR, even after it has passed the ownership checks.
await Promise.all([
  rm(serverDir, { recursive: true, force: true }),
  rm(clientDir, { recursive: true, force: true }),
  rm(openAiDir, { recursive: true, force: true }),
]);
await mkdir(serverDir, { recursive: true });
await mkdir(clientDir, { recursive: true });
await mkdir(openAiDir, { recursive: true });
await writeFile(path.join(outRoot, buildMarkerName), buildMarkerContent, "utf8");

const assets = {};
for (const item of files) {
  const source = path.join(root, item.file);
  let body;
  try {
    const data = await readFile(source);
    body = item.kind === "base64" ? data.toString("base64") : data.toString("utf8");
  } catch (error) {
    if (item.optional) continue;
    throw error;
  }
  assets[item.route] = {
    contentType: item.contentType,
    kind: item.kind,
    body,
  };
}

await copyRecursive(path.join(root, "assets"), path.join(clientDir, "assets"));
await copyFile(path.join(root, "index.html"), path.join(clientDir, "index.html"));
await copyFile(path.join(root, "styles.css"), path.join(clientDir, "styles.css"));
await copyFile(path.join(root, ".openai", "hosting.json"), path.join(openAiDir, "hosting.json"));

const screenshotSource = path.join(root, "public", "screenshot.jpeg");
try {
  await mkdir(path.join(clientDir, "public"), { recursive: true });
  await copyFile(screenshotSource, path.join(clientDir, "screenshot.jpeg"));
  await copyFile(screenshotSource, path.join(clientDir, "public", "screenshot.jpeg"));
} catch {
  // The screenshot is required for polished Sites previews, but the Worker can
  // still be built locally before the capture step has run.
}

const serverSource = `const ASSETS = ${JSON.stringify(assets)};
const SECURITY_HEADERS = ${JSON.stringify(securityHeaders)};

const binaryCache = new Map();

function decodeBase64(route, body) {
  let cached = binaryCache.get(route);
  if (cached) return cached;
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  binaryCache.set(route, bytes);
  return bytes;
}

function responseFor(route, asset) {
  const cacheControl = route === "/index.html"
    ? "public, max-age=60"
    : "public, max-age=31536000, immutable";
  const body = asset.kind === "base64" ? decodeBase64(route, asset.body) : asset.body;
  return new Response(body, {
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": asset.contentType,
      "Cache-Control": cacheControl,
    },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    let route = url.pathname;
    if (route === "/" || route.endsWith("/")) route = "/index.html";

    const asset = ASSETS[route];
    if (asset) return responseFor(route, asset);

    if (route.startsWith("/assets/")) {
      return new Response("Not found", { status: 404 });
    }

    return responseFor("/index.html", ASSETS["/index.html"]);
  },
};
`;

await writeFile(path.join(serverDir, "index.js"), serverSource, "utf8");

async function copyRecursive(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyRecursive(from, to);
    } else {
      await copyFile(from, to);
    }
  }
}
