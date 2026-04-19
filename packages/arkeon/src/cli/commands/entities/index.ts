// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { MAX_FILE_SIZE, computeCidFromBytes } from "../../lib/cid.js";
import { credentials } from "../../lib/credentials.js";
import { defaultFilename, inferContentType, parseContentDispositionFilename } from "../../lib/files.js";
import { apiRequest, apiResponse } from "../../lib/http.js";
import { resolveBinaryInput } from "../../lib/input.js";
import { output } from "../../lib/output.js";

const DIRECT_UPLOAD_THRESHOLD = 8 * 1024 * 1024;

type EntityResponse = {
  wiki: {
    id: string;
    ver: number;
    properties?: Record<string, unknown>;
  };
};

type UploadUrlResponse = {
  upload_url: string;
  r2_key: string;
  expires_at: string;
};

type UploadResult = {
  cid: string;
  size: number;
  key: string;
  ver: number;
};

type DeleteFileOptions = {
  key?: string;
  cid?: string;
  ver?: string;
};

type RenameFileOptions = {
  from: string;
  to: string;
  ver?: string;
};

type UploadOptions = {
  key: string;
  ver?: string;
  filename?: string;
  contentType?: string;
  strategy?: "auto" | "direct" | "presigned";
};

type DownloadOptions = {
  key?: string;
  cid?: string;
  output?: string;
};

function requireEntitiesGroup(program: Command): Command {
  return program.commands.find((command) => command.name() === "entities")
    ?? program.command("entities").description("entities operations");
}

async function getEntity(entityId: string): Promise<EntityResponse["wiki"]> {
  const result = await apiRequest<EntityResponse>(`/wiki/${encodeURIComponent(entityId)}`, {
    method: "GET",
    auth: "optional",
  });
  return result.wiki;
}

async function getCurrentVersion(entityId: string): Promise<number> {
  return (await getEntity(entityId)).ver;
}

function parseVersion(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error("Invalid version.");
  }
  return parsed;
}

async function uploadDirect(entityId: string, bytes: Uint8Array, options: { key: string; ver: number; filename?: string; contentType: string }): Promise<UploadResult> {
  const query = new URLSearchParams({
    key: options.key,
    ver: String(options.ver),
  });
  if (options.filename) {
    query.set("filename", options.filename);
  }

  return apiRequest<UploadResult>(`/wiki/${encodeURIComponent(entityId)}/content?${query.toString()}`, {
    method: "POST",
    auth: true,
    headers: {
      "content-type": options.contentType,
      "content-length": String(bytes.byteLength),
    },
    body: bytes,
  });
}

async function uploadPresigned(entityId: string, bytes: Uint8Array, options: { key: string; ver: number; filename?: string; contentType: string }): Promise<UploadResult> {
  const cid = await computeCidFromBytes(bytes);
  const presign = await apiRequest<UploadUrlResponse>(`/wiki/${encodeURIComponent(entityId)}/content/upload-url`, {
    method: "POST",
    auth: true,
    body: JSON.stringify({
      cid,
      content_type: options.contentType,
      size: bytes.byteLength,
    }),
  });

  const uploadResponse = await fetch(presign.upload_url, {
    method: "PUT",
    headers: {
      "content-type": options.contentType,
      "content-length": String(bytes.byteLength),
    },
    body: bytes,
  });
  if (!uploadResponse.ok) {
    throw new Error(`Presigned upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
  }

  return apiRequest<UploadResult>(`/wiki/${encodeURIComponent(entityId)}/content/complete`, {
    method: "POST",
    auth: true,
    body: JSON.stringify({
      key: options.key,
      cid,
      size: bytes.byteLength,
      content_type: options.contentType,
      ver: options.ver,
      ...(options.filename ? { filename: options.filename } : {}),
    }),
  });
}

export function registerEntityContentCommands(program: Command): void {
  const entities = requireEntitiesGroup(program);

  entities
    .command("upload <id> <file>")
    .description("Upload a file to an entity")
    .requiredOption("--key <key>", "Content key")
    .option("--ver <n>", "Current entity version (defaults to latest)")
    .option("--filename <name>", "Display filename (defaults to source filename)")
    .option("--content-type <mime>", "MIME type (defaults from file extension)")
    .option("--strategy <mode>", "Upload strategy: auto | direct | presigned", "auto")
    .addHelpText("after", "\nInput: <file> may be a path or - for stdin bytes")
    .action(async (id: string, file: string, options: UploadOptions) => {
      try {
        credentials.requireApiKey();
        const absolutePath = resolve(file);
        const bytes = await resolveBinaryInput(file);
        if (bytes.byteLength > MAX_FILE_SIZE) {
          throw new Error("File exceeds 500 MB limit.");
        }

        const ver = parseVersion(options.ver) ?? await getCurrentVersion(id);
        const filename = options.filename ?? (file === "-" ? `${id}.bin` : defaultFilename(absolutePath));
        const contentType = options.contentType ?? (file === "-" ? "application/octet-stream" : inferContentType(absolutePath));
        const strategy = options.strategy ?? "auto";
        const resolvedStrategy = strategy === "auto"
          ? (bytes.byteLength <= DIRECT_UPLOAD_THRESHOLD ? "direct" : "presigned")
          : strategy;

        output.progress(`Uploading ${file === "-" ? "stdin" : basename(absolutePath)} (${bytes.byteLength} bytes)...`);
        const result = resolvedStrategy === "direct"
          ? await uploadDirect(id, bytes, { key: options.key, ver, filename, contentType })
          : resolvedStrategy === "presigned"
            ? await uploadPresigned(id, bytes, { key: options.key, ver, filename, contentType })
            : bytes.byteLength <= DIRECT_UPLOAD_THRESHOLD
              ? await uploadDirect(id, bytes, { key: options.key, ver, filename, contentType })
              : await uploadPresigned(id, bytes, { key: options.key, ver, filename, contentType });

        output.result({
          operation: "entities.upload",
          entity_id: id,
          path: file === "-" ? "-" : absolutePath,
          key: result.key,
          cid: result.cid,
          ver: result.ver,
          size: result.size,
          filename,
          content_type: contentType,
          strategy: resolvedStrategy,
        });
      } catch (error) {
        output.error(error, { operation: "entities.upload" });
        process.exitCode = 1;
      }
    });

  entities
    .command("download <id> [destination]")
    .description("Download a file from an entity")
    .option("--key <key>", "Content key")
    .option("--cid <cid>", "Specific CID")
    .action(async (id: string, destination: string | undefined, options: DownloadOptions) => {
      try {
        const query = new URLSearchParams();
        if (options.key) {
          query.set("key", options.key);
        }
        if (options.cid) {
          query.set("cid", options.cid);
        }

        const response = await apiResponse(
          `/wiki/${encodeURIComponent(id)}/content${query.size ? `?${query.toString()}` : ""}`,
          {
            method: "GET",
            auth: "optional",
          },
        );

        const bytes = new Uint8Array(await response.arrayBuffer());
        const inferredName =
          destination
          ?? parseContentDispositionFilename(response.headers.get("content-disposition"))
          ?? options.key
          ?? options.cid
          ?? `${id}.bin`;
        const outputPath = resolve(inferredName);
        writeFileSync(outputPath, bytes);

        output.result({
          operation: "entities.download",
          entity_id: id,
          path: outputPath,
          bytes: bytes.byteLength,
          content_type: response.headers.get("content-type") ?? "application/octet-stream",
          key: options.key ?? null,
          cid: options.cid ?? null,
        });
      } catch (error) {
        output.error(error, { operation: "entities.download" });
        process.exitCode = 1;
      }
    });

  entities
    .command("delete-file <id>")
    .description("Delete a file from an entity")
    .option("--key <key>", "Content key")
    .option("--cid <cid>", "Specific CID")
    .option("--ver <n>", "Current entity version (defaults to latest)")
    .action(async (id: string, options: DeleteFileOptions) => {
      try {
        credentials.requireApiKey();
        if (!options.key && !options.cid) {
          throw new Error("Specify --key or --cid.");
        }
        const ver = parseVersion(options.ver) ?? await getCurrentVersion(id);
        const query = new URLSearchParams({ ver: String(ver) });
        if (options.key) {
          query.set("key", options.key);
        }
        if (options.cid) {
          query.set("cid", options.cid);
        }

        await apiRequest<void>(`/wiki/${encodeURIComponent(id)}/content?${query.toString()}`, {
          method: "DELETE",
          auth: true,
        });
        const latestVer = await getCurrentVersion(id);

        output.result({
          operation: "entities.delete-file",
          entity_id: id,
          ver: latestVer,
          key: options.key ?? null,
          cid: options.cid ?? null,
        });
      } catch (error) {
        output.error(error, { operation: "entities.delete-file" });
        process.exitCode = 1;
      }
    });

  entities
    .command("rename-file <id>")
    .description("Rename a file key on an entity")
    .requiredOption("--from <key>", "Current content key")
    .requiredOption("--to <key>", "New content key")
    .option("--ver <n>", "Current entity version (defaults to latest)")
    .action(async (id: string, options: RenameFileOptions) => {
      try {
        credentials.requireApiKey();
        const ver = parseVersion(options.ver) ?? await getCurrentVersion(id);

        const result = await apiRequest<{ ok: boolean; ver: number }>(`/wiki/${encodeURIComponent(id)}/content`, {
          method: "PATCH",
          auth: true,
          body: JSON.stringify({
            from: options.from,
            to: options.to,
            ver,
          }),
        });

        output.result({
          operation: "entities.rename-file",
          entity_id: id,
          from: options.from,
          to: options.to,
          ver: result.ver,
        });
      } catch (error) {
        output.error(error, { operation: "entities.rename-file" });
        process.exitCode = 1;
      }
    });
}
