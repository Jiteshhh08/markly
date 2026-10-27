import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// File storage abstraction. Local filesystem for development;
// swap the internals for cloud object storage later (same function names).
// Large binaries (templates, DOCX, LaTeX, PDFs) must never go into MongoDB.

const here = dirname(fileURLToPath(import.meta.url));
export const assetsDir = join(here, "..", "..", "assets");
export const uploadsDir = join(assetsDir, "uploads");

export function ensureDirs() {
  for (const sub of ["", "uploads", "generated"]) {
    const dir = join(assetsDir, sub);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function safeRelativeAssetPath(ref) {
  if (typeof ref !== "string" || !ref.startsWith("/assets/")) return null;
  const rel = ref.slice("/assets/".length);
  if (!rel || rel.includes("\\") || rel.includes("\0")) return null;
  if (rel.startsWith("/") || rel.includes("..") || rel.includes("//") || rel.includes("%")) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(rel)) return null;
  // Keep a single supported namespace: top-level tenant artwork or the
  // administrator upload directory. No arbitrary nested filesystem access.
  const first = rel.split("/")[0];
  if (rel.includes("/") && first !== "uploads") return null;
  if (first === "uploads" && rel.split("/").length !== 2) return null;
  return rel;
}

// Resolve a template asset reference (e.g. "/assets/tcet-header.png" or
// "/assets/uploads/logo-abc.png") to a filesystem path. Returns null when the
// file is missing so renderers can degrade gracefully instead of emitting
// broken images.
export function resolveAsset(ref) {
  const rel = safeRelativeAssetPath(ref);
  if (!rel) return null;
  const full = resolve(assetsDir, rel);
  const root = resolve(assetsDir);
  if (full !== root && !full.startsWith(`${root}${sep}`)) return null;
  return existsSync(full) ? full : null;
}

export function assetUrl(ref) {
  return safeRelativeAssetPath(ref) ? ref : null;
}

export function safeUploadFilename(originalName, extension) {
  const stem = basename(String(originalName ?? "asset"))
    .replace(/\.[^.]*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "asset";
  return `${stem}-${cryptoRandomSuffix()}${extension}`;
}

function cryptoRandomSuffix() {
  return randomUUID().slice(0, 12);
}
