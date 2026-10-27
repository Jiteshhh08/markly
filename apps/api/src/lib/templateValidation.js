import { SECTION_NAMES } from "../schemas.js";

// STAGE 3: reusable template-configuration validation.
//
// Template fields become CSS, HTML and LaTeX. User-provided values therefore
// never flow into a renderer unchecked. This module deliberately uses
// allowlists and narrow grammars rather than trying to "escape" CSS later.
// It is shared by create, update, import, preview and the admin routes.

export class TemplateValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "TemplateValidationError";
    this.status = status;
  }
}

const PAGE_SIZES = new Set(["A3", "A4", "A5", "LETTER", "LEGAL", "TABLOID"]);
const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 '",._-]{0,199}$/;
const CSS_LENGTH = /^\d{1,3}(?:\.\d{1,2})?(?:px|mm|cm|in|pt)$/i;
const COLOR = /^#[0-9a-f]{3,8}$/i;
const SAFE_ASSET_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/;
const ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const SAFE_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,49}$/;
const FORBIDDEN_CSS = /[;{}<>]|url\s*\(|expression\s*\(|@import|javascript:|data:/i;
// eslint-disable-next-line no-control-regex -- control characters are rejected explicitly
const CONTROL_CHARS = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]");

const RUNTIME_FIELDS = new Set([
  "name",
  "status",
  "page",
  "pageSettings",
  "typography",
  "requiredSections",
  "studentMetadataFields",
  "assets",
  "watermark",
  "header",
  "footer",
  "headerFooter",
  "facultyTable",
  "layoutPolicy",
  "metadata",
  "description",
]);

export function pickTemplateRuntimeFields(body) {
  const out = {};
  for (const [key, value] of Object.entries(body ?? {})) {
    if (RUNTIME_FIELDS.has(key)) out[key] = value;
  }
  return out;
}

function fail(message) {
  throw new TemplateValidationError(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertNoUnsafeKeys(value, label, depth = 0) {
  if (depth > 8) fail(`${label} is nested too deeply.`);
  if (Array.isArray(value)) {
    if (value.length > 200) fail(`${label} contains too many entries.`);
    for (const child of value) assertNoUnsafeKeys(child, label, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith("$") || key.includes(".") || key === "__proto__" || key === "constructor" || key === "prototype") {
      fail(`${label} contains an unsupported key.`);
    }
    assertNoUnsafeKeys(child, label, depth + 1);
  }
}

function boundedText(value, label, max, { allowEmpty = true, multiline = false } = {}) {
  if (typeof value !== "string") fail(`${label} must be a string.`);
  if (CONTROL_CHARS.test(value)) fail(`${label} contains control characters.`);
  if (!multiline && /[\r\n]/.test(value)) fail(`${label} must be a single line.`);
  const text = value.trim();
  if (!allowEmpty && text.length === 0) fail(`${label} is required.`);
  if (text.length > max) fail(`${label} is too long.`);
  return text;
}

function safeCssLength(value, label, { max = 300 } = {}) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 0 || value > max) fail(`${label} is outside the allowed range.`);
    return `${value}px`;
  }
  if (typeof value !== "string") fail(`${label} must be a CSS length.`);
  const text = value.trim();
  if (!CSS_LENGTH.test(text) || FORBIDDEN_CSS.test(text)) {
    fail(`${label} must be a simple px/mm/cm/in/pt value.`);
  }
  const number = Number.parseFloat(text);
  if (!Number.isFinite(number) || number < 0 || number > max) {
    fail(`${label} is outside the allowed range.`);
  }
  return text;
}

function normalizeObject(value, label, maxBytes = 20_000) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) fail(`${label} must be an object.`);
  assertNoUnsafeKeys(value, label);
  const json = JSON.stringify(value);
  if (json.length > maxBytes) fail(`${label} is too large.`);
  return JSON.parse(json);
}

export function isSafeAssetReference(ref) {
  if (typeof ref !== "string") return false;
  if (ref.length === 0 || ref.length > 255) return false;
  if (!ref.startsWith("/assets/")) return false;
  const rel = ref.slice("/assets/".length);
  if (!SAFE_ASSET_PATH.test(rel)) return false;
  if (rel.includes("..") || rel.includes("//") || rel.includes("%")) return false;
  const lower = rel.toLowerCase();
  if (lower.includes("svg")) return false;
  const dot = lower.lastIndexOf(".");
  if (dot < 0 || !ASSET_EXTENSIONS.has(lower.slice(dot))) return false;
  return true;
}

export function validateAssetReference(ref, label = "Asset") {
  if (ref === null || ref === undefined || ref === "") return null;
  if (!isSafeAssetReference(ref)) {
    fail(`${label} must be a safe local /assets/ image reference.`);
  }
  return ref;
}

function validateAssetMap(value, label) {
  if (value === undefined) return undefined;
  const obj = normalizeObject(value, label);
  const out = {};
  for (const [key, ref] of Object.entries(obj)) {
    // Optional slots (for example assets.logo) are cleared by sending null or
    // an empty string. Treat those as "absent" instead of rejecting them; the
    // returned map replaces the previous one, so the clear is persisted.
    if (ref === null || ref === undefined || ref === "") continue;
    if (typeof ref !== "string") fail(`${label}.${key} must be an asset reference.`);
    out[key] = validateAssetReference(ref, `${label}.${key}`);
  }
  return out;
}

function validatePage(value) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) fail("page must be an object.");
  const out = {};
  if (value.size !== undefined) {
    if (typeof value.size !== "string" || !PAGE_SIZES.has(value.size.trim().toUpperCase())) {
      fail("page.size must be one of A3, A4, A5, Letter, Legal or Tabloid.");
    }
    out.size = value.size.trim().toUpperCase() === "LETTER"
      ? "Letter"
      : value.size.trim().toUpperCase() === "LEGAL"
        ? "Legal"
        : value.size.trim().toUpperCase() === "TABLOID"
          ? "Tabloid"
          : value.size.trim().toUpperCase();
  }
  if (value.margin !== undefined) {
    if (!isPlainObject(value.margin)) fail("page.margin must be an object.");
    out.margin = {};
    for (const side of ["top", "right", "bottom", "left"]) {
      if (value.margin[side] === undefined) continue;
      out.margin[side] = safeCssLength(value.margin[side], `page.margin.${side}`, { max: 300 });
    }
  }
  if (value.border !== undefined) out.border = validateBorder(value.border);
  if (value.orientation !== undefined) out.orientation = validateOrientation(value.orientation);
  return out;
}

function validateOrientation(value) {
  if (typeof value !== "string" || !["portrait", "landscape"].includes(value.trim().toLowerCase())) {
    fail("Page orientation must be portrait or landscape.");
  }
  return value.trim().toLowerCase();
}

function validateBorder(value) {
  if (typeof value === "boolean") return value;
  if (!isPlainObject(value)) fail("Page border must be a boolean or an object.");
  const out = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") fail("Page border enabled must be a boolean.");
    out.enabled = value.enabled;
  }
  if (value.style !== undefined) {
    if (!["solid", "double", "dashed", "dotted"].includes(value.style)) {
      fail("Page border style is not supported.");
    }
    out.style = value.style;
  }
  if (value.width !== undefined) out.width = safeCssLength(value.width, "Page border width", { max: 12 });
  if (value.color !== undefined) {
    if (typeof value.color !== "string" || !COLOR.test(value.color)) {
      fail("Page border color must be a hex color.");
    }
    out.color = value.color;
  }
  return out;
}

function validatePageSettings(value) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) fail("pageSettings must be an object.");
  const out = {};
  if (value.orientation !== undefined) out.orientation = validateOrientation(value.orientation);
  if (value.columns !== undefined) {
    if (!Number.isInteger(value.columns) || value.columns < 1 || value.columns > 3) {
      fail("pageSettings.columns must be between 1 and 3.");
    }
    out.columns = value.columns;
  }
  if (value.border !== undefined) out.border = validateBorder(value.border);
  return out;
}

function validateTypography(value) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) fail("typography must be an object.");
  const out = {};
  if (value.fontFamily !== undefined) {
    if (typeof value.fontFamily !== "string") fail("typography.fontFamily must be a string.");
    const font = value.fontFamily.trim();
    if (!FONT_NAME.test(font) || FORBIDDEN_CSS.test(font)) {
      fail("typography.fontFamily contains unsupported characters.");
    }
    out.fontFamily = font;
  }
  if (value.baseSize !== undefined) {
    const size = safeCssLength(value.baseSize, "typography.baseSize", { max: 72 });
    if (!/^\d+(?:\.\d+)?(?:pt|px|mm)$/i.test(size)) {
      fail("typography.baseSize must use pt, px or mm.");
    }
    out.baseSize = size;
  }
  if (value.lineHeight !== undefined) {
    const lineHeight = Number(value.lineHeight);
    if (!Number.isFinite(lineHeight) || lineHeight < 0.8 || lineHeight > 3) {
      fail("typography.lineHeight must be between 0.8 and 3.");
    }
    out.lineHeight = lineHeight;
  }
  return out;
}

function validateHeaderFooter(value, label) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) fail(`${label} must be an object.`);
  const out = {};
  if (value.image !== undefined) out.image = validateAssetReference(value.image, `${label}.image`);
  if (value.alt !== undefined) out.alt = boundedText(value.alt, `${label}.alt`, 300);
  if (value.height !== undefined) out.height = safeCssLength(value.height, `${label}.height`, { max: 200 });
  if (value.everyPage !== undefined) {
    if (typeof value.everyPage !== "boolean") fail(`${label}.everyPage must be a boolean.`);
    out.everyPage = value.everyPage;
  }
  return out;
}

function validateFooter(value) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) fail("footer must be an object.");
  const out = {};
  if (value.text !== undefined) out.text = boundedText(value.text, "footer.text", 500, { multiline: true });
  if (value.showPageNumber !== undefined) {
    if (typeof value.showPageNumber !== "boolean") fail("footer.showPageNumber must be a boolean.");
    out.showPageNumber = value.showPageNumber;
  }
  return out;
}

function validateWatermark(value) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) fail("watermark must be an object.");
  const out = {};
  if (value.image !== undefined) out.image = validateAssetReference(value.image, "watermark.image");
  if (value.alt !== undefined) out.alt = boundedText(value.alt, "watermark.alt", 300);
  if (value.everyPage !== undefined) {
    if (typeof value.everyPage !== "boolean") fail("watermark.everyPage must be a boolean.");
    out.everyPage = value.everyPage;
  }
  if (value.opacity !== undefined && Number(value.opacity) !== 0.5) {
    fail("Watermark opacity is fixed at 50%.");
  }
  if (value.opacity !== undefined) out.opacity = 0.5;
  return out;
}

function validateRequiredSections(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail("requiredSections must be an array.");
  if (value.length === 0) fail("requiredSections must not be empty.");
  const out = [];
  const seen = new Set();
  let lastIndex = -1;
  for (const section of value) {
    if (typeof section !== "string" || !SECTION_NAMES.includes(section)) {
      fail(`requiredSections contains an unknown section.`);
    }
    if (seen.has(section)) fail("requiredSections must not contain duplicates.");
    const index = SECTION_NAMES.indexOf(section);
    if (index < lastIndex) fail("requiredSections must follow the supported section order.");
    lastIndex = index;
    seen.add(section);
    out.push(section);
  }
  return out;
}

function validateMetadataFields(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) fail("studentMetadataFields must be an array of up to 20 fields.");
  const out = [];
  for (const field of value) {
    if (typeof field !== "string" || !SAFE_FIELD_NAME.test(field)) {
      fail("studentMetadataFields contains an unsupported field name.");
    }
    out.push(field);
  }
  return out;
}

function validateFacultyTable(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isPlainObject(value)) fail("facultyTable must be an object or null.");
  const out = {};
  if (value.title !== undefined) out.title = boundedText(value.title, "facultyTable.title", 200);
  if (value.columns !== undefined) {
    if (!Array.isArray(value.columns) || value.columns.length === 0 || value.columns.length > 20) {
      fail("facultyTable.columns must contain 1 to 20 columns.");
    }
    out.columns = value.columns.map((column, index) =>
      boundedText(column, `facultyTable.columns[${index}]`, 200),
    );
  }
  if (value.rows !== undefined) {
    if (!Array.isArray(value.rows) || value.rows.length > 50) {
      fail("facultyTable.rows must be an array of up to 50 rows.");
    }
    out.rows = value.rows.map((row, rowIndex) => {
      if (!Array.isArray(row) || row.length > 20) {
        fail(`facultyTable.rows[${rowIndex}] must be an array.`);
      }
      return row.map((cell, cellIndex) =>
        boundedText(String(cell ?? ""), `facultyTable.rows[${rowIndex}][${cellIndex}]`, 500, {
          multiline: true,
        }),
      );
    });
  }
  if (out.columns && out.rows) {
    for (const row of out.rows) {
      if (row.length !== out.columns.length) {
        fail("Every facultyTable row must match the column count.");
      }
    }
  }
  return out;
}

/**
 * Validate and normalize runtime template fields. The caller decides whether
 * the fields are a create body, an update patch, or a preview payload.
 */
export function validateTemplateFields(fields = {}, { requireName = false } = {}) {
  if (!isPlainObject(fields)) fail("Template configuration must be an object.");
  assertNoUnsafeKeys(fields, "Template configuration");
  const out = {};

  if (fields.name !== undefined) {
    out.name = boundedText(fields.name, "Template name", 120, { allowEmpty: false });
    if (out.name.length < 3) fail("Template name must be at least 3 characters.");
  } else if (requireName) {
    fail("Template name must be at least 3 characters.");
  }

  if (fields.status !== undefined) {
    if (!["draft", "active", "published", "archived"].includes(fields.status)) {
      fail("Invalid template status.");
    }
    out.status = fields.status;
  }

  if (fields.page !== undefined) out.page = validatePage(fields.page);
  if (fields.pageSettings !== undefined) out.pageSettings = validatePageSettings(fields.pageSettings);
  if (fields.typography !== undefined) out.typography = validateTypography(fields.typography);
  if (fields.requiredSections !== undefined) {
    out.requiredSections = validateRequiredSections(fields.requiredSections);
  }
  if (fields.studentMetadataFields !== undefined) {
    out.studentMetadataFields = validateMetadataFields(fields.studentMetadataFields);
  }
  if (fields.assets !== undefined) out.assets = validateAssetMap(fields.assets, "assets");
  if (fields.watermark !== undefined) out.watermark = validateWatermark(fields.watermark);
  if (fields.header !== undefined) out.header = validateHeaderFooter(fields.header, "header");
  if (fields.footer !== undefined) out.footer = validateFooter(fields.footer);
  if (fields.headerFooter !== undefined) {
    out.headerFooter = validateHeaderFooter(fields.headerFooter, "headerFooter");
  }
  if (fields.facultyTable !== undefined) out.facultyTable = validateFacultyTable(fields.facultyTable);
  if (fields.layoutPolicy !== undefined) out.layoutPolicy = normalizeObject(fields.layoutPolicy, "layoutPolicy");
  if (fields.metadata !== undefined) out.metadata = normalizeObject(fields.metadata, "metadata");
  if (fields.description !== undefined) out.description = boundedText(fields.description, "description", 1000, {
    multiline: true,
  });

  return out;
}

export function assertTemplateStatusTransition(currentStatus, nextStatus) {
  if (!nextStatus) return;
  const current = currentStatus === "active" ? "published" : currentStatus;
  const next = nextStatus === "active" ? "published" : nextStatus;
  // `active` and `published` are the same lifecycle state. Re-publishing an
  // already published template forks a new immutable version; it is not an
  // invalid self-transition.
  if (next === current) return;
  const allowed = {
    draft: new Set(["published", "archived"]),
    published: new Set(["archived", "draft"]),
    archived: new Set(["draft"]),
  };
  if (!allowed[current]?.has(next)) {
    fail(`Cannot change a template from ${currentStatus} to ${nextStatus}.`);
  }
}

export function assertTemplateReferences({ scope, tenantId, departmentId } = {}) {
  if (scope === "platform") {
    if (tenantId || departmentId) fail("Platform templates cannot be scoped to a college or branch.");
    return;
  }
  if (scope === "college" && !tenantId) fail("A college is required for a college template.");
  if (scope === "private" && departmentId && !tenantId) {
    fail("A college is required when a branch is provided.");
  }
}

export function safeTemplateName(value, fallback = "Imported template") {
  const name = typeof value === "string" ? value.trim().slice(0, 120) : "";
  return name.length >= 3 ? name : fallback;
}
