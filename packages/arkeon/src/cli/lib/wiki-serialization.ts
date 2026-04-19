// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Serialize wiki entities to markdown with YAML frontmatter, and parse
 * them back into API-ready payloads. Used by `pull` and `add` to round-trip
 * entities through the local filesystem.
 */

// --- Frontmatter keys that map to top-level wiki fields (not nested under properties:) ---
const WIKI_FIELDS = new Set([
  "id",
  "ver",
  "subject_type",
  "aliases",
  "keywords",
  "short_description",
]);

// Properties we never write to frontmatter (they're derived or stored in body)
const OMIT_PROPERTIES = new Set([
  "label",
  "content",
  "submitted_content",
  "status",
  "source_file",
  "source_hash",
  "file_type",
]);

export type ParsedEntity = {
  id?: string;
  ver?: number;
  label: string;
  subject_type?: string;
  aliases?: string[];
  keywords?: string[];
  short_description?: string;
  content: string;
  properties?: Record<string, unknown>;
};

// ---------- Serialize (API entity → markdown file) ----------

type ApiEntity = {
  id: string;
  ver: number;
  properties: Record<string, unknown>;
};

/**
 * Serialize an API entity to a markdown string with YAML frontmatter.
 *
 * - Label becomes the first `# ` heading
 * - Uses `submitted_content` (original link syntax) when available
 * - Metadata goes in YAML frontmatter
 */
export function serializeEntity(entity: ApiEntity): string {
  const props = entity.properties;
  const label = (props.label as string) || "Untitled";

  // Pick content: prefer submitted_content (has authored link syntax)
  const body = (props.submitted_content as string) || (props.content as string) || "";

  // Build frontmatter fields
  const fm: Record<string, unknown> = {
    id: entity.id,
    ver: entity.ver,
  };

  if (props.subject_type) fm.subject_type = props.subject_type;
  if (Array.isArray(props.aliases) && props.aliases.length > 0) fm.aliases = props.aliases;
  if (Array.isArray(props.keywords) && props.keywords.length > 0) fm.keywords = props.keywords;
  if (props.short_description) fm.short_description = props.short_description;

  // Custom properties (anything not in the reserved set)
  const custom: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (!WIKI_FIELDS.has(k) && !OMIT_PROPERTIES.has(k)) {
      custom[k] = v;
    }
  }
  if (Object.keys(custom).length > 0) fm.properties = custom;

  const frontmatter = yamlSerialize(fm);

  // Ensure body starts with the label as H1 (don't duplicate if already there)
  const hasH1 = /^#\s+\S/m.test(body.trimStart().split("\n")[0] || "");
  const content = hasH1 ? body : `# ${label}\n\n${body}`;

  return `---\n${frontmatter}---\n\n${content.trimEnd()}\n`;
}

// ---------- Parse (markdown file → API payload) ----------

/**
 * Parse a markdown file with YAML frontmatter into an API-ready entity payload.
 *
 * - Extracts the first `# ` heading as label
 * - Frontmatter fields map to wiki metadata
 * - Body becomes content
 */
export function parseEntityFile(raw: string): ParsedEntity {
  const { frontmatter, body } = splitFrontmatter(raw);

  // Extract label from first H1 heading
  const h1Match = body.match(/^#\s+(.+)$/m);
  const label = h1Match?.[1]?.trim() || "Untitled";

  // Strip the H1 from the body to get clean content
  const content = h1Match
    ? body.slice(0, h1Match.index!) + body.slice(h1Match.index! + h1Match[0].length)
    : body;
  const cleanContent = content.replace(/^\n+/, "").trimEnd();

  const result: ParsedEntity = {
    label,
    content: cleanContent,
  };

  if (frontmatter.id) result.id = String(frontmatter.id);
  if (frontmatter.ver != null) result.ver = Number(frontmatter.ver);
  if (frontmatter.subject_type) result.subject_type = String(frontmatter.subject_type);
  if (Array.isArray(frontmatter.aliases)) result.aliases = frontmatter.aliases.map(String);
  if (Array.isArray(frontmatter.keywords)) result.keywords = frontmatter.keywords.map(String);
  if (frontmatter.short_description) result.short_description = String(frontmatter.short_description);

  // Custom properties from frontmatter
  if (frontmatter.properties && typeof frontmatter.properties === "object") {
    result.properties = frontmatter.properties as Record<string, unknown>;
  }

  return result;
}

// ---------- YAML helpers (minimal, no external deps) ----------

/**
 * Split a markdown file into frontmatter object and body string.
 */
function splitFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: raw };
  }

  const end = trimmed.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: {}, body: raw };
  }

  const yamlBlock = trimmed.slice(4, end); // skip opening "---\n"
  const body = trimmed.slice(end + 4); // skip closing "\n---"

  return {
    frontmatter: yamlParse(yamlBlock),
    body: body.replace(/^\n+/, ""),
  };
}

/**
 * Minimal YAML serializer — handles the subset we use in frontmatter:
 * scalars, string arrays, and nested objects (one level).
 */
function yamlSerialize(obj: Record<string, unknown>, indent = 0): string {
  const prefix = "  ".repeat(indent);
  let out = "";

  for (const [key, value] of Object.entries(obj)) {
    if (value == null) continue;

    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      out += `${prefix}${key}:\n`;
      for (const item of value) {
        out += `${prefix}  - ${yamlEscapeScalar(String(item))}\n`;
      }
    } else if (typeof value === "object") {
      out += `${prefix}${key}:\n`;
      out += yamlSerialize(value as Record<string, unknown>, indent + 1);
    } else if (typeof value === "string" && value.includes("\n")) {
      out += `${prefix}${key}: >\n`;
      for (const line of value.split("\n")) {
        out += `${prefix}  ${line}\n`;
      }
    } else {
      out += `${prefix}${key}: ${yamlEscapeScalar(value)}\n`;
    }
  }

  return out;
}

function yamlEscapeScalar(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const s = String(value);
  // Quote if it contains special YAML chars or looks like a number/bool
  if (/[:#{}[\],&*?|>!%@`'"\n]/.test(s) || /^(true|false|null|yes|no|\d+\.?\d*)$/i.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

/**
 * Minimal YAML parser — handles the subset we produce:
 * key: value, key:\n  - item, key:\n  nested_key: value
 */
function yamlParse(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^(\s*)(\w[\w.-]*)\s*:\s*(.*)/);
    if (!match) { i++; continue; }

    const indent = match[1].length;
    const key = match[2];
    const valuePart = match[3].trim();

    if (valuePart === ">" || valuePart === "|") {
      // Multi-line scalar
      let text = "";
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        const nextIndent = nextLine.match(/^\s*/)?.[0].length ?? 0;
        if (nextLine.trim() === "" || nextIndent > indent) {
          text += (text ? "\n" : "") + nextLine.trimStart();
          i++;
        } else break;
      }
      result[key] = text.trimEnd();
      continue;
    }

    if (valuePart === "") {
      // Could be array or nested object — peek at next line
      i++;
      if (i < lines.length && lines[i].trimStart().startsWith("- ")) {
        // Array
        const items: string[] = [];
        while (i < lines.length) {
          const itemMatch = lines[i].match(/^\s+-\s+(.*)/);
          if (!itemMatch) break;
          items.push(String(yamlUnescapeScalar(itemMatch[1].trim())));
          i++;
        }
        result[key] = items;
      } else {
        // Nested object
        const nested: Record<string, unknown> = {};
        while (i < lines.length) {
          const nestedMatch = lines[i].match(/^(\s+)(\w[\w.-]*)\s*:\s*(.*)/);
          if (!nestedMatch || nestedMatch[1].length <= indent) break;
          nested[nestedMatch[2]] = yamlUnescapeScalar(nestedMatch[3].trim());
          i++;
        }
        result[key] = nested;
      }
      continue;
    }

    // Simple scalar value
    result[key] = yamlUnescapeScalar(valuePart);
    i++;
  }

  return result;
}

function yamlUnescapeScalar(s: string): string | number | boolean {
  // Quoted string
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  // Boolean
  if (/^(true|yes)$/i.test(s)) return true;
  if (/^(false|no)$/i.test(s)) return false;
  // Number
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (/^\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}
