// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Core types for binary file ingestion.
 *
 * A `FileHandler` claims one or more file extensions and produces an
 * HTML sidecar (plus optional asset files) from a binary source. The
 * watcher dispatches to handlers via the registry in `./index.ts`; the
 * runner (`./runner.ts`) handles atomic write, sidecar sync, and
 * re-extraction skip rules.
 *
 * Adding a format = drop a new module here, export a FileHandler,
 * register it. Everything else (install-deps, dispatch, observability)
 * derives from the registry.
 */

/** Declarative dependency on an external tool, package, or env var. */
export interface DependencySpec {
  kind: "system_binary" | "python_package" | "node_package";
  /** Binary name (`pandoc`), package name (`pymupdf`), etc. */
  name: string;
  /** Semver-ish, advisory only — install-deps shows it as a hint. */
  versionConstraint?: string;
  /** Per-platform install hints printed by install-deps on miss. */
  installHint: {
    mac: string;
    linux: string;
    windows?: string;
  };
}

/**
 * Resolved paths to installed adapters. Populated by `install-deps`
 * into `~/.arkeon-wiki/adapters.json`, read at extraction time.
 */
export interface AdaptersManifest {
  /** Schema version — bump when shape changes. */
  schema_version: 1;
  python?: {
    /** Absolute path to the venv's `python` binary. */
    path: string;
    version: string;
  };
  /** Absolute paths to system binaries (`pandoc`, `ffmpeg`, ...). */
  system_binaries: Record<string, { path: string; version?: string }>;
  /** Python packages confirmed importable in the venv. */
  python_packages: Record<string, { version: string }>;
  /** When this manifest was last written. */
  generated_at: string;
}

export interface ExtractContext {
  /** Absolute path to the binary on disk. */
  absPath: string;
  /** Path relative to the watched root, e.g. "sources/paper.pdf". */
  relativePath: string;
  /** Resolved adapters from `~/.arkeon-wiki/adapters.json`. */
  adapters: AdaptersManifest;
  /**
   * Absolute path to the asset directory the handler should write into.
   * Pre-created by the runner; cleared between invocations. Handlers
   * write whatever PNG/JPG/etc. files they want here.
   */
  assetsDir: string;
  /**
   * Basename of `assetsDir`. Use this to construct `<img src=>` paths
   * in the sidecar HTML — e.g., `<img src="paper.pdf.assets/page-1.png">`.
   * The path is sidecar-relative because both live in the same parent dir.
   */
  assetsRelDir: string;
  /** Cancellation signal — daemon shutdown / timeout. */
  signal: AbortSignal;
  log: (level: "info" | "warn" | "error", msg: string) => void;
}

export interface ExtractResult {
  /** Full HTML document: <!DOCTYPE>+<html>+<head>+<body>. */
  html: string;
  /**
   * Identifier for the path through the handler. Stored as the
   * sidecar's `extracted_by` tag so re-extraction can detect
   * already-processed sidecars vs. manual ones.
   */
  extractedBy: string;
  /** Soft issues from the extractor — go into the daemon log. */
  warnings?: string[];
}

export interface FileHandler {
  /** Identifier for logs, adapters.json, telemetry. */
  name: string;
  /** Lowercase extensions including the dot. e.g. [".pdf"]. */
  extensions: readonly string[];
  /** Declarative dependency manifest — drives install-deps. */
  dependencies: readonly DependencySpec[];
  /** Run the extraction. Throws on unrecoverable failure. */
  extract(ctx: ExtractContext): Promise<ExtractResult>;
}
