// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon add <files/globs>` — push files to the knowledge graph.
 *
 * Two modes:
 *   1. **Frontmatter entity** — file has YAML frontmatter with `id` and `ver`
 *      (typically from `arkeon pull`). Parsed into a full wiki update and sent
 *      via PUT /wiki/{id}. The server re-runs the wiki pipeline (link
 *      resolution, relationship diffing) automatically.
 *   2. **Raw document** — file without frontmatter. Creates/updates a document
 *      entity tracked by `source_file` + `source_hash` properties.
 */

import type { Command } from "commander";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";

import { apiGet, apiPost, apiPut } from "../../lib/api-client.js";
import { credentials } from "../../lib/credentials.js";
import { contentHash, loadManifest, saveManifest } from "../../lib/manifest.js";
import { output } from "../../lib/output.js";
import { requireRepoState } from "../../lib/repo-state.js";
import { parseEntityFile } from "../../lib/wiki-serialization.js";

const IGNORE_DIRS = new Set([".arkeon", ".git", "node_modules", ".claude"]);

/**
 * Expand a path argument: if it's a directory, recursively collect all files;
 * if it's a file, return it directly. Supports shell globs via the shell
 * expanding them before they reach us.
 */
function expandPath(p: string, cwd: string): string[] {
  const abs = join(cwd, p);
  // Guard against path traversal — files must be under cwd
  if (!abs.startsWith(cwd + "/") && abs !== cwd) return [];
  if (!existsSync(abs)) return [];
  const stat = statSync(abs);
  if (stat.isFile()) return [relative(cwd, abs)];
  if (stat.isDirectory()) {
    const results: string[] = [];
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        results.push(...expandPath(join(p, entry.name), cwd));
      } else if (entry.isFile()) {
        results.push(relative(cwd, join(abs, entry.name)));
      }
    }
    return results;
  }
  return [];
}

type EntityResult = {
  id: string;
  ver: number;
  properties: Record<string, unknown>;
};

type ListResponse = {
  entities: EntityResult[];
  cursor: string | null;
};

const TEXT_EXTENSIONS = new Set([".md", ".txt", ".tex", ".rst", ".adoc", ".org"]);
const FILE_FILTER = "type:file";

function sha256(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function fileType(ext: string): string {
  const map: Record<string, string> = {
    ".md": "markdown",
    ".txt": "text",
    ".tex": "latex",
    ".rst": "restructuredtext",
    ".adoc": "asciidoc",
    ".org": "org",
    ".pdf": "pdf",
    ".docx": "docx",
    ".pptx": "pptx",
  };
  return map[ext] ?? "binary";
}

async function findExistingDoc(
  apiUrl: string,
  apiKey: string,
  spaceId: string,
  sourceFile: string,
): Promise<{ entity_id: string; source_hash: string; ver: number } | null> {
  const filter = `${FILE_FILTER},properties.source_file:${sourceFile}`;
  const resp = await apiGet<{ files: EntityResult[]; cursor: string | null }>(
    apiUrl,
    `/files?filter=${encodeURIComponent(filter)}&space_id=${spaceId}&limit=1`,
    apiKey,
  );
  const entity = resp.files[0];
  if (!entity) return null;
  return {
    entity_id: entity.id,
    source_hash: (entity.properties?.source_hash as string) ?? "",
    ver: entity.ver,
  };
}

function documentLabel(relPath: string): string {
  return relPath.length <= 200 ? relPath : relPath.slice(-200);
}

async function createDocumentFile(
  apiUrl: string,
  apiKey: string,
  spaceId: string,
  file: { relPath: string; hash: string; ext: string; content: string | null },
): Promise<EntityResult> {
  const label = documentLabel(file.relPath);
  const fileKind = fileType(file.ext);
  const content = file.content ?? `Binary ${fileKind} document registered from ${file.relPath}.`;
  const folder = dirname(file.relPath);
  const created = await apiPost<{ file: EntityResult }>(apiUrl, "/files", apiKey, {
    label,
    content,
    source_file: file.relPath,
    source_hash: file.hash,
    file_type: fileKind,
    ...(folder !== "." ? { folder } : {}),
    space_id: spaceId,
  });
  return created.file;
}

export function registerAddCommand(program: Command): void {
  program
    .command("add")
    .description("Push files to the knowledge graph (supports pulled entities and raw documents)")
    .argument("<paths...>", "File paths or glob patterns to add")
    .action(async (paths: string[]) => {
      try {
        const cwd = process.cwd();
        const state = requireRepoState(cwd);
        const actorId = state.actors.ingestor?.actor_id;
        if (!actorId) throw new Error("No ingestor actor in state. Run `arkeon init` first.");
        const apiKey = credentials.requireActorKey(actorId);

        // Resolve paths to concrete files (shell handles glob expansion)
        const resolvedFiles: string[] = [];
        for (const p of paths) {
          const expanded = expandPath(p, cwd);
          if (expanded.length === 0) {
            output.warn(`No files found: ${p}`);
          } else {
            resolvedFiles.push(...expanded);
          }
        }

        if (resolvedFiles.length === 0) {
          output.error(new Error("No files to add."), { operation: "add" });
          process.exitCode = 1;
          return;
        }

        // Deduplicate
        const uniqueFiles = [...new Set(resolvedFiles.map((f) => relative(cwd, join(cwd, f))))];

        const manifest = loadManifest(cwd);
        let manifestDirty = false;
        let addedCount = 0;
        let updatedCount = 0;
        let skippedCount = 0;
        const documents: Array<{ path: string; entity_id: string; action: string }> = [];

        // Separate files by type: frontmatter entities vs raw documents
        const frontmatterFiles: Array<{
          relPath: string;
          parsed: ReturnType<typeof parseEntityFile>;
        }> = [];
        const rawToCreate: Array<{
          relPath: string;
          hash: string;
          ext: string;
          content: string | null;
        }> = [];
        const rawToUpdate: Array<{
          relPath: string;
          hash: string;
          ext: string;
          content: string | null;
          entity_id: string;
          ver: number;
        }> = [];

        for (const relPath of uniqueFiles) {
          const absPath = join(cwd, relPath);
          if (!existsSync(absPath)) {
            output.warn(`Skipping ${relPath}: file not found`);
            continue;
          }

          const ext = extname(relPath).toLowerCase();

          // Check for YAML frontmatter with entity ID (pulled entity)
          if (ext === ".md") {
            const raw = readFileSync(absPath, "utf-8");
            const parsed = parseEntityFile(raw);

            if (parsed.id && parsed.ver != null) {
              // Frontmatter entity — check if content changed since last pull
              const manifestEntry = manifest.entries[relPath];
              if (manifestEntry) {
                const currentHash = contentHash(absPath);
                if (currentHash === manifestEntry.content_hash) {
                  skippedCount++;
                  output.progress(`  = ${relPath} (up to date)`);
                  continue;
                }
              }

              frontmatterFiles.push({ relPath, parsed });
              continue;
            }
          }

          // Raw document path (existing behavior)
          const hash = sha256(absPath);
          const existing = await findExistingDoc(state.api_url, apiKey, state.space_id, relPath);

          if (existing && existing.source_hash === hash) {
            skippedCount++;
            output.progress(`  = ${relPath} (up to date)`);
            continue;
          }

          const content = TEXT_EXTENSIONS.has(ext) ? readFileSync(absPath, "utf-8") : null;

          if (existing) {
            rawToUpdate.push({ relPath, hash, ext, content, entity_id: existing.entity_id, ver: existing.ver });
          } else {
            rawToCreate.push({ relPath, hash, ext, content });
          }
        }

        // --- Frontmatter entities: PUT /wiki/{id} with full parsed payload ---
        for (const { relPath, parsed } of frontmatterFiles) {
          const properties: Record<string, unknown> = {
            content: parsed.content,
            label: parsed.label,
          };
          if (parsed.subject_type) properties.subject_type = parsed.subject_type;
          if (parsed.aliases) properties.aliases = parsed.aliases;
          if (parsed.keywords) properties.keywords = parsed.keywords;
          if (parsed.short_description) properties.short_description = parsed.short_description;
          if (parsed.properties) Object.assign(properties, parsed.properties);

          const resp = await apiPut<{ wiki: EntityResult }>(
            state.api_url,
            `/wiki/${parsed.id}`,
            apiKey,
            { ver: parsed.ver, properties },
          );

          // Update manifest with new version
          const absPath = join(cwd, relPath);
          manifest.entries[relPath] = {
            entity_id: parsed.id!,
            ver: resp.wiki.ver,
            content_hash: contentHash(absPath),
            synced_at: new Date().toISOString(),
          };
          manifestDirty = true;

          documents.push({ path: relPath, entity_id: parsed.id!, action: "updated" });
          output.progress(`  ~ ${relPath} (${parsed.id})`);
          updatedCount++;
        }

        // --- Raw documents: create new ---
        for (const file of rawToCreate) {
          const entity = await createDocumentFile(state.api_url, apiKey, state.space_id, file);
          documents.push({ path: file.relPath, entity_id: entity.id, action: "added" });
          output.progress(`  + ${file.relPath} -> ${entity.id}`);
          addedCount++;
        }

        // --- Raw documents: update modified ---
        for (const file of rawToUpdate) {
          const properties: Record<string, unknown> = {
            source_hash: file.hash,
            file_type: fileType(file.ext),
          };
          if (file.content !== null) {
            properties.content = file.content;
          }

          await apiPut(state.api_url, `/files/${file.entity_id}`, apiKey, {
            ver: file.ver,
            properties,
          });

          documents.push({ path: file.relPath, entity_id: file.entity_id, action: "updated" });
          output.progress(`  ~ ${file.relPath} (${file.entity_id})`);
          updatedCount++;
        }

        if (manifestDirty) {
          saveManifest(manifest, cwd);
        }

        output.result({
          operation: "add",
          added: addedCount,
          updated: updatedCount,
          skipped: skippedCount,
          documents,
        });
      } catch (error) {
        output.error(error, { operation: "add" });
        process.exitCode = 1;
      }
    });
}
