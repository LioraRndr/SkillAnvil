import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const buildMarkerName = ".skillanvil-sites-build";
export const buildMarkerContent = "SkillAnvil Sites build output v1\n";

export const securityHeaders = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'none'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; upgrade-insecure-requests",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

function isSameOrAncestor(ancestor, candidate) {
  const relative = path.relative(ancestor, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function assertSafeOutputRoot(sourceRoot, requestedOutRoot) {
  const source = path.resolve(sourceRoot);
  const out = path.resolve(requestedOutRoot);
  const defaultOut = path.join(source, "dist");
  const filesystemRoot = path.parse(out).root;

  if (out === filesystemRoot || isSameOrAncestor(out, source)) {
    throw new Error(`Refusing to use a filesystem root or source ancestor as build output: ${out}`);
  }
  if (isSameOrAncestor(source, out) && out !== defaultOut) {
    throw new Error(`Build output inside the landing source must be exactly ${defaultOut}`);
  }

  let entries;
  try {
    entries = await readdir(out);
  } catch (error) {
    if (error?.code === "ENOENT") return out;
    throw error;
  }

  if (out !== defaultOut && entries.length > 0) {
    let marker = null;
    try {
      marker = await readFile(path.join(out, buildMarkerName), "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (marker !== buildMarkerContent) {
      throw new Error(`Refusing to overwrite a non-empty, unowned build directory: ${out}`);
    }
  }

  return out;
}
