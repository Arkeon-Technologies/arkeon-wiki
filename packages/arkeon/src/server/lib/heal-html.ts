// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-file healing for HTML wikilinks whose literal-resolved
 * target moved between folders.
 *
 * Doctrine: the filesystem is truth. When sync detects a basename-
 * unique fallback, the on-disk source HTML is edited so that the
 * next extraction sees coherent state — not the served response,
 * not just SQL. "View source" matches what renders; git history
 * carries the heal as a real edit.
 *
 *   1. `applyHeals` walks the parsed DOM and rewrites every
 *      `<a class="wikilink">` whose literal-resolved href matches a
 *      heal-from path to point at the heal-to path. Pure function:
 *      returns the new content + the number of anchors edited.
 *   2. `writeAtomic` writes via temp + rename so a crash mid-write
 *      leaves the original file intact.
 *
 * Used by `sync.ts` from two sites: inline during `syncText` when
 * extractHtmlLinks reports a fallback hit, and inside
 * `reresolveBasenameRedlinks` when a newly-landed artifact heals a
 * previously-stuck inbound href.
 */

import { renameSync, writeFileSync } from "node:fs";
import { parse } from "node-html-parser";

import { relativeHref } from "./basename-fallback.js";
import { resolveHref } from "./html-links.js";

export interface HrefHeal {
  /** The literal-resolved (broken) target the href currently points at. */
  brokenTarget: string;
  /** The basename-fallback resolved target the heal should land on. */
  healedTarget: string;
}

export interface HealResult {
  content: string;
  changed: number;
}

/**
 * Apply `heals` to every matching `<a class="wikilink">` in `content`.
 * Returns the rewritten content and how many anchors were updated.
 * When `changed === 0` the original content is returned unchanged so
 * the caller can skip the write entirely.
 */
export function applyHeals(
  content: string,
  sourceRelativePath: string,
  heals: ReadonlyArray<HrefHeal>,
): HealResult {
  if (heals.length === 0) return { content, changed: 0 };
  const map = new Map<string, string>();
  for (const h of heals) map.set(h.brokenTarget, h.healedTarget);

  const root = parse(content);
  let changed = 0;
  for (const a of root.querySelectorAll("a")) {
    const cls = a.getAttribute("class") ?? "";
    if (!cls.split(/\s+/).some((t) => t === "wikilink")) continue;
    const href = a.getAttribute("href");
    if (!href) continue;
    const literal = resolveHref(href, sourceRelativePath);
    if (literal === null) continue;
    const healed = map.get(literal);
    if (!healed) continue;
    a.setAttribute("href", relativeHref(sourceRelativePath, healed));
    changed++;
  }
  if (changed === 0) return { content, changed: 0 };
  return { content: root.toString(), changed };
}

/**
 * Write `content` to `absPath` atomically: write to a sibling temp
 * file first, then rename over the destination. A crash between the
 * two leaves the original intact (the temp file is orphaned, not the
 * source).
 */
export function writeAtomic(absPath: string, content: string): void {
  const tmp = `${absPath}.heal.tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, absPath);
}
