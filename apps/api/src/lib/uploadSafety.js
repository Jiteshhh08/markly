// STAGE 3 upload safety. File extensions and client-provided MIME types are
// hints only; the bytes decide what a file is.

export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_PAGES = 40;

export class UploadValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "UploadValidationError";
    this.status = status;
  }
}

function startsWith(buffer, bytes) {
  if (!Buffer.isBuffer(buffer) || buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

export function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { extension: ".png", mimeType: "image/png" };
  }
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return { extension: ".jpg", mimeType: "image/jpeg" };
  }
  if (
    startsWith(buffer, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(buffer, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return { extension: ".gif", mimeType: "image/gif" };
  }
  if (
    buffer.slice(0, 4).toString("ascii") === "RIFF" &&
    buffer.slice(8, 12).toString("ascii") === "WEBP"
  ) {
    return { extension: ".webp", mimeType: "image/webp" };
  }
  return null;
}

export function looksLikeSvg(buffer) {
  const head = Buffer.isBuffer(buffer) ? buffer.slice(0, 512).toString("utf8").trim().toLowerCase() : "";
  return head.startsWith("<svg") || head.startsWith("<?xml") || head.includes("<svg");
}

export function validateImageUpload(file) {
  if (!file?.buffer || file.buffer.length === 0) {
    throw new UploadValidationError("No image file uploaded (field name: file)");
  }
  if (file.buffer.length > MAX_IMAGE_BYTES) {
    throw new UploadValidationError("Image is too large (5MB max)");
  }
  if (looksLikeSvg(file.buffer)) {
    throw new UploadValidationError("SVG uploads are not accepted");
  }
  const detected = detectImageType(file.buffer);
  if (!detected) {
    throw new UploadValidationError("Unsupported image format (PNG, JPEG, GIF or WebP only)");
  }
  const original = String(file.originalname ?? "").toLowerCase();
  if (original.endsWith(".svg") || String(file.mimetype ?? "").toLowerCase().includes("svg")) {
    throw new UploadValidationError("SVG uploads are not accepted");
  }
  return detected;
}

export function validatePdfUpload(file) {
  if (!file?.buffer || file.buffer.length === 0) {
    throw new UploadValidationError("No PDF file uploaded (field name: file)");
  }
  if (file.buffer.length > MAX_PDF_BYTES) {
    throw new UploadValidationError("PDF is too large (25MB max)");
  }
  if (looksLikeSvg(file.buffer)) {
    throw new UploadValidationError("Unsupported file format (PDF required)");
  }
  if (!file.buffer.slice(0, 8).toString("ascii").startsWith("%PDF-")) {
    throw new UploadValidationError("The uploaded file is not a valid PDF");
  }
  const tail = file.buffer.slice(Math.max(0, file.buffer.length - 2048)).toString("latin1");
  if (!tail.includes("%%EOF")) {
    throw new UploadValidationError("The uploaded PDF is incomplete or malformed");
  }
  const raw = file.buffer.toString("latin1");
  if (/\/JavaScript\b|\/JS\b|\/Launch\b/i.test(raw)) {
    throw new UploadValidationError("PDFs with active content are not accepted");
  }
  const pageCount = (raw.match(/\/Type\s*\/Page\b/g) ?? []).length;
  if (pageCount > MAX_PDF_PAGES) {
    throw new UploadValidationError(`PDF has too many pages (${MAX_PDF_PAGES} max)`);
  }
  return { pageCount };
}
