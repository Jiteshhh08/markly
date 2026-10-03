import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  HorizontalPositionAlign,
  HorizontalPositionRelativeFrom,
  ImageRun,
  Packer,
  PageBorderDisplay,
  PageBorderOffsetFrom,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalPositionAlign,
  VerticalPositionRelativeFrom,
} from "docx";
import { readFileSync } from "node:fs";
import { resolveAsset } from "../lib/storage.js";

// DOCX renderer (Phase 4). Same sections/order as the HTML renderer.
// Header + footer are native Word constructs (repeat on every page automatically).
// Watermark is a floating behind-text image inside the header, so it repeats too.
//
// Opacity caveat: OOXML has no per-image opacity; Word renders the PNG as-is.
// The 50% rule is enforced by using artwork saved at 50% transparency
// (see apps/api/assets/README.md). HTML/LaTeX enforce 0.5 programmatically.

function assetBuffer(ref) {
  const full = resolveAsset(ref);
  return full ? readFileSync(full) : null;
}

const bullet = (text) => new Paragraph({ text, bullet: { level: 0 } });
const body = (text) => new Paragraph({ children: [new TextRun(text)] });
const h2 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_2 });

// Static faculty grading table (template data, not LLM output), printed last.
function facultyTable(t) {
  const ft = t.facultyTable;
  if (!ft?.columns?.length) return [];
  const cell = (text, bold = false) =>
    new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text: String(text ?? ""), bold })] })],
    });
  const rows = [
    new TableRow({ children: ft.columns.map((c) => cell(c, true)) }),
    ...(ft.rows ?? []).map((r) => new TableRow({ children: ft.columns.map((_, i) => cell(r[i] ?? "")) })),
  ];
  return [
    new Paragraph({ text: ft.title ?? "For Faculty Use", heading: HeadingLevel.HEADING_2 }),
    new Table({ rows }),
  ];
}

export async function renderDocx(content, template, options = {}) {
  const t = template?.template ?? {};
  const includeVivaTitle = options.includeVivaTitle === true;
  const typedConclusion = options.typedConclusion !== false;
  const handwrite = [new Paragraph({ text: "" }), new Paragraph({ text: "" }), new Paragraph({ text: "" })];
  const headerImg = assetBuffer(t.header?.image);
  const wmImg = assetBuffer(t.watermark?.image);
  const footerText = t.footer?.text ?? "";
  const showPageNumber = t.footer?.showPageNumber !== false;

  const headerChildren = [];
  if (headerImg) {
    headerChildren.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new ImageRun({ data: headerImg, transformation: { width: 520, height: 62 } })],
      }),
    );
  }
  if (wmImg) {
    headerChildren.push(
      new Paragraph({
        children: [
          new ImageRun({
            data: wmImg,
            transformation: { width: 320, height: 320 },
            floating: {
              horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, align: HorizontalPositionAlign.CENTER },
              verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, align: VerticalPositionAlign.CENTER },
              behindDocument: true,
              allowOverlap: true,
            },
          }),
        ],
      }),
    );
  }

  const children = [
    new Paragraph({
      text: content.title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    }),
  ];
  if (content.experimentNumber) {
    children.push(new Paragraph({ text: `Experiment No. ${content.experimentNumber}`, alignment: AlignmentType.CENTER }));
  }
  children.push(h2("Aim"), body(content.aim));
  children.push(h2("Objectives"));
  for (const o of content.objectives) children.push(bullet(o));
  children.push(h2("Theory"));
  for (const p of content.theory) children.push(body(p));
  children.push(h2("Steps"));
  for (const s of content.steps) {
    children.push(new Paragraph({ text: `Step ${s.number}: ${s.title}`, heading: HeadingLevel.HEADING_3 }));
    for (const d of s.description) children.push(bullet(d));
    if (s.code) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: s.code, font: "Consolas", size: 20 })],
        }),
      );
    }
  }
  children.push(h2("Conclusion"));
  if (typedConclusion) children.push(body(content.conclusion));
  else for (const p of handwrite) children.push(p);
  // Viva Questions is a HEADING ONLY when enabled — questions are handwritten by faculty, never generated.
  if (includeVivaTitle) {
    children.push(h2("Viva Questions"));
    for (const p of handwrite) children.push(p);
    children.push(new Paragraph({ text: "" }));
  }
  for (const node of facultyTable(t)) children.push(node);

  const frame = { style: BorderStyle.SINGLE, size: 12, color: "000000", space: 24 };
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margins: { top: 1440, right: 1150, bottom: 1150, left: 1150, header: 720, footer: 720 },
            borders: {
              pageBorders: { display: PageBorderDisplay.ALL_PAGES, offsetFrom: PageBorderOffsetFrom.PAGE },
              pageBorderTop: frame,
              pageBorderLeft: frame,
              pageBorderBottom: frame,
              pageBorderRight: frame,
            },
          },
        },
        headers: { default: new Header({ children: headerChildren }) },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  ...(footerText ? [new TextRun({ text: `${footerText}  |  `, size: 18 })] : []),
                  // PageNumber.CURRENT only emits a real PAGE field when wrapped
                  // in a TextRun — as a bare paragraph child it serialized as the
                  // literal text "CURRENT" (invalid OOXML Word silently drops).
                  ...(showPageNumber ? [new TextRun({ size: 18, children: [PageNumber.CURRENT] })] : []),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}
