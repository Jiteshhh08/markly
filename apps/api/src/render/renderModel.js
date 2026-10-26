import { readFileSync } from "node:fs";
import {
  blocksFromContent,
  documentBlocksSchema,
  storedDocumentBlocks,
} from "../lib/documentBlocks.js";
import { resolveAsset } from "../lib/storage.js";

// STAGE 6: shared render model.
//
// The saved `document.blocks` body is the single source of truth for export
// order and edited text. HTML, DOCX and LaTeX must not interpret sections
// independently again: they all consume the same resolved node list, the same
// validated style values and the same template geometry from this module.
//
// `content` remains the academic snapshot. It is used only as a READ-ONLY
// fallback for legacy records and template previews that have no saved body.

// PRODUCT RULE: watermark opacity is ALWAYS 50%. This constant wins over any
// template value so the rule holds for every tenant, every page, every format.
export const WATERMARK_OPACITY = 0.5;

export const FRAME_INSET_MM = 10;

const PAGE_DIMENSIONS = Object.freeze({
  A3: { width: 297, height: 420 },
  A4: { width: 210, height: 297 },
  A5: { width: 148, height: 210 },
  LETTER: { width: 215.9, height: 279.4 },
  LEGAL: { width: 215.9, height: 355.6 },
  TABLOID: { width: 279.4, height: 431.8 },
});

const CSS_LENGTH = /^(\d+(?:\.\d+)?)(px|mm|cm|in|pt)$/i;

export function templateOf(template) {
  return template?.template ?? template ?? {};
}

export function normalizePageSize(value) {
  const key = String(value ?? "A4").trim().toUpperCase();
  return PAGE_DIMENSIONS[key] ? key : "A4";
}

/**
 * Convert a validated CSS length to millimetres. Numeric template values are
 * treated as pixels, matching the Stage 3 validation contract.
 */
export function parseCssLength(value, fallbackMm = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return (value * 25.4) / 96;
  }
  const match = CSS_LENGTH.exec(String(value ?? "").trim());
  if (!match) return fallbackMm;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return fallbackMm;
  switch (match[2].toLowerCase()) {
    case "mm":
      return number;
    case "cm":
      return number * 10;
    case "in":
      return number * 25.4;
    case "pt":
      return (number * 25.4) / 72;
    case "px":
    default:
      return (number * 25.4) / 96;
  }
}

export function mmToPt(mm) {
  return (Number(mm) * 72) / 25.4;
}

export function mmToPx(mm) {
  return (Number(mm) * 96) / 25.4;
}

export function pxToPt(px) {
  return (Number(px) * 72) / 96;
}

export function pxToTwips(px) {
  return Math.round((Number(px) * 1440) / 96);
}

export function mmToTwips(mm) {
  return Math.round((Number(mm) * 1440) / 25.4);
}

export function mmToEmu(mm) {
  return Math.round(Number(mm) * 36000);
}

export function ptToHalfPoints(pt) {
  return Math.round(Number(pt) * 2);
}

/** First concrete family from a CSS font stack, for DOCX/PDF font names. */
export function primaryFontFamily(fontFamily, fallback = "Georgia") {
  const first = String(fontFamily ?? "")
    .split(",")[0]
    .trim()
    .replace(/^['"]|['"]$/g, "");
  return first || fallback;
}

export function parseFontSizePt(value, fallbackPt = 12) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const match = CSS_LENGTH.exec(String(value ?? "").trim());
  if (!match) return fallbackPt;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return fallbackPt;
  switch (match[2].toLowerCase()) {
    case "pt":
      return number;
    case "px":
      return pxToPt(number);
    case "mm":
      return mmToPt(number);
    case "cm":
      return mmToPt(number * 10);
    case "in":
      return number * 72;
    default:
      return fallbackPt;
  }
}

export function formatNumber(value, digits = 2) {
  const rounded = Number(Number(value).toFixed(digits));
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

export function safeHexColor(value, fallback = "#111111") {
  const text = String(value ?? "").trim();
  if (!/^#[0-9a-f]{3,8}$/i.test(text)) return fallback;
  if (text.length === 4) {
    return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
  }
  return text.slice(0, 7);
}

export function docxHexColor(value) {
  return safeHexColor(value).slice(1).toUpperCase();
}

export function imageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "jpg";
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return "gif";
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return "bmp";
  return null;
}

/**
 * Tiny intrinsic-size parser for the raster formats the renderers support.
 * Template uploads are validated before they reach here; this only prevents
 * distorted artwork when a banner is not the aspect ratio of its display box.
 */
export function imageDimensions(buffer) {
  if (!buffer || buffer.length < 24) return null;
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + length;
    }
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return {
      width: Math.abs(buffer.readInt32LE(18)),
      height: Math.abs(buffer.readInt32LE(22)),
    };
  }
  return null;
}

export function assetImage(ref) {
  const full = resolveAsset(ref);
  if (!full) return null;
  try {
    const buffer = readFileSync(full);
    const type = imageType(buffer);
    const size = imageDimensions(buffer);
    if (!type || !size?.width || !size?.height) return null;
    return { buffer, type, ...size };
  } catch {
    return null;
  }
}

export function borderConfig(template) {
  const t = templateOf(template);
  const raw = t.page?.border ?? t.pageSettings?.border;
  if (raw === false) return null;
  const border = raw && typeof raw === "object" ? raw : {};
  if (border.enabled === false) return null;
  const style = ["solid", "double", "dashed", "dotted"].includes(border.style)
    ? border.style
    : "solid";
  const width = border.width ?? "1.5px";
  const widthMm = parseCssLength(width, 0.4);
  return {
    enabled: true,
    style,
    width,
    widthMm,
    widthPt: mmToPt(widthMm),
    color: safeHexColor(border.color ?? "#111111"),
  };
}

export function pageGeometry(template) {
  const t = templateOf(template);
  const page = t.page ?? {};
  const settings = t.pageSettings ?? {};
  const size = normalizePageSize(page.size);
  const dimensions = PAGE_DIMENSIONS[size];
  const orientation =
    settings.orientation === "landscape" || page.orientation === "landscape"
      ? "landscape"
      : "portrait";
  let width = dimensions.width;
  let height = dimensions.height;
  if (orientation === "landscape") {
    width = dimensions.height;
    height = dimensions.width;
  }

  const configuredMargin = {
    top: parseCssLength(page.margin?.top, 29.1),
    right: parseCssLength(page.margin?.right, 18),
    bottom: parseCssLength(page.margin?.bottom, 20),
    left: parseCssLength(page.margin?.left, 18),
  };

  const header = t.header ?? {};
  const headerImage = header.image ? assetImage(header.image) : null;
  const frameWidth = Math.max(20, width - FRAME_INSET_MM * 2);
  const headerWidth = frameWidth;
  const headerImageHeight = headerImage
    ? (headerWidth * headerImage.height) / headerImage.width
    : 0;
  const configuredHeaderHeight = parseCssLength(header.height, 0);
  const headerHeight = headerImageHeight || configuredHeaderHeight;
  const hasHeader = Boolean(header.image);
  const headerTop = FRAME_INSET_MM + 3;
  // The header is a locked template element. When it is taller than the
  // configured text margin, body content starts below it rather than overlapping.
  const requiredTop = hasHeader ? headerTop + headerHeight + 5 : 0;
  const top = Math.max(configuredMargin.top, requiredTop);

  return {
    size,
    orientation,
    width,
    height,
    frameInset: FRAME_INSET_MM,
    frameWidth,
    contentWidth: Math.max(20, width - configuredMargin.left - configuredMargin.right),
    margin: { ...configuredMargin, top },
    configuredMargin,
    header: {
      hasImage: hasHeader,
      width: headerWidth,
      height: headerHeight,
      top: headerTop,
    },
    border: borderConfig(t),
  };
}

export function typographyConfig(template) {
  const typo = templateOf(template).typography ?? {};
  const lineHeight = Number(typo.lineHeight);
  return {
    fontFamily:
      typeof typo.fontFamily === "string" && typo.fontFamily.trim()
        ? typo.fontFamily.trim()
        : "Georgia, 'Times New Roman', serif",
    baseSize:
      typeof typo.baseSize === "string" && typo.baseSize.trim()
        ? typo.baseSize.trim()
        : "12pt",
    baseSizePt: parseFontSizePt(typo.baseSize, 12),
    lineHeight:
      Number.isFinite(lineHeight) && lineHeight >= 0.8 && lineHeight <= 3
        ? lineHeight
        : 1.6,
  };
}

// PRODUCT RULE: one watermark size for every renderer. 40% of page width keeps
// the mark centred without swallowing the body text.
export const WATERMARK_WIDTH_RATIO = 0.4;
export const LOGO_HEIGHT_MM = 14;

export function assetFileName(kind, image, fallback = "png") {
  return `${kind}.${image?.type ?? fallback}`;
}

/**
 * Locked template artwork geometry shared by all renderers. The header spans
 * the inner frame, the optional logo overlays its left edge, and the watermark
 * is centred on the page at 40% width.
 */
export function artworkLayout(template, geometry = pageGeometry(template)) {
  const t = templateOf(template);
  const header = t.header?.image ? assetImage(t.header.image) : null;
  const watermark = t.watermark?.image ? assetImage(t.watermark.image) : null;
  const logo = t.assets?.logo ? assetImage(t.assets.logo) : null;
  const headerWidthMm = geometry.header.width;
  const headerHeightMm = header
    ? (headerWidthMm * header.height) / header.width
    : geometry.header.height;
  const logoWidthMm = logo ? (LOGO_HEIGHT_MM * logo.width) / logo.height : 0;
  const watermarkWidthMm = geometry.width * WATERMARK_WIDTH_RATIO;
  return {
    header: header
      ? {
          image: header,
          name: assetFileName("header", header),
          xMm: geometry.frameInset,
          yMm: geometry.header.top,
          widthMm: headerWidthMm,
          heightMm: headerHeightMm,
        }
      : null,
    logo: logo
      ? {
          image: logo,
          name: assetFileName("logo", logo),
          xMm: geometry.frameInset + 2,
          yMm: geometry.header.top + 2,
          widthMm: logoWidthMm,
          heightMm: LOGO_HEIGHT_MM,
        }
      : null,
    watermark: watermark
      ? {
          image: watermark,
          name: assetFileName("watermark", watermark),
          widthMm: watermarkWidthMm,
          heightMm: (watermarkWidthMm * watermark.height) / watermark.width,
        }
      : null,
  };
}

function looksLikeContent(value) {
  if (!value || typeof value !== "object") return false;
  return (
    "title" in value ||
    "aim" in value ||
    "objectives" in value ||
    "theory" in value ||
    "steps" in value ||
    "conclusion" in value
  );
}

/**
 * Resolve the saved block body. Precedence is deliberate:
 *   1. the durable `document.blocks` revision (exports must use saved data),
 *   2. an already-normalized document's validated `blocks`,
 *   3. a read-only legacy projection from `content`.
 */
export function resolveBlocks(source) {
  if (!source || typeof source !== "object") return [];
  const stored = storedDocumentBlocks(source);
  if (stored) return stored;
  if (Array.isArray(source.blocks)) {
    const parsed = documentBlocksSchema.safeParse(source.blocks);
    if (parsed.success) return parsed.data;
  }
  if (Array.isArray(source.document?.blocks)) {
    const parsed = documentBlocksSchema.safeParse(source.document.blocks);
    if (parsed.success) return parsed.data;
  }
  if (source.content && typeof source.content === "object") {
    return blocksFromContent(source.content);
  }
  if (looksLikeContent(source)) return blocksFromContent(source);
  return [];
}

export function resolvePresentation(source, options = {}) {
  const base = source?.presentation ?? source?.options ?? source?.input ?? {};
  const includeVivaTitle =
    typeof options.includeVivaTitle === "boolean"
      ? options.includeVivaTitle
      : base.includeVivaTitle === true;
  const typedConclusion =
    typeof options.typedConclusion === "boolean"
      ? options.typedConclusion
      : base.typedConclusion !== false;
  return { includeVivaTitle, typedConclusion };
}

function handwriteNode(id) {
  return { id, type: "handwrite", content: {} };
}

/**
 * Apply presentation-only flags to the saved body without changing the saved
 * body itself. Typed conclusion text is replaced by writing space; a Viva
 * heading is appended as a heading plus writing space when enabled.
 */
export function buildRenderNodes(source, template, options = {}) {
  const blocks = resolveBlocks(source);
  const presentation = resolvePresentation(source, options);
  const nodes = [];
  let conclusionReplaced = false;

  for (const block of blocks) {
    if (
      block.type === "paragraph" &&
      block.source?.section === "conclusion" &&
      !presentation.typedConclusion
    ) {
      nodes.push(handwriteNode(`${block.id}-handwrite`));
      conclusionReplaced = true;
      continue;
    }
    nodes.push(block);
  }

  if (!presentation.typedConclusion && !conclusionReplaced) {
    nodes.push(handwriteNode("render-conclusion-handwrite"));
  }

  const hasVivaHeading = blocks.some(
    (block) =>
      block.type === "heading" &&
      /^viva\s+questions$/i.test(String(block.content?.text ?? "").trim()),
  );
  if (presentation.includeVivaTitle && !hasVivaHeading) {
    nodes.push({
      id: "render-viva-heading",
      type: "heading",
      content: { text: "Viva Questions" },
      internal: "vivaHeading",
    });
    nodes.push(handwriteNode("render-viva-handwrite"));
  }

  return {
    blocks: nodes,
    template: templateOf(template),
    presentation,
    hasSavedBlocks: storedDocumentBlocks(source) !== null,
  };
}

export function documentTitle(source, nodes = []) {
  const titleBlock = nodes.find(
    (block) => block.type === "title" && String(block.content?.text ?? "").trim(),
  );
  if (titleBlock) return String(titleBlock.content.text);
  if (source?.content?.title) return String(source.content.title);
  if (source?.title) return String(source.title);
  return "Assignment";
}

export function facultyTableData(template) {
  const ft = templateOf(template).facultyTable;
  if (!ft?.columns?.length) return null;
  return {
    title: ft.title ?? "For Faculty Use",
    columns: ft.columns.map((column) => String(column ?? "")),
    rows: (ft.rows ?? []).map((row) =>
      ft.columns.map((_, index) => String(row?.[index] ?? "")),
    ),
  };
}

export const BLOCK_DEFAULT_FONT_PX = Object.freeze({
  title: 26,
  experimentNumber: 13,
  heading: 17,
  subheading: 14.5,
  paragraph: null,
  bulletList: null,
  numberedList: null,
  code: 13.333,
});

export const BLOCK_DEFAULT_ALIGN = Object.freeze({
  title: "center",
  experimentNumber: "center",
});

export const BLOCK_DEFAULT_SPACING = Object.freeze({
  title: { before: 0, after: 8 },
  experimentNumber: { before: 0, after: 12 },
  heading: { before: 22, after: 6 },
  subheading: { before: 10, after: 4 },
  paragraph: { before: 0, after: 8 },
  bulletList: { before: 0, after: 8 },
  numberedList: { before: 0, after: 8 },
  code: { before: 0, after: 8 },
  spacer: { before: 0, after: 0 },
});

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Normalize one block's validated style against template typography. The
 * result is expressed in CSS pixels for HTML and converted by the DOCX/LaTeX
 * renderers. A block style always wins over the template default.
 */
export function blockStyle(block, template) {
  const typography = typographyConfig(template);
  const style = block?.style ?? {};
  const defaults = BLOCK_DEFAULT_SPACING[block?.type] ?? { before: 0, after: 0 };
  const defaultFont = BLOCK_DEFAULT_FONT_PX[block?.type];
  const basePx = mmToPx((typography.baseSizePt * 25.4) / 72);
  const fontSizePx =
    finiteNumber(style.fontSize) ?? defaultFont ?? basePx;
  const lineHeight =
    finiteNumber(style.lineHeight) ??
    (block?.type === "code" ? 1.35 : typography.lineHeight);
  return {
    align: style.align ?? BLOCK_DEFAULT_ALIGN[block?.type] ?? "left",
    fontSizePx,
    fontSizePt: pxToPt(fontSizePx),
    lineHeight,
    spacingBeforePx: finiteNumber(style.spacingBefore) ?? defaults.before,
    spacingAfterPx: finiteNumber(style.spacingAfter) ?? defaults.after,
    indentPx: finiteNumber(style.indent) ?? 0,
  };
}

export function textLines(value) {
  return String(value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
}

export function codeLanguage(block) {
  const language = String(block?.content?.language ?? "").trim();
  return /^[A-Za-z0-9+#.-]{1,32}$/.test(language) ? language : "";
}
