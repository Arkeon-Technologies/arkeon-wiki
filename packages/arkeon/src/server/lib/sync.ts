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
import {
  applyHeals,
  writeAtomic,
  type HrefHeal,
} from "./heal-html.js";
import { extractHtmlLinks, resolveHref } from "./html-links.js";
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
 * Given an asset's relative path, return the path of the binary it
 * was derived from (`null` if the asset is a primary, not a derived
 * one).
 *
 * Derived-asset convention: extractor outputs land under
 * `.sidecars/<mirrored-binary>.assets/<asset-name>`, where the
 * `.assets/` segment immediately precedes the asset's basename.
 * Stripping `.sidecars/` and everything from the last `.assets/`
 * onward yields the parent binary's watch-relative path.
 *
 *   `.sidecars/iarpa/paper.pdf.assets/page-1.png` → `iarpa/paper.pdf`
 */
export function detectDerivedFrom(relativePath: string): string | null {
  if (!relativePath.startsWith(".sidecars/")) return null;
  const inner = relativePath.slice(".sidecars/".length);
  const idx = inner.lastIndexOf(".assets/");
  if (idx < 0) return null;
  const assetName = inner.slice(idx + ".assets/".length);
  // Reject pathological paths where something further nested follows
  // `.assets/`. The current extractor pipeline always lands assets at
  // the immediate child of the `.assets/` directory.
  if (assetName.length === 0 || assetName.includes("/")) return null;
  return inner.slice(0, idx);
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
  const result = await syncText(
    watchedRoot,
    relativePath,
    content,
    hash,
    fingerprint,
    existing[0] ?? null,
  );

  // A new text artifact may have just resolved one or more previously-
  // stuck redlinks — both MD `[[X]]` (slug-form) and HTML hrefs whose
  // basename matches the new file (path-form, healed when X moves
  // between folders). Run the resolver after every create so live
  // watcher writes converge, not just the initial reconcile.
  if (result.action === "created") {
    await reresolveBasenameRedlinks(watchedRoot);
  }
  return result;
}

async function syncText(
  watchedRoot: string,
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
    let workingContent = content;
    const meta = parseHtmlMeta(workingContent);
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
    // Pass `known` so extractHtmlLinks can apply basename fallback
    // when a literal-relative-resolved href misses a file that's
    // been moved between folders. Same shape MD already uses.
    const sql = createSql();
    const pathRows = await sql`SELECT path FROM artifacts`;
    const known = new Set<string>();
    for (const row of pathRows) known.add(row.path as string);
    const heals: HrefHeal[] = [];
    for (const l of extractHtmlLinks(workingContent, relativePath, known)) {
      if (l.resolved == null) continue;
      // If extractHtmlLinks healed the resolution via basename
      // fallback, queue the source-file edit. The doctrine: rewrite
      // the href on disk so subsequent extractions see coherent
      // state and "view source" matches what renders.
      const literal = resolveHref(l.href, relativePath);
      if (literal !== null && literal !== l.resolved) {
        heals.push({ brokenTarget: literal, healedTarget: l.resolved });
      }
      resolvedLinks.push({
        target: l.resolved,
        text: l.text || null,
        attrs: l.data ?? {},
      });
    }
    if (heals.length > 0) {
      const healed = applyHeals(workingContent, relativePath, heals);
      if (healed.changed > 0) {
        const absPath = join(watchedRoot, relativePath);
        writeAtomic(absPath, healed.content);
        // Re-derive hash + fingerprint from the post-heal file so
        // the row we're about to write matches what's on disk —
        // when the watcher fires on our own write, it'll hit the
        // stat-fingerprint fast path and skip a redundant sync.
        workingContent = healed.content;
        hash = contentHash(workingContent);
        const newStats = statSync(absPath);
        fingerprint = statFingerprint(newStats);
      }
    }
    content = workingContent;
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
  // Derived assets (PDF page-renders, extracted figures, future
  // handler outputs) carry a pointer back to the binary they were
  // extracted from. Lets harnesses filter "what binaries do I have?"
  // (not_property: ["derived_from"]) separately from "what visual
  // assets exist?" (has_property: ["derived_from"]) without a schema
  // change.
  const derivedFrom = detectDerivedFrom(relativePath);
  if (derivedFrom !== null) {
    properties.derived_from = derivedFrom;
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

  // Second pass: re-resolve unresolved redlinks (both MD slug-form
  // and HTML path-form) whose basename now matches an artifact.
  // Necessary because syncFile resolves links against the index as it
  // stood when the source was synced — if A.md was processed before
  // B.md was indexed, A's link to [[B]] got persisted as a literal
  // "B" redlink and would never converge without this sweep. Same
  // shape applies to HTML hrefs that pointed at an old folder path.
  await reresolveBasenameRedlinks(watchedRoot);

  return summary;
}

/**
 * Walk every unresolved redlink and re-resolve against the current
 * artifact index by basename. Two shapes handled in one pass:
 *
 *   - MD slug-form (`target_path` with no slash, e.g. "B"): match
 *     against basename OR stem (with-or-without-extension), per the
 *     existing MD `[[X]]` semantics. Lets `[[paper]]` heal to
 *     `paper.pdf.html`. Index-only — the source `.md` keeps its
 *     abstract `[[X]]` syntax (that's the point of slug resolution).
 *   - HTML path-form (`target_path` with a slash, e.g.
 *     "chartbook/article-one.html"): match against the target's own
 *     basename, extension-strict. When a unique fallback exists, ALSO
 *     edit the source HTML on disk so the href spells the new path —
 *     the doctrine is that the filesystem is truth, so corrections
 *     get propagated as real file edits. Source-file write is
 *     skipped silently when the inbound source can't be read
 *     (deleted, permissions); the next reconcile retries.
 *
 * Ambiguous basenames (>1 match) are skipped in both shapes — the
 * link stays a redlink. For MD the operator can disambiguate with
 * `[[folder/X]]`; for HTML, the inbound article has to be edited
 * manually.
 *
 * Called after `syncDirectory` (reconcile case) and after every
 * `syncFile` create (live watcher case) so resolution converges
 * regardless of file-arrival order.
 */
export async function reresolveBasenameRedlinks(
  watchedRoot: string,
): Promise<void> {
  const sql = createSql();
  // Pull source_path alongside target_path so we can locate the
  // inbound article(s) for HTML source-file healing. Multiple inbound
  // articles can share the same broken target — each needs its own
  // file rewrite, so don't DISTINCT the target away.
  const rows = (await sql`
    SELECT l.source_path, l.target_path
    FROM links l
    LEFT JOIN artifacts a ON a.path = l.target_path
    WHERE a.path IS NULL
  `) as { source_path: string; target_path: string }[];
  if (rows.length === 0) return;

  const allRows = (await sql`SELECT path FROM artifacts`) as { path: string }[];
  // Two indices because the two redlink shapes need different match
  // semantics:
  //
  //   - `byBaseAndStem` unions full basename AND stem (basename
  //     without final extension). Mirrors the pre-change MD logic so
  //     `[[paper]]` keeps resolving to `paper.pdf.html` and
  //     `[[paper.pdf]]` keeps being ambiguous when both a `.pdf`
  //     asset and its `.pdf.html` sidecar exist.
  //   - `byStrictBase` indexes full basename only. HTML hrefs are
  //     explicit about the extension; `./article.html` shouldn't
  //     quietly heal to `article.md`.
  const byBaseAndStem: Record<string, string[]> = {};
  const byStrictBase: Record<string, string[]> = {};
  for (const r of allRows) {
    const b = posix.basename(r.path).toLowerCase();
    const s = b.replace(/\.[^.]+$/, "");
    (byBaseAndStem[b] ??= []).push(r.path);
    if (s !== b) (byBaseAndStem[s] ??= []).push(r.path);
    (byStrictBase[b] ??= []).push(r.path);
  }

  // Group heals: SQL updates per unique target, HTML file edits per
  // (source, [heals]) tuple. Same broken target can heal once in SQL
  // but require N file rewrites if N inbound HTML articles point at
  // it.
  const sqlHeals = new Map<string, string>(); // brokenTarget → healedTarget
  const htmlFileHeals = new Map<string, HrefHeal[]>(); // source_path → heals

  for (const row of rows) {
    const target = row.target_path;
    const source = row.source_path;
    let candidates: string[] | undefined;
    let isPathForm = false;
    if (target.includes("/")) {
      isPathForm = true;
      const targetBase = posix.basename(target).toLowerCase();
      candidates = byStrictBase[targetBase];
      // Don't self-rewrite to the same path (defensive; the redlink
      // wouldn't exist if it already pointed at the present row).
      if (candidates && candidates.length === 1 && candidates[0] === target) {
        continue;
      }
    } else {
      candidates = byBaseAndStem[target.toLowerCase()];
    }
    if (!candidates || candidates.length !== 1) continue;
    const healed = candidates[0]!;
    sqlHeals.set(target, healed);
    // Source-file healing is HTML-only by design: MD `[[X]]` is an
    // abstract slug that already resolves by basename — keeping
    // `[[X]]` as written is the operator's intent. HTML hrefs claim
    // a specific path; rewriting them to match reality is the honest
    // move.
    if (isPathForm && (source.endsWith(".html") || source.endsWith(".htm"))) {
      const list = htmlFileHeals.get(source) ?? [];
      list.push({ brokenTarget: target, healedTarget: healed });
      htmlFileHeals.set(source, list);
    }
  }

  for (const [broken, healed] of sqlHeals) {
    await sql.query(
      `UPDATE links SET target_path = ? WHERE target_path = ?`,
      [healed, broken],
    );
  }

  for (const [sourcePath, heals] of htmlFileHeals) {
    const absPath = join(watchedRoot, sourcePath);
    let content: string;
    try {
      content = readFileSync(absPath, "utf-8");
    } catch (err) {
      console.error(
        `[sync] heal: source ${sourcePath} unreadable — ${(err as Error).message}`,
      );
      continue;
    }
    const result = applyHeals(content, sourcePath, heals);
    if (result.changed === 0) continue;
    try {
      writeAtomic(absPath, result.content);
    } catch (err) {
      console.error(
        `[sync] heal: write failed for ${sourcePath} — ${(err as Error).message}`,
      );
    }
  }
}
