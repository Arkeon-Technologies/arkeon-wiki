// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

import {
  ADD_SOURCE_EXTENSIONS,
  buildInboxContent,
  extractFilenameFromUrl,
  resolveAddSourcePath,
  resolveInboxPath,
  slugify,
  splitFilename,
  utcDateStamp,
} from "../../src/server/lib/inbox.js";
import {
  assertSourcePath,
  assertTextContent,
  sanitizeCaller,
} from "../../src/server/lib/source-write-guards.js";
import { ApiError } from "../../src/server/lib/errors.js";

describe("slugify", () => {
  it("lowercases and kebab-cases", () => {
    expect(slugify("Slack Thread On Migrations")).toBe(
      "slack-thread-on-migrations",
    );
  });

  it("collapses non-alnum runs to a single hyphen", () => {
    expect(slugify("foo!!!  bar___baz")).toBe("foo-bar-baz");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("  --foo--  ")).toBe("foo");
  });

  it("caps length", () => {
    const long = "a".repeat(200);
    expect(slugify(long).length).toBe(60);
  });

  it("strips diacritics via NFKD normalize", () => {
    expect(slugify("naïve façade")).toBe("naive-facade");
  });

  it("returns empty string for slug-empty input", () => {
    expect(slugify("!!!")).toBe("");
    expect(slugify("")).toBe("");
  });
});

describe("utcDateStamp", () => {
  it("formats as YYYY-MM-DD in UTC", () => {
    expect(utcDateStamp(new Date("2026-05-15T03:14:00Z"))).toBe("2026-05-15");
  });

  it("uses UTC, not local time", () => {
    // 23:30 UTC on May 14 is the next day in many local zones; we expect UTC.
    expect(utcDateStamp(new Date("2026-05-14T23:30:00Z"))).toBe("2026-05-14");
  });
});

describe("resolveInboxPath", () => {
  const now = new Date("2026-05-15T10:00:00Z");

  it("uses slugified title + .md by default", () => {
    const { relativePath } = resolveInboxPath({
      watchDir: "/tmp/space",
      title: "Slack thread on migrations",
      kind: "md",
      now,
      exists: () => false,
    });
    expect(relativePath).toBe(
      "sources/inbox/2026-05-15/slack-thread-on-migrations.md",
    );
  });

  it("falls back to a ULID prefix when title is missing", () => {
    const { relativePath } = resolveInboxPath({
      watchDir: "/tmp/space",
      kind: "md",
      now,
      exists: () => false,
    });
    expect(relativePath).toMatch(
      /^sources\/inbox\/2026-05-15\/[0-9a-z]{10}\.md$/,
    );
  });

  it("falls back to a ULID prefix when title slugifies to empty", () => {
    const { relativePath } = resolveInboxPath({
      watchDir: "/tmp/space",
      title: "!!!",
      kind: "md",
      now,
      exists: () => false,
    });
    expect(relativePath).toMatch(
      /^sources\/inbox\/2026-05-15\/[0-9a-z]{10}\.md$/,
    );
  });

  it("auto-suffixes on collision", () => {
    const taken = new Set([
      "/tmp/space/sources/inbox/2026-05-15/note.md",
      "/tmp/space/sources/inbox/2026-05-15/note-2.md",
    ]);
    const { relativePath } = resolveInboxPath({
      watchDir: "/tmp/space",
      title: "note",
      kind: "md",
      now,
      exists: (p) => taken.has(p),
    });
    expect(relativePath).toBe("sources/inbox/2026-05-15/note-3.md");
  });

  it("uses .txt extension when kind=txt", () => {
    const { relativePath } = resolveInboxPath({
      watchDir: "/tmp/space",
      title: "raw",
      kind: "txt",
      now,
      exists: () => false,
    });
    expect(relativePath).toBe("sources/inbox/2026-05-15/raw.txt");
  });
});

describe("buildInboxContent", () => {
  it("md with title prepends a # heading", () => {
    expect(
      buildInboxContent({ kind: "md", title: "Hello", text: "world" }),
    ).toBe("# Hello\n\nworld\n");
  });

  it("md without title writes text verbatim", () => {
    expect(buildInboxContent({ kind: "md", text: "raw text" })).toBe(
      "raw text\n",
    );
  });

  it("txt ignores title", () => {
    expect(
      buildInboxContent({ kind: "txt", title: "Ignored", text: "plain" }),
    ).toBe("plain\n");
  });

  it("normalizes trailing newlines to exactly one", () => {
    expect(buildInboxContent({ kind: "md", text: "foo\n\n\n" })).toBe("foo\n");
  });
});

describe("assertSourcePath", () => {
  it("accepts a normal source path", () => {
    expect(() => assertSourcePath("sources/inbox/foo.md")).not.toThrow();
  });

  it("rejects empty path", () => {
    expect(() => assertSourcePath("")).toThrow(ApiError);
  });

  it("rejects wiki paths", () => {
    expect(() => assertSourcePath("wiki/foo.html")).toThrow(/wiki/);
    expect(() => assertSourcePath("wiki")).toThrow(/wiki/);
  });

  it("rejects traversal", () => {
    expect(() => assertSourcePath("sources/../escape.md")).toThrow(/\.\./);
  });

  it("rejects absolute paths", () => {
    expect(() => assertSourcePath("/etc/passwd")).toThrow(/relative/);
  });

  it("rejects NUL bytes", () => {
    expect(() => assertSourcePath("sources/foo\0.md")).toThrow(/NUL/);
  });
});

describe("assertTextContent", () => {
  it("accepts text bodies regardless of extension when sniff passes", () => {
    const buf = Buffer.from("hello world");
    expect(() => assertTextContent(buf, "sources/foo.md")).not.toThrow();
  });

  it("rejects asset extensions even with text body (asset uploads go through disk)", () => {
    // PNGs are kind='asset' — they ARE indexable, just not via the HTTP
    // text write-back. Drop them in the watch dir directly.
    expect(() =>
      assertTextContent(Buffer.from("PNG"), "sources/foo.png"),
    ).toThrow(/binary asset/);
  });

  it("rejects secret-bearing extensions", () => {
    expect(() =>
      assertTextContent(Buffer.from("KEY=value"), "sources/prod.env"),
    ).toThrow(/secrets or scratch/);
  });

  it("rejects buffers with NUL bytes when extension is unknown", () => {
    // .unknown isn't on either allowlist, so we fall through to the sniff.
    const buf = Buffer.from([0x68, 0x69, 0x00, 0x21]);
    expect(() => assertTextContent(buf, "sources/foo.unknown")).toThrow(
      /binary/,
    );
  });

  it("trusts the text allowlist even if the body would sniff binary", () => {
    // .md is on TEXT_EXTENSIONS, so we skip the sniff. (Pathological case;
    // the watcher behaves identically.)
    const buf = Buffer.from([0x68, 0x00, 0x69]);
    expect(() => assertTextContent(buf, "sources/foo.md")).not.toThrow();
  });
});

describe("splitFilename", () => {
  it("splits stem + lowercased ext", () => {
    expect(splitFilename("paper.PDF")).toEqual({ stem: "paper", ext: ".pdf" });
    expect(splitFilename("note.tar.gz")).toEqual({
      stem: "note.tar",
      ext: ".gz",
    });
  });

  it("returns empty ext when no dot", () => {
    expect(splitFilename("noext")).toEqual({ stem: "noext", ext: "" });
  });

  it("treats a leading dot as no extension (dotfile)", () => {
    expect(splitFilename(".gitignore")).toEqual({
      stem: ".gitignore",
      ext: "",
    });
  });
});

describe("extractFilenameFromUrl", () => {
  it("prefers Content-Disposition when extension is allowed", () => {
    const filename = extractFilenameFromUrl({
      url: "https://example.com/api/download?id=42",
      contentType: "application/pdf",
      contentDisposition: 'attachment; filename="Quarterly Report Q1.pdf"',
    });
    expect(filename).toBe("quarterly-report-q1.pdf");
  });

  it("decodes RFC 5987 extended filename", () => {
    const filename = extractFilenameFromUrl({
      url: "https://example.com/x",
      contentType: "application/pdf",
      contentDisposition: "attachment; filename*=UTF-8''na%C3%AFve%20paper.pdf",
    });
    expect(filename).toBe("naive-paper.pdf");
  });

  it("falls back to URL basename when Content-Disposition is absent", () => {
    const filename = extractFilenameFromUrl({
      url: "https://example.com/papers/2026-augustine-grief.pdf?utm=foo",
      contentType: "application/pdf",
      contentDisposition: null,
    });
    expect(filename).toBe("2026-augustine-grief.pdf");
  });

  it("ignores URL basename without an allowed extension", () => {
    const filename = extractFilenameFromUrl({
      url: "https://example.com/article",
      contentType: "text/html",
      contentDisposition: null,
    });
    // No allowed ext on the URL basename, so fall through to ULID + .html
    expect(filename).toMatch(/^[0-9a-z]{10}\.html$/);
  });

  it("returns null for unsupported media types", () => {
    expect(
      extractFilenameFromUrl({
        url: "https://example.com/foo",
        contentType: "application/octet-stream",
        contentDisposition: null,
      }),
    ).toBeNull();
    expect(
      extractFilenameFromUrl({
        url: "https://example.com/installer.dmg",
        contentType: "application/x-apple-diskimage",
        contentDisposition: null,
      }),
    ).toBeNull();
  });

  it("strips query string and decodes URL-encoded basenames", () => {
    const filename = extractFilenameFromUrl({
      url: "https://example.com/papers/Augustine%20on%20grief.pdf?download=1",
      contentType: "application/pdf",
      contentDisposition: null,
    });
    expect(filename).toBe("augustine-on-grief.pdf");
  });

  it("ULID fallback when no useful filename can be derived", () => {
    const filename = extractFilenameFromUrl({
      url: "https://example.com/",
      contentType: "text/html",
      contentDisposition: null,
    });
    expect(filename).toMatch(/^[0-9a-z]{10}\.html$/);
  });
});

describe("ADD_SOURCE_EXTENSIONS", () => {
  it("includes the universal-safe image set + pdf + common text", () => {
    for (const ext of [".pdf", ".png", ".html", ".md", ".txt"]) {
      expect(ADD_SOURCE_EXTENSIONS.has(ext)).toBe(true);
    }
    for (const ext of [".exe", ".dmg", ".sh", ".zip", ".js"]) {
      expect(ADD_SOURCE_EXTENSIONS.has(ext)).toBe(false);
    }
  });
});

describe("resolveAddSourcePath", () => {
  const now = new Date("2026-05-15T10:00:00Z");

  it("uses the filename verbatim under sources/inbox/<date>/", () => {
    const { relativePath } = resolveAddSourcePath({
      watchDir: "/tmp/space",
      filename: "augustine-on-grief.pdf",
      now,
      exists: () => false,
    });
    expect(relativePath).toBe(
      "sources/inbox/2026-05-15/augustine-on-grief.pdf",
    );
  });

  it("auto-suffixes on collision while preserving the extension", () => {
    const taken = new Set([
      "/tmp/space/sources/inbox/2026-05-15/paper.pdf",
      "/tmp/space/sources/inbox/2026-05-15/paper-2.pdf",
    ]);
    const { relativePath } = resolveAddSourcePath({
      watchDir: "/tmp/space",
      filename: "paper.pdf",
      now,
      exists: (p) => taken.has(p),
    });
    expect(relativePath).toBe("sources/inbox/2026-05-15/paper-3.pdf");
  });

  it("handles extensionless filenames", () => {
    const { relativePath } = resolveAddSourcePath({
      watchDir: "/tmp/space",
      filename: "raw",
      now,
      exists: () => false,
    });
    expect(relativePath).toBe("sources/inbox/2026-05-15/raw");
  });
});

describe("sanitizeCaller", () => {
  it("returns the allowed value", () => {
    expect(sanitizeCaller("slack-bridge")).toBe("slack-bridge");
    expect(sanitizeCaller("import.bot_1")).toBe("import.bot_1");
  });

  it("falls back to api for missing/empty input", () => {
    expect(sanitizeCaller(undefined)).toBe("api");
    expect(sanitizeCaller(null)).toBe("api");
    expect(sanitizeCaller("")).toBe("api");
  });

  it("falls back to api for invalid characters", () => {
    expect(sanitizeCaller("my bot!")).toBe("api");
    expect(sanitizeCaller("a".repeat(41))).toBe("api");
  });
});
