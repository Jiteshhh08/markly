import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  ImageRun,
  LevelFormat,
  LineRuleType,
  PageBorderDisplay,
  PageBorderOffsetFrom,
  PageBreak,
  PageNumber,
  PageOrientation,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalPositionRelativeFrom,
  HorizontalPositionRelativeFrom,
  WidthType,
} from "docx";
import { ImageWatermark } from "docx/watermarks";
import {
  artworkLayout,
  blockStyle,
  buildRenderNodes,
  documentTitle,
  docxHexColor,
  facultyTableData,
  mmToEmu,
  mmToPx,
  mmToPt,
  mmToTwips,
  pageGeometry,
  primaryFontFamily,
  ptToHalfPoints,
  pxToTwips,
  textLines,
  typographyConfig,
} from "./renderModel.js";

// DOCX renderer (Stage 6).
//
// The saved `document.blocks` body controls order, edited text and supported
// formatting. Template fields remain locked presentation: page size/margins,
// header/logo/watermark/footer, page border and typography defaults.
// HTML, DOCX and LaTeX all consume the same resolved node list from
// renderModel.js, so exports cannot drift in section order or body text.
//
// Watermark opacity: OOXML has no per-image opacity. `ImageWatermark` writes
// Word's own washout (gain/black-level) VML attributes, which is the verified
// safe equivalent of the HTML/LaTeX 50% rule. The watermark is centred on the
// page and repeats through the header.

const ALIGNMENTS = Object.freeze({
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
});

const BORDER_STYLES = Object.freeze({
  solid: BorderStyle.SINGLE,
  double: BorderStyle.DOUBLE,
  dashed: BorderStyle.DASHED,
  dotted: BorderStyle.DOTTED,
});

const CODE_FONT = "Consolas";

function alignmentOf(value) {
  return ALIGNMENTS[value] ?? AlignmentType.LEFT;
}

function lineSpacing(lineHeight) {
  return {
    line: Math.max(1, Math.round(Number(lineHeight) * 240)),
    lineRule: LineRuleType.AUTO,
  };
}

function paragraphSpacing(style, { before = true, after = true } = {}) {
  return {
    before: before ? pxToTwips(style.spacingBeforePx) : 0,
    after: after ? pxToTwips(style.spacingAfterPx) : 0,
    ...lineSpacing(style.lineHeight),
  };
}

function indentOf(style, extraPx = 0) {
  const left = style.indentPx + extraPx;
  return left > 0 ? { left: pxToTwips(left) } : undefined;
}

function textRun(text, style, { bold = false, font, color } = {}) {
  return new TextRun({
    children: [String(text ?? "")],
    bold,
    font,
    size: ptToHalfPoints(style.fontSizePt),
    color,
  });
}

function headingParagraph(block, style, typography, { bold = true, outlineLevel } = {}) {
  return new Paragraph({
    children: [
      textRun(block.content?.text ?? "", style, {
        bold,
        font: primaryFontFamily(typography.fontFamily),
      }),
    ],
    alignment: alignmentOf(style.align),
    spacing: paragraphSpacing(style),
    indent: indentOf(style),
    keepNext: true,
    keepLines: true,
    outlineLevel,
  });
}

function bodyParagraph(block, style, typography) {
  return new Paragraph({
    children: [
      textRun(block.content?.text ?? "", style, {
        font: primaryFontFamily(typography.fontFamily),
      }),
    ],
    alignment: alignmentOf(style.align),
    spacing: paragraphSpacing(style),
    indent: indentOf(style),
  });
}

function listParagraphs(block, style, typography, numbering) {
  const items = Array.isArray(block.content?.items) ? block.content.items : [];
  if (!items.length) return [];
  const numbered = block.type === "numberedList";
  const reference = numbered ? `stage6-numbered-${numbering.length}` : null;
  if (numbered) {
    numbering.push({
      reference,
      levels: [
        {
          level: 0,
          format: LevelFormat.DECIMAL,
          text: "%1.",
          alignment: AlignmentType.LEFT,
          start: 1,
          style: {
            paragraph: {
              indent: { left: pxToTwips(style.indentPx + 18), hanging: pxToTwips(10) },
            },
          },
        },
      ],
    });
  }
  return items.map((item, index) => {
    const first = index === 0;
    const last = index === items.length - 1;
    return new Paragraph({
      children: [
        textRun(item, style, {
          font: primaryFontFamily(typography.fontFamily),
        }),
      ],
      alignment: alignmentOf(style.align),
      spacing: paragraphSpacing(style, { before: first, after: last }),
      indent: numbered ? undefined : indentOf(style, 18),
      numbering: numbered ? { reference, level: 0 } : undefined,
      bullet: numbered ? undefined : { level: 0 },
    });
  });
}

function codeParagraphs(block, style) {
  const lines = textLines(block.content?.text);
  if (!lines.length) return [];
  const font = CODE_FONT;
  const exactLine = Math.max(1, Math.round(style.fontSizePt * style.lineHeight * 20));
  return lines.map((line, index) => {
    const first = index === 0;
    const last = index === lines.length - 1;
    return new Paragraph({
      // `children` (not `text`) preserves leading spaces and tabs through
      // xml:space="preserve", so code indentation survives in Word.
      children: [
        new TextRun({
          children: [line.length ? line : " "],
          font,
          size: ptToHalfPoints(style.fontSizePt),
        }),
      ],
      alignment: alignmentOf(style.align),
      spacing: {
        before: first ? pxToTwips(style.spacingBeforePx) : 0,
        after: last ? pxToTwips(style.spacingAfterPx) : 0,
        line: exactLine,
        lineRule: LineRuleType.EXACT,
      },
      indent: {
        left: pxToTwips(style.indentPx + 8),
        right: pxToTwips(8),
      },
      shading: { type: ShadingType.CLEAR, fill: "F4F4F4" },
    });
  });
}

function spacerParagraph(heightPx) {
  return new Paragraph({
    children: [new TextRun({ children: [" "] })],
    spacing: {
      before: 0,
      after: 0,
      line: Math.max(1, pxToTwips(heightPx)),
      lineRule: LineRuleType.EXACT,
    },
  });
}

function pageBreakParagraph() {
  return new Paragraph({ children: [new PageBreak()] });
}

function blockParagraphs(block, template, typography, numbering) {
  const style = blockStyle(block, template);
  if (block.type === "pageBreak") return [pageBreakParagraph()];
  if (block.type === "spacer") {
    const height = Number.isFinite(block.content?.height) ? block.content.height : 24;
    return [spacerParagraph(height)];
  }
  if (block.type === "handwrite") return [spacerParagraph(140)];
  if (block.type === "bulletList" || block.type === "numberedList") {
    return listParagraphs(block, style, typography, numbering);
  }
  if (block.type === "code") return codeParagraphs(block, style);
  if (block.type === "title") {
    return [headingParagraph(block, style, typography, { outlineLevel: 0 })];
  }
  if (block.type === "heading") {
    return [headingParagraph(block, style, typography, { outlineLevel: 1 })];
  }
  if (block.type === "subheading") {
    return [headingParagraph(block, style, typography, { outlineLevel: 2 })];
  }
  if (block.type === "experimentNumber") {
    return [headingParagraph(block, style, typography)];
  }
  if (block.type === "paragraph") {
    return [bodyParagraph(block, style, typography)];
  }
  return [];
}

function facultyTableParagraphs(template, typography) {
  const data = facultyTableData(template);
  if (!data) return [];
  const border = { style: BorderStyle.SINGLE, size: 4, color: "333333" };
  const cellBorders = {
    top: border,
    bottom: border,
    left: border,
    right: border,
  };
  const cell = (value, { bold = false } = {}) =>
    new TableCell({
      children: [
        new Paragraph({
          children: [
            new TextRun({
              children: [String(value ?? "").length ? String(value) : " "],
              bold,
              font: primaryFontFamily(typography.fontFamily),
              size: ptToHalfPoints(10.5),
            }),
          ],
          spacing: { before: 0, after: 0, line: pxToTwips(44), lineRule: LineRuleType.EXACT },
        }),
      ],
      borders: cellBorders,
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
    });
  const rows = [
    new TableRow({
      children: data.columns.map((column) => cell(column, { bold: true })),
      tableHeader: true,
    }),
    ...data.rows.map(
      (row) => new TableRow({ children: data.columns.map((_, index) => cell(row[index])) }),
    ),
  ];
  return [
    new Paragraph({
      children: [
        new TextRun({
          text: data.title,
          bold: true,
          font: primaryFontFamily(typography.fontFamily),
          size: ptToHalfPoints(12.75),
        }),
      ],
      spacing: { before: pxToTwips(22), after: pxToTwips(6) },
      keepNext: true,
    }),
    new Table({
      rows,
      width: { size: 100, type: WidthType.PERCENTAGE },
    }),
  ];
}

function artworkHeaderChildren(art) {
  const children = [];
  if (art.header) {
    children.push(
      new ImageRun({
        type: art.header.image.type,
        data: art.header.image.buffer,
        transformation: {
          width: Math.round(mmToPx(art.header.widthMm)),
          height: Math.round(mmToPx(art.header.heightMm)),
        },
        floating: {
          horizontalPosition: {
            relative: HorizontalPositionRelativeFrom.PAGE,
            offset: mmToEmu(art.header.xMm),
          },
          verticalPosition: {
            relative: VerticalPositionRelativeFrom.PAGE,
            offset: mmToEmu(art.header.yMm),
          },
          behindDocument: true,
          allowOverlap: true,
        },
      }),
    );
  }
  if (art.logo) {
    children.push(
      new ImageRun({
        type: art.logo.image.type,
        data: art.logo.image.buffer,
        transformation: {
          width: Math.round(mmToPx(art.logo.widthMm)),
          height: Math.round(mmToPx(art.logo.heightMm)),
        },
        floating: {
          horizontalPosition: {
            relative: HorizontalPositionRelativeFrom.PAGE,
            offset: mmToEmu(art.logo.xMm),
          },
          verticalPosition: {
            relative: VerticalPositionRelativeFrom.PAGE,
            offset: mmToEmu(art.logo.yMm),
          },
          behindDocument: true,
          allowOverlap: true,
        },
      }),
    );
  }
  if (art.watermark) {
    children.push(
      new ImageWatermark({
        type: art.watermark.image.type,
        data: art.watermark.image.buffer,
        transformation: {
          width: Math.round(mmToPx(art.watermark.widthMm)),
          height: Math.round(mmToPx(art.watermark.heightMm)),
        },
        washout: true,
        title: "Watermark",
      }),
    );
  }
  if (!children.length) children.push(new TextRun({ text: "" }));
  return [new Paragraph({ children, spacing: { before: 0, after: 0 } })];
}

function pageBorderOptions(border) {
  if (!border) return undefined;
  const spec = {
    style: BORDER_STYLES[border.style] ?? BorderStyle.SINGLE,
    size: Math.max(2, Math.round(border.widthPt * 8)),
    color: docxHexColor(border.color),
    space: Math.min(31, Math.round(mmToPt(10))),
  };
  return {
    pageBorders: {
      display: PageBorderDisplay.ALL_PAGES,
      offsetFrom: PageBorderOffsetFrom.PAGE,
    },
    pageBorderTop: spec,
    pageBorderRight: spec,
    pageBorderBottom: spec,
    pageBorderLeft: spec,
  };
}

export async function renderDocx(source, template, options = {}) {
  const model = buildRenderNodes(source, template, options);
  const t = model.template;
  const geometry = pageGeometry(t);
  const typography = typographyConfig(t);
  const art = artworkLayout(t, geometry);
  const numbering = [];
  const children = [];

  for (const block of model.blocks) {
    children.push(...blockParagraphs(block, t, typography, numbering));
  }
  children.push(...facultyTableParagraphs(t, typography));

  const footer = t.footer ?? {};
  const footerText = String(footer.text ?? "").trim();
  const showPageNumber = footer.showPageNumber === true;
  const footerChildren = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        ...(footerText ? [new TextRun({ text: `${footerText}  |  `, size: 18 })] : []),
        // PageNumber.CURRENT only emits a real PAGE field when wrapped in a
        // TextRun; as a bare paragraph child it serializes as literal "CURRENT".
        ...(showPageNumber ? [new TextRun({ size: 18, children: [PageNumber.CURRENT] })] : []),
      ],
      spacing: { before: 0, after: 0 },
    }),
  ];

  // docx's `createPageSize` swaps width/height itself when orientation is
  // landscape, so it expects the portrait dimensions and the orientation flag.
  const pageWidthMm = geometry.orientation === "landscape" ? geometry.height : geometry.width;
  const pageHeightMm = geometry.orientation === "landscape" ? geometry.width : geometry.height;

  const doc = new Document({
    title: documentTitle(source, model.blocks),
    styles: {
      default: {
        document: {
          run: {
            font: primaryFontFamily(typography.fontFamily),
            size: ptToHalfPoints(typography.baseSizePt),
            color: "111111",
          },
          paragraph: {
            spacing: lineSpacing(typography.lineHeight),
          },
        },
      },
    },
    numbering: numbering.length ? { config: numbering } : undefined,
    features: { updateFields: true },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: mmToTwips(pageWidthMm),
              height: mmToTwips(pageHeightMm),
              orientation:
                geometry.orientation === "landscape"
                  ? PageOrientation.LANDSCAPE
                  : PageOrientation.PORTRAIT,
            },
            margin: {
              top: mmToTwips(geometry.margin.top),
              right: mmToTwips(geometry.margin.right),
              bottom: mmToTwips(geometry.margin.bottom),
              left: mmToTwips(geometry.margin.left),
              header: mmToTwips(geometry.header.top),
              footer: mmToTwips(geometry.frameInset),
            },
            borders: pageBorderOptions(geometry.border),
          },
        },
        headers: { default: new Header({ children: artworkHeaderChildren(art) }) },
        footers: { default: new Footer({ children: footerChildren }) },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}
