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

async function splitToFitSize(inputPath: string, outputDir: string, baseName: string, maxSize: number): Promise<string[]> {
  const totalPages = await getPageCount(inputPath);
  const fileSize = fs.statSync(inputPath).size;

  if (totalPages <= 1 || fileSize <= maxSize) {
    return [inputPath];
  }

  let tmpCounter = 0;

  async function tryExtract(start: number, end: number): Promise<{ path: string; size: number }> {
    tmpCounter++;
    const tmpPath = path.join(outputDir, `${baseName}__tmp_${tmpCounter}.pdf`);
    await execFileAsync("qpdf", [
      inputPath,
      "--pages", inputPath, `${start}-${end}`, "--",
      tmpPath,
    ]);
    const size = fs.statSync(tmpPath).size;
    return { path: tmpPath, size };
  }

  async function findMaxPages(start: number, maxEnd: number): Promise<{ endPage: number; filePath: string }> {
    let result = await tryExtract(start, maxEnd);
    if (result.size <= maxSize) {
      return { endPage: maxEnd, filePath: result.path };
    }
    fs.unlinkSync(result.path);

    if (start === maxEnd) {
      log(`  Warning: single page ${start} is ${(result.size / 1024 / 1024).toFixed(2)} MB (exceeds limit), keeping as-is`);
      const single = await tryExtract(start, start);
      return { endPage: start, filePath: single.path };
    }

    let lo = start;
    let hi = maxEnd - 1;
    let bestEnd = start;
    let bestPath = "";

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      result = await tryExtract(start, mid);

      if (result.size <= maxSize) {
        if (bestPath) {
          try { fs.unlinkSync(bestPath); } catch {}
        }
        bestEnd = mid;
        bestPath = result.path;
        lo = mid + 1;
      } else {
        fs.unlinkSync(result.path);
        hi = mid - 1;
      }
    }

    if (!bestPath) {
      const single = await tryExtract(start, start);
      return { endPage: start, filePath: single.path };
    }

    return { endPage: bestEnd, filePath: bestPath };
  }

  const parts: string[] = [];
  let currentPage = 1;

  while (currentPage <= totalPages) {
    const { endPage, filePath } = await findMaxPages(currentPage, totalPages);
    parts.push(filePath);
    log(`  Split: pages ${currentPage}-${endPage} (${(fs.statSync(filePath).size / 1024 / 1024).toFixed(2)} MB)`);
    currentPage = endPage + 1;
  }

  return parts;
}

async function convertToPdfA(inputPath: string, outputPath: string): Promise<void> {
  const args = [
    "-dPDFA=1",
    "-dBATCH",
    "-dNOPAUSE",
    "-dNOOUTERSAVE",
    "-sColorConversionStrategy=UseDeviceIndependentColor",
    "-sDEVICE=pdfwrite",
    "-dPDFACompatibilityPolicy=1",
    `-sOutputFile=${outputPath}`,
    inputPath,
  ];

  await execFileAsync("gs", args);
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

    const sessionId = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    const sessionDir = path.join(OUTPUT_DIR, sessionId);
    const splitDir = path.join(sessionDir, "split");
    const convertedDir = path.join(sessionDir, "converted");

    ensureDir(sessionDir);
    ensureDir(splitDir);
    ensureDir(convertedDir);

    const results: ConvertedFile[] = [];

    try {
      for (const file of files) {
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const baseName = path.parse(originalName).name;
        const stat = fs.statSync(file.path);

        log(`Processing: ${originalName} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

        const tempConvertedPath = path.join(splitDir, `${baseName}_pdfa_full.pdf`);

        try {
          log(`Converting to PDF/A: ${originalName}`);
          await convertToPdfA(file.path, tempConvertedPath);
        } catch (err: any) {
          log(`Error converting ${originalName}: ${err.message}`);
          throw new Error(`Errore nella conversione di ${originalName}: ${err.message}`);
        }

        const convertedSize = fs.statSync(tempConvertedPath).size;
        log(`Converted size: ${(convertedSize / 1024 / 1024).toFixed(2)} MB`);

        if (convertedSize > MAX_SIZE_BYTES) {
          log(`Output > 9MB, splitting converted PDF/A with QPDF...`);
          const parts = await splitToFitSize(tempConvertedPath, convertedDir, baseName, MAX_SIZE_BYTES);

          const partsDetail: PartVerification[] = [];
          for (let i = 0; i < parts.length; i++) {
            const finalName = `${baseName}_parte${i + 1}.pdf`;
            const finalPath = path.join(convertedDir, finalName);
            if (parts[i] !== finalPath) {
              fs.renameSync(parts[i], finalPath);
            }
            const partSize = fs.statSync(finalPath).size;
            const verification = await verifyPdfA(finalPath);
            partsDetail.push({ name: finalName, size: partSize, verified: verification.valid, conformance: verification.conformance });
            log(`  Part ${i + 1}: ${finalName} (${(partSize / 1024 / 1024).toFixed(2)} MB) - ${verification.valid ? verification.conformance : "NON CONFORME"}`);
          }

          fs.unlinkSync(tempConvertedPath);

          const allVerified = partsDetail.every(p => p.verified);
          results.push({
            originalName,
            outputName: baseName,
            outputSize: partsDetail.reduce((acc, f) => acc + f.size, 0),
            wasSplit: true,
            parts: partsDetail.length,
            verified: allVerified,
            conformance: allVerified ? partsDetail[0].conformance : null,
            partsDetail,
          });
        } else {
          const finalPath = path.join(convertedDir, originalName);
          fs.renameSync(tempConvertedPath, finalPath);

          const verification = await verifyPdfA(finalPath);
          log(`Verification: ${verification.valid ? verification.conformance : "NON CONFORME"}`);

          results.push({
            originalName,
            outputName: originalName,
            outputSize: convertedSize,
            wasSplit: false,
            verified: verification.valid,
            conformance: verification.conformance,
          });
        }

        try { fs.unlinkSync(file.path); } catch {}
      }

      const originalNames = files.map(f => {
        const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
        return path.parse(name).name;
      });
      fs.writeFileSync(path.join(sessionDir, "original_names.json"), JSON.stringify(originalNames));

      return res.json({
        sessionId,
        files: results,
        totalSize: results.reduce((acc, r) => acc + r.outputSize, 0),
      });
    } catch (err: any) {
      cleanupDir(sessionDir);
      // Cleanup uploaded files
      for (const file of files) {
        try { fs.unlinkSync(file.path); } catch {}
      }
      return res.status(500).json({ message: err.message || "Errore durante la conversione" });
    }
  });

  app.post("/api/rename/:sessionId", (req, res) => {
    const { sessionId } = req.params;
    const { newBaseName } = req.body;
    const sessionDir = path.join(OUTPUT_DIR, sessionId);
    const convertedDir = path.join(sessionDir, "converted");

    if (!newBaseName || typeof newBaseName !== "string" || newBaseName.trim().length === 0) {
      return res.status(400).json({ message: "Nome non valido" });
    }

    if (!fs.existsSync(convertedDir)) {
      return res.status(404).json({ message: "Sessione non trovata" });
    }

    const metaPath = path.join(sessionDir, "original_names.json");
    if (fs.existsSync(metaPath)) {
      try {
        const names: string[] = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        if (names.length > 1) {
          return res.status(400).json({ message: "La rinomina non è disponibile per sessioni con più file originali" });
        }
      } catch {}
    }

    const sanitized = newBaseName.trim().replace(/[<>:"/\\|?*]/g, "_");
    const pdfFiles = fs.readdirSync(convertedDir).filter(f => f.endsWith(".pdf")).sort();

    const renamedFiles: { oldName: string; newName: string; size: number }[] = [];

    if (pdfFiles.length === 1) {
      const oldPath = path.join(convertedDir, pdfFiles[0]);
      const newName = `${sanitized}.pdf`;
      const newPath = path.join(convertedDir, newName);
      fs.renameSync(oldPath, newPath);
      renamedFiles.push({ oldName: pdfFiles[0], newName, size: fs.statSync(newPath).size });
    } else {
      const tempNames: { oldPath: string; newName: string }[] = [];
      for (let i = 0; i < pdfFiles.length; i++) {
        const oldPath = path.join(convertedDir, pdfFiles[i]);
        const newName = `${sanitized}_parte${i + 1}.pdf`;
        tempNames.push({ oldPath, newName });
      }
      for (const { oldPath, newName } of tempNames) {
        const tmpPath = oldPath + ".tmp_rename";
        fs.renameSync(oldPath, tmpPath);
      }
      for (let i = 0; i < tempNames.length; i++) {
        const tmpPath = tempNames[i].oldPath + ".tmp_rename";
        const newPath = path.join(convertedDir, tempNames[i].newName);
        fs.renameSync(tmpPath, newPath);
        renamedFiles.push({ oldName: pdfFiles[i], newName: tempNames[i].newName, size: fs.statSync(newPath).size });
      }
    }

    fs.writeFileSync(path.join(sessionDir, "original_names.json"), JSON.stringify([sanitized]));

    log(`Renamed files in session ${sessionId}: ${renamedFiles.map(r => r.newName).join(", ")}`);
    return res.json({ files: renamedFiles });
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
