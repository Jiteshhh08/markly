import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderHtml, escapeHtml, WATERMARK_OPACITY } from "../src/render/html.js";
import { getDefaultTemplate, getTemplate } from "../src/lib/templates.js";

const doc = {
  experimentNumber: 7,
  title: "Exploring subqueries in SQL",
  aim: "Explore subqueries in SQL",
  objectives: ["Understand scalar and correlated subqueries"],
  theory: ["A subquery is a query nested inside another query with context."],
  steps: [
    { number: 1, title: "Setup", description: ["Create sample tables."], code: null, language: null },
  ],
  conclusion: "Subqueries were explored and observed outputs recorded.",
  metadata: {},
};

describe("tenant templates", () => {
  it("ships a default template with header + watermark config", () => {
    const seed = getDefaultTemplate();
    assert.ok(seed, "expected a default template seed");
    assert.equal(seed.template.header.everyPage, true);
    assert.equal(seed.template.watermark.everyPage, true);
    assert.ok(getTemplate(seed.template.id), "template lookup by id works");
  });
});

describe("HTML renderer", () => {
  it("locks watermark opacity at 50% regardless of template", () => {
    assert.equal(WATERMARK_OPACITY, 0.5);
    const html = renderHtml(doc, getDefaultTemplate());
    assert.ok(html.includes("opacity: 0.5"), "expected opacity: 0.5 in output CSS");
    assert.ok(!html.includes("opacity: 1"), "must not render full-opacity watermark");
  });

  it("puts header and watermark on every page via fixed positioning", () => {
    const html = renderHtml(doc, getDefaultTemplate());
    assert.ok(html.includes('class="doc-header"'), "header block missing");
    assert.ok(html.includes("/assets/tcet-header.png"), "header artwork ref missing");
    assert.ok(html.includes('class="watermark"'), "watermark block missing");
    assert.ok(html.includes("/assets/tcet-watermark.png"), "watermark artwork ref missing");
    assert.ok(html.includes("@page"), "@page print CSS missing");
  });

  it("draws an every-page frame and prints the faculty table last", () => {
    const html = renderHtml(doc, getDefaultTemplate());
    assert.ok(html.includes('class="page-frame"'), "page frame div missing");
    assert.ok(html.includes("For Faculty Use"), "faculty title missing");
    assert.ok(html.includes("Marks Obtained"), "faculty row missing");
    const concIdx = html.indexOf("<h2>Conclusion</h2>");
    assert.ok(html.indexOf("For Faculty Use") > concIdx, "faculty table must come after conclusion");
  });

  it("renders all required sections in order", () => {
    const html = renderHtml(doc, getDefaultTemplate());
    const order = ["Aim", "Objectives", "Theory", "Steps", "Conclusion"];
    let last = -1;
    for (const h of order) {
      const i = html.indexOf(`<h2>${h}</h2>`);
      assert.ok(i > last, `section ${h} missing or out of order`);
      last = i;
    }
    assert.ok(html.includes("Experiment No. 7"));
  });

  it("escapes untrusted LLM content", () => {
    const evil = { ...doc, aim: '<script>alert("x")</script>' };
    const html = renderHtml(evil, getDefaultTemplate());
    assert.ok(!html.includes('<script>alert'), "raw script tag leaked into output");
    assert.ok(html.includes("&lt;script&gt;"), "expected escaped script tag");
    assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
  });

  it("emits no inline event handlers (helmet CSP blocks script-src-attr)", () => {
    const html = renderHtml(doc, getDefaultTemplate());
    assert.ok(!/\son\w+="/i.test(html), "inline event handler leaked into preview document");
  });

  it("resolves artwork server-side and placeholders missing files", () => {
    const html = renderHtml(doc, getDefaultTemplate());
    assert.ok(html.includes('class="doc-header-img"'), "existing header artwork should render an img");
    const broken = {
      template: {
        header: { image: "/assets/definitely-missing.png" },
        watermark: { image: "/assets/definitely-missing.png" },
      },
    };
    const out = renderHtml(doc, broken);
    assert.ok(out.includes("doc-header-missing"), "missing header artwork must render the placeholder box");
    assert.ok(!out.includes('class="watermark-img"'), "missing watermark file must not emit a broken img");
  });

  it("footers print a bare page number and never the college name", () => {
    const html = renderHtml(doc, getDefaultTemplate());
    assert.ok(!html.includes("Thakur College"), "college name must not appear in the document");
    assert.ok(html.includes('class="pagenum"'), "page number span missing");
    assert.ok(!html.includes("Page <span"), "page number must be bare (1/2/3), not 'Page N'");
    const noNum = renderHtml(doc, { template: { footer: { text: "", showPageNumber: false } } });
    assert.ok(!noNum.includes('class="pagenum"'), "showPageNumber:false must drop the number");
    const withText = renderHtml(doc, { template: { footer: { text: "Dept", showPageNumber: true } } });
    assert.ok(withText.includes("Dept") && withText.includes('class="pagenum"'), "text + number combo broken");
    assert.ok(!withText.includes("Page "), "'Page ' prefix must be gone everywhere");
  });
});
