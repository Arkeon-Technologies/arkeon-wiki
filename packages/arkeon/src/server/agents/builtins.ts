// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Built-in role templates.
 *
 * Each entry is a `RoleConfig` whose fields are the *defaults* the
 * runtime will use unless the user's agents.yaml overrides them. The
 * goal is that an empty `.arkeon/agents.yaml` (just `defaults:` with
 * a model) gets you a working agent — you only configure what you
 * want to change.
 *
 * Workflows + tool descriptions live here, in code, where they get
 * type-checked and reviewed. Operators tune *focus, style, scope* via
 * the `instructions` field in YAML; they don't rewrite the workflow.
 *
 * Custom user-defined roles are NOT in this file — they live entirely
 * in YAML and must supply their own `system`/`tools`/etc.
 */

import type { RoleConfig } from "./config.js";

export const BUILTIN_ROLES: Record<string, RoleConfig> = {
  // ── ingestor ───────────────────────────────────────────────────
  // The single worker that turns sources into wikis. Triggered when a
  // source file is added or updated; reads the source, finds related
  // wikis, edits or creates them. Provenance is captured by the
  // markdown links the agent writes from wiki bodies back to source
  // paths — those become relationship edges in SQLite automatically.
  ingestor: {
    tools: ["read_file", "list_wikis", "search", "write_file", "edit_file"],
    max_steps: 20,
    system: [
      "You ingest source files into a wiki knowledge graph.",
      "",
      "Workflow:",
      "  1. Use read_file on the source path you were given.",
      "  2. Identify the distinct named subjects the source discusses",
      "     (people, organizations, concepts, publications, events,",
      "     places, etc.). Skip generic terms — only cover named",
      "     subjects a reader would plausibly want a wiki page for.",
      "  3. For each subject:",
      "     - Use list_wikis with label_prefix to check whether a wiki",
      "       for this subject already exists.",
      "     - If a matching wiki exists: use edit_file to weave 1-3",
      "       sentences about what THIS source establishes about the",
      "       subject into the existing body. Always include a markdown",
      "       link back to the source path so the relationship is",
      "       captured (e.g.,",
      "         '[as discussed in Shannon's bio](../../sources/shannon-bio.md)').",
      "     - If no matching wiki exists: use write_file to create",
      "       wiki/{subject_type}/{slug}.md with full YAML frontmatter",
      "       (label, subject_type) and a 2-4 paragraph body grounded",
      "       in this source. Include a markdown link back to the",
      "       source.",
      "  4. Cross-link to other existing wikis whenever a name comes up",
      "     that already has a page in this space.",
      "  5. Stop when every distinct subject has been covered.",
      "",
      "Slugify labels for filenames: lowercase, ASCII-only, hyphens for",
      "spaces. Pick a sensible subject_type — common ones are person,",
      "organization, concept, publication, event, place.",
    ].join("\n"),
    user: [
      "Source path: {{trigger_path}}",
      "Source entity id: {{trigger_entity_id}}",
      "",
      "Ingest this source into the wiki.",
    ].join("\n"),
  },
};

export function isBuiltinRole(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTIN_ROLES, name);
}
