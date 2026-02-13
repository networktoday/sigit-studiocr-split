import { useState, useCallback, useRef, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  FileText,
  Upload,
  Loader2,
  Download,
  X,
  FileCheck,
  Archive,
  ShieldCheck,
  ShieldX,
  Pencil,
  Play,
  Mail,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "@/hooks/use-toast";

type ProcessingStep = "pending" | "uploading" | "processing" | "done" | "error";

interface FileItem {
  id: string;
  name: string;
  size: number;
  file: File;
  status: ProcessingStep;
  progress: number;
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

interface ConversionResult {
  sessionId: string;
  files: ConvertedFile[];
  totalSize: number;
}

export default function Converter() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);
  const [conversionResult, setConversionResult] = useState<ConversionResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [customName, setCustomName] = useState("");
  const [isStaged, setIsStaged] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [logMessages, setLogMessages] = useState<string[]>([]);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const [notifyEmail, setNotifyEmail] = useState("");
  const [emailSent, setEmailSent] = useState(false);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logMessages]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return;

    setErrorMessage(null);
    setIsCompleted(false);
    setConversionResult(null);

    const newFiles = acceptedFiles.map((file) => ({
      id: Math.random().toString(36).substring(7),
      name: file.name,
      size: file.size,
      file,
      status: "pending" as ProcessingStep,
      progress: 0,
    }));

    setFiles(newFiles);
    setIsStaged(true);

    if (acceptedFiles.length === 1) {
      const baseName = acceptedFiles[0].name.replace(/\.pdf$/i, "");
      setCustomName(baseName);
    } else {
      setCustomName("");
    }
  }, []);

  const startConversion = async () => {
    if (files.length === 0) return;

    setIsProcessing(true);
    setErrorMessage(null);
    setLogMessages([]);

    const formData = new FormData();
    files.forEach((f) => {
      formData.append("files", f.file);
    });

    if (customName.trim() && files.length === 1) {
      formData.append("customName", customName.trim());
    }

    if (notifyEmail.trim()) {
      formData.append("notifyEmail", notifyEmail.trim());
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setFiles((prev) => prev.map((f) => ({ ...f, status: "uploading", progress: 30 })));

    try {
      const response = await fetch("/api/convert", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      setFiles((prev) => prev.map((f) => ({ ...f, status: "processing", progress: 60 })));

      if (!response.body) {
        throw new Error("Errore: risposta senza contenuto");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalResult: ConversionResult | null = null;
      let streamError: string | null = null;
      let emailConfirmed = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "log") {
              setLogMessages((prev) => [...prev, parsed.message]);
              if (parsed.message.includes("Notifica email inviata")) {
                emailConfirmed = true;
              }
            } else if (parsed.type === "result") {
              finalResult = parsed.data;
            } else if (parsed.type === "error") {
              streamError = parsed.message;
            }
          } catch {}
        }
      }

      if (streamError) {
        throw new Error(streamError);
      }

      if (!finalResult) {
        throw new Error("Nessun risultato ricevuto dal server");
      }

      setConversionResult(finalResult);
      setFiles((prev) => prev.map((f) => ({ ...f, status: "done", progress: 100 })));
      setIsProcessing(false);
      setIsCompleted(true);
      setIsStaged(false);
      setEmailSent(emailConfirmed);

      toast({
        title: "Conversione Completata",
        description: emailConfirmed
          ? "File convertiti in PDF/A-1b. Notifica email inviata."
          : "Tutti i file sono stati convertiti in formato PDF/A-1b e sono pronti per il download.",
      });
    } catch (err: any) {
      if (err.name === "AbortError") return;

      setFiles((prev) => prev.map((f) => ({ ...f, status: "error", progress: 0 })));
      setIsProcessing(false);
      setErrorMessage(err.message || "Errore sconosciuto durante la conversione");

      toast({
        title: "Errore",
        description: err.message || "Errore durante la conversione dei file.",
        variant: "destructive",
      });
    }
  };

  const removeFile = (id: string) => {
    setFiles((prev) => {
      const updated = prev.filter((f) => f.id !== id);
      if (updated.length === 0) {
        setIsStaged(false);
        setCustomName("");
      } else if (updated.length === 1) {
        setCustomName(updated[0].name.replace(/\.pdf$/i, ""));
      }
      return updated;
    });
  };

  const clearAll = () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    setFiles([]);
    setIsCompleted(false);
    setIsProcessing(false);
    setConversionResult(null);
    setErrorMessage(null);
    setCustomName("");
    setIsStaged(false);
    setLogMessages([]);
    setNotifyEmail("");
    setEmailSent(false);
  };

  const handleDownload = () => {
    if (!conversionResult) return;
    window.open(`/api/download/${conversionResult.sessionId}`, "_blank");
    toast({
      title: "Download avviato",
      description: "Il tuo archivio ZIP si sta scaricando.",
    });
  };

  return (
    <div className="min-h-screen bg-background p-6 md:p-12 font-sans text-foreground selection:bg-primary/20">
      <div className="mx-auto max-w-3xl space-y-8">

        <header className="space-y-2 text-center md:text-left">
          <div className="flex items-center justify-center md:justify-start gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary flex items-center justify-center text-primary-foreground shadow-lg shadow-primary/20">
              <FileCheck className="h-6 w-6" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight">Convertitore PDF/A-1b</h1>
          </div>
          <p className="text-muted-foreground max-w-lg mx-auto md:mx-0 text-lg">
            Conversione documenti in formato <strong>PDF/A-1b</strong> (ISO 19005-1)<br />lo standard per l'archiviazione a lungo termine.<br />I file generati non superano mai i <strong>9MB</strong> (compatibile SIGIT).
          </p>
        </header>

        {!isProcessing && !isCompleted && !isStaged && (
          <DropzoneArea onDrop={onDrop} />
        )}

        {errorMessage && !isProcessing && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 text-sm text-destructive flex items-start gap-3"
          >
            <span className="flex-1">{errorMessage}</span>
            <Button variant="ghost" size="sm" onClick={clearAll} className="text-destructive hover:text-destructive/80 h-6 px-2 text-xs">
              Riprova
            </Button>
          </motion.div>
        )}

        {(files.length > 0 || isCompleted) && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-6"
          >
            <Card className="border-none shadow-xl shadow-black/5 overflow-hidden">
              <CardContent className="p-0">
                <div className="bg-muted/30 p-4 border-b flex justify-between items-center">
                  <span className="font-medium font-mono text-sm text-muted-foreground">SESSIONE: {new Date().toLocaleDateString()}</span>
                  {(isStaged || isCompleted || errorMessage) && !isProcessing && (
                    <Button data-testid="button-clear" variant="ghost" size="sm" onClick={clearAll} className="h-8 text-xs hover:bg-destructive/10 hover:text-destructive transition-colors">
                      Ricomincia
                    </Button>
                  )}
                </div>
                <div className="divide-y max-h-[500px] overflow-y-auto">
                  <AnimatePresence>
                    {files.map((file) => (
                      <FileRow key={file.id} file={file} onRemove={removeFile} isLocked={isProcessing || isCompleted} />
                    ))}
                  </AnimatePresence>
                </div>
              </CardContent>
            </Card>

            {isStaged && !isProcessing && files.length === 1 && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-muted/50 rounded-lg p-4"
              >
                <div className="flex items-center gap-2 mb-2">
                  <Pencil className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Nome file generato</span>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    data-testid="input-custom-name"
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && startConversion()}
                    className="text-sm"
                    placeholder="Inserisci il nome del file..."
                  />
                  <span className="text-sm text-muted-foreground shrink-0">.pdf</span>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Modifica il nome prima della conversione. Se il file viene diviso, le parti saranno nominate come: {customName || "nome"}_parte1.pdf, {customName || "nome"}_parte2.pdf, ecc.
                </p>
              </motion.div>
            )}

            {isStaged && !isProcessing && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-muted/50 rounded-lg p-4"
              >
                <div className="flex items-center gap-2 mb-2">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Notifica email (opzionale)</span>
                </div>
                <Input
                  data-testid="input-notify-email"
                  type="email"
                  value={notifyEmail}
                  onChange={(e) => setNotifyEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && startConversion()}
                  className="text-sm"
                  placeholder="Inserisci la tua email per ricevere una notifica..."
                />
                <p className="text-xs text-muted-foreground mt-2">
                  Ricevi un'email con il riepilogo e il link per scaricare i file convertiti.
                </p>
              </motion.div>
            )}

            {isCompleted && emailSent && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 text-sm text-emerald-700 dark:text-emerald-400 flex items-center gap-2"
              >
                <Mail className="h-4 w-4" />
                Notifica email inviata a {notifyEmail}
              </motion.div>
            )}

            {isCompleted && conversionResult && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                className="pt-6 border-t"
              >
                <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                  <Archive className="h-5 w-5 text-primary" />
                  Riepilogo File Generati
                </h3>

                <div className="bg-muted/50 rounded-lg p-4 space-y-3">
                  {conversionResult.files.map((file, index) => {
                    if (file.wasSplit && file.partsDetail) {
                      return (
                        <div key={index} className="space-y-2">
                          <div className="text-xs text-muted-foreground font-mono mb-1">
                            {file.originalName} &rarr; diviso in {file.partsDetail.length} parti
                          </div>
                          {file.partsDetail.map((part, i) => (
                            <div key={`${index}-part-${i}`} data-testid={`row-part-${index}-${i}`} className="flex justify-between items-center text-sm pl-4">
                              <span data-testid={`text-part-name-${index}-${i}`} className="flex items-center gap-2">
                                <FileCheck className="h-4 w-4 text-emerald-500" />
                                {part.name}
                              </span>
                              <div className="flex items-center gap-3">
                                <PdfaBadge verified={part.verified} conformance={part.conformance} />
                                <span data-testid={`text-part-size-${index}-${i}`} className="font-mono text-muted-foreground">
                                  {(part.size / 1024 / 1024).toFixed(2)} MB
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    }

                    return (
                      <div key={index} data-testid={`row-file-${index}`} className="flex justify-between items-center text-sm">
                        <span data-testid={`text-output-name-${index}`} className="flex items-center gap-2">
                          <FileCheck className="h-4 w-4 text-emerald-500" />
                          {file.outputName}
                        </span>
                        <div className="flex items-center gap-3">
                          <PdfaBadge verified={file.verified} conformance={file.conformance} />
                          <span data-testid={`text-output-size-${index}`} className="font-mono text-muted-foreground">
                            {(file.outputSize / 1024 / 1024).toFixed(2)} MB
                          </span>
                        </div>
                      </div>
                    );
                  })}

                  <div className="pt-3 mt-3 border-t border-dashed flex justify-between items-center font-medium">
                    <span>Totale Archivio ZIP</span>
                    <span>
                      {(conversionResult.totalSize / 1024 / 1024).toFixed(2)} MB
                    </span>
                  </div>
                </div>
              </motion.div>
            )}

            <div className="flex justify-end pt-4">
              {isStaged && !isProcessing && (
                <Button
                  data-testid="button-convert"
                  size="lg"
                  onClick={startConversion}
                  className="w-full md:w-auto gap-2 shadow-xl shadow-primary/20"
                >
                  <Play className="h-4 w-4" /> Converti in PDF/A-1b
                </Button>
              )}
              {isCompleted ? (
                <Button
                  data-testid="button-download"
                  size="lg"
                  onClick={handleDownload}
                  className="w-full md:w-auto gap-2 shadow-xl shadow-primary/20 animate-in fade-in zoom-in duration-300"
                >
                  <Download className="h-4 w-4" /> Scarica tutto (ZIP)
                </Button>
              ) : (
                isProcessing && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground animate-pulse">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Elaborazione file in corso... non chiudere questa scheda.
                  </div>
                )
              )}
            </div>

            {(isProcessing || logMessages.length > 0) && (
              <div data-testid="console-log" className="bg-zinc-950 rounded-lg border border-zinc-800 overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-2 bg-zinc-900 border-b border-zinc-800">
                  <div className="flex gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full bg-red-500/80" />
                    <span className="h-2.5 w-2.5 rounded-full bg-yellow-500/80" />
                    <span className="h-2.5 w-2.5 rounded-full bg-green-500/80" />
                  </div>
                  <span className="text-xs font-mono text-zinc-400">Console</span>
                </div>
                <div className="p-3 max-h-48 overflow-y-auto font-mono text-xs space-y-1">
                  {logMessages.map((msg, i) => (
                    <div key={i} className="flex gap-2 text-zinc-300">
                      <span className="text-zinc-600 select-none shrink-0">{String(i + 1).padStart(2, "0")}</span>
                      <span>{msg}</span>
                    </div>
                  ))}
                  {isProcessing && (
                    <div className="flex gap-2 text-emerald-400 animate-pulse">
                      <span className="text-zinc-600 select-none shrink-0">{String(logMessages.length + 1).padStart(2, "0")}</span>
                      <span>In attesa...</span>
                    </div>
                  )}
                  <div ref={logEndRef} />
                </div>
              </div>
            )}
          </motion.div>
        )}
      </div>
    </div>
  );
}

function DropzoneArea({ onDrop }: { onDrop: (files: File[]) => void }) {
  const [rejectionError, setRejectionError] = useState<string | null>(null);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (accepted, rejected) => {
      if (rejected.length > 0) {
        const nonPdf = rejected.filter((r) =>
          r.errors.some((e) => e.code === "file-invalid-type")
        );
        if (nonPdf.length > 0) {
          const names = nonPdf.map((r) => r.file.name).join(", ");
          setRejectionError(`I seguenti file non sono in formato PDF e non possono essere caricati: ${names}`);
        } else {
          setRejectionError("Alcuni file superano il limite di 200MB.");
        }
      } else {
        setRejectionError(null);
      }
      if (accepted.length > 0) {
        onDrop(accepted);
      }
    },
    accept: {
      "application/pdf": [".pdf"],
    },
    maxSize: 200 * 1024 * 1024,
  });

  return (
    <div
      {...getRootProps()}
      data-testid="dropzone-upload"
      className={`
        relative group cursor-pointer transition-all duration-300
        ${isDragActive ? "scale-[1.02]" : ""}
      `}
    >
      <div
        className={`
        absolute -inset-1 bg-gradient-to-r from-primary/20 to-blue-600/20 rounded-2xl blur opacity-25 
        transition duration-500
        ${isDragActive ? "opacity-75 blur-md" : "group-hover:opacity-50"}
      `}
      />

      <div
        className={`
        relative block w-full rounded-xl border-2 border-dashed bg-card p-12 text-center transition-all 
        ${
          isDragActive
            ? "border-primary bg-primary/5"
            : "border-primary/30 hover:border-primary/60 hover:bg-primary/5"
        }
      `}
      >
        <div className="flex flex-col items-center gap-4">
          <div
            className={`
            h-16 w-16 rounded-full flex items-center justify-center text-primary transition-all duration-300
            ${isDragActive ? "bg-primary/20 scale-110" : "bg-primary/10 group-hover:scale-110"}
          `}
          >
            <Upload className="h-8 w-8" />
          </div>
          <div className="space-y-1">
            <h3 className="text-xl font-semibold">
              {isDragActive ? "Rilascia i file qui..." : "Trascina qui i file PDF"}
            </h3>
            <p className="text-sm text-muted-foreground">o clicca per sfogliare. Max 200MB per file.</p>
          </div>
          <div className="flex gap-2 text-xs font-mono text-muted-foreground/60 mt-4">
            <span className="px-2 py-1 bg-muted rounded">PDF 1.4+</span>
            <span className="px-2 py-1 bg-muted rounded">PDF/A-1b</span>
            <span className="px-2 py-1 bg-muted rounded">Ghostscript</span>
          </div>
        </div>
        <input {...getInputProps()} />
      </div>

      {rejectionError && (
        <div data-testid="text-rejection-error" className="mt-3 bg-destructive/10 border border-destructive/30 rounded-lg p-3 text-sm text-destructive flex items-center gap-2">
          <X className="h-4 w-4 shrink-0" />
          <span>{rejectionError}</span>
        </div>
      )}
    </div>
  );
}

function FileRow({
  file,
  onRemove,
  isLocked,
}: {
  file: FileItem;
  onRemove: (id: string) => void;
  isLocked: boolean;
}) {
  const getStatusText = (file: FileItem) => {
    switch (file.status) {
      case "uploading":
        return "Caricamento...";
      case "processing":
        return "Conversione in PDF/A...";
      case "done":
        return "Pronto";
      case "error":
        return "Errore";
      default:
        return "In attesa";
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      className="p-4 group relative"
    >
      <div className="flex items-start gap-4">
        <div className="mt-1 p-2 bg-muted rounded-md text-muted-foreground">
          {file.status === "done" ? <Archive className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
        </div>

        <div className="flex-1 space-y-2">
          <div className="flex justify-between items-center">
            <div className="flex flex-col">
              <span className="font-medium truncate max-w-[200px] md:max-w-md" title={file.name}>
                {file.name}
              </span>
              <span className="text-xs text-muted-foreground font-mono">
                {(file.size / 1024 / 1024).toFixed(2)} MB
              </span>
            </div>
            {!isLocked && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onRemove(file.id)}
                className="h-8 w-8 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>

          {file.status !== "pending" && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs font-medium">
              <span className={file.status === "done" ? "text-emerald-600" : file.status === "error" ? "text-destructive" : "text-primary"}>
                {getStatusText(file)}
              </span>
              <span className="text-muted-foreground">{file.progress}%</span>
            </div>
            <Progress value={file.progress} className="h-1.5" />
          </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function PdfaBadge({ verified, conformance }: { verified: boolean; conformance: string | null }) {
  if (verified) {
    return (
      <span data-testid="badge-pdfa-verified" className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
        <ShieldCheck className="h-3.5 w-3.5" />
        {conformance || "PDF/A"} verificato
      </span>
    );
  }

  return (
    <span data-testid="badge-pdfa-failed" className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
      <ShieldX className="h-3.5 w-3.5" />
      Non conforme
    </span>
  );
}
