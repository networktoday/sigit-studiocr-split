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

async function splitPdfWithQpdf(inputPath: string, baseName: string, sessionDir: string): Promise<string[]> {
  const pageCountResult = await execFileAsync("qpdf", ["--show-npages", inputPath]);
  const totalPages = parseInt(pageCountResult.stdout.trim(), 10);

  if (totalPages <= 1) {
    return [inputPath];
  }

  const stat = fs.statSync(inputPath);
  const avgPageSize = stat.size / totalPages;
  const pagesPerPart = Math.max(1, Math.floor(MAX_SIZE_BYTES / avgPageSize));

  const parts: string[] = [];
  let startPage = 1;
  let partIndex = 1;

  while (startPage <= totalPages) {
    const endPage = Math.min(startPage + pagesPerPart - 1, totalPages);
    const partPath = path.join(sessionDir, `${baseName}_parte${partIndex}.pdf`);

    await execFileAsync("qpdf", [
      inputPath,
      "--pages", inputPath, `${startPage}-${endPage}`, "--",
      partPath,
    ]);

    parts.push(partPath);
    startPage = endPage + 1;
    partIndex++;
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

function cleanupDir(dir: string) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

interface ConvertedFile {
  originalName: string;
  outputName: string;
  outputSize: number;
  wasSplit: boolean;
  parts?: number;
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

        let filesToConvert: { path: string; outputName: string }[] = [];

        if (stat.size > MAX_SIZE_BYTES) {
          log(`File > 9MB, splitting with QPDF...`);
          const parts = await splitPdfWithQpdf(file.path, baseName, splitDir);

          filesToConvert = parts.map((partPath, i) => ({
            path: partPath,
            outputName: `${baseName}_parte${i + 1}.pdf`,
          }));

          results.push({
            originalName,
            outputName: baseName,
            outputSize: 0,
            wasSplit: true,
            parts: parts.length,
          });
        } else {
          filesToConvert = [{ path: file.path, outputName: originalName }];
        }

        for (const item of filesToConvert) {
          const outputPath = path.join(convertedDir, item.outputName);
          log(`Converting to PDF/A: ${item.outputName}`);

          try {
            await convertToPdfA(item.path, outputPath);
            const outStat = fs.statSync(outputPath);

            if (!filesToConvert[0].outputName.includes("_parte")) {
              results.push({
                originalName,
                outputName: item.outputName,
                outputSize: outStat.size,
                wasSplit: false,
              });
            } else {
              const parentResult = results.find(r => r.wasSplit && r.outputName === baseName);
              if (parentResult) {
                parentResult.outputSize += outStat.size;
              }
            }
          } catch (err: any) {
            log(`Error converting ${item.outputName}: ${err.message}`);
            throw new Error(`Errore nella conversione di ${item.outputName}: ${err.message}`);
          }
        }

        // Cleanup uploaded temp file
        try { fs.unlinkSync(file.path); } catch {}
      }

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

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=file_convertiti_pdfa.zip");

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
