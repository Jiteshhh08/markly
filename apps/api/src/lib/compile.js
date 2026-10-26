import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { artworkLayout } from "../render/renderModel.js";

const execFileAsync = promisify(execFile);

// PDF compilation (Phase 4). NEVER runs pdflatex on the host.
// Default strategy: one-shot texlive container. Override with PDF_COMPILE_CMD,
// a shell template using {dir} (working dir holding doc.tex) — e.g. on a
// machine with native Docker:  docker run --rm -v "{dir}:/work" -w /work texlive/texlive:latest ...
// From Windows with Docker inside WSL, use the {wslDir} placeholder (cmd.exe
// cannot do $(wslpath) interpolation, so Node translates the path itself):
//   wsl docker run --rm -v "{wslDir}:/work" -w /work texlive/texlive:latest pdflatex -no-shell-escape -interaction=nonstopmode -halt-on-error doc
// Custom commands MUST include -no-shell-escape: saved LaTeX overrides are
// untrusted input, and shell-escape would let them run host/container commands.
// Compilation failures return { ok: false } with the compiler output attached.

const DEFAULT_CMD =
  process.env.PDF_COMPILE_CMD ||
  'docker run --rm -v "{dir}:/work" -w /work texlive/texlive:latest pdflatex -no-shell-escape -interaction=nonstopmode -halt-on-error doc.tex';

// Compiler preflight: which docker and which image to look for. Checked BEFORE
// every compile so a missing image produces "pull it" instructions instead of
// a cryptic 2-minute timeout while docker tries to fetch gigabytes.
function dockerBin() {
  if (process.env.PDF_DOCKER) return process.env.PDF_DOCKER;
  // Infer from the compile command: everything before " run " ("wsl docker" or "docker").
  const cmd = process.env.PDF_COMPILE_CMD || DEFAULT_CMD;
  const idx = cmd.indexOf(" run ");
  return idx === -1 ? "docker" : cmd.slice(0, idx);
}
const COMPILER_IMAGE = process.env.PDF_IMAGE ?? "texlive/texlive:latest";

export async function checkCompiler() {
  try {
    await execFileAsync(`${dockerBin()} image inspect ${COMPILER_IMAGE}`, { shell: true, timeout: 30000 });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error:
        `PDF compiler image "${COMPILER_IMAGE}" is not available locally ` +
        `(${String(err.message ?? err).slice(0, 200)}). ` +
        `Pull it first: docker pull ${COMPILER_IMAGE}`,
    };
  }
}

// Translate a Windows temp path (C:\Users\…) to its WSL mount (/mnt/c/Users/…).
// Non-Windows paths pass through untouched.
export function toWslPath(dir) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(dir);
  if (!m) return dir.replaceAll("\\", "/");
  return `/mnt/${m[1].toLowerCase()}/${m[2].replaceAll("\\", "/")}`;
}

export function fillCmd(dir) {
  const cmd = process.env.PDF_COMPILE_CMD || DEFAULT_CMD;
  return cmd.replaceAll("{wslDir}", toWslPath(dir)).replaceAll("{dir}", dir).replaceAll("{tex}", join(dir, "doc.tex"));
}

export async function compileLatexToPdf(tex, template, workDir) {
  const dir = workDir ?? mkdtempSync(join(tmpdir(), "Markly-tex-"));
  try {
    // Staged filenames match the extensions the LaTeX renderer actually emits.
    // A template banner may be JPEG bytes behind a .png name; using intrinsic
    // type avoids a "cannot determine size" failure inside the compiler.
    const art = artworkLayout(template);
    const assets = [
      ["header", art.header],
      ["logo", art.logo],
      ["watermark", art.watermark],
    ].filter(([, asset]) => Boolean(asset));
    // Older saved overrides reference the fixed `header.png`/`watermark.png`
    // names. Keep them compiling by pointing those references at the real
    // staged filename without touching any other source text.
    const legacyAliases = assets
      .filter(([kind, asset]) => asset.name !== `${kind}.png`)
      .map(([kind, asset]) => [`{${kind}.png}`, `{${asset.name}}`]);
    const stagedTex = legacyAliases.reduce(
      (source, [from, to]) => source.replaceAll(from, to),
      tex,
    );
    writeFileSync(join(dir, "doc.tex"), stagedTex);
    for (const [, asset] of assets) {
      writeFileSync(join(dir, asset.name), asset.image.buffer);
    }

    const cmd = fillCmd(dir);
    try {
      // Two passes: tikz `remember picture` overlays (border, watermark,
      // header positions) are written to .aux on pass 1 and only land
      // correctly on pass 2. A single pass leaves them misplaced.
      await execFileAsync(cmd, { shell: true, timeout: 120000, cwd: dir, maxBuffer: 4 * 1024 * 1024 });
      await execFileAsync(cmd, { shell: true, timeout: 120000, cwd: dir, maxBuffer: 4 * 1024 * 1024 });
    } catch (err) {
      const log = tailFile(join(dir, "doc.log"), 60);
      return { ok: false, error: `PDF compilation failed: ${String(err.message ?? err).slice(0, 500)}`, log };
    }
    return { ok: true, pdf: readFileSync(join(dir, "doc.pdf")) };
  } catch (err) {
    return { ok: false, error: `PDF pipeline error: ${String(err.message ?? err).slice(0, 500)}`, log: "" };
  }
}

function tailFile(path, lines) {
  try {
    const all = readFileSync(path, "utf8").split("\n");
    return all.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

