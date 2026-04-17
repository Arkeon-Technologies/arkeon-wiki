// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon add <files/globs>` — register files as document entities in the graph.
 *
 * Like `git add`: takes files on disk and creates corresponding document entities
 * in the bound space. If a document entity already exists for that source_file
 * with a different hash, it updates the entity's properties in place (the entity
 * ID stays stable so extracted_from relationships remain valid).
 */

import type { Command } from "commander";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { apiGet, apiPost, apiPut } from "../../lib/api-client.js";
import { credentials } from "../../lib/credentials.js";
import { output } from "../../lib/output.js";
import { requireRepoState } from "../../lib/repo-state.js";

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

type CreateWikiResponse = {
  wiki: EntityResult;
};

const TEXT_EXTENSIONS = new Set([".md", ".txt", ".tex", ".rst", ".adoc", ".org"]);
const DOCUMENT_FILTER = "properties.subject_type:document";
const LEGACY_DOCUMENT_FILTER = "type:document";

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
  const filters = [
    `${DOCUMENT_FILTER},properties.source_file:${sourceFile}`,
    `${LEGACY_DOCUMENT_FILTER},properties.source_file:${sourceFile}`,
  ];
  let entity: EntityResult | undefined;
  for (const filter of filters) {
    const resp = await apiGet<ListResponse>(
      apiUrl,
      `/wiki?filter=${encodeURIComponent(filter)}&space_id=${spaceId}&limit=1`,
      apiKey,
    );
    entity = resp.entities[0];
    if (entity) break;
  }
  if (!entity) return null;
  return {
    entity_id: entity.id,
    source_hash: (entity.properties?.source_hash as string) ?? "",
    ver: entity.ver,
  };
}

function keyword(value: string): string {
  return value.slice(0, 100);
}

function documentShortDescription(relPath: string): string {
  return `Document registered from ${relPath}`.slice(0, 400);
}

function documentLabel(relPath: string): string {
  return relPath.length <= 200 ? relPath : relPath.slice(-200);
}

async function createDocumentWiki(
  apiUrl: string,
  apiKey: string,
  spaceId: string,
  file: { relPath: string; hash: string; ext: string; content: string | null },
): Promise<EntityResult> {
  const label = documentLabel(file.relPath);
  const fileKind = fileType(file.ext);
  const content = file.content ?? `Binary ${fileKind} document registered from ${file.relPath}.`;
  const created = await apiPost<CreateWikiResponse>(apiUrl, "/wiki", apiKey, {
    label,
    subject_type: "document",
    keywords: [keyword(file.relPath), keyword(fileKind)],
    short_description: documentShortDescription(file.relPath),
    content,
    properties: {
      source_file: file.relPath,
      source_hash: file.hash,
      file_type: fileKind,
    },
    space_id: spaceId,
  });
  return created.wiki;
}

export function registerAddCommand(program: Command): void {
  program
    .command("add")
    .description("Register files as document entities in the graph")
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

        let addedCount = 0;
        let updatedCount = 0;
        let skippedCount = 0;
        const documents: Array<{ path: string; entity_id: string; action: string }> = [];

        // Separate files into new (need creation) and modified (need update)
        const toCreate: Array<{
          relPath: string;
          hash: string;
          ext: string;
          content: string | null;
        }> = [];
        const toUpdate: Array<{
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

          const hash = sha256(absPath);
          const ext = extname(relPath).toLowerCase();
          const existing = await findExistingDoc(state.api_url, apiKey, state.space_id, relPath);

          if (existing && existing.source_hash === hash) {
            skippedCount++;
            output.progress(`  = ${relPath} (up to date)`);
            continue;
          }

          const content = TEXT_EXTENSIONS.has(ext) ? readFileSync(absPath, "utf-8") : null;

          if (existing) {
            // Modified — update properties in place (entity ID stays stable)
            toUpdate.push({ relPath, hash, ext, content, entity_id: existing.entity_id, ver: existing.ver });
          } else {
            toCreate.push({ relPath, hash, ext, content });
          }
        }

        // Create new documents through the wiki pipeline with repo tracking
        // properties attached to the initial entity.
        for (const file of toCreate) {
          const entity = await createDocumentWiki(state.api_url, apiKey, state.space_id, file);
          documents.push({ path: file.relPath, entity_id: entity.id, action: "added" });
          output.progress(`  + ${file.relPath} -> ${entity.id}`);
          addedCount++;
        }

        // Update modified documents via PUT /wiki/{id}
        for (const file of toUpdate) {
          const properties: Record<string, unknown> = {
            source_hash: file.hash,
            file_type: fileType(file.ext),
          };
          if (file.content !== null) {
            properties.content = file.content;
          }

          // PUT /wiki/{id} shallow-merges properties — omitted keys
          // (source_file, label) are preserved, only provided keys are updated.
          await apiPut(state.api_url, `/wiki/${file.entity_id}`, apiKey, {
            ver: file.ver,
            properties,
          });

          documents.push({ path: file.relPath, entity_id: file.entity_id, action: "updated" });
          output.progress(`  ~ ${file.relPath} (${file.entity_id})`);
          updatedCount++;
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
