import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import archiver from "archiver";
import { log } from "./index";

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
  limits: { fileSize: 200 * 1024 * 1024 },
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
const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = path.dirname(__filename_local);
async function findPageRangesForSize(convertedPdfPath: string, maxSize: number): Promise<{ start: number; end: number }[]> {
  const totalPages = await getPageCount(convertedPdfPath);
  const fileSize = fs.statSync(convertedPdfPath).size;

  if (totalPages <= 1) {
    return [{ start: 1, end: 1 }];
  }

  const tmpDir = path.dirname(convertedPdfPath);
  let tmpCounter = 0;

  async function tryExtractSize(start: number, end: number): Promise<number> {
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

  const ranges: { start: number; end: number }[] = [];
  let currentPage = 1;

  while (currentPage <= totalPages) {
    let size = await tryExtractSize(currentPage, totalPages);
    if (size <= maxSize) {
      ranges.push({ start: currentPage, end: totalPages });
      break;
    }

    let lo = currentPage;
    let hi = totalPages - 1;
    let bestEnd = currentPage;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      size = await tryExtractSize(currentPage, mid);
      if (size <= maxSize) {
        bestEnd = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    ranges.push({ start: currentPage, end: bestEnd });
    currentPage = bestEnd + 1;
  }

  return ranges;
}

const ICC_PROFILE_PATH = path.resolve(__dirname_local, "srgb.icc");
const PDFA_DEF_TEMPLATE = path.resolve(__dirname_local, "PDFA_def.ps");

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
    `-dPDFSETTINGS=/prepress`,
    `--permit-file-read=${iccPath}`,
    `-sOutputFile=${outputPath}`,
    tmpDefPath,
    inputPath,
  ];

  try {
    await execFileAsync("gs", args);
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

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.post("/api/convert", upload.array("files", 20), async (req, res) => {
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      return res.status(400).json({ message: "Nessun file caricato" });
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");

    function sendLog(message: string) {
      try {
        res.write(JSON.stringify({ type: "log", message }) + "\n");
      } catch {}
    }

    const customName = typeof req.body?.customName === "string" && req.body.customName.trim()
      ? req.body.customName.trim().replace(/[<>:"/\\|?*]/g, "_")
      : null;

    const sessionId = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    const sessionDir = path.join(OUTPUT_DIR, sessionId);
    const splitDir = path.join(sessionDir, "split");
    const convertedDir = path.join(sessionDir, "converted");

    ensureDir(sessionDir);
    ensureDir(splitDir);
    ensureDir(convertedDir);

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
            sendLog(`${fileLabel} Parte ${i + 1}: ${finalName} (${(partSize / 1024 / 1024).toFixed(2)} MB) - ${verification.valid ? verification.conformance : "Non conforme"}`);
            log(`  Part ${i + 1}: ${finalName} (${(partSize / 1024 / 1024).toFixed(2)} MB) - ${verification.valid ? verification.conformance : "NON CONFORME"}`);
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

      res.write(JSON.stringify({ type: "result", data: resultData }) + "\n");
      return res.end();
    } catch (err: any) {
      cleanupDir(sessionDir);
      for (const file of files) {
        try { fs.unlinkSync(file.path); } catch {}
      }
      res.write(JSON.stringify({ type: "error", message: err.message || "Errore durante la conversione" }) + "\n");
      return res.end();
    }
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
