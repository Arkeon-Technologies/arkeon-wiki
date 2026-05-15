// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";

import type { AppBindings } from "./types.js";
import { requestContextMiddleware } from "./middleware/request-context.js";
import { ApiError, errorBody } from "./lib/errors.js";
import { mapDatabaseError } from "./lib/db-errors.js";
import { createSql } from "./lib/sql.js";
import { LLMS_TXT } from "./lib/llms-txt.js";
import { spacesRouter } from "./routes/spaces.js";
import { spaceScopedRouter } from "./routes/space-scoped.js";
import { inboxRouter } from "./routes/inbox.js";
import { readerRouter } from "./routes/reader.js";

export function createApp() {
  const app = new Hono<AppBindings>();

  app.use("*", requestContextMiddleware);

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/ready", (c) => {
    try {
      const sql = createSql();
      sql`SELECT 1`;
      return c.json({ status: "ready" });
    } catch {
      return c.json({ status: "unavailable" }, 503);
    }
  });

  app.get("/llms.txt", (c) =>
    c.body(LLMS_TXT, 200, { "content-type": "text/plain; charset=utf-8" }),
  );
  app.get("/help", (c) =>
    c.body(LLMS_TXT, 200, { "content-type": "text/plain; charset=utf-8" }),
  );

  app.route("/spaces", spacesRouter);
  app.route("/", spaceScopedRouter);
  // Inbox/source-write endpoints sit before the reader so the reader's
  // `/:space/*` GET fallback never shadows them (it wouldn't anyway —
  // distinct methods — but mounting order keeps the intent explicit).
  app.route("/", inboxRouter);
  // The reader is mounted last because its `/:space/*` fallback should
  // only match URLs no other route has claimed.
  app.route("/", readerRouter);

  app.notFound((c) => {
    const requestId = c.get("requestId");
    return c.json(
      {
        error: {
          code: "not_found",
          message: "Route not found",
          request_id: requestId,
        },
      },
      404,
    );
  });

  app.onError((error, c) => {
    const requestId = c.get("requestId");

    if (error instanceof ApiError) {
      return new Response(JSON.stringify(errorBody(error, requestId)), {
        status: error.status,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const dbError = mapDatabaseError(error);
    if (dbError) {
      console.error("[db]", error);
      return new Response(JSON.stringify(errorBody(dbError, requestId)), {
        status: dbError.status,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    console.error(error);
    return new Response(
      JSON.stringify(
        errorBody(
          new ApiError(500, "internal_error", "Internal server error"),
          requestId,
        ),
      ),
      {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  });

  return app;
}
