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

  const avgPageSize = fileSize / totalPages;
  const pagesPerPart = Math.max(1, Math.floor(maxSize / avgPageSize));

  const parts: string[] = [];
  let startPage = 1;
  let partIndex = 1;

  while (startPage <= totalPages) {
    const endPage = Math.min(startPage + pagesPerPart - 1, totalPages);
    const partPath = path.join(outputDir, `${baseName}__tmp_part${partIndex}.pdf`);

    await execFileAsync("qpdf", [
      inputPath,
      "--pages", inputPath, `${startPage}-${endPage}`, "--",
      partPath,
    ]);

    const partSize = fs.statSync(partPath).size;
    if (partSize > maxSize && endPage > startPage) {
      fs.unlinkSync(partPath);
      const halfPages = Math.max(1, Math.floor((endPage - startPage + 1) / 2));
      const firstHalfEnd = startPage + halfPages - 1;

      const firstPath = path.join(outputDir, `${baseName}__tmp_part${partIndex}.pdf`);
      await execFileAsync("qpdf", [
        inputPath,
        "--pages", inputPath, `${startPage}-${firstHalfEnd}`, "--",
        firstPath,
      ]);
      parts.push(firstPath);
      partIndex++;

      const secondPath = path.join(outputDir, `${baseName}__tmp_part${partIndex}.pdf`);
      await execFileAsync("qpdf", [
        inputPath,
        "--pages", inputPath, `${firstHalfEnd + 1}-${endPage}`, "--",
        secondPath,
      ]);
      parts.push(secondPath);
      partIndex++;
    } else {
      parts.push(partPath);
      partIndex++;
    }

    startPage = endPage + 1;
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

          const finalParts: { name: string; size: number }[] = [];
          for (let i = 0; i < parts.length; i++) {
            const finalName = `${baseName}_parte${i + 1}.pdf`;
            const finalPath = path.join(convertedDir, finalName);
            if (parts[i] !== finalPath) {
              fs.renameSync(parts[i], finalPath);
            }
            const partSize = fs.statSync(finalPath).size;
            finalParts.push({ name: finalName, size: partSize });
            log(`  Part ${i + 1}: ${finalName} (${(partSize / 1024 / 1024).toFixed(2)} MB)`);
          }

          fs.unlinkSync(tempConvertedPath);

          results.push({
            originalName,
            outputName: baseName,
            outputSize: finalParts.reduce((acc, f) => acc + f.size, 0),
            wasSplit: true,
            parts: finalParts.length,
          });
        } else {
          const finalPath = path.join(convertedDir, originalName);
          fs.renameSync(tempConvertedPath, finalPath);

          results.push({
            originalName,
            outputName: originalName,
            outputSize: convertedSize,
            wasSplit: false,
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
