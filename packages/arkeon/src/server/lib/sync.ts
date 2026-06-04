// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Core sync primitive: bridge files on disk to artifact rows in SQLite.
 *
 * `syncFile()` is the heart of arkeon-wiki. It reads a file from the
 * filesystem, parses it, and upserts the corresponding artifact +
 * link rows + FTS5 entry. Path is identity.
 */

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { createHash } from "node:crypto";

import { posix } from "node:path";

import { createSql, withTransaction } from "./sql.js";
import { classifyFile } from "./fs-watcher.js";
import { parseHtmlMeta } from "./html-meta.js";
import { extractHtmlLinks } from "./html-links.js";
import { extractMarkdownLinks } from "./md-links.js";

export type ArtifactKind = "text" | "asset";

export interface SyncResult {
  action: "created" | "updated" | "unchanged" | "noop";
  kind: ArtifactKind;
  label: string;
  linksExtracted: number;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function fileContentHash(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Cheap change-detection fingerprint stored alongside `source_hash`.
 * `mtime_ms-size_bytes`. When unchanged, the sync path skips the
 * content read AND the hash recomputation.
 */
function statFingerprint(stats: { mtimeMs: number; size: number }): string {
  return `${stats.mtimeMs}-${stats.size}`;
}

function isHtmlPath(relativePath: string): boolean {
  const ext = extname(relativePath).toLowerCase();
  return ext === ".html" || ext === ".htm";
}

function isMarkdownPath(relativePath: string): boolean {
  const ext = extname(relativePath).toLowerCase();
  return ext === ".md" || ext === ".markdown";
}

/**
 * Sidecars at `.sidecars/<mirrored>.html` get their label from the
 * underlying binary's basename (without the binary extension) instead
 * of the embedded `<title>`. Keeps asset.label and sidecar.label
 * matching — asset `paper.pdf` → label "paper"; sidecar
 * `.sidecars/iarpa/sources/paper.pdf.html` → label "paper" too.
 * Returns null when the path isn't a sidecar.
 */
function sidecarLabel(relativePath: string): string | null {
  if (!relativePath.startsWith(".sidecars/")) return null;
  if (!relativePath.endsWith(".html")) return null;
  const inner = relativePath.slice(".sidecars/".length, -".html".length);
  if (!inner) return null;
  return basename(inner, extname(inner));
}

/**
 * Sync a single file from disk into the database.
 *
 * @param watchedRoot - Absolute path to the root the daemon is watching.
 * @param relativePath - Path relative to the watched root (forward slashes).
 */
export async function syncFile(
  watchedRoot: string,
  relativePath: string,
): Promise<SyncResult> {
  const absPath = join(watchedRoot, relativePath);

  // (1) Stat-fingerprint fast path.
  const stats = statSync(absPath);
  const fingerprint = statFingerprint(stats);

  const sql = createSql();
  const existing = await sql`
    SELECT source_hash, stat_fingerprint, kind, label
    FROM artifacts
    WHERE path = ${relativePath}
  `;

  if (
    existing.length > 0 &&
    existing[0].stat_fingerprint != null &&
    existing[0].stat_fingerprint === fingerprint
  ) {
    return {
      action: "unchanged",
      kind: existing[0].kind as ArtifactKind,
      label: existing[0].label as string,
      linksExtracted: 0,
    };
  }

  // (2) Classify and dispatch.
  const kind = classifyFile(relativePath, absPath);
  if (kind === "asset") {
    return syncAsset(relativePath, absPath, stats, fingerprint, existing[0] ?? null);
  }

  const content = readFileSync(absPath, "utf-8");
  const hash = contentHash(content);

  // (3) Touch-without-change.
  if (existing.length > 0 && existing[0].source_hash === hash) {
    await sql`
      UPDATE artifacts
      SET stat_fingerprint = ${fingerprint}
      WHERE path = ${relativePath}
    `;
    return {
      action: "unchanged",
      kind: (existing[0].kind as ArtifactKind) ?? "text",
      label: existing[0].label as string,
      linksExtracted: 0,
    };
  }

  // (4) Real content change.
  const result = await syncText(relativePath, content, hash, fingerprint, existing[0] ?? null);

  // A new text artifact may have just resolved one or more previously-
  // stuck markdown redlinks (their [[X]] target slug matches the new
  // file's basename). Run the resolver after every create so live
  // watcher writes converge, not just the initial reconcile.
  if (result.action === "created") {
    await reresolveMarkdownRedlinks();
  }
  return result;
}

async function syncText(
  relativePath: string,
  content: string,
  hash: string,
  fingerprint: string,
  existing: Record<string, unknown> | null,
): Promise<SyncResult> {
  let label: string;
  let propsJson: string;
  const resolvedLinks: { target: string; text: string | null; attrs: Record<string, string> }[] = [];

  if (isHtmlPath(relativePath)) {
    const meta = parseHtmlMeta(content);
    // Sidecars: always derive label from the binary's basename so
    // asset.label and sidecar.label match (paper.pdf → "paper" on
    // both rows). The embedded <title> is for human display, not
    // the DB label column.
    const sidecarLbl = sidecarLabel(relativePath);
    label =
      sidecarLbl ??
      meta.title ??
      basename(relativePath, extname(relativePath));
    propsJson = JSON.stringify(meta.properties);
    for (const l of extractHtmlLinks(content, relativePath)) {
      if (l.resolved == null) continue;
      resolvedLinks.push({
        target: l.resolved,
        text: l.text || null,
        attrs: l.data ?? {},
      });
    }
  } else if (isMarkdownPath(relativePath)) {
    label = basename(relativePath, extname(relativePath));
    propsJson = JSON.stringify({ file_type: extname(relativePath).slice(1) });
    const sql = createSql();
    const pathRows = await sql`SELECT path FROM artifacts`;
    const known = new Set<string>();
    for (const row of pathRows) known.add(row.path as string);
    for (const l of extractMarkdownLinks(content, relativePath, known)) {
      if (l.resolved == null) continue;
      resolvedLinks.push({
        target: l.resolved,
        text: l.text || null,
        attrs: l.data ?? {},
      });
    }
  } else {
    label = basename(relativePath, extname(relativePath));
    propsJson = JSON.stringify({ file_type: extname(relativePath).slice(1) || "unknown" });
  }

  await withTransaction(async (tx) => {
    if (existing) {
      await tx`
        UPDATE artifacts
        SET label = ${label},
            source_hash = ${hash},
            stat_fingerprint = ${fingerprint},
            properties = ${propsJson},
            kind = 'text',
            updated_at = datetime('now')
        WHERE path = ${relativePath}
      `;
    } else {
      await tx`
        INSERT INTO artifacts (path, kind, label, source_hash, stat_fingerprint, properties, updated_at)
        VALUES (${relativePath}, 'text', ${label}, ${hash}, ${fingerprint}, ${propsJson}, datetime('now'))
      `;
    }

    // Rebuild outbound edges. One row per anchor — an article that cites
    // the same source twice with different data-* attrs gets two rows.
    await tx`DELETE FROM links WHERE source_path = ${relativePath}`;
    for (const link of resolvedLinks) {
      const attrsJson = JSON.stringify(link.attrs);
      await tx.query(
        `INSERT INTO links (source_path, target_path, link_text, attrs)
         VALUES (?, ?, ?, ?)`,
        [relativePath, link.target, link.text, attrsJson],
      );
    }

    // FTS5 upsert. Replace by delete + insert (no MERGE in SQLite FTS5).
    await tx`DELETE FROM fts_artifacts WHERE path = ${relativePath}`;
    await tx`INSERT INTO fts_artifacts (path, text) VALUES (${relativePath}, ${content})`;
  });

  return {
    action: existing ? "updated" : "created",
    kind: "text",
    label,
    linksExtracted: resolvedLinks.length,
  };
}

async function syncAsset(
  relativePath: string,
  absPath: string,
  stats: { mtimeMs: number; size: number },
  fingerprint: string,
  existing: Record<string, unknown> | null,
): Promise<SyncResult> {
  const label = basename(relativePath, extname(relativePath));
  const sql = createSql();

  const hash = await fileContentHash(absPath);

  // Touch-without-change.
  if (existing && existing.source_hash === hash) {
    await sql`
      UPDATE artifacts
      SET stat_fingerprint = ${fingerprint}
      WHERE path = ${relativePath}
    `;
    return { action: "unchanged", kind: "asset", label, linksExtracted: 0 };
  }

  const properties: Record<string, unknown> = {
    file_type: extname(relativePath).slice(1).toLowerCase() || "unknown",
    size_bytes: stats.size,
  };
  // Address of the searchable HTML sidecar a future extractor pass
  // will produce. The convention is fixed (.sidecars/<mirrored>.html);
  // the file may not exist yet (no handler registered, or extraction
  // pending) — harnesses dereference and check.
  //
  // Assets that themselves live under .sidecars/ (e.g. PDF page-render
  // PNGs at .sidecars/X.assets/page-N.png) are terminal derived state —
  // no further extractor pass will produce a sidecar from a sidecar's
  // own derived files. Omit the field rather than fabricate a doubly-
  // prefixed path (.sidecars/.sidecars/...) that points at nothing.
  if (!relativePath.startsWith(".sidecars/")) {
    properties.sidecar_path = `.sidecars/${relativePath}.html`;
  }
  const propsJson = JSON.stringify(properties);

  if (existing) {
    await sql`
      UPDATE artifacts
      SET label = ${label},
          source_hash = ${hash},
          stat_fingerprint = ${fingerprint},
          properties = ${propsJson},
          kind = 'asset',
          updated_at = datetime('now')
      WHERE path = ${relativePath}
    `;
    return { action: "updated", kind: "asset", label, linksExtracted: 0 };
  }

  await sql`
    INSERT INTO artifacts (path, kind, label, source_hash, stat_fingerprint, properties, updated_at)
    VALUES (${relativePath}, 'asset', ${label}, ${hash}, ${fingerprint}, ${propsJson}, datetime('now'))
  `;
  return { action: "created", kind: "asset", label, linksExtracted: 0 };
}

/**
 * Remove an artifact when its file disappears from disk. Inbound links
 * survive (target_path has no FK), becoming redlinks naturally.
 */
export async function removeByPath(relativePath: string): Promise<boolean> {
  const sql = createSql();
  const rows = await sql`
    DELETE FROM artifacts
    WHERE path = ${relativePath}
    RETURNING source_hash
  `;
  if (rows.length > 0) {
    await sql`DELETE FROM fts_artifacts WHERE path = ${relativePath}`;
    return true;
  }
  return false;
}

/**
 * Sync a list of files in one pass, then remove rows whose files no
 * longer exist on disk. Reconcile walk.
 *
 * `failed` counts files whose syncFile call threw — the loop continues
 * past errors so one corrupt file doesn't stop the sweep, but the
 * caller (POST /reconcile, periodic sweep) gets a real number back
 * instead of a silent log entry.
 */
export async function syncDirectory(
  watchedRoot: string,
  files: string[],
): Promise<{
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  failed: number;
}> {
  const summary = { created: 0, updated: 0, unchanged: 0, removed: 0, failed: 0 };

  for (const file of files) {
    try {
      const result = await syncFile(watchedRoot, file);
      if (result.action === "created") summary.created++;
      else if (result.action === "updated") summary.updated++;
      else if (result.action === "unchanged") summary.unchanged++;
    } catch (err) {
      summary.failed++;
      console.error(`[sync] failed ${file}: ${(err as Error).message}`);
    }
  }

  const sql = createSql();
  const dbArtifacts = await sql`SELECT path FROM artifacts`;
  for (const row of dbArtifacts) {
    const p = row.path as string;
    if (!existsSync(join(watchedRoot, p))) {
      if (await removeByPath(p)) summary.removed++;
    }
  }

  // Second pass: re-resolve markdown redlinks whose target slug now
  // matches an artifact basename. Necessary because syncFile resolves
  // [[X]] against the index as it stood when the source was synced —
  // if A.md was processed before B.md was indexed, A's link to [[B]]
  // got persisted as a literal "B" redlink and would never converge
  // without this sweep.
  await reresolveMarkdownRedlinks();

  return summary;
}

/**
 * Walk every unresolved slug-form redlink and re-resolve against the
 * current artifact index. Called after `syncDirectory` (reconcile case)
 * and after every `syncFile` create (live watcher case) so markdown
 * link resolution converges regardless of file-arrival order.
 */
export async function reresolveMarkdownRedlinks(): Promise<void> {
  const sql = createSql();
  const rows = (await sql`
    SELECT DISTINCT l.target_path
    FROM links l
    LEFT JOIN artifacts a ON a.path = l.target_path
    WHERE a.path IS NULL AND l.target_path NOT LIKE '%/%'
  `) as { target_path: string }[];
  if (rows.length === 0) return;

  const allRows = (await sql`SELECT path FROM artifacts`) as { path: string }[];
  // Index artifacts by both basename and basename-without-extension
  // so [[paper]] resolves to paper.pdf.html and [[paper.pdf.html]] also
  // resolves. Ambiguous basenames (>1 match) are skipped — the user can
  // disambiguate with [[folder/X]].
  const byBase: Record<string, string[]> = {};
  for (const r of allRows) {
    const b = posix.basename(r.path).toLowerCase();
    const s = b.replace(/\.[^.]+$/, "");
    (byBase[b] ??= []).push(r.path);
    if (s !== b) (byBase[s] ??= []).push(r.path);
  }

  for (const row of rows) {
    const slug = row.target_path.toLowerCase();
    const candidates = byBase[slug];
    if (!candidates || candidates.length !== 1) continue;
    await sql.query(
      `UPDATE links SET target_path = ? WHERE target_path = ?`,
      [candidates[0], row.target_path],
    );
  }
}
