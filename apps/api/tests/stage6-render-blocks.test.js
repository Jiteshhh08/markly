// STAGE 6 — saved block body drives every renderer.
//
// These tests are renderer-level (no Mongo): they prove that HTML, DOCX and
// LaTeX consume the same saved `document.blocks` order/text/styles, that
// template presentation remains locked, and that legacy content-only records
// still render. The companion route test covers exact template versions and
// the LaTeX override workflow.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";

import { renderHtml } from "../src/render/html.js";
import { escapeLatex, renderLatex } from "../src/render/latex.js";
import { renderDocx } from "../src/render/docx.js";
import { getDefaultTemplate } from "../src/lib/templates.js";

const LEGACY_CONTENT = {
  experimentNumber: 7,
  title: "LEGACY TITLE MUST NOT RENDER",
  aim: "LEGACY AIM MUST NOT RENDER",
  objectives: ["LEGACY OBJECTIVE MUST NOT RENDER"],
  theory: ["LEGACY THEORY MUST NOT RENDER"],
  steps: [
    {
      number: 1,
      title: "LEGACY STEP MUST NOT RENDER",
      description: ["LEGACY DESCRIPTION MUST NOT RENDER"],
      code: "LEGACY CODE MUST NOT RENDER",
      language: "sql",
    },
  ],
  conclusion: "LEGACY CONCLUSION MUST NOT RENDER",
  metadata: {},
};

const SAVED_BLOCKS = [
  {
    id: "s6-title",
    type: "title",
    content: { text: "STAGE6 TITLE EDITED" },
    style: { align: "center", fontSize: 28 },
  },
  {
    id: "s6-experiment",
    type: "experimentNumber",
    content: { text: "Experiment No. 99" },
  },
  {
    id: "s6-heading",
    type: "heading",
    content: { text: "STAGE6 HEADING ONE" },
  },
  {
    id: "s6-paragraph",
    type: "paragraph",
    content: { text: "STAGE6 PARAGRAPH BODY" },
    style: {
      align: "justify",
      fontSize: 17,
      lineHeight: 1.85,
      spacingBefore: 14,
      spacingAfter: 18,
      indent: 22,
    },
  },
  {
    id: "s6-bullets",
    type: "bulletList",
    content: { items: ["STAGE6 BULLET ALPHA", "STAGE6 BULLET BETA"] },
  },
  {
    id: "s6-numbers",
    type: "numberedList",
    content: { items: ["STAGE6 NUMBER ALPHA", "STAGE6 NUMBER BETA"] },
  },
  {
    id: "s6-code",
    type: "code",
    content: {
      text: "def solve(value):\n    if value:\n\treturn value\n    return 0",
      language: "python",
    },
  },
  { id: "s6-break", type: "pageBreak", content: {} },
  { id: "s6-spacer", type: "spacer", content: { height: 64 } },
  {
    id: "s6-subheading",
    type: "subheading",
    content: { text: "STAGE6 SUBHEADING" },
  },
  {
    id: "s6-after-break",
    type: "paragraph",
    content: { text: "STAGE6 AFTER BREAK" },
  },
  {
    id: "s6-unsafe",
    type: "paragraph",
    content: { text: 'STAGE6 UNSAFE <script>alert("x")</script>' },
  },
];

function savedRecord(blocks = SAVED_BLOCKS, overrides = {}) {
  return {
    content: LEGACY_CONTENT,
    document: { schemaVersion: 2, revision: 7, blocks },
    ...overrides,
  };
}

async function docxParts(source, template = getDefaultTemplate()) {
  const buffer = Buffer.from(await renderDocx(source, template));
  const zip = await JSZip.loadAsync(buffer);
  const read = async (name) => {
    const file = zip.file(name);
    return file ? file.async("string") : "";
  };
  return {
    buffer,
    zip,
    documentXml: await read("word/document.xml"),
    headerXml: await read("word/header1.xml"),
    footerXml: await read("word/footer1.xml"),
    numberingXml: await read("word/numbering.xml"),
    stylesXml: await read("word/styles.xml"),
  };
}

function decodeXml(value) {
  return String(value)
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function docxText(xml) {
  return [...xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXml(match[1]))
    .join("\n");
}

function assertOrder(haystack, markers, label) {
  let last = -1;
  for (const marker of markers) {
    const index = haystack.indexOf(marker);
    assert.ok(index >= 0, `${label}: missing marker ${JSON.stringify(marker)}`);
    assert.ok(index > last, `${label}: marker ${JSON.stringify(marker)} is out of order`);
    last = index;
  }
}

function paragraphContaining(xml, marker) {
  for (const match of xml.matchAll(/<w:p>[\s\S]*?<\/w:p>/g)) {
    if (match[0].includes(marker)) return match[0];
  }
  return "";
}

function countOccurrences(haystack, marker) {
  return haystack.split(marker).length - 1;
}

const ORDER_MARKERS = [
  "STAGE6 TITLE EDITED",
  "Experiment No. 99",
  "STAGE6 HEADING ONE",
  "STAGE6 PARAGRAPH BODY",
  "STAGE6 BULLET ALPHA",
  "STAGE6 BULLET BETA",
  "STAGE6 NUMBER ALPHA",
  "STAGE6 NUMBER BETA",
  "def solve(value):",
  "    if value:",
  "\treturn value",
  "    return 0",
  "STAGE6 SUBHEADING",
  "STAGE6 AFTER BREAK",
  "STAGE6 UNSAFE",
];

describe("STAGE 6 saved block traversal", () => {
  it("uses the saved block order and edited text in HTML, LaTeX and DOCX", async () => {
    const source = savedRecord();
    const html = renderHtml(source, getDefaultTemplate());
    const tex = renderLatex(source, getDefaultTemplate());
    const { documentXml } = await docxParts(source);
    const docx = docxText(documentXml);

    assertOrder(html, ORDER_MARKERS, "HTML");
    assertOrder(tex, ORDER_MARKERS, "LaTeX");
    assertOrder(docx, ORDER_MARKERS, "DOCX");

    for (const legacy of [
      "LEGACY TITLE MUST NOT RENDER",
      "LEGACY AIM MUST NOT RENDER",
      "LEGACY OBJECTIVE MUST NOT RENDER",
      "LEGACY THEORY MUST NOT RENDER",
      "LEGACY STEP MUST NOT RENDER",
      "LEGACY DESCRIPTION MUST NOT RENDER",
      "LEGACY CODE MUST NOT RENDER",
      "LEGACY CONCLUSION MUST NOT RENDER",
    ]) {
      assert.ok(!html.includes(legacy), `HTML leaked legacy content: ${legacy}`);
      assert.ok(!tex.includes(legacy), `LaTeX leaked legacy content: ${legacy}`);
      assert.ok(!docx.includes(legacy), `DOCX leaked legacy content: ${legacy}`);
    }

    assert.ok(html.includes("<h1"), "saved title must be a heading");
    assert.ok(html.includes("<h2>STAGE6 HEADING ONE</h2>"), "saved heading missing");
    assert.ok(html.includes("<h3>STAGE6 SUBHEADING</h3>"), "saved subheading missing");
    assert.ok(html.includes("<ul"), "saved bullet list missing");
    assert.ok(html.includes("<ol"), "saved numbered list missing");
    assert.ok(html.includes('<div class="page-break"'), "saved page break missing");
    assert.ok(html.includes('<div class="spacer" style="height: 64px"'), "saved spacer missing");
  });

  it("honors saved formatting in HTML and escapes untrusted block text", () => {
    const html = renderHtml(savedRecord(), getDefaultTemplate());

    assert.ok(
      html.includes(
        'style="text-align: justify; font-size: 17px; line-height: 1.85; margin-top: 14px; margin-bottom: 18px; margin-left: 22px"',
      ),
      "paragraph formatting must come from the saved block style",
    );
    assert.ok(
      html.includes('<h1 style="text-align: center; font-size: 28px">STAGE6 TITLE EDITED</h1>'),
      "title formatting must come from the saved block style",
    );
    assert.ok(html.includes('<pre class="code" data-language="python">'), "code language missing");
    assert.ok(html.includes("STAGE6 UNSAFE &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
    assert.ok(!html.includes('<script>alert("x")</script>'), "raw block text must never become markup");
  });

  it("honors saved formatting, code indentation, page breaks and escaping in LaTeX", () => {
    const tex = renderLatex(savedRecord(), getDefaultTemplate());

    assert.ok(
      tex.includes("\\fontsize{12.75pt}{23.59pt}\\selectfont"),
      "saved font size and line height must reach LaTeX",
    );
    assert.ok(tex.includes("\\begin{center}"), "saved center alignment missing");
    assert.ok(
      tex.includes("\\begin{adjustwidth}{16.5pt}{0pt}"),
      "saved indentation missing",
    );
    assert.ok(tex.includes("\\vspace*{10.5pt}"), "saved space-before missing");
    assert.ok(tex.includes("\\vspace{13.5pt}"), "saved space-after missing");
    assert.ok(tex.includes("\\begin{lstlisting}"), "code must use listings");
    assert.ok(tex.includes("    if value:"), "leading code spaces must survive");
    assert.ok(tex.includes("\treturn value"), "code tabs must survive");
    assert.ok(tex.includes("\\newpage"), "saved page break missing");
    assert.ok(tex.includes("\\vspace*{48pt}"), "saved 64px spacer missing");
    assert.ok(tex.includes("STAGE6 UNSAFE <script>"), "LaTeX must preserve text content");
    assert.ok(!tex.includes("\\begin{verbatim}"), "verbatim must not be used for code");
    assert.equal(
      escapeLatex(String.raw`C:\temp {x} 50% & $5 #1 _x_ ^ ~`),
      String.raw`C:\textbackslash{}temp \{x\} 50\% \& \$5 \#1 \_x\_ \textasciicircum{} \textasciitilde{}`,
      "escaping must not re-escape the braces of replacement commands",
    );
  });

  it("honors saved formatting, code lines, headings, page breaks and page settings in DOCX", async () => {
    const { documentXml, headerXml, footerXml } = await docxParts(savedRecord());

    assert.ok(
      documentXml.includes('w:pgSz w:w="11906" w:h="16838" w:orient="portrait"'),
      "template page size must serialize",
    );
    assert.ok(
      documentXml.includes('w:pgMar w:top="2980" w:right="1020" w:bottom="1134" w:left="1020"'),
      "template margins must serialize (top clears the locked header)",
    );
    assert.ok(
      documentXml.includes('w:pgBorders w:display="allPages" w:offsetFrom="page"'),
      "template page border must serialize",
    );
    assert.ok(
      documentXml.includes('<w:top w:val="single" w:color="111111" w:sz="9" w:space="28"/>'),
      "template page border geometry/color must serialize",
    );

    const headingParagraph = paragraphContaining(documentXml, "STAGE6 HEADING ONE");
    assert.ok(headingParagraph.includes("<w:keepNext/>"), "headings must keep with following content");
    assert.ok(headingParagraph.includes("<w:keepLines/>"), "headings must not split across pages");
    assert.ok(headingParagraph.includes('w:outlineLvl w:val="1"'), "heading outline level missing");
    assert.ok(headingParagraph.includes("<w:b/>"), "headings must remain bold");

    const paragraph = paragraphContaining(documentXml, "STAGE6 PARAGRAPH BODY");
    assert.ok(paragraph.includes('w:jc w:val="both"'), "saved justify alignment missing");
    assert.ok(
      paragraph.includes('w:spacing w:after="270" w:before="210" w:line="444" w:lineRule="auto"'),
      "saved paragraph spacing/line height missing",
    );
    assert.ok(paragraph.includes('w:ind w:left="330"'), "saved paragraph indentation missing");
    assert.ok(paragraph.includes('w:sz w:val="26"'), "saved font size missing");

    assert.equal(
      countOccurrences(documentXml, 'w:ascii="Consolas"'),
      4,
      "each code line must be its own monospaced run",
    );
    for (const line of ["def solve(value):", "    if value:", "\treturn value", "    return 0"]) {
      assert.ok(
        documentXml.includes(`<w:t xml:space="preserve">${line}</w:t>`),
        `code line must preserve whitespace: ${JSON.stringify(line)}`,
      );
    }
    assert.ok(
      documentXml.includes('w:lineRule="exact"'),
      "code lines must use exact line spacing",
    );
    assert.ok(documentXml.includes('<w:br w:type="page"/>'), "saved page break missing");
    assert.ok(
      documentXml.indexOf("STAGE6 AFTER BREAK") < documentXml.indexOf("For Faculty Use"),
      "saved content must precede the locked faculty table",
    );
    assert.ok(
      documentXml.indexOf("STAGE6 UNSAFE") < documentXml.indexOf("For Faculty Use"),
      "the last saved block must precede the faculty table",
    );

    assert.ok(headerXml.includes('relativeFrom="page"'), "header artwork must anchor to the page");
    assert.ok(headerXml.includes("<wp:posOffset>360000</wp:posOffset>"), "header x offset missing");
    assert.ok(headerXml.includes("<wp:posOffset>468000</wp:posOffset>"), "header y offset missing");
    assert.ok(headerXml.includes('behindDoc="1"'), "header artwork must sit behind document text");
    assert.ok(headerXml.includes('gain="19661f"'), "watermark washout gain missing");
    assert.ok(headerXml.includes('blacklevel="22938f"'), "watermark washout black level missing");
    assert.ok(headerXml.includes("width:237.75pt"), "watermark must use 40% page width");
    assert.ok(footerXml.includes('<w:instrText xml:space="preserve">PAGE</w:instrText>'));
  });

  it("serializes template page size, margins, orientation, border and typography in DOCX", async () => {
    const template = {
      template: {
        page: {
          size: "A5",
          orientation: "landscape",
          margin: { top: "24mm", right: "16mm", bottom: "18mm", left: "20mm" },
          border: { style: "double", width: "2px", color: "#224466" },
        },
        typography: { fontFamily: "Arial, sans-serif", baseSize: "14pt", lineHeight: 1.4 },
        footer: { text: "Landscape footer", showPageNumber: true },
      },
    };
    const source = savedRecord(
      [{ id: "s6-landscape", type: "paragraph", content: { text: "STAGE6 LANDSCAPE" } }],
      { content: { title: "x" } },
    );
    const { documentXml, stylesXml, footerXml } = await docxParts(source, template);

    assert.ok(
      documentXml.includes('w:pgSz w:w="11906" w:h="8391" w:orient="landscape"'),
      "A5 landscape page size must not be swapped twice",
    );
    assert.ok(
      documentXml.includes('w:pgMar w:top="1361" w:right="907" w:bottom="1020" w:left="1134"'),
      "template margins must be used exactly",
    );
    assert.ok(
      documentXml.includes(
        '<w:pgBorders w:display="allPages" w:offsetFrom="page"><w:top w:val="double" w:color="224466" w:sz="12" w:space="28"/>',
      ),
      "template border style/color/width missing",
    );
    assert.ok(
      stylesXml.includes('<w:rFonts w:ascii="Arial" w:cs="Arial" w:eastAsia="Arial" w:hAnsi="Arial"/>'),
      "template font must become the DOCX default",
    );
    assert.ok(stylesXml.includes('<w:sz w:val="28"/>'), "template base size must become the DOCX default");
    assert.ok(stylesXml.includes('<w:spacing w:line="336" w:lineRule="auto"/>'));
    assert.ok(footerXml.includes("Landscape footer"));
  });

  it("keeps template artwork, footer and border locked across every renderer", async () => {
    const template = getDefaultTemplate();
    template.template.assets = { logo: "/assets/tcet-header.png", logoAlt: "Locked logo" };
    template.template.footer = { text: "STAGE6 TEMPLATE FOOTER", showPageNumber: true };
    template.template.typography = {
      fontFamily: "Arial, sans-serif",
      baseSize: "13pt",
      lineHeight: 1.5,
    };

    const source = savedRecord();
    const html = renderHtml(source, template);
    const tex = renderLatex(source, template);
    const { headerXml, footerXml, documentXml, zip } = await docxParts(source, template);

    assert.ok(!documentXml.includes("STAGE6 TEMPLATE FOOTER"), "footer text must not leak into body content");
    assert.ok(html.includes('class="doc-logo"'), "locked logo missing from HTML");
    assert.ok(html.includes('class="doc-header-img"'), "locked header missing from HTML");
    assert.ok(html.includes('class="watermark-img"'), "locked watermark missing from HTML");
    assert.ok(html.includes('class="page-frame"'), "locked border missing from HTML");
    assert.ok(html.includes("STAGE6 TEMPLATE FOOTER"), "locked footer missing from HTML");
    assert.ok(html.includes("width: 84mm"), "HTML watermark must be 40% of page width");
    assert.ok(html.includes("font-family: Arial, sans-serif"), "template font missing from HTML");

    assert.ok(tex.includes("header.jpg"), "locked header missing from LaTeX");
    assert.ok(tex.includes("watermark.png"), "locked watermark missing from LaTeX");
    assert.ok(tex.includes("logo.jpg"), "locked logo missing from LaTeX");
    assert.ok(tex.includes("STAGE6 TEMPLATE FOOTER"), "locked footer missing from LaTeX");
    assert.ok(tex.includes("width=0.4\\paperwidth"), "LaTeX watermark must be 40% of page width");
    assert.ok(tex.includes("\\IfFileExists{helvet.sty}"), "template sans font must be selected");

    assert.ok(headerXml.includes("<wp:anchor"), "locked header/logo must be in the DOCX header");
    assert.equal(
      countOccurrences(headerXml, "<wp:anchor"),
      2,
      "DOCX header must contain both the banner and the logo",
    );
    assert.ok(headerXml.includes('gain="19661f"'), "locked watermark missing from DOCX header");
    assert.ok(footerXml.includes("STAGE6 TEMPLATE FOOTER"), "locked footer missing from DOCX footer");
    assert.ok(!headerXml.includes("STAGE6 TITLE EDITED"), "saved body must not replace header artwork");
    assert.ok(!footerXml.includes("STAGE6 TITLE EDITED"), "saved body must not replace footer text");
    const media = zip.file(/word\/media\//) ?? [];
    assert.ok(media.length >= 2, "DOCX must package banner/logo and watermark media");
    assert.ok(headerXml.includes("<v:imagedata"), "DOCX watermark must be a VML image");
  });

  it("renders legacy content-only records when no saved blocks exist", async () => {
    const source = { content: LEGACY_CONTENT };
    const html = renderHtml(source, getDefaultTemplate());
    const tex = renderLatex(source, getDefaultTemplate());
    const { documentXml } = await docxParts(source);
    const docx = docxText(documentXml);

    for (const output of [html, tex, docx]) {
      assert.ok(output.includes("LEGACY TITLE MUST NOT RENDER"));
      assert.ok(output.includes("LEGACY AIM MUST NOT RENDER"));
      assert.ok(output.includes("LEGACY OBJECTIVE MUST NOT RENDER"));
      assert.ok(output.includes("LEGACY THEORY MUST NOT RENDER"));
      assert.ok(output.includes("LEGACY STEP MUST NOT RENDER"));
      assert.ok(output.includes("LEGACY CODE MUST NOT RENDER"));
      assert.ok(output.includes("LEGACY CONCLUSION MUST NOT RENDER"));
    }
    assertOrder(
      html,
      ["Aim", "Objectives", "Theory", "Steps", "Conclusion"],
      "legacy HTML",
    );
    assertOrder(tex, ["Aim", "Objectives", "Theory", "Steps", "Conclusion"], "legacy LaTeX");
    assertOrder(
      docx,
      ["Aim", "Objectives", "Theory", "Steps", "Conclusion"],
      "legacy DOCX",
    );
  });

  it("preserves every block in short and long saved documents", async () => {
    const shortSource = savedRecord(
      [{ id: "s6-short", type: "paragraph", content: { text: "STAGE6 SHORT ONLY" } }],
      { content: { title: "x" } },
    );
    const shortHtml = renderHtml(shortSource, getDefaultTemplate());
    const shortTex = renderLatex(shortSource, getDefaultTemplate());
    const shortDocx = docxText((await docxParts(shortSource)).documentXml);
    for (const output of [shortHtml, shortTex, shortDocx]) {
      assert.equal(countOccurrences(output, "STAGE6 SHORT ONLY"), 1);
    }

    const longBlocks = [];
    for (let index = 1; index <= 160; index += 1) {
      const marker = `STAGE6 LONG ${String(index).padStart(3, "0")}`;
      longBlocks.push(
        index % 2 === 0
          ? { id: `s6-long-${index}`, type: "paragraph", content: { text: marker } }
          : { id: `s6-long-${index}`, type: "heading", content: { text: marker } },
      );
      if (index % 40 === 0) {
        longBlocks.push({
          id: `s6-long-break-${index}`,
          type: "pageBreak",
          content: {},
        });
      }
    }
    const longSource = savedRecord(longBlocks, { content: { title: "x" } });
    const longHtml = renderHtml(longSource, getDefaultTemplate());
    const longTex = renderLatex(longSource, getDefaultTemplate());
    const { documentXml: longDocumentXml } = await docxParts(longSource);
    const longDocx = docxText(longDocumentXml);
    const markers = longBlocks
      .filter((block) => block.type !== "pageBreak")
      .map((block) => block.content.text);

    assert.equal(markers.length, 160);
    for (const output of [longHtml, longTex, longDocx]) {
      assertOrder(output, markers, "long document");
      for (const marker of markers) {
        assert.equal(countOccurrences(output, marker), 1, `${marker} must appear exactly once`);
      }
    }
    assert.equal(countOccurrences(longHtml, 'class="page-break"'), 4);
    assert.equal(countOccurrences(longTex, "\\newpage"), 4);
    assert.equal(countOccurrences(longDocumentXml, '<w:br w:type="page"/>'), 4);
  });
});
