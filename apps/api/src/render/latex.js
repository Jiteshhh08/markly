import {
  WATERMARK_OPACITY,
  artworkLayout,
  blockStyle,
  buildRenderNodes,
  codeLanguage,
  facultyTableData,
  formatNumber,
  pageGeometry,
  pxToPt,
  safeHexColor,
  typographyConfig,
} from "./renderModel.js";

// LaTeX renderer (Stage 6).
//
// The saved `document.blocks` body controls order, edited text and supported
// formatting. Template fields remain locked presentation: page geometry,
// header/logo/watermark/footer, page border and typography defaults.
// Compile ONLY inside an isolated container (see lib/compile.js), never host pdflatex.

const LATEX_LANGUAGES = Object.freeze({
  sql: "SQL",
  javascript: "JavaScript",
  js: "JavaScript",
  typescript: "Java",
  ts: "Java",
  python: "Python",
  py: "Python",
  java: "Java",
  c: "C",
  "c++": "C++",
  cpp: "C++",
  csharp: "C#",
  "c#": "C#",
  html: "HTML",
  css: "CSS",
  php: "PHP",
  ruby: "Ruby",
  bash: "bash",
  sh: "bash",
  shell: "bash",
  go: "Go",
  rust: "Rust",
  json: "JSON",
  xml: "XML",
});

const LATEX_ESCAPES = Object.freeze({
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  "$": "\\$",
  "&": "\\&",
  "%": "\\%",
  "#": "\\#",
  _: "\\_",
  "^": "\\textasciicircum{}",
  "~": "\\textasciitilde{}",
});

export function escapeLatex(value) {
  // Single-pass replacement: escaping a backslash first and then escaping the
  // braces of \textbackslash{} would turn one backslash into three glyphs.
  return String(value ?? "").replace(/[\\{}$&%#_^~]/g, (character) => LATEX_ESCAPES[character]);
}

function safeVerbatim(code) {
  return String(code ?? "").replaceAll("\\end{lstlisting}", "END LISTING");
}

function pt(px) {
  return `${formatNumber(pxToPt(px), 2)}pt`;
}

function wrapBlock(style, content, { font = true, par = true } = {}) {
  if (!content) return "";
  let body = content;
  if (font) {
    const size = formatNumber(style.fontSizePt, 2);
    const baseline = formatNumber(style.fontSizePt * style.lineHeight, 2);
    body = `{\\fontsize{${size}pt}{${baseline}pt}\\selectfont ${body}}`;
  }
  if (par && !body.endsWith("\\par")) body = `${body}\\par`;
  if (style.align === "center") {
    body = `\\begin{center}\n${body}\n\\end{center}`;
  } else if (style.align === "right") {
    body = `\\begin{flushright}\n${body}\n\\end{flushright}`;
  } else if (style.align === "left") {
    body = `{\\raggedright\n${body}\\par}`;
  }
  if (style.indentPx > 0) {
    body = `\\begin{adjustwidth}{${pt(style.indentPx)}}{0pt}\n${body}\n\\end{adjustwidth}`;
  }
  const before = style.spacingBeforePx > 0 ? `\\vspace*{${pt(style.spacingBeforePx)}}` : "";
  const after = style.spacingAfterPx > 0 ? `\\vspace{${pt(style.spacingAfterPx)}}` : "";
  return [before, body, after].filter(Boolean).join("\n");
}

function listBlock(block, style) {
  const items = Array.isArray(block.content?.items) ? block.content.items : [];
  if (!items.length) return "";
  const env = block.type === "numberedList" ? "enumerate" : "itemize";
  const body = `\\begin{${env}}\n${items
    .map((item) => `  \\item ${escapeLatex(item)}`)
    .join("\n")}\n\\end{${env}}`;
  return wrapBlock(style, body, { par: false });
}

function codeBlock(block, style) {
  const text = String(block.content?.text ?? "");
  if (!text) return "";
  const language = codeLanguage(block);
  const options = [
    `basicstyle=\\ttfamily\\fontsize{${formatNumber(style.fontSizePt, 2)}pt}{${formatNumber(style.fontSizePt * style.lineHeight, 2)}pt}\\selectfont`,
  ];
  const mapped = LATEX_LANGUAGES[language.toLowerCase()];
  if (mapped) options.push(`language=${mapped}`);
  const body = `\\begin{lstlisting}[${options.join(",")}]\n${safeVerbatim(text)}\n\\end{lstlisting}`;
  return wrapBlock(style, body, { font: false, par: false });
}

function latexBlock(block, template) {
  if (block.type === "pageBreak") return "\\newpage";
  if (block.type === "handwrite") return "\\vspace{45mm}";
  if (block.type === "spacer") {
    const height = Number.isFinite(block.content?.height) ? block.content.height : 24;
    return `\\vspace*{${pt(height)}}`;
  }
  if (block.type === "bulletList" || block.type === "numberedList") {
    return listBlock(block, blockStyle(block, template));
  }
  if (block.type === "code") {
    return codeBlock(block, blockStyle(block, template));
  }

  const style = blockStyle(block, template);
  const text = escapeLatex(block.content?.text ?? "");
  if (!text) return "";

  if (block.internal === "vivaHeading") {
    return "\\section*{Viva Questions}";
  }
  if (block.type === "title") {
    return wrapBlock(style, `{\\bfseries ${text}}`);
  }
  if (block.type === "experimentNumber") {
    if (!block.style || Object.keys(block.style).length === 0) {
      return `\\begin{center}\n{\\large ${text}}\n\\end{center}\n\\vspace{9pt}`;
    }
    return wrapBlock(style, text);
  }
  if (block.type === "heading") {
    return wrapBlock(style, `\\noindent{\\bfseries ${text}}`);
  }
  if (block.type === "subheading") {
    return wrapBlock(style, `\\noindent{\\bfseries ${text}}`);
  }
  if (block.type === "paragraph") {
    return wrapBlock(style, `\\noindent ${text}`);
  }
  return "";
}

function facultyTable(template) {
  const data = facultyTableData(template);
  if (!data) return "";
  const n = data.columns.length;
  const col = `p{${(0.9 / n).toFixed(3)}\\textwidth}`;
  const spec = `|${Array(n).fill(col).join("|")}|`;
  const head = `${data.columns.map((c) => `\\textbf{${escapeLatex(c)}}`).join(" & ")} \\\\ \\hline`;
  const rows = data.rows
    .map((row) => {
      const cells = data.columns.map((_, index) => {
        const value = escapeLatex(row[index] ?? "");
        return value || "\\rule{0pt}{14mm}";
      });
      return `${cells.join(" & ")} \\\\ \\hline`;
    })
    .join("\n");
  return `\\vfill
{\\bfseries ${escapeLatex(data.title)}}\\\\[2mm]
\\begin{center}
{\\small\\begin{tabular}{${spec}}
\\hline
${head}
${rows}
\\end{tabular}}
\\end{center}`;
}

function borderOptions(border) {
  if (!border) return "";
  const options = [`line width=${formatNumber(border.widthPt, 3)}pt`, "draw=docborder"];
  if (border.style === "double") options.push("double");
  if (border.style === "dashed") options.push("dash pattern=on 4pt off 2pt");
  if (border.style === "dotted") options.push("dash pattern=on 1pt off 2pt");
  return options.join(",");
}

export function renderLatex(source, template, options = {}) {
  const model = buildRenderNodes(source, template, options);
  const t = model.template;
  const geometry = pageGeometry(t);
  const typography = typographyConfig(t);
  const art = artworkLayout(t, geometry);
  const border = geometry.border;
  const footer = t.footer ?? {};
  const showPageNumber = footer.showPageNumber === true;
  const footerText = String(footer.text ?? "").trim();
  const footerCommand = showPageNumber
    ? footerText
      ? `\\fancyfoot[C]{${escapeLatex(footerText)}\\quad\\thepage}`
      : "\\fancyfoot[C]{\\thepage}"
    : footerText
      ? `\\fancyfoot[C]{${escapeLatex(footerText)}}`
      : "\\fancyfoot[C]{}";
  const borderColor = safeHexColor(border?.color ?? "#111111").slice(1).toUpperCase();
  const body = model.blocks.map((block) => latexBlock(block, t)).filter(Boolean).join("\n\n");
  const hasSansFont = /arial|helvetica|sans/i.test(typography.fontFamily);

  return `\\documentclass[12pt]{article}
\\usepackage[paperwidth=${formatNumber(geometry.width, 2)}mm,paperheight=${formatNumber(geometry.height, 2)}mm,left=${formatNumber(geometry.margin.left, 2)}mm,right=${formatNumber(geometry.margin.right, 2)}mm,top=${formatNumber(geometry.margin.top, 2)}mm,bottom=${formatNumber(geometry.margin.bottom, 2)}mm,headheight=12pt,headsep=6mm]{geometry}
\\usepackage{graphicx}
\\usepackage{fancyhdr}
\\usepackage{eso-pic}
\\usepackage{tikz}
\\usepackage{listings}
\\usepackage{changepage}
\\usepackage{hyperref}
${
  hasSansFont
    ? "\\IfFileExists{helvet.sty}{\\usepackage{helvet}\\renewcommand{\\familydefault}{\\sfdefault}}{}"
    : "\\IfFileExists{mathptmx.sty}{\\usepackage{mathptmx}}{}"
}
\\lstset{basicstyle=\\ttfamily\\small,breaklines=true,breakatwhitespace=true,columns=fullflexible,keepspaces=true}
\\linespread{${formatNumber(typography.lineHeight / 1.2, 3)}}\\selectfont
\\pagestyle{fancy}
\\fancyhf{}
\\fancyhead[C]{}
${footerCommand}
\\definecolor{docborder}{HTML}{${borderColor}}
\\AddToShipoutPictureBG{%
\\begin{tikzpicture}[remember picture,overlay]
${
  border
    ? `\\draw[${borderOptions(border)}] ([xshift=${geometry.frameInset}mm,yshift=-${geometry.frameInset}mm]current page.north west) rectangle ([xshift=-${geometry.frameInset}mm,yshift=${geometry.frameInset}mm]current page.south east);`
    : ""
}
${
  art.watermark
    ? `\\node[opacity=${WATERMARK_OPACITY}] at (current page.center) {\\includegraphics[width=0.4\\paperwidth,keepaspectratio]{${art.watermark.name}}};`
    : ""
}
${
  art.header
    ? `\\node[anchor=north] at ([yshift=-${formatNumber(art.header.yMm, 2)}mm]current page.north) {\\includegraphics[width=${formatNumber(art.header.widthMm, 2)}mm,keepaspectratio]{${art.header.name}}};`
    : ""
}
${
  art.logo
    ? `\\node[anchor=north west] at ([xshift=${formatNumber(art.logo.xMm, 2)}mm,yshift=-${formatNumber(art.logo.yMm, 2)}mm]current page.north west) {\\includegraphics[height=${formatNumber(art.logo.heightMm, 2)}mm,keepaspectratio]{${art.logo.name}}};`
    : ""
}
\\end{tikzpicture}%
}
\\begin{document}
\\fontsize{${formatNumber(typography.baseSizePt, 2)}pt}{${formatNumber(typography.baseSizePt * typography.lineHeight, 2)}pt}\\selectfont
${body}

${facultyTable(t)}
\\end{document}
`;
}
