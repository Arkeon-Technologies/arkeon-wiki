// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiki chunker for embedding-based search (issue #47).
 *
 * Pure function — no I/O. Given a parsed wiki, returns the canonical
 * list of chunks that the embedder will see. Each wiki produces:
 *
 *   1. One synthetic "card" chunk built from frontmatter + lead paragraph.
 *      Wins queries where no single section has all the words.
 *   2. One section chunk per non-empty H2, with the heading path
 *      ("Label > H2 [> H3]") prepended to the body. Sections stay whole.
 *   3. Fallback: oversized sections split by H3, then by paragraph,
 *      with ~80-token overlap. Almost no real wiki section hits this.
 *
 * The embedder, vector index, and fusion layer arrive in follow-up PRs.
 * This module's only job is to produce a deterministic, inspectable
 * chunk list and the per-chunk content_hash that the embedder will use
 * to skip unchanged chunks.
 */

import { createHash } from "node:crypto";

import type { ParsedWiki } from "./frontmatter.js";

export type ChunkKind = "card" | "section" | "section_part";

export interface Chunk {
  chunk_index: number;
  chunk_kind: ChunkKind;
  heading_path: string;
  start_line: number | null;
  end_line: number | null;
  text: string;
  content_hash: string;
}

/**
 * Approximate token budget per section before we fall back to splitting.
 * Whitespace-token count is a rough proxy for tokenizer output (typically
 * within ~30% of the real count for English prose). Chosen well below the
 * 2048-token context of EmbeddingGemma to leave headroom for the prepended
 * heading path. Replace with a real tokenizer count when the embedder lands.
 */
const MAX_SECTION_TOKENS = 1500;

/**
 * Token overlap when an oversized section is paragraph-split. Matches the
 * @m13v finding from the issue thread: ~80 tokens of carryover preserves
 * cross-paragraph context without blowing up the chunk count.
 */
const OVERLAP_TOKENS = 80;

interface Heading {
  level: number;       // 2 for H2, 3 for H3, etc.
  text: string;        // cleaned heading text (no leading #, no markdown)
  lineIndex: number;   // 0-based line of the heading itself
}

interface Section {
  heading: string;
  startLine: number;        // line of the heading
  bodyStartLine: number;    // first body line (1-based for storage)
  bodyEndLine: number;      // last body line (1-based, inclusive)
  body: string;             // trimmed body text (no heading)
  subsections: Section[];   // H3s nested under an H2 (empty for H3)
}

export function chunkWiki(parsed: ParsedWiki, label: string): Chunk[] {
  const chunks: Chunk[] = [];
  const props = parsed.properties;
  const { lead, sections } = parseSections(parsed.body);

  let chunkIndex = 0;

  const cardText = buildCardText({
    label,
    subject_type: stringOrNull(props.subject_type),
    aliases: stringArrayOrEmpty(props.aliases),
    short_description: stringOrNull(props.short_description),
    lead,
  });

  if (cardText) {
    chunks.push(makeChunk({
      chunk_index: chunkIndex++,
      chunk_kind: "card",
      heading_path: label,
      start_line: null,
      end_line: null,
      text: cardText,
    }));
  }

  for (const section of sections) {
    const trimmedBody = section.body.trim();
    if (!trimmedBody && section.subsections.every((s) => !s.body.trim())) {
      continue;
    }

    const headingPath = `${label} > ${section.heading}`;
    const sectionTokens = estimateTokens(trimmedBody) +
      section.subsections.reduce((n, s) => n + estimateTokens(s.body), 0);

    if (sectionTokens <= MAX_SECTION_TOKENS) {
      const text = `${headingPath}\n\n${reassembleSection(section).trim()}`;
      chunks.push(makeChunk({
        chunk_index: chunkIndex++,
        chunk_kind: "section",
        heading_path: headingPath,
        start_line: section.bodyStartLine,
        end_line: section.bodyEndLine,
        text,
      }));
    } else {
      for (const part of splitOversized(section, label)) {
        chunks.push(makeChunk({ ...part, chunk_index: chunkIndex++ }));
      }
    }
  }

  return chunks;
}

// ── Frontmatter → card ───────────────────────────────────────────────

interface CardInput {
  label: string;
  subject_type: string | null;
  aliases: string[];
  short_description: string | null;
  lead: string;
}

function buildCardText(input: CardInput): string {
  const lines: string[] = [];

  if (input.subject_type) {
    lines.push(`${input.label} (${input.subject_type})`);
  } else {
    lines.push(input.label);
  }

  if (input.aliases.length > 0) {
    lines.push(`Aliases: ${input.aliases.join(", ")}`);
  }

  if (input.short_description) {
    lines.push(input.short_description);
  }

  const lead = input.lead.trim();
  if (lead) {
    lines.push(lead);
  }

  // Card always carries at least the label; never returns empty.
  return lines.join("\n\n");
}

// ── Body → sections ──────────────────────────────────────────────────

/**
 * Walk the body line-by-line, splitting on ATX headings (`## ...`,
 * `### ...`). Lines before the first H2 form the "lead" used by the card.
 * H3s nest inside the H2 above them. Anything deeper than H3 is treated
 * as body content of the enclosing H3 (or H2 if no H3) — we don't try to
 * model the full heading tree.
 *
 * Setext headings (`Title\n=====`) and code-fenced `#` lines are not
 * treated as headings. Wikis in this repo use ATX style.
 */
function parseSections(body: string): { lead: string; sections: Section[] } {
  const lines = body.split("\n");
  const headings: Heading[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const m = /^(#{2,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      headings.push({
        level: m[1].length,
        text: cleanHeadingText(m[2]),
        lineIndex: i,
      });
    }
  }

  if (headings.length === 0) {
    return { lead: body, sections: [] };
  }

  const firstH2 = headings.findIndex((h) => h.level === 2);
  if (firstH2 === -1) {
    // Only H3+ headings — keep the whole body as the lead, no sections.
    return { lead: body, sections: [] };
  }

  const lead = lines.slice(0, headings[firstH2].lineIndex).join("\n");

  const sections: Section[] = [];
  for (let i = firstH2; i < headings.length; i++) {
    const h = headings[i];
    if (h.level !== 2) continue;

    const next = headings.slice(i + 1).find((x) => x.level === 2);
    const sectionEndLine = next ? next.lineIndex : lines.length;

    const subHeadings = headings
      .slice(i + 1)
      .filter((x) => x.level === 3 && x.lineIndex < sectionEndLine);

    const bodyEndLineForH2 = subHeadings.length > 0
      ? subHeadings[0].lineIndex
      : sectionEndLine;

    const h2Body = lines.slice(h.lineIndex + 1, bodyEndLineForH2).join("\n");

    const subsections: Section[] = subHeadings.map((sub, j) => {
      const subEnd = j + 1 < subHeadings.length
        ? subHeadings[j + 1].lineIndex
        : sectionEndLine;
      return {
        heading: sub.text,
        startLine: sub.lineIndex + 1,
        bodyStartLine: sub.lineIndex + 2,
        bodyEndLine: subEnd,
        body: lines.slice(sub.lineIndex + 1, subEnd).join("\n"),
        subsections: [],
      };
    });

    sections.push({
      heading: h.text,
      startLine: h.lineIndex + 1,
      bodyStartLine: h.lineIndex + 2,
      bodyEndLine: sectionEndLine,
      body: h2Body,
      subsections,
    });
  }

  return { lead, sections };
}

function reassembleSection(section: Section): string {
  // Stitch H2 body + each H3 (with its heading line) back together so the
  // chunked text matches what a reader would see.
  const parts: string[] = [];
  if (section.body.trim()) parts.push(section.body.trim());
  for (const sub of section.subsections) {
    if (!sub.body.trim()) continue;
    parts.push(`### ${sub.heading}\n\n${sub.body.trim()}`);
  }
  return parts.join("\n\n");
}

// ── Oversized section fallback ───────────────────────────────────────

interface PartialChunk {
  chunk_kind: ChunkKind;
  heading_path: string;
  start_line: number | null;
  end_line: number | null;
  text: string;
}

function splitOversized(section: Section, label: string): PartialChunk[] {
  const parts: PartialChunk[] = [];
  const h2Path = `${label} > ${section.heading}`;

  const h2Body = section.body.trim();
  if (h2Body) {
    if (estimateTokens(h2Body) <= MAX_SECTION_TOKENS) {
      parts.push({
        chunk_kind: "section_part",
        heading_path: h2Path,
        start_line: section.bodyStartLine,
        end_line: section.subsections.length > 0
          ? section.subsections[0].startLine - 1
          : section.bodyEndLine,
        text: `${h2Path}\n\n${h2Body}`,
      });
    } else {
      for (const piece of paragraphSplit(h2Body, h2Path, section.bodyStartLine)) {
        parts.push(piece);
      }
    }
  }

  for (const sub of section.subsections) {
    const subBody = sub.body.trim();
    if (!subBody) continue;
    const subPath = `${label} > ${section.heading} > ${sub.heading}`;
    if (estimateTokens(subBody) <= MAX_SECTION_TOKENS) {
      parts.push({
        chunk_kind: "section_part",
        heading_path: subPath,
        start_line: sub.bodyStartLine,
        end_line: sub.bodyEndLine,
        text: `${subPath}\n\n${subBody}`,
      });
    } else {
      for (const piece of paragraphSplit(subBody, subPath, sub.bodyStartLine)) {
        parts.push(piece);
      }
    }
  }

  return parts;
}

function paragraphSplit(
  body: string,
  headingPath: string,
  startLine: number,
): PartialChunk[] {
  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return [];

  const out: PartialChunk[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;
  let pieceStart = startLine;

  const flush = (endLine: number): void => {
    if (buffer.length === 0) return;
    const text = `${headingPath}\n\n${buffer.join("\n\n")}`;
    out.push({
      chunk_kind: "section_part",
      heading_path: headingPath,
      start_line: pieceStart,
      end_line: endLine,
      text,
    });
  };

  let cursor = startLine;
  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);
    const paraLines = para.split("\n").length;

    if (bufferTokens + paraTokens > MAX_SECTION_TOKENS && buffer.length > 0) {
      flush(cursor - 1);

      const carry: string[] = [];
      let carryTokens = 0;
      for (let i = buffer.length - 1; i >= 0 && carryTokens < OVERLAP_TOKENS; i--) {
        carry.unshift(buffer[i]);
        carryTokens += estimateTokens(buffer[i]);
      }
      buffer = carry;
      bufferTokens = carryTokens;
      pieceStart = cursor;
    }

    buffer.push(para);
    bufferTokens += paraTokens;
    cursor += paraLines + 1;
  }

  flush(cursor - 1);
  return out;
}

// ── Helpers ──────────────────────────────────────────────────────────

function makeChunk(input: Omit<Chunk, "content_hash">): Chunk {
  return {
    ...input,
    content_hash: createHash("sha256").update(input.text).digest("hex"),
  };
}

function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function cleanHeadingText(raw: string): string {
  // Strip common decorations: bold/italic markers, inline code backticks,
  // attribute blocks `{.class}`, leading/trailing whitespace.
  return raw
    .replace(/\{[^}]*\}\s*$/, "")
    .replace(/[*_`]+/g, "")
    .trim();
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function stringArrayOrEmpty(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean);
}
