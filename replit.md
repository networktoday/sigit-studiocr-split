# Overview

This is a **PDF to PDF/A-1b Converter** web application (Italian-language UI: "Convertitore PDF/A-1b"). Users upload PDF files through a drag-and-drop interface, and the server converts them to PDF/A-1b format (ISO 19005-1) using Ghostscript with embedded sRGB ICC profile. Large PDFs are automatically split into smaller parts to stay under a **9MB size limit** (mandatory for SIGIT - Tribunale Telematico). The converted files can be downloaded as a ZIP archive. Real-time console logs show conversion progress to the user.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend
- **Framework**: React 18 with TypeScript, bundled by Vite
- **Routing**: Wouter (lightweight client-side router) with a single main route (`/` → Converter page)
- **UI Components**: shadcn/ui component library (new-york style) built on Radix UI primitives
- **Styling**: Tailwind CSS v4 with CSS variables for theming, using `@tailwindcss/vite` plugin
- **State Management**: TanStack React Query for server state; local React state for UI
- **Animations**: Framer Motion for file upload/processing animations
- **File Upload**: react-dropzone for drag-and-drop PDF uploads
- **Fonts**: Inter (sans-serif) and JetBrains Mono (monospace) from Google Fonts

## Backend
- **Runtime**: Node.js with Express
- **Language**: TypeScript, executed via tsx
- **File Upload Handling**: Multer middleware, storing uploads in `/tmp/pdfa_uploads`
- **PDF Processing**: Uses `qpdf` system binary (via `child_process.execFile`) to count pages and split large PDFs
- **File Output**: Converted files stored in `/tmp/pdfa_output`; archiver package creates ZIP downloads for multiple files
- **Size Limit**: Files over 9MB are automatically split into smaller parts using qpdf
- **Email Notifications**: Optional email notification via SendGrid (Replit connector) when conversion completes; module in `server/email.ts`
- **API Pattern**: RESTful endpoints under `/api/` prefix

## Data Storage
- **Database Schema**: PostgreSQL via Drizzle ORM, defined in `shared/schema.ts`
- **Current Tables**: `users` table with id (UUID), username, and password fields
- **Runtime Storage**: The app currently uses an in-memory storage implementation (`MemStorage`) rather than the database for user operations. The database schema exists but isn't actively connected for the core PDF conversion feature.
- **Schema Management**: Drizzle Kit with `db:push` command for schema synchronization
- **Shared Types**: Zod schemas generated from Drizzle schemas via `drizzle-zod` for validation

## Build System
- **Development**: Vite dev server with HMR proxied through Express; tsx runs the server
- **Production Build**: Two-step process — Vite builds the client to `dist/public`, esbuild bundles the server to `dist/index.cjs`
- **Server Bundling**: Key dependencies are bundled (allowlisted) to reduce cold start syscalls; others are externalized

## Dev/Prod Mode
- In development (`NODE_ENV=development`), Vite middleware is attached to Express for HMR
- In production, Express serves static files from `dist/public` with SPA fallback to `index.html`
- Replit-specific plugins (cartographer, dev-banner, runtime-error-modal) are conditionally loaded

## Path Aliases
- `@/*` → `client/src/*`
- `@shared/*` → `shared/*`
- `@assets` → `attached_assets/`

# External Dependencies

- **PostgreSQL**: Required database, connection via `DATABASE_URL` environment variable
- **Drizzle ORM**: Database ORM with PostgreSQL dialect
- **qpdf**: System-level binary required for PDF page counting and splitting (must be installed on the system)
- **Replit Plugins**: `@replit/vite-plugin-runtime-error-modal`, `@replit/vite-plugin-cartographer`, `@replit/vite-plugin-dev-banner` for Replit platform integration
- **SendGrid**: Email service for conversion completion notifications, connected via Replit connector (`@sendgrid/mail`)
- **Google Fonts**: Inter and JetBrains Mono loaded from `fonts.googleapis.com`