import {
  WATERMARK_OPACITY,
  assetImage,
  buildRenderNodes,
  documentTitle,
  facultyTableData,
  formatNumber,
  pageGeometry,
  safeHexColor,
  typographyConfig,
} from "./renderModel.js";

export { WATERMARK_OPACITY };

// HTML document renderer (Stage 6).
//
// The saved `document.blocks` body controls order, edited text and supported
// formatting. Template fields remain locked presentation: page geometry,
// header/logo/watermark/footer, page border and typography defaults.
// The same resolved node list is consumed by the DOCX and LaTeX renderers.

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function styleAttribute(block) {
  const style = block?.style ?? {};
  const declarations = [];
  if (style.align) declarations.push(`text-align: ${style.align}`);
  if (Number.isFinite(style.fontSize)) declarations.push(`font-size: ${style.fontSize}px`);
  if (Number.isFinite(style.lineHeight)) declarations.push(`line-height: ${style.lineHeight}`);
  if (Number.isFinite(style.spacingBefore)) declarations.push(`margin-top: ${style.spacingBefore}px`);
  if (Number.isFinite(style.spacingAfter)) declarations.push(`margin-bottom: ${style.spacingAfter}px`);
  if (Number.isFinite(style.indent)) declarations.push(`margin-left: ${style.indent}px`);
  return declarations.length ? ` style="${declarations.join("; ")}"` : "";
}

function listHtml(block, tag) {
  const items = Array.isArray(block.content?.items) ? block.content.items : [];
  return `<${tag} class="block-list"${styleAttribute(block)}>${items
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("")}</${tag}>`;
}

function blockHtml(block) {
  const text = block.content?.text ?? "";
  if (block.type === "title") {
    return `<h1${styleAttribute(block)}>${escapeHtml(text)}</h1>`;
  }
  if (block.type === "experimentNumber") {
    return `<p class="exp-no"${styleAttribute(block)}>${escapeHtml(text)}</p>`;
  }
  if (block.type === "heading") {
    return `<h2${styleAttribute(block)}>${escapeHtml(text)}</h2>`;
  }
  if (block.type === "subheading") {
    return `<h3${styleAttribute(block)}>${escapeHtml(text)}</h3>`;
  }
  if (block.type === "paragraph") {
    return `<p class="block-paragraph"${styleAttribute(block)}>${escapeHtml(text)}</p>`;
  }
  if (block.type === "bulletList") return listHtml(block, "ul");
  if (block.type === "numberedList") return listHtml(block, "ol");
  if (block.type === "code") {
    const language = String(block.content?.language ?? "");
    return `<pre class="code"${language ? ` data-language="${escapeHtml(language)}"` : ""}${styleAttribute(block)}>${escapeHtml(text)}</pre>`;
  }
  if (block.type === "spacer") {
    const height = Number.isFinite(block.content?.height) ? block.content.height : 24;
    return `<div class="spacer" style="height: ${height}px" aria-hidden="true"></div>`;
  }
  if (block.type === "pageBreak") {
    return `<div class="page-break" aria-hidden="true"></div>`;
  }
  if (block.type === "handwrite") {
    return `<div class="handwrite" aria-hidden="true"></div>`;
  }
  return "";
}

function artwork(template, geometry) {
  const t = template ?? {};
  const header = t.header ?? {};
  const watermark = t.watermark ?? {};
  const logoRef = t.assets?.logo;
  const headerImage = header.image ? assetImage(header.image) : null;
  const logoImage = logoRef ? assetImage(logoRef) : null;
  const watermarkImage = watermark.image ? assetImage(watermark.image) : null;

  const headerImg = header.image
    ? headerImage
      ? `<img class="doc-header-img" src="${escapeHtml(header.image)}" alt="${escapeHtml(header.alt ?? "Header")}" />`
      : `<div class="doc-header-missing">[header artwork missing: ${escapeHtml(header.image)}]</div>`
    : "";
  const logoImg = logoImage
    ? `<img class="doc-logo" src="${escapeHtml(logoRef)}" alt="${escapeHtml(t.assets?.logoAlt ?? "Logo")}" />`
    : "";
  const watermarkImg = watermark.image
    ? watermarkImage
      ? `<img class="watermark-img" src="${escapeHtml(watermark.image)}" alt="${escapeHtml(watermark.alt ?? "Watermark")}" style="width: ${formatNumber(geometry.width * 0.4, 2)}mm" />`
      : ""
    : `<div class="watermark-missing">[watermark artwork missing]</div>`;

  return { headerImg, logoImg, watermarkImg };
}

function facultyTableHtml(template) {
  const data = facultyTableData(template);
  if (!data) return "";
  const head = data.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
  const rows = data.rows
    .map(
      (row) =>
        `<tr>${data.columns
          .map((_, index) => `<td>${escapeHtml(row[index] ?? "") || "&nbsp;"}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<h2>${escapeHtml(data.title)}</h2>
    <table class="faculty"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderHtml(source, template, options = {}) {
  const model = buildRenderNodes(source, template, options);
  const t = model.template;
  const geometry = pageGeometry(t);
  const typography = typographyConfig(t);
  const { headerImg, logoImg, watermarkImg } = artwork(t, geometry);
  const footer = t.footer ?? {};
  const pageNumHtml = footer.showPageNumber === true ? '<span class="pagenum"></span>' : "";
  const footerHtml = [escapeHtml(footer.text ?? ""), pageNumHtml].filter(Boolean).join(" &nbsp;|&nbsp; ");
  const border = geometry.border;
  const frameStyle = border
    ? `border: ${formatNumber(border.widthPt, 3)}pt ${border.style} ${safeHexColor(border.color)};`
    : "border: 0;";
  const pageBreakCss = `
  .page-break { height: 0; break-after: page; page-break-after: always; }
  .page-break:last-child { break-after: auto; page-break-after: auto; }
  `;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(documentTitle(source, model.blocks))}</title>
<style>
  @page { size: ${escapeHtml(geometry.size.toLowerCase())} ${geometry.orientation}; margin: 0; }
  * { box-sizing: border-box; }
  body {
    font-family: ${typography.fontFamily};
    font-size: ${typography.baseSize};
    line-height: ${typography.lineHeight};
    color: #111;
    margin: 0;
    padding: 0;
  }
  /* Fixed elements repeat on EVERY printed page (Chrome/Edge print + PDF). */
  .doc-header {
    position: fixed; top: ${formatNumber(geometry.header.top, 2)}mm;
    left: ${geometry.frameInset}mm; right: ${geometry.frameInset}mm;
    display: flex; align-items: center; gap: 3mm;
    padding: 0 0 2mm 0;
    border-bottom: 1px solid #1a3a7c;
    background: #fff;
    z-index: 1;
  }
  .doc-header-img { display: block; flex: 1 1 auto; width: 100%; height: auto; min-width: 0; }
  .doc-logo { display: block; flex: 0 0 auto; width: auto; height: 14mm; }
  .doc-header-missing { border: 1px dashed #999; color: #777; text-align: center; padding: 14px; font-size: 10pt; flex: 1; }
  .watermark {
    position: fixed; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    opacity: ${WATERMARK_OPACITY};
    pointer-events: none;
    z-index: 0;
    text-align: center;
  }
  .watermark-img { max-width: 60%; height: auto; }
  .watermark-missing { border: 1px dashed #999; color: #777; padding: 40px 60px; font-size: 10pt; }
  .doc-footer {
    position: fixed; bottom: ${geometry.frameInset}mm;
    left: ${geometry.frameInset}mm; right: ${geometry.frameInset}mm;
    padding: 2mm 0 0 0;
    font-size: 9pt; color: #444; text-align: center;
    border-top: 1px solid #ccc; background: #fff;
    z-index: 1;
  }
  .doc-footer .pagenum::after { counter-increment: page; content: counter(page); }
  .page-frame {
    position: fixed; top: ${geometry.frameInset}mm; right: ${geometry.frameInset}mm;
    bottom: ${geometry.frameInset}mm; left: ${geometry.frameInset}mm;
    ${frameStyle}
    pointer-events: none; z-index: 2;
  }
  .faculty { width: 100%; border-collapse: collapse; margin-top: 8px; }
  .faculty th, .faculty td { border: 1px solid #333; padding: 6px 8px; font-size: 10.5pt; text-align: left; vertical-align: top; }
  .faculty td { height: 44px; }
  .handwrite { height: 140px; }
  main {
    position: relative; z-index: 1;
    padding: ${formatNumber(geometry.margin.top, 2)}mm ${formatNumber(geometry.margin.right, 2)}mm ${formatNumber(geometry.margin.bottom, 2)}mm ${formatNumber(geometry.margin.left, 2)}mm;
  }
  h1 { font-size: 19.5pt; text-align: center; margin: 0 0 8px 0; }
  .exp-no { text-align: center; font-weight: bold; margin: 0 0 12px 0; }
  h2 { font-size: 12.75pt; border-bottom: 1px solid #333; padding-bottom: 2px; margin: 22px 0 6px 0; }
  h3 { font-size: 10.9pt; margin: 10px 0 4px 0; }
  .block-paragraph { margin: 0 0 8px 0; white-space: pre-wrap; }
  .block-list { margin: 0 0 8px 0; padding-left: 1.5em; }
  .block-list li { white-space: pre-wrap; }
  pre.code { background: #f4f4f4; border: 1px solid #ccc; padding: 8px; overflow-x: auto; font-size: 10pt; line-height: 1.35; white-space: pre; font-family: Consolas, "Courier New", monospace; }
  .spacer { width: 100%; }
  ${pageBreakCss}
  @media screen { body { background: #e8e8e8; } main, .doc-header, .doc-footer { max-width: ${formatNumber(geometry.width, 2)}mm; margin-left: auto; margin-right: auto; } }
</style>
</head>
<body>
  ${border ? '<div class="page-frame"></div>' : ""}
  <div class="doc-header">${logoImg}${headerImg}</div>
  <div class="watermark">${watermarkImg}</div>
  <div class="doc-footer">${footerHtml}</div>
  <main>
    ${model.blocks.map(blockHtml).join("\n    ")}
    ${facultyTableHtml(t)}
  </main>
</body>
</html>`;
}
