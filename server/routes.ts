import type { Express, Response } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import archiver from "archiver";
import { log } from "./index";
import { sendConversionEmail, isValidEmail } from "./email";

const execFileAsync = promisify(execFile);

const UPLOAD_DIR = path.resolve("/tmp/pdfa_uploads");
const OUTPUT_DIR = path.resolve("/tmp/pdfa_output");
const MAX_SIZE_BYTES = 9 * 1024 * 1024; // 9 MB

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf")) {
      cb(null, true);
    } else {
      cb(new Error("Solo file PDF sono accettati"));
    }
  },
});

async function getPageCount(pdfPath: string): Promise<number> {
  const result = await execFileAsync("qpdf", ["--show-npages", pdfPath]);
  return parseInt(result.stdout.trim(), 10);
}

import { fileURLToPath } from "url";

const __server_dir = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return typeof __dirname !== "undefined" ? __dirname : process.cwd();
  }
})();

function resolveServerFile(filename: string): string {
  const candidates = [
    path.join(__server_dir, filename),
    path.resolve("server", filename),
    path.join(process.cwd(), "server", filename),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

async function findPageRangesForSize(convertedPdfPath: string, maxSize: number): Promise<{ start: number; end: number }[]> {
  const totalPages = await getPageCount(convertedPdfPath);
  const fileSize = fs.statSync(convertedPdfPath).size;

  if (totalPages <= 1) {
    return [{ start: 1, end: 1 }];
  }

  const tmpDir = path.dirname(convertedPdfPath);
  let tmpCounter = 0;

  async function extractSize(start: number, end: number): Promise<number> {
    tmpCounter++;
    const tmpPath = path.join(tmpDir, `__size_probe_${tmpCounter}.pdf`);
    await execFileAsync("qpdf", [
      convertedPdfPath,
      "--pages", convertedPdfPath, `${start}-${end}`, "--",
      tmpPath,
    ]);
    const size = fs.statSync(tmpPath).size;
    fs.unlinkSync(tmpPath);
    return size;
  }

  const avgPageSize = fileSize / totalPages;
  const estimatedPagesPerChunk = Math.max(1, Math.floor((maxSize * 0.85) / avgPageSize));

  const ranges: { start: number; end: number }[] = [];
  let currentPage = 1;

  while (currentPage <= totalPages) {
    if (currentPage + estimatedPagesPerChunk - 1 >= totalPages) {
      const size = await extractSize(currentPage, totalPages);
      if (size <= maxSize) {
        ranges.push({ start: currentPage, end: totalPages });
        break;
      }
    }

    let candidateEnd = Math.min(currentPage + estimatedPagesPerChunk - 1, totalPages);
    let size = await extractSize(currentPage, candidateEnd);

    if (size <= maxSize) {
      let probes = 0;
      while (candidateEnd + 1 <= totalPages && probes < 10) {
        const nextSize = await extractSize(currentPage, candidateEnd + 1);
        probes++;
        if (nextSize > maxSize) break;
        candidateEnd++;
        size = nextSize;
      }
    } else {
      while (candidateEnd > currentPage) {
        candidateEnd--;
        size = await extractSize(currentPage, candidateEnd);
        if (size <= maxSize) break;
      }
      if (candidateEnd === currentPage && size > maxSize) {
        // single page exceeds limit - accept it and move on
      }
    }

    ranges.push({ start: currentPage, end: candidateEnd });
    currentPage = candidateEnd + 1;
  }

  return ranges;
}

const ICC_PROFILE_PATH = resolveServerFile("srgb.icc");
const PDFA_DEF_TEMPLATE = resolveServerFile("PDFA_def.ps");

async function convertToPdfA(inputPath: string, outputPath: string): Promise<void> {
  const iccPath = fs.existsSync(ICC_PROFILE_PATH)
    ? ICC_PROFILE_PATH
    : path.resolve("server/srgb.icc");

  const templatePath = fs.existsSync(PDFA_DEF_TEMPLATE)
    ? PDFA_DEF_TEMPLATE
    : path.resolve("server/PDFA_def.ps");

  const tmpDefPath = outputPath + ".pdfa_def.ps";
  const templateContent = fs.readFileSync(templatePath, "utf-8");
  fs.writeFileSync(tmpDefPath, templateContent.replace("__SRGB_ICC_PATH__", iccPath));

  const args = [
    "-dPDFA=1",
    "-dBATCH",
    "-dNOPAUSE",
    "-dNOOUTERSAVE",
    "-sColorConversionStrategy=UseDeviceIndependentColor",
    "-sDEVICE=pdfwrite",
    "-dPDFACompatibilityPolicy=1",
    `-dPDFSETTINGS=/ebook`,
    "-dNumRenderingThreads=4",
    "-dBandBufferSpace=500000000",
    "-dBufferSpace=1000000000",
    "-sBandListStorage=memory",
    "-dMaxBitmap=1000000000",
    "-dCompressFonts=true",
    "-dDetectDuplicateImages=true",
    `--permit-file-read=${iccPath}`,
    `-sOutputFile=${outputPath}`,
    tmpDefPath,
    inputPath,
  ];

  try {
    await execFileAsync("gs", args, { maxBuffer: 500 * 1024 * 1024 });
  } finally {
    try { fs.unlinkSync(tmpDefPath); } catch {}
  }
}

async function verifyPdfA(filePath: string): Promise<{ valid: boolean; conformance: string | null }> {
  try {
    const buffer = fs.readFileSync(filePath);
    const content = buffer.toString("latin1");

    const partMatch = content.match(/pdfaid:part[>"'\s=]*(\d+)/i);
    const confMatch = content.match(/pdfaid:conformance[>"'\s=]*([A-Za-z]+)/i);

    if (partMatch) {
      const part = partMatch[1];
      const conformance = confMatch ? confMatch[1].toUpperCase() : "B";
      return { valid: true, conformance: `PDF/A-${part}${conformance.toLowerCase()}` };
    }

    return { valid: false, conformance: null };
  } catch {
    return { valid: false, conformance: null };
  }
}

function cleanupDir(dir: string) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

interface PartVerification {
  name: string;
  size: number;
  verified: boolean;
  conformance: string | null;
}

interface ConvertedFile {
  originalName: string;
  outputName: string;
  outputSize: number;
  wasSplit: boolean;
  parts?: number;
  verified: boolean;
  conformance: string | null;
  partsDetail?: PartVerification[];
}

interface SessionProgress {
  logs: { type: string; message?: string; data?: any }[];
  clients: Set<Response>;
  done: boolean;
}

const progressStore = new Map<string, SessionProgress>();

function broadcastToSession(sessionId: string, event: { type: string; message?: string; data?: any }) {
  const session = progressStore.get(sessionId);
  if (!session) return;
  session.logs.push(event);
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  session.clients.forEach((client) => {
    try {
      client.write(payload);
    } catch {}
  });
}

function cleanupSession(sessionId: string, delay = 60000) {
  setTimeout(() => {
    progressStore.delete(sessionId);
  }, delay);
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.post("/api/convert", upload.array("files", 20), async (req, res) => {
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      return res.status(400).json({ message: "Nessun file caricato" });
    }

    const customName = typeof req.body?.customName === "string" && req.body.customName.trim()
      ? req.body.customName.trim().replace(/[<>:"/\\|?*]/g, "_")
      : null;

    const rawEmail = typeof req.body?.notifyEmail === "string" ? req.body.notifyEmail.trim() : "";
    const notifyEmail = rawEmail && isValidEmail(rawEmail) ? rawEmail : null;

    const sessionId = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    const sessionDir = path.join(OUTPUT_DIR, sessionId);
    const splitDir = path.join(sessionDir, "split");
    const convertedDir = path.join(sessionDir, "converted");

    ensureDir(sessionDir);
    ensureDir(splitDir);
    ensureDir(convertedDir);

    progressStore.set(sessionId, { logs: [], clients: new Set(), done: false });

    res.json({ sessionId });

    function sendLog(message: string) {
      broadcastToSession(sessionId, { type: "log", message });
    }

    if (rawEmail && !notifyEmail) {
      sendLog("Avviso: indirizzo email non valido, la notifica non verrà inviata.");
    }

    const results: ConvertedFile[] = [];

    try {
      for (let fi = 0; fi < files.length; fi++) {
        const file = files[fi];
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const originalBaseName = path.parse(originalName).name;
        const outputBaseName = (customName && files.length === 1) ? customName : originalBaseName;
        const stat = fs.statSync(file.path);

        const fileLabel = `[${fi + 1}/${files.length}]`;
        sendLog(`${fileLabel} Elaborazione: ${originalName} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
        log(`Processing: ${originalName} (${(stat.size / 1024 / 1024).toFixed(2)} MB) → output as "${outputBaseName}"`);

        const tempConvertedPath = path.join(splitDir, `${originalBaseName}_pdfa_full.pdf`);

        try {
          sendLog(`${fileLabel} Conversione in formato PDF/A-1b in corso...`);
          log(`Converting to PDF/A: ${originalName}`);
          await convertToPdfA(file.path, tempConvertedPath);
          sendLog(`${fileLabel} Conversione PDF/A-1b completata.`);
        } catch (err: any) {
          log(`Error converting ${originalName}: ${err.message}`);
          throw new Error(`Errore nella conversione di ${originalName}: ${err.message}`);
        }

        const convertedSize = fs.statSync(tempConvertedPath).size;
        sendLog(`${fileLabel} Dimensione convertita: ${(convertedSize / 1024 / 1024).toFixed(2)} MB`);
        log(`Converted size: ${(convertedSize / 1024 / 1024).toFixed(2)} MB`);

        if (convertedSize > MAX_SIZE_BYTES) {
          sendLog(`${fileLabel} File superiore a 9MB, divisione in parti...`);
          log(`Output > 9MB, splitting original PDF and converting each part separately...`);

          const pageRanges = await findPageRangesForSize(tempConvertedPath, MAX_SIZE_BYTES);
          fs.unlinkSync(tempConvertedPath);

          sendLog(`${fileLabel} Diviso in ${pageRanges.length} parti. Conversione di ogni parte...`);

          const partsDetail: PartVerification[] = [];
          for (let i = 0; i < pageRanges.length; i++) {
            const { start, end } = pageRanges[i];
            const partOrigPath = path.join(splitDir, `${originalBaseName}_orig_part${i + 1}.pdf`);
            await execFileAsync("qpdf", [
              file.path,
              "--pages", file.path, `${start}-${end}`, "--",
              partOrigPath,
            ]);

            const finalName = `${outputBaseName}_parte${i + 1}.pdf`;
            const finalPath = path.join(convertedDir, finalName);

            sendLog(`${fileLabel} Conversione parte ${i + 1}/${pageRanges.length} (pagine ${start}-${end})...`);
            log(`  Converting part ${i + 1} (pages ${start}-${end}) to PDF/A...`);
            await convertToPdfA(partOrigPath, finalPath);
            try { fs.unlinkSync(partOrigPath); } catch {}

            const partSize = fs.statSync(finalPath).size;
            const verification = await verifyPdfA(finalPath);
            partsDetail.push({ name: finalName, size: partSize, verified: verification.valid, conformance: verification.conformance });
            const partMB = (partSize / 1024 / 1024).toFixed(2);
            if (partSize > MAX_SIZE_BYTES) {
              sendLog(`${fileLabel} ⚠ ATTENZIONE: Parte ${i + 1} (${partMB} MB) supera il limite di 9MB! Contiene pagine troppo grandi per essere ulteriormente divise.`);
              log(`  WARNING: Part ${i + 1}: ${finalName} (${partMB} MB) EXCEEDS 9MB LIMIT`);
            } else {
              sendLog(`${fileLabel} Parte ${i + 1}: ${finalName} (${partMB} MB) - ${verification.valid ? verification.conformance : "Non conforme"}`);
              log(`  Part ${i + 1}: ${finalName} (${partMB} MB) - ${verification.valid ? verification.conformance : "NON CONFORME"}`);
            }
          }

          const allVerified = partsDetail.every(p => p.verified);
          results.push({
            originalName,
            outputName: outputBaseName,
            outputSize: partsDetail.reduce((acc, f) => acc + f.size, 0),
            wasSplit: true,
            parts: partsDetail.length,
            verified: allVerified,
            conformance: allVerified ? partsDetail[0].conformance : null,
            partsDetail,
          });
        } else {
          const outputFileName = `${outputBaseName}.pdf`;
          const finalPath = path.join(convertedDir, outputFileName);
          fs.renameSync(tempConvertedPath, finalPath);

          sendLog(`${fileLabel} Verifica conformità PDF/A-1b...`);
          const verification = await verifyPdfA(finalPath);
          sendLog(`${fileLabel} ${verification.valid ? `Conforme: ${verification.conformance}` : "Attenzione: non conforme"}`);
          log(`Verification: ${verification.valid ? verification.conformance : "NON CONFORME"}`);

          results.push({
            originalName,
            outputName: outputFileName,
            outputSize: convertedSize,
            wasSplit: false,
            verified: verification.valid,
            conformance: verification.conformance,
          });
        }

        try { fs.unlinkSync(file.path); } catch {}
      }

      const zipBaseName = customName && files.length === 1 ? customName : files.map(f => {
        const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
        return path.parse(name).name;
      }).join("_");
      fs.writeFileSync(path.join(sessionDir, "original_names.json"), JSON.stringify([zipBaseName]));

      sendLog("Elaborazione completata. File pronti per il download.");

      const resultData = {
        sessionId,
        files: results,
        totalSize: results.reduce((acc, r) => acc + r.outputSize, 0),
      };

      if (notifyEmail) {
        try {
          const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
          const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:5000";
          const downloadUrl = `${protocol}://${host}/api/download/${sessionId}`;

          await sendConversionEmail({
            recipientEmail: notifyEmail,
            fileCount: results.length,
            totalSize: resultData.totalSize,
            fileDetails: results.map(r => ({
              name: r.outputName,
              size: r.outputSize,
              verified: r.verified,
              conformance: r.conformance,
              wasSplit: r.wasSplit,
              parts: r.parts,
            })),
            downloadUrl,
          });
          sendLog(`✉ Notifica email inviata a ${notifyEmail}`);
          log(`Email notification sent to ${notifyEmail}`);
        } catch (emailErr: any) {
          sendLog(`Avviso: impossibile inviare notifica email (${emailErr.message})`);
          log(`Email notification failed: ${emailErr.message}`);
        }
      }

      broadcastToSession(sessionId, { type: "result", data: resultData });
      const session = progressStore.get(sessionId);
      if (session) session.done = true;
      cleanupSession(sessionId);
    } catch (err: any) {
      cleanupDir(sessionDir);
      for (const file of files) {
        try { fs.unlinkSync(file.path); } catch {}
      }
      broadcastToSession(sessionId, { type: "error", message: err.message || "Errore durante la conversione" });
      const session = progressStore.get(sessionId);
      if (session) session.done = true;
      cleanupSession(sessionId);
    }
  });

  app.get("/api/progress/:sessionId", (req, res) => {
    const { sessionId } = req.params;
    const session = progressStore.get(sessionId);

    if (!session) {
      return res.status(404).json({ message: "Sessione non trovata" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    if (res.socket) {
      res.socket.setNoDelay(true);
      res.socket.setKeepAlive(true);
    }

    for (const pastEvent of session.logs) {
      res.write(`data: ${JSON.stringify(pastEvent)}\n\n`);
    }

    if (session.done) {
      res.end();
      return;
    }

    session.clients.add(res);

    req.on("close", () => {
      session.clients.delete(res);
    });
  });

  app.get("/api/download/:sessionId", (req, res) => {
    const { sessionId } = req.params;
    const convertedDir = path.join(OUTPUT_DIR, sessionId, "converted");

    if (!fs.existsSync(convertedDir)) {
      return res.status(404).json({ message: "Sessione non trovata o file già scaricati" });
    }

    const pdfFiles = fs.readdirSync(convertedDir).filter(f => f.endsWith(".pdf"));

    if (pdfFiles.length === 0) {
      return res.status(404).json({ message: "Nessun file convertito trovato" });
    }

    let zipFileName = "file_convertiti_pdfa.zip";
    const metaPath = path.join(OUTPUT_DIR, sessionId, "original_names.json");
    if (fs.existsSync(metaPath)) {
      try {
        const names: string[] = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        if (names.length === 1) {
          zipFileName = `${names[0]}_convertito_pdfa.zip`;
        } else {
          zipFileName = `${names.join("_")}_convertito_pdfa.zip`;
        }
      } catch {}
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(zipFileName)}"`);

    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("error", (err) => {
      log(`ZIP error: ${err.message}`);
      res.status(500).end();
    });

    archive.pipe(res);

    for (const file of pdfFiles) {
      archive.file(path.join(convertedDir, file), { name: file });
    }

    archive.finalize();

    res.on("finish", () => {
      log(`Download completed for session ${sessionId}, cleaning up...`);
      cleanupDir(path.join(OUTPUT_DIR, sessionId));
    });
  });

  return httpServer;
}
