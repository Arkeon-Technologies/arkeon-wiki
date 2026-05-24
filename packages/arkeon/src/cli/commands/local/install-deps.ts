// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki install-deps` — bootstrap the binary-ingestion toolchain.
 *
 * Walks the FileHandler registry, collects every declared dependency,
 * and resolves each:
 *   - python_package → install into ~/.arkeon-wiki/python/ via uv (or
 *     python3 -m venv + pip) — one shared venv for all Python handlers.
 *   - system_binary  → confirm the executable is on PATH; emit the
 *     platform install hint on miss.
 *   - node_package   → no-op (npm install handled it); reported for
 *     transparency only.
 *
 * Writes a versioned manifest to ~/.arkeon-wiki/adapters.json that the
 * runtime reads at extraction time. No sudo, no shell — uses
 * spawnSync with arg arrays throughout.
 *
 * `--check` runs in verify-only mode: reports what would be installed
 * vs. what's already present, exits non-zero on miss. Useful for CI
 * gates and for confirming a fresh box.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { delimiter, join, sep } from "node:path";
import type { Command } from "commander";

import { arkeonDir, ensureArkeonDir } from "../../lib/local-runtime.js";
import { output } from "../../lib/output.js";
import {
  adaptersManifestPath,
  writeAdaptersManifest,
} from "../../../server/extractors/adapters.js";
import {
  HANDLERS,
} from "../../../server/extractors/index.js";
import type {
  AdaptersManifest,
  DependencySpec,
} from "../../../server/extractors/types.js";

interface InstallDepsCliOptions {
  check?: boolean;
}

export function registerInstallDepsCommand(program: Command): void {
  program
    .command("install-deps")
    .description(
      "Bootstrap the toolchain for binary ingestion (Python venv, system binaries). Writes ~/.arkeon-wiki/adapters.json.",
    )
    .option(
      "--check",
      "Verify-only: report what's missing without installing or writing the manifest. Exits non-zero on any miss.",
    )
    .action(async (opts: InstallDepsCliOptions) => {
      try {
        await runInstallDeps(opts);
      } catch (err) {
        output.error(err, { operation: "install-deps" });
        process.exitCode = 1;
      }
    });
}

interface DependencyPlan {
  pythonPackages: Set<string>;
  pythonVersions: Map<string, string | undefined>;
  systemBinaries: Map<string, DependencySpec>;
  nodePackages: Map<string, DependencySpec>;
}

function buildPlan(): DependencyPlan {
  const plan: DependencyPlan = {
    pythonPackages: new Set(),
    pythonVersions: new Map(),
    systemBinaries: new Map(),
    nodePackages: new Map(),
  };
  for (const handler of HANDLERS) {
    for (const dep of handler.dependencies) {
      switch (dep.kind) {
        case "python_package":
          plan.pythonPackages.add(dep.name);
          if (dep.versionConstraint) {
            plan.pythonVersions.set(dep.name, dep.versionConstraint);
          }
          break;
        case "system_binary":
          plan.systemBinaries.set(dep.name, dep);
          break;
        case "node_package":
          plan.nodePackages.set(dep.name, dep);
          break;
      }
    }
  }
  return plan;
}

async function runInstallDeps(opts: InstallDepsCliOptions): Promise<void> {
  const checkOnly = opts.check === true;
  const plan = buildPlan();

  ensureArkeonDir();

  // ---------------- Python ----------------
  let pythonInfo: AdaptersManifest["python"] | undefined;
  const venvDir = join(arkeonDir(), "python");
  const venvPythonPath = venvPython(venvDir);
  if (plan.pythonPackages.size > 0) {
    output.progress(`[install-deps] python venv: ${venvDir}`);
    if (!checkOnly) {
      ensurePythonVenv(venvDir);
    } else if (!existsSync(venvPythonPath)) {
      throw new Error(
        `python venv missing at ${venvDir} — run \`arkeon-wiki install-deps\` (without --check) to bootstrap`,
      );
    }
    if (!checkOnly) {
      installPythonPackages(venvPythonPath, plan);
    }
    const pyVersion = readPythonVersion(venvPythonPath);
    pythonInfo = { path: venvPythonPath, version: pyVersion };
  }

  // Verify each package is importable in the venv.
  const pythonPackages: Record<string, { version: string }> = {};
  for (const pkg of plan.pythonPackages) {
    const version = readPythonPackageVersion(venvPythonPath, pkg);
    if (!version) {
      throw new Error(
        `python package "${pkg}" is not importable in the venv at ${venvDir}. ` +
          `Try \`${venvPythonPath} -m pip install ${pkg}\` directly to debug.`,
      );
    }
    pythonPackages[pkg] = { version };
  }

  // ---------------- System binaries ----------------
  const systemBinaries: Record<string, { path: string; version?: string }> = {};
  const missingBinaries: string[] = [];
  for (const [name, dep] of plan.systemBinaries) {
    const resolved = whichSync(name);
    if (!resolved) {
      missingBinaries.push(formatMissingBinary(name, dep));
      continue;
    }
    systemBinaries[name] = { path: resolved };
    const version = readBinaryVersion(resolved);
    if (version) systemBinaries[name].version = version;
  }

  // ---------------- Node packages ----------------
  // No-op: npm/install ships these. We report what each handler relies on
  // for transparency; if a node_package is missing the handler will fail
  // at runtime with a require/import error, not here.
  for (const dep of plan.nodePackages.values()) {
    output.progress(
      `[install-deps] node_package ${dep.name}${dep.versionConstraint ? ` ${dep.versionConstraint}` : ""} — assumed installed via npm`,
    );
  }

  if (missingBinaries.length > 0) {
    throw new Error(
      `missing system binaries:\n  - ${missingBinaries.join("\n  - ")}`,
    );
  }

  // ---------------- Manifest ----------------
  const manifest: AdaptersManifest = {
    schema_version: 1,
    python: pythonInfo,
    system_binaries: systemBinaries,
    python_packages: pythonPackages,
    generated_at: new Date().toISOString(),
  };

  if (!checkOnly) {
    writeAdaptersManifest(manifest);
  }

  output.result({
    operation: "install-deps",
    mode: checkOnly ? "check" : "install",
    adapters_manifest: checkOnly
      ? "(not written — --check)"
      : adaptersManifestPath(),
    handlers: HANDLERS.map((h) => {
      const declared = h.dependencies;
      const allPresent = declared.every((d) => {
        switch (d.kind) {
          case "python_package":
            return Boolean(pythonPackages[d.name]);
          case "system_binary":
            return Boolean(systemBinaries[d.name]);
          case "node_package":
            return true;
        }
      });
      return {
        name: h.name,
        extensions: h.extensions,
        enabled: allPresent,
        deps_satisfied: declared
          .filter((d) => {
            if (d.kind === "python_package") return Boolean(pythonPackages[d.name]);
            if (d.kind === "system_binary") return Boolean(systemBinaries[d.name]);
            return true;
          })
          .map((d) => `${d.kind}:${d.name}`),
        deps_missing: declared
          .filter((d) => {
            if (d.kind === "python_package") return !pythonPackages[d.name];
            if (d.kind === "system_binary") return !systemBinaries[d.name];
            return false;
          })
          .map((d) => `${d.kind}:${d.name}`),
      };
    }),
    python: pythonInfo,
    system_binaries: systemBinaries,
    python_packages: pythonPackages,
  });
}

// =====================================================================
// Python venv bootstrap
// =====================================================================

function venvPython(venvDir: string): string {
  // Cross-platform: venvs put the executable in `bin/` (POSIX) or
  // `Scripts/` (Windows). We only support macOS + Linux in v0.
  return process.platform === "win32"
    ? join(venvDir, "Scripts", "python.exe")
    : join(venvDir, "bin", "python");
}

function ensurePythonVenv(venvDir: string): void {
  if (existsSync(venvPython(venvDir))) return;

  // Prefer `uv` — much faster, handles Python version pinning, single
  // binary install. Fall back to system python3 + venv if uv isn't on
  // PATH.
  if (whichSync("uv")) {
    const res = spawnSync("uv", ["venv", venvDir], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (res.status !== 0) {
      throw new Error(
        `\`uv venv ${venvDir}\` failed with exit code ${res.status}`,
      );
    }
    return;
  }

  const py = whichSync("python3") ?? whichSync("python");
  if (!py) {
    throw new Error(
      `neither \`uv\` nor \`python3\`/\`python\` is on PATH. ` +
        `Install Python 3.10+ (https://www.python.org/downloads/) ` +
        `or uv (https://docs.astral.sh/uv/) and re-run.`,
    );
  }

  mkdirSync(venvDir, { recursive: true });
  const res = spawnSync(py, ["-m", "venv", venvDir], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (res.status !== 0) {
    throw new Error(
      `\`${py} -m venv ${venvDir}\` failed with exit code ${res.status}`,
    );
  }
}

function installPythonPackages(venvPythonPath: string, plan: DependencyPlan): void {
  if (plan.pythonPackages.size === 0) return;
  const specs = Array.from(plan.pythonPackages).map((pkg) => {
    const constraint = plan.pythonVersions.get(pkg);
    return constraint ? `${pkg}${constraint}` : pkg;
  });

  // Prefer `uv pip install --python <venv-python>` so we get uv's
  // resolver + cache; fall back to the venv's pip module.
  if (whichSync("uv")) {
    const res = spawnSync(
      "uv",
      ["pip", "install", "--python", venvPythonPath, ...specs],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    if (res.status !== 0) {
      throw new Error(`\`uv pip install\` failed with exit code ${res.status}`);
    }
    return;
  }

  const res = spawnSync(
    venvPythonPath,
    ["-m", "pip", "install", "--upgrade", ...specs],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (res.status !== 0) {
    throw new Error(
      `pip install failed with exit code ${res.status} (venv: ${venvPythonPath})`,
    );
  }
}

function readPythonVersion(venvPythonPath: string): string {
  const res = spawnSync(venvPythonPath, ["--version"], { encoding: "utf-8" });
  if (res.status !== 0) {
    return "unknown";
  }
  // `Python 3.12.5`
  const stdout = (res.stdout ?? "").trim();
  const stderr = (res.stderr ?? "").trim();
  const line = stdout || stderr;
  return line.replace(/^Python\s+/i, "") || "unknown";
}

/**
 * Importable + version query for a single Python package. Returns the
 * version string or null if the import fails for any reason. Uses a
 * tiny inline script via -c so we don't need a temp file.
 */
function readPythonPackageVersion(
  venvPythonPath: string,
  packageName: string,
): string | null {
  // importlib.metadata is the modern way; falls back gracefully on
  // older packages that don't ship metadata.
  const code = `import importlib.metadata, sys\n` +
    `try:\n` +
    `    print(importlib.metadata.version(${JSON.stringify(packageName)}))\n` +
    `except importlib.metadata.PackageNotFoundError:\n` +
    `    sys.exit(1)\n`;
  const res = spawnSync(venvPythonPath, ["-c", code], { encoding: "utf-8" });
  if (res.status !== 0) return null;
  const version = (res.stdout ?? "").trim();
  return version || null;
}

// =====================================================================
// System binary resolution
// =====================================================================

function whichSync(name: string): string | null {
  const path = process.env.PATH ?? "";
  if (!path) return null;

  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];

  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      // We don't need to check the X bit explicitly; existence inside a
      // PATH dir is the convention every shell uses.
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function readBinaryVersion(binPath: string): string | undefined {
  // Many tools expose `--version`; some only stderr. Capture both.
  const res = spawnSync(binPath, ["--version"], {
    encoding: "utf-8",
    timeout: 5000,
  });
  if (res.error) return undefined;
  const out = (res.stdout ?? "").trim() || (res.stderr ?? "").trim();
  if (!out) return undefined;
  // Trim to first line — most version strings are one line; longer
  // banners aren't useful in the manifest.
  return out.split(/\r?\n/)[0]?.trim();
}

function formatMissingBinary(name: string, dep: DependencySpec): string {
  const platform = process.platform;
  const hint =
    platform === "darwin"
      ? dep.installHint.mac
      : platform === "linux"
        ? dep.installHint.linux
        : dep.installHint.windows ?? `(no install hint for ${platform})`;
  return `${name}: ${hint}`;
}

// Re-exported for tests so they can poke the path helpers without
// touching the real PATH.
export { whichSync as _whichSyncForTest };

// Re-export for tests of the cross-platform path join semantics.
export const _venvPythonPathSep = sep;
