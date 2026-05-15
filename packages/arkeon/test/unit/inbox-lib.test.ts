// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

import {
  buildInboxContent,
  resolveInboxPath,
  slugify,
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

  it("rejects binary extensions even with text body", () => {
    expect(() =>
      assertTextContent(Buffer.from("PNG"), "sources/foo.png"),
    ).toThrow(/not indexable/);
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
