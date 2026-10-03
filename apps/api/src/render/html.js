import { resolveAsset } from "../lib/storage.js";

// HTML document renderer (Phase 2).
// Assignment JSON in -> complete printable HTML document out.
// The DOCX (Phase 4) and LaTeX (Phase 4) renderers must mirror these same
// sections in the same order; only presentation differs per template.

// PRODUCT RULE: watermark opacity is ALWAYS 50%. This constant wins over any
// template value so the rule holds for every tenant, every page, every format.
export const WATERMARK_OPACITY = 0.5;

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sectionList(items) {
  return `<ul>${items.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`;
}

function stepsList(steps) {
  return `<ol class="steps">${steps
    .map(
      (s) => `<li class="step">
        <div class="step-title">Step ${s.number}: ${escapeHtml(s.title)}</div>
        ${sectionList(s.description)}
        ${s.code ? `<pre class="code"${s.language ? ` data-language="${escapeHtml(s.language)}"` : ""}>${escapeHtml(s.code)}</pre>` : ""}
      </li>`,
    )
    .join("")}</ol>`;
}

function facultyTable(t) {
  const ft = t.facultyTable;
  if (!ft?.columns?.length) return "";
  const head = ft.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const rows = (ft.rows ?? [])
    .map(
      (r) =>
        `<tr>${ft.columns.map((_, i) => `<td>${escapeHtml(r[i] ?? "") || "&nbsp;"}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<h2>${escapeHtml(ft.title ?? "For Faculty Use")}</h2>
    <table class="faculty"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderHtml(content, template, options = {}) {
  const includeVivaTitle = options.includeVivaTitle === true;
  const typedConclusion = options.typedConclusion !== false;
  const t = template?.template ?? {};
  const conclusionHtml = typedConclusion
    ? `<p>${escapeHtml(content.conclusion)}</p>`
    : `<div class="handwrite"></div>`;
  const vivaHtml = includeVivaTitle ? `<h2>Viva Questions</h2>\n    <div class="handwrite"></div>` : "";
  const page = t.page ?? {};
  const margin = page.margin ?? {};
  const typo = t.typography ?? {};
  const header = t.header ?? {};
  const watermark = t.watermark ?? {};
  const footer = t.footer ?? {};
  // Footer = tenant text (optional) + bare page number (no "Page " prefix —
  // the same bare 1/2/3 the LaTeX renderer prints via \thepage).
  const pageNumHtml = footer.showPageNumber ? '<span class="pagenum"></span>' : "";
  const footerHtml = [escapeHtml(footer.text ?? ""), pageNumHtml].filter(Boolean).join(" &nbsp;|&nbsp; ");

  // Asset refs are URL paths served by the API (/assets/*). Existence is
  // resolved SERVER-SIDE (resolveAsset) so the document carries no inline
  // event handlers — helmet's CSP (script-src-attr 'none') would block them
  // in the preview iframe anyway. Missing artwork renders the same labeled
  // placeholder box in the same position.
  const headerMissing = header.image?.startsWith("/assets/") && !resolveAsset(header.image);
  const watermarkMissing = watermark.image?.startsWith("/assets/") && !resolveAsset(watermark.image);
  const headerImg = header.image
    ? headerMissing
      ? `<div class="doc-header-missing">[header artwork missing: ${escapeHtml(header.image)}]</div>`
      : `<img class="doc-header-img" src="${escapeHtml(header.image)}" alt="${escapeHtml(header.alt ?? "Header")}" />`
    : "";
  const watermarkImg = watermark.image
    ? watermarkMissing
      ? ""
      : `<img class="watermark-img" src="${escapeHtml(watermark.image)}" alt="${escapeHtml(watermark.alt ?? "Watermark")}" />`
    : `<div class="watermark-missing">[watermark artwork missing]</div>`;

  const expNo = content.experimentNumber ? `Experiment No. ${escapeHtml(content.experimentNumber)}` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(content.title)}</title>
<style>
  @page { size: ${escapeHtml(page.size ?? "A4")}; margin: 0; }
  * { box-sizing: border-box; }
  body {
    font-family: ${typo.fontFamily ?? "Georgia, 'Times New Roman', serif"};
    font-size: ${typo.baseSize ?? "12pt"};
    line-height: ${typo.lineHeight ?? 1.6};
    color: #111;
    margin: 0;
    padding: 0;
  }
  /* Fixed elements repeat on EVERY printed page (Chrome/Edge print + PDF). */
  .doc-header {
    position: fixed; top: 0; left: 0; right: 0;
    padding: 10px 18mm 8px 18mm;
    border-bottom: 2px solid #1a3a7c;
    background: #fff;
  }
  .doc-header-img { display: block; width: 100%; height: ${escapeHtml(header.height ?? "72px")}; object-fit: contain; }
  .doc-header-missing { border: 1px dashed #999; color: #777; text-align: center; padding: 14px; font-size: 10pt; }
  .watermark {
    position: fixed; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    opacity: ${WATERMARK_OPACITY};
    pointer-events: none;
    z-index: 0;
    text-align: center;
  }
  .watermark-img { width: 320px; max-width: 60%; }
  .watermark-missing { border: 1px dashed #999; color: #777; padding: 40px 60px; font-size: 10pt; }
  .doc-footer {
    position: fixed; bottom: 0; left: 0; right: 0;
    padding: 6px 18mm;
    font-size: 9pt; color: #444; text-align: center;
    border-top: 1px solid #ccc; background: #fff;
  }
  .doc-footer .pagenum::after { counter-increment: page; content: counter(page); }
  .page-frame {
    position: fixed; top: 10mm; right: 10mm; bottom: 10mm; left: 10mm;
    border: 1.5px solid #111; pointer-events: none; z-index: 2;
  }
  .faculty { width: 100%; border-collapse: collapse; margin-top: 8px; }
  .faculty th, .faculty td { border: 1px solid #333; padding: 6px 8px; font-size: 10.5pt; text-align: left; vertical-align: top; }
  .faculty td { height: 44px; }
  .handwrite { height: 140px; }
  main {
    position: relative; z-index: 1;
    padding: ${escapeHtml(margin.top ?? "110px")} ${escapeHtml(margin.right ?? "18mm")} ${escapeHtml(margin.bottom ?? "20mm")} ${escapeHtml(margin.left ?? "18mm")};
  }
  h1 { font-size: 17pt; text-align: center; margin: 0 0 4px 0; }
  .exp-no { text-align: center; font-weight: bold; margin-bottom: 12px; }
  h2 { font-size: 13pt; border-bottom: 1px solid #333; padding-bottom: 2px; margin-top: 22px; }
  .aim-box { border: 1px solid #333; padding: 8px 12px; }
  pre.code { background: #f4f4f4; border: 1px solid #ccc; padding: 8px; overflow-x: auto; font-size: 10pt; }
  @media screen { body { background: #e8e8e8; } main, .doc-header, .doc-footer { max-width: 210mm; margin-left: auto; margin-right: auto; } }
</style>
</head>
<body>
  <div class="page-frame"></div>
  <div class="doc-header">${headerImg}</div>
  <div class="watermark">${watermarkImg}</div>
  <div class="doc-footer">${footerHtml}</div>
  <main>
    <h1>${escapeHtml(content.title)}</h1>
    ${expNo ? `<div class="exp-no">${expNo}</div>` : ""}
    <h2>Aim</h2>
    <div class="aim-box">${escapeHtml(content.aim)}</div>
    <h2>Objectives</h2>
    ${sectionList(content.objectives)}
    <h2>Theory</h2>
    ${content.theory.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n    ")}
    <h2>Steps</h2>
    ${stepsList(content.steps)}
    <h2>Conclusion</h2>
    ${conclusionHtml}
    ${vivaHtml}
    ${facultyTable(t)}
  </main>
</body>
</html>`;
}
