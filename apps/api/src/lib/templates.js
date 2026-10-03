import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, "..", "templates");

let cache = null;

// Loads tenant template seeds from src/templates/*.json.
// Phase 8 replaces this with Template CRUD + versioning; the shape stays the same.
export function loadTemplates() {
  if (cache) return cache;
  cache = [];
  let files = [];
  try {
    files = readdirSync(templatesDir).filter((f) => f.endsWith(".json"));
  } catch {
    return cache;
  }
  for (const f of files) {
    try {
      cache.push(JSON.parse(readFileSync(join(templatesDir, f), "utf8")));
    } catch {
      // Skip malformed seeds; never crash boot on tenant data.
    }
  }
  return cache;
}

// Raw seed lookups (used by render tests + one-off tooling). The versioned
// runtime store (templateStore.js) is canonical for requests; these helpers
// intentionally read seeds directly so renderer tests stay independent of it.
export function getTemplate(id) {
  const all = loadTemplates();
  return all.find((t) => t.template?.id === id) ?? null;
}

export function getDefaultTemplate() {
  const all = loadTemplates();
  return all.find((t) => t.template?.status === "active") ?? all[0] ?? null;
}
