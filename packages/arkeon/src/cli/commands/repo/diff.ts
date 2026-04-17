// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon diff` — compare files on disk vs document entities in the graph.
 *
 * Like `git status`: shows what files are new, modified, deleted, or unchanged
 * relative to the bound Arkeon space.
 */

import type { Command } from "commander";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { apiGet } from "../../lib/api-client.js";
import { credentials } from "../../lib/credentials.js";
import { output } from "../../lib/output.js";
import { requireRepoState } from "../../lib/repo-state.js";

type EntityResult = {
  id: string;
  type: string;
  properties: Record<string, unknown>;
};

type ListResponse = {
  entities: EntityResult[];
  cursor: string | null;
};

const DEFAULT_EXTENSIONS = new Set([".md", ".txt", ".tex"]);
const IGNORE_DIRS = new Set([".arkeon", ".git", "node_modules", ".claude"]);
const DOCUMENT_FILTERS = ["properties.subject_type:document", "type:document"];

function walkDir(dir: string, base: string, extensions: Set<string>): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      results.push(...walkDir(join(dir, entry.name), base, extensions));
    } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
      results.push(relative(base, join(dir, entry.name)));
    }
  }
  return results;
}

function sha256(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

export type DiffEntry = {
  path: string;
  sha256?: string;
  entity_id?: string;
};

export type DiffResult = {
  added: DiffEntry[];
  modified: DiffEntry[];
  deleted: DiffEntry[];
  unchanged: number;
};

async function fetchDocumentEntities(
  apiUrl: string,
  apiKey: string,
  spaceId: string,
): Promise<Map<string, { entity_id: string; source_hash: string }>> {
  const docs = new Map<string, { entity_id: string; source_hash: string }>();
  let cursor: string | null = null;

  for (const filter of DOCUMENT_FILTERS) {
    cursor = null;
    for (;;) {
      const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const resp: ListResponse = await apiGet<ListResponse>(
        apiUrl,
        `/wiki?filter=${encodeURIComponent(filter)}&space_id=${spaceId}&limit=200${cursorParam}`,
        apiKey,
      );

      for (const entity of resp.entities) {
        const sourceFile = entity.properties?.source_file as string | undefined;
        const sourceHash = entity.properties?.source_hash as string | undefined;
        if (sourceFile) {
          docs.set(sourceFile, {
            entity_id: entity.id,
            source_hash: sourceHash ?? "",
          });
        }
      }

      cursor = resp.cursor;
      if (!cursor) break;
    }
  }

  return docs;
}

export async function computeDiff(cwd: string, extensions?: Set<string>): Promise<DiffResult> {
  const state = requireRepoState(cwd);
  const actorId = state.actors.ingestor?.actor_id;
  if (!actorId) throw new Error("No ingestor actor in state. Run `arkeon init` first.");
  const apiKey = credentials.requireActorKey(actorId);

  // Get document entities from the graph
  const graphDocs = await fetchDocumentEntities(state.api_url, apiKey, state.space_id);

  // Walk disk
  const exts = extensions ?? DEFAULT_EXTENSIONS;
  const files = walkDir(cwd, cwd, exts);

  const added: DiffEntry[] = [];
  const modified: DiffEntry[] = [];
  const deleted: DiffEntry[] = [];
  let unchanged = 0;

  const seen = new Set<string>();

  for (const relPath of files) {
    seen.add(relPath);
    const hash = sha256(join(cwd, relPath));
    const graphEntry = graphDocs.get(relPath);

    if (!graphEntry) {
      added.push({ path: relPath, sha256: hash });
    } else if (graphEntry.source_hash !== hash) {
      modified.push({ path: relPath, sha256: hash, entity_id: graphEntry.entity_id });
    } else {
      unchanged++;
    }
  }

  // Anything in graph but not on disk is deleted
  for (const [sourceFile, entry] of graphDocs) {
    if (!seen.has(sourceFile)) {
      deleted.push({ path: sourceFile, entity_id: entry.entity_id });
    }
  }

  return { added, modified, deleted, unchanged };
}

export function registerDiffCommand(program: Command): void {
  program
    .command("diff")
    .description("Compare files on disk vs document entities in the graph")
    .option("--json", "Output as JSON for programmatic use")
    .option("--ext <extensions>", "Comma-separated file extensions (default: .md,.txt,.tex)")
    .action(async (opts: { json?: boolean; ext?: string }) => {
      try {
        const cwd = process.cwd();
        const extensions = opts.ext
          ? new Set(opts.ext.split(",").map((e) => (e.startsWith(".") ? e : `.${e}`)))
          : undefined;
        const diff = await computeDiff(cwd, extensions);

        if (opts.json) {
          output.result({
            operation: "diff",
            ...diff,
          });
          return;
        }

        // Human-readable output
        const total = diff.added.length + diff.modified.length + diff.deleted.length + diff.unchanged;
        output.progress(
          `${diff.added.length} added, ${diff.modified.length} modified, ${diff.deleted.length} deleted, ${diff.unchanged} unchanged (${total} total)`,
        );
        output.progress("");

        for (const entry of diff.added) {
          output.progress(`  + ${entry.path}`);
        }
        for (const entry of diff.modified) {
          output.progress(`  ~ ${entry.path}  (${entry.entity_id})`);
        }
        for (const entry of diff.deleted) {
          output.progress(`  - ${entry.path}  (${entry.entity_id})`);
        }

        if (diff.added.length + diff.modified.length + diff.deleted.length === 0) {
          output.progress("  (up to date)");
        }
      } catch (error) {
        output.error(error, { operation: "diff" });
        process.exitCode = 1;
      }
    });
}
