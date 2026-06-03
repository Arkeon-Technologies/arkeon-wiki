// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Output helpers for the api-CLI commands.
 *
 * The contract: if stdout is a TTY, pretty-print. If it's piped or
 * redirected (`| jq`, `> out.json`), emit the full JSON response so
 * scripts get the same payload the daemon returned. Matches the
 * convention used by `git log`, `ls`, `gh`, etc.
 */

export function isTty(): boolean {
  return Boolean(process.stdout.isTTY);
}

/**
 * Emit `value` as pretty-printed JSON followed by a newline. Use this
 * for piped output and `--json` flags.
 */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Render an array of records as a left-aligned, two-space-padded
 * table. Column order is taken from the first row's key order
 * (insertion order), which the command files set deliberately.
 *
 * Empty rows render as "(none)" so a TTY user never sees a silently
 * blank table.
 */
export function printTable(rows: Record<string, string>[]): void {
  if (rows.length === 0) {
    process.stdout.write("(none)\n");
    return;
  }
  const headers = Object.keys(rows[0]!);
  const widths = headers.map((h) =>
    Math.max(h.length, ...rows.map((r) => (r[h] ?? "").length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  process.stdout.write(`${fmt(headers)}\n`);
  for (const row of rows) {
    process.stdout.write(`${fmt(headers.map((h) => row[h] ?? ""))}\n`);
  }
}

/**
 * Two-column key/value layout for scalar-flavored responses
 * (`stats`, `tag`, ...). Keys are right-padded to the longest key
 * length so colons align.
 */
export function printKeyValue(pairs: Array<[string, string]>): void {
  if (pairs.length === 0) {
    process.stdout.write("(none)\n");
    return;
  }
  const width = Math.max(...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) {
    process.stdout.write(`${k.padEnd(width)}  ${v}\n`);
  }
}

/**
 * Truncate `s` to `n` characters, appending an ellipsis when cut. Used
 * for table columns that would otherwise wrap to absurd widths on
 * narrow terminals (long quoted citations, etc.).
 */
export function truncate(s: string | null | undefined, n: number): string {
  if (s == null) return "";
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}
