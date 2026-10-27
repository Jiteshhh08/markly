import http from "node:http";

// STAGE 3 test fixtures. These are deliberately tiny, byte-level samples so the
// real upload validators (not mocks) decide whether they are accepted.

export function pngBytes() {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
    Buffer.from("IHDR", "ascii"),
    Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01]),
  ]);
}

export function jpegBytes() {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from("JFIF", "ascii"),
    Buffer.from([0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01]),
  ]);
}

export function gifBytes() {
  return Buffer.concat([
    Buffer.from("GIF89a", "ascii"),
    Buffer.from([0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]),
  ]);
}

export function webpBytes() {
  const body = Buffer.from([0x00, 0x00, 0x00, 0x00]);
  return Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.from([0x04, 0x00, 0x00, 0x00]),
    Buffer.from("WEBP", "ascii"),
    body,
  ]);
}

export function svgBytes() {
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    "utf8",
  );
}

export function textBytes(text = "this is not an image") {
  return Buffer.from(text, "utf8");
}

export function minimalPdf({ pages = 1, javascript = false, eof = true } = {}) {
  const pageIds = [];
  const objects = [];
  objects.push("1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj");
  const kids = [];
  for (let index = 0; index < pages; index += 1) {
    const pageId = index + 3;
    pageIds.push(pageId);
    kids.push(`${pageId} 0 R`);
  }
  objects.push(
    `2 0 obj << /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >> endobj`,
  );
  for (const pageId of pageIds) {
    objects.push(
      `${pageId} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj`,
    );
  }
  if (javascript) {
    objects.push("9 0 obj << /Type /Action /S /JavaScript /JS (alert(1)) >> endobj");
  }
  const body = [
    "%PDF-1.4",
    ...objects,
    "trailer << /Root 1 0 R >>",
    ...(eof ? ["%%EOF"] : []),
  ].join("\n");
  return Buffer.from(body, "latin1");
}

export async function startAiStub(handler) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const payload =
        typeof handler === "function"
          ? handler(req)
          : {
              suggestedName: "Imported PDF Template",
              requiredSections: ["title", "aim", "theory", "steps", "conclusion"],
              detectedHeadings: ["Aim", "Theory"],
              chars: 1234,
            };
      if (payload?.status && payload?.body !== undefined) {
        res.writeHead(payload.status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload.body));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    url,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

export function fileForm(fields = {}, file = null) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.append(key, String(value));
  }
  if (file) form.append("file", file.blob, file.name);
  return form;
}

export function pdfFile(buffer = minimalPdf(), name = "sample.pdf") {
  return {
    blob: new Blob([buffer], { type: "application/pdf" }),
    name,
  };
}

export function imageFile(buffer = pngBytes(), name = "artwork.png", type = "image/png") {
  return {
    blob: new Blob([buffer], { type }),
    name,
  };
}
