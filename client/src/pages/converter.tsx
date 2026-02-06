import { useState, useCallback, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  FileText,
  Upload,
  CheckCircle2,
  Loader2,
  AlertCircle,
  Download,
  X,
  FileCheck,
  Archive,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "@/hooks/use-toast";

// Types
type ProcessingStep = "uploading" | "splitting" | "converting" | "compressing" | "done" | "error";

interface FileItem {
  id: string;
  name: string;
  size: number;
  status: ProcessingStep;
  progress: number;
  splitParts?: number;
}

export default function Converter() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);

  // Mock processing logic
  useEffect(() => {
    if (!isProcessing || files.every((f) => f.status === "done")) {
      if (files.length > 0 && files.every((f) => f.status === "done")) {
        setIsProcessing(false);
        setIsCompleted(true);
        toast({
          title: "Conversione Completata",
          description: "Tutti i file sono stati convertiti in PDF/A e sono pronti per il download.",
        });
      }
      return;
    }

    const interval = setInterval(() => {
      setFiles((currentFiles) => {
        return currentFiles.map((file) => {
          if (file.status === "done") return file;

          // State Machine for Mock Simulation
          if (file.status === "uploading") {
            if (file.progress < 100) return { ...file, progress: file.progress + 5 };
            return { ...file, status: file.size > 9 * 1024 * 1024 ? "splitting" : "converting", progress: 0 };
          }

          if (file.status === "splitting") {
            if (file.progress < 100) return { ...file, progress: file.progress + 10 };
            return { ...file, status: "converting", progress: 0, splitParts: Math.ceil(file.size / (9 * 1024 * 1024)) + 1 };
          }

          if (file.status === "converting") {
            if (file.progress < 100) return { ...file, progress: file.progress + 2 };
            return { ...file, status: "compressing", progress: 0 };
          }
          
           if (file.status === "compressing") {
            if (file.progress < 100) return { ...file, progress: file.progress + 20 };
            return { ...file, status: "done", progress: 100 };
          }

          return file;
        });
      });
    }, 200);

    return () => clearInterval(interval);
  }, [isProcessing, files]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const newFiles = acceptedFiles.map((file) => ({
      id: Math.random().toString(36).substring(7),
      name: file.name,
      size: file.size,
      status: "uploading" as ProcessingStep,
      progress: 0,
    }));

    setFiles((prev) => [...prev, ...newFiles]);
    setIsProcessing(true);
    setIsCompleted(false);
  }, []);

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const clearAll = () => {
    setFiles([]);
    setIsCompleted(false);
    setIsProcessing(false);
  };

  return (
    <div className="min-h-screen bg-background p-6 md:p-12 font-sans text-foreground selection:bg-primary/20">
      <div className="mx-auto max-w-3xl space-y-8">
        
        {/* Header */}
        <header className="space-y-2 text-center md:text-left">
          <div className="flex items-center justify-center md:justify-start gap-3">
             <div className="h-10 w-10 rounded-lg bg-primary flex items-center justify-center text-primary-foreground shadow-lg shadow-primary/20">
               <FileCheck className="h-6 w-6" />
             </div>
             <h1 className="text-3xl font-bold tracking-tight">Convertitore PDF/A</h1>
          </div>
          <p className="text-muted-foreground max-w-lg mx-auto md:mx-0 text-lg">
            Conversione sicura e conforme. I file di grandi dimensioni vengono automaticamente divisi ed elaborati.
          </p>
        </header>

        {/* Upload Area */}
        {!isProcessing && !isCompleted && (
          <DropzoneArea onDrop={onDrop} />
        )}

        {/* File List & Status */}
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
                    {isCompleted && (
                        <Button variant="ghost" size="sm" onClick={clearAll} className="h-8 text-xs hover:bg-destructive/10 hover:text-destructive transition-colors">
                          Ricomincia
                        </Button>
                    )}
                  </div>
                  <div className="divide-y max-h-[500px] overflow-y-auto">
                    <AnimatePresence>
                      {files.map((file) => (
                        <FileRow key={file.id} file={file} onRemove={removeFile} isLocked={isProcessing} />
                      ))}
                    </AnimatePresence>
                  </div>
               </CardContent>
            </Card>

            {/* Action Area */}
            <div className="flex justify-end pt-4">
               {isCompleted ? (
                 <Button size="lg" className="w-full md:w-auto gap-2 shadow-xl shadow-primary/20 animate-in fade-in zoom-in duration-300">
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
          </motion.div>
        )}
      </div>
    </div>
  );
}

// Sub-components

function DropzoneArea({ onDrop }: { onDrop: (files: File[]) => void }) {
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf']
    },
    maxSize: 50 * 1024 * 1024, // 50MB
  });

  return (
    <div 
      {...getRootProps()}
      className={`
        relative group cursor-pointer transition-all duration-300
        ${isDragActive ? 'scale-[1.02]' : ''}
      `}
    >
      <div className={`
        absolute -inset-1 bg-gradient-to-r from-primary/20 to-blue-600/20 rounded-2xl blur opacity-25 
        transition duration-500
        ${isDragActive ? 'opacity-75 blur-md' : 'group-hover:opacity-50'}
      `} />
      
      <div className={`
        relative block w-full rounded-xl border-2 border-dashed bg-card p-12 text-center transition-all 
        ${isDragActive 
          ? 'border-primary bg-primary/5' 
          : 'border-primary/30 hover:border-primary/60 hover:bg-primary/5'
        }
      `}>
        <div className="flex flex-col items-center gap-4">
          <div className={`
            h-16 w-16 rounded-full flex items-center justify-center text-primary transition-all duration-300
            ${isDragActive ? 'bg-primary/20 scale-110' : 'bg-primary/10 group-hover:scale-110'}
          `}>
            <Upload className="h-8 w-8" />
          </div>
          <div className="space-y-1">
            <h3 className="text-xl font-semibold">
              {isDragActive ? "Rilascia i file qui..." : "Trascina qui i file PDF"}
            </h3>
            <p className="text-sm text-muted-foreground">
              o clicca per sfogliare. Max 50MB per file.
            </p>
          </div>
          <div className="flex gap-2 text-xs font-mono text-muted-foreground/60 mt-4">
            <span className="px-2 py-1 bg-muted rounded">PDF 1.4+</span>
            <span className="px-2 py-1 bg-muted rounded">PDF/A-1b</span>
            <span className="px-2 py-1 bg-muted rounded">Ghostscript</span>
          </div>
        </div>
        <input {...getInputProps()} />
      </div>
    </div>
  );
}

function FileRow({ file, onRemove, isLocked }: { file: FileItem; onRemove: (id: string) => void; isLocked: boolean }) {
  const getStatusText = (file: FileItem) => {
    switch (file.status) {
      case "uploading": return "Caricamento...";
      case "splitting": return `File > 9MB. Divisione in corso...`;
      case "converting": return file.splitParts ? `Conversione di ${file.splitParts} parti in PDF/A...` : "Conversione in PDF/A...";
      case "compressing": return "Compressione in ZIP...";
      case "done": return "Pronto";
      default: return "In attesa";
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
               <span className="font-medium truncate max-w-[200px] md:max-w-md" title={file.name}>{file.name}</span>
               <span className="text-xs text-muted-foreground font-mono">{(file.size / 1024 / 1024).toFixed(2)} MB</span>
             </div>
             {!isLocked && (
               <Button variant="ghost" size="icon" onClick={() => onRemove(file.id)} className="h-8 w-8 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity">
                 <X className="h-4 w-4" />
               </Button>
             )}
          </div>
          
          <div className="space-y-1">
            <div className="flex justify-between text-xs font-medium">
               <span className={file.status === "done" ? "text-emerald-600" : "text-primary"}>
                 {getStatusText(file)}
               </span>
               <span className="text-muted-foreground">{file.progress}%</span>
            </div>
            <Progress value={file.progress} className="h-1.5" />
          </div>
        </div>
      </div>
    </motion.div>
  );
}
