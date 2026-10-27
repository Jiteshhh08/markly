import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderLatex, escapeLatex } from "../src/render/latex.js";
import { renderDocx } from "../src/render/docx.js";
import { checkCompiler, compileLatexToPdf, fillCmd, toWslPath } from "../src/lib/compile.js";
import { getDefaultTemplate } from "../src/lib/templates.js";
import { WATERMARK_OPACITY } from "../src/render/html.js";

const doc = {
  experimentNumber: 7,
  title: "Exploring subqueries in SQL",
  aim: "Explore subqueries in SQL",
  objectives: ["Understand scalar and correlated subqueries"],
  theory: ["A subquery is a query nested inside another query with context."],
  steps: [
    {
      number: 1,
      title: "Scalar subquery",
      description: ["Write and run a scalar subquery."],
      code: "SELECT * FROM t WHERE x = (SELECT MAX(x) FROM t);",
      language: "sql",
    },
  ],
  conclusion: "Subqueries were explored and observed outputs recorded.",
  metadata: {},
};

describe("LaTeX renderer", () => {
  it("draws a page border and centers the watermark at 50% via tikz", () => {
    assert.equal(WATERMARK_OPACITY, 0.5);
    const tex = renderLatex(doc, getDefaultTemplate());
    assert.ok(tex.includes("\\usepackage{tikz}"), "tikz package missing");
    assert.ok(tex.includes("current page.north west"), "page border missing");
    assert.ok(tex.includes("at (current page.center)"), "watermark must anchor to exact page center");
    assert.ok(tex.includes("opacity=0.5"), "watermark must use opacity=0.5");
    assert.ok(tex.includes("fancyhead"), "header must be configured");
  });
  it("uses a paragraph break (not \\\\\\\\ line breaks) under the title", () => {
    const tex = renderLatex(doc, getDefaultTemplate());
    assert.ok(!tex.includes("\\\\\\\\Experiment"), "double line-breaks are fatal under -halt-on-error");
    assert.ok(tex.includes("{\\large Experiment No. 7}"), "experiment line missing");
  });
  it("spans the header full width, keeps footer to page number only, left-aligns faculty title", () => {
    const tex = renderLatex(doc, getDefaultTemplate());
    assert.ok(tex.includes("\\includegraphics[width=190mm,keepaspectratio]{header.jpg}"), "header must span the full inner frame width using its real raster type");
    assert.ok(tex.includes("anchor=north") && tex.includes("yshift=-13mm"), "header must pin just inside the border top");
    assert.ok(tex.includes("\\fancyfoot[C]{\\thepage}"), "footer must be page number only");
    assert.ok(!tex.includes("Thakur College"), "footer college text must be gone");
    assert.ok(!tex.includes("\\begin{center}\n{\\bfseries For Faculty Use}"), "faculty title must not be centered");
    assert.ok(tex.includes("{\\bfseries For Faculty Use}"), "faculty title missing");
  });
  it("wraps long code lines so nothing exceeds the border", () => {
    const tex = renderLatex(doc, getDefaultTemplate());
    assert.ok(tex.includes("\\usepackage{listings}"), "listings package missing");
    assert.ok(tex.includes("breaklines=true"), "code must wrap");
    assert.ok(tex.includes("\\begin{lstlisting}"), "code must use lstlisting");
    assert.ok(!tex.includes("\\begin{verbatim}"), "verbatim must be gone (it overflows)");
  });
  it("prints the faculty table last at the bottom", () => {
    const tex = renderLatex(doc, getDefaultTemplate());
    assert.ok(tex.includes("For Faculty Use"), "faculty title missing");
    assert.ok(tex.includes("Marks Obtained"), "faculty row missing");
    assert.ok(tex.includes("\\vfill"), "faculty table must flush to the bottom");
    const concIdx = tex.indexOf("Conclusion");
    assert.ok(tex.indexOf("For Faculty Use") > concIdx, "faculty table must come after conclusion");
  });
  it("escapes LaTeX special characters", () => {
    assert.equal(escapeLatex("100% sure & $5 #1 _x_"), "100\\% sure \\& \\$5 \\#1 \\_x\\_");
    const tex = renderLatex({ ...doc, aim: "Use 100% & more" }, getDefaultTemplate());
    assert.ok(tex.includes("100\\% \\& more"));
  });
});

describe("DOCX renderer", () => {
  it("produces a valid non-empty .docx package", async () => {
    const buf = Buffer.from(await renderDocx(doc, getDefaultTemplate()));
    assert.ok(buf.length > 2000, `suspiciously small docx (${buf.length} bytes)`);
    assert.equal(buf[0], 0x50);
    assert.equal(buf[1], 0x4b); // PK zip magic
  });
});

describe("PDF compiler", () => {
  it("preflight says plainly when the compiler image is missing", async () => {
    const prevBin = process.env.PDF_DOCKER;
    process.env.PDF_DOCKER = "definitely-not-docker-xyz";
    try {
      const out = await checkCompiler();
      assert.equal(out.ok, false);
      assert.ok(out.error.includes("not available"), "expected pull instructions");
      assert.ok(out.error.includes("docker pull"), "expected the pull command");
    } finally {
      if (prevBin === undefined) delete process.env.PDF_DOCKER;
      else process.env.PDF_DOCKER = prevBin;
    }
  });

  it("runs the compiler twice so tikz overlays settle", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const marker = path.join(os.tmpdir(), "Markly-passes-probe.txt").replaceAll("\\", "/");
    try { fs.unlinkSync(marker); } catch { /* first run */ }
    const prev = process.env.PDF_COMPILE_CMD;
    // Stub compiler: records each invocation, then fakes a PDF.
    process.env.PDF_COMPILE_CMD = `node -e "const fs=require('fs');fs.appendFileSync('${marker}','x');fs.writeFileSync('doc.pdf','PDF')"`;
    try {
      const out = await compileLatexToPdf("\\documentclass{article}\\begin{document}hi\\end{document}", null);
      assert.equal(out.ok, true);
      assert.equal(fs.readFileSync(marker, "utf8").length, 2, "compiler must run twice");
    } finally {
      if (prev === undefined) delete process.env.PDF_COMPILE_CMD;
      else process.env.PDF_COMPILE_CMD = prev;
      try { fs.unlinkSync(marker); } catch { /* cleanup */ }
    }
  });

  it("fails gracefully when no compiler is available", async () => {
    const prev = process.env.PDF_COMPILE_CMD;
    process.env.PDF_COMPILE_CMD = "definitely-not-a-real-command-xyz {dir}";
    try {
      const out = await compileLatexToPdf("\\documentclass{article}\\begin{document}hi\\end{document}", null);
      assert.equal(out.ok, false);
      assert.ok(out.error.length > 0, "expected an explanatory error, not a crash");
    } finally {
      if (prev === undefined) delete process.env.PDF_COMPILE_CMD;
      else process.env.PDF_COMPILE_CMD = prev;
    }
  });

  it("keeps legacy override asset references compiling with the real staged extension", async () => {
    const prev = process.env.PDF_COMPILE_CMD;
    process.env.PDF_COMPILE_CMD =
      'node -e "const fs=require(\'fs\');fs.writeFileSync(\'doc.pdf\',fs.readFileSync(\'doc.tex\'))"';
    try {
      const legacy = [
        "\\documentclass{article}",
        "\\usepackage{graphicx}",
        "\\begin{document}",
        "\\includegraphics[width=190mm]{header.png}",
        "\\includegraphics[width=84mm]{watermark.png}",
        "\\end{document}",
      ].join("\n");
      const out = await compileLatexToPdf(legacy, getDefaultTemplate());
      assert.equal(out.ok, true, out.error);
      const staged = out.pdf.toString("utf8");
      assert.ok(staged.includes("{header.jpg}"), "legacy header.png must resolve to the staged JPEG");
      assert.ok(staged.includes("{watermark.png}"), "a real PNG watermark must keep its name");
      assert.ok(!staged.includes("{header.png}"), "the missing legacy filename must not remain");
    } finally {
      if (prev === undefined) delete process.env.PDF_COMPILE_CMD;
      else process.env.PDF_COMPILE_CMD = prev;
    }
  });
});

describe("WSL compile command", () => {
  it("translates Windows temp paths for WSL docker mounts", () => {
    assert.equal(toWslPath("C:\\Users\\Admin\\Temp\\Markly-tex-abc"), "/mnt/c/Users/Admin/Temp/Markly-tex-abc");
    assert.equal(toWslPath("/tmp/Markly-tex-abc"), "/tmp/Markly-tex-abc");
  });
  it("fills {wslDir} from PDF_COMPILE_CMD", () => {
    const prev = process.env.PDF_COMPILE_CMD;
    process.env.PDF_COMPILE_CMD = 'wsl docker run --rm -v "{wslDir}:/work" img';
    try {
      const cmd = fillCmd("C:\\Users\\Admin\\Temp\\workdir");
      assert.ok(cmd.includes("/mnt/c/Users/Admin/Temp/workdir:/work"), `got: ${cmd}`);
      assert.ok(!cmd.includes("{wslDir}"), "placeholder must be replaced");
    } finally {
      if (prev === undefined) delete process.env.PDF_COMPILE_CMD;
      else process.env.PDF_COMPILE_CMD = prev;
    }
  });
});

