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

async function splitPdfByPages(inputPath: string, baseName: string, sessionDir: string, startPage: number, endPage: number, pagesPerPart: number, startIndex: number): Promise<string[]> {
  const parts: string[] = [];
  let currentStart = startPage;
  let partIndex = startIndex;

  while (currentStart <= endPage) {
    const currentEnd = Math.min(currentStart + pagesPerPart - 1, endPage);
    const partPath = path.join(sessionDir, `${baseName}_parte${partIndex}.pdf`);

    await execFileAsync("qpdf", [
      inputPath,
      "--pages", inputPath, `${currentStart}-${currentEnd}`, "--",
      partPath,
    ]);

    parts.push(partPath);
    currentStart = currentEnd + 1;
    partIndex++;
  }

  return parts;
}

async function splitPdfWithQpdf(inputPath: string, baseName: string, sessionDir: string, targetSize: number = MAX_SIZE_BYTES * 0.75): Promise<string[]> {
  const totalPages = await getPageCount(inputPath);

  if (totalPages <= 1) {
    return [inputPath];
  }

  const stat = fs.statSync(inputPath);
  const avgPageSize = stat.size / totalPages;
  const pagesPerPart = Math.max(1, Math.floor(targetSize / avgPageSize));

  return splitPdfByPages(inputPath, baseName, sessionDir, 1, totalPages, pagesPerPart, 1);
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
        let needsSplit = stat.size > MAX_SIZE_BYTES;

        if (needsSplit) {
          log(`File > 9MB, splitting with QPDF...`);
          const parts = await splitPdfWithQpdf(file.path, baseName, splitDir);
          filesToConvert = parts.map((partPath, i) => ({
            path: partPath,
            outputName: `${baseName}_parte${i + 1}.pdf`,
          }));
        } else {
          filesToConvert = [{ path: file.path, outputName: originalName }];
        }

        const finalOutputFiles: { name: string; size: number }[] = [];

        for (const item of filesToConvert) {
          const outputPath = path.join(convertedDir, item.outputName);
          log(`Converting to PDF/A: ${item.outputName}`);

          try {
            await convertToPdfA(item.path, outputPath);
            const outStat = fs.statSync(outputPath);

            if (outStat.size > MAX_SIZE_BYTES) {
              log(`Output ${item.outputName} is ${(outStat.size / 1024 / 1024).toFixed(2)} MB (> 9MB), re-splitting...`);
              fs.unlinkSync(outputPath);

              const sourcePages = await getPageCount(item.path);
              if (sourcePages <= 1) {
                log(`Cannot split further (single page), keeping as-is`);
                await convertToPdfA(item.path, outputPath);
                const restat = fs.statSync(outputPath);
                finalOutputFiles.push({ name: item.outputName, size: restat.size });
                needsSplit = true;
              } else {
                const subParts = await splitPdfWithQpdf(item.path, path.parse(item.outputName).name, splitDir, MAX_SIZE_BYTES * 0.5);
                needsSplit = true;

                for (let si = 0; si < subParts.length; si++) {
                  const subName = `${path.parse(item.outputName).name}_${si + 1}.pdf`;
                  const subOutputPath = path.join(convertedDir, subName);
                  await convertToPdfA(subParts[si], subOutputPath);
                  const subStat = fs.statSync(subOutputPath);
                  finalOutputFiles.push({ name: subName, size: subStat.size });
                }
              }
            } else {
              finalOutputFiles.push({ name: item.outputName, size: outStat.size });
            }
          } catch (err: any) {
            log(`Error converting ${item.outputName}: ${err.message}`);
            throw new Error(`Errore nella conversione di ${item.outputName}: ${err.message}`);
          }
        }

        if (needsSplit || finalOutputFiles.length > 1) {
          results.push({
            originalName,
            outputName: baseName,
            outputSize: finalOutputFiles.reduce((acc, f) => acc + f.size, 0),
            wasSplit: true,
            parts: finalOutputFiles.length,
          });
        } else {
          results.push({
            originalName,
            outputName: finalOutputFiles[0].name,
            outputSize: finalOutputFiles[0].size,
            wasSplit: false,
          });
        }

        // Cleanup uploaded temp file
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
