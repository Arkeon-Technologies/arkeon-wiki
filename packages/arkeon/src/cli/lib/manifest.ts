// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `.arkeon/manifest.json` — tracks the bidirectional mapping between local
 * markdown files and remote wiki entities. Used by `pull` and `add` to
 * reconcile local edits with server state.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type ManifestEntry = {
  entity_id: string;
  ver: number;
  content_hash: string;
  /** When this entry was last synced from the server (pull) or pushed (add). */
  synced_at: string;
};

export type Manifest = {
  version: 1;
  entries: Record<string, ManifestEntry>;
};

const MANIFEST_FILE = "manifest.json";

function manifestPath(cwd: string): string {
  return join(cwd, ".arkeon", MANIFEST_FILE);
}

export function loadManifest(cwd: string): Manifest {
  const p = manifestPath(cwd);
  if (!existsSync(p)) return { version: 1, entries: {} };
  const raw = readFileSync(p, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  // Schema validation — reject corrupted manifests
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid manifest: not an object");
  }
  if (parsed.version !== 1) {
    throw new Error(`Invalid manifest: unsupported version ${parsed.version}`);
  }
  if (typeof parsed.entries !== "object" || parsed.entries === null || Array.isArray(parsed.entries)) {
    throw new Error("Invalid manifest: entries must be an object");
  }

  // Validate each entry and reject unsafe paths
  const entries = parsed.entries as Record<string, unknown>;
  const validated: Record<string, ManifestEntry> = {};
  for (const [path, entry] of Object.entries(entries)) {
    if (!isValidManifestPath(path)) continue;
    if (!isManifestEntry(entry)) continue;
    validated[path] = entry;
  }

  return { version: 1, entries: validated };
}

/**
 * Validate that a manifest path is safe — must be under wiki/ with no
 * traversal sequences.
 */
function isValidManifestPath(path: string): boolean {
  return path.startsWith("wiki/") && !path.includes("..") && !path.startsWith("/");
}

function isManifestEntry(value: unknown): value is ManifestEntry {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.entity_id === "string" &&
    typeof obj.ver === "number" &&
    typeof obj.content_hash === "string" &&
    typeof obj.synced_at === "string"
  );
}

export function saveManifest(manifest: Manifest, cwd: string): void {
  const p = manifestPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

/**
 * Reverse-lookup: find a manifest entry by entity ID.
 */
export function findByEntityId(
  manifest: Manifest,
  entityId: string,
): { path: string; entry: ManifestEntry } | null {
  for (const [path, entry] of Object.entries(manifest.entries)) {
    if (entry.entity_id === entityId) return { path, entry };
  }
  return null;
}

/**
 * SHA-256 hash of file contents (used to detect local modifications).
 */
export function contentHash(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Slugify a label for use as a filename.
 * "Claude Shannon" → "claude-shannon"
 * "Information Theory (overview)" → "information-theory-overview"
 */
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "untitled";
}

/**
 * Compute the file path for a given entity, avoiding collisions with
 * existing manifest entries.
 *
 * Layout: `wiki/{subject_type}/{slug}.md`
 */
export function entityToFilePath(
  entity: { id: string; properties: Record<string, unknown> },
  manifest: Manifest,
): string {
  const rawType = entity.properties.subject_type as string | undefined;
  const typeDir = rawType ? slugify(rawType) : "_uncategorized";
  const label = (entity.properties.label as string) || "untitled";
  const slug = slugify(label);
  const dir = `wiki/${typeDir}`;
  const base = `${dir}/${slug}.md`;

  // Check if this path is already taken by a different entity
  const existing = manifest.entries[base];
  if (!existing || existing.entity_id === entity.id) return base;

  // Collision: append short entity ID suffix
  const suffix = entity.id.slice(-8).toLowerCase();
  return `${dir}/${slug}-${suffix}.md`;
}
