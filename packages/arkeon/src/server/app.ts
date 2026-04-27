// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";

import type { AppBindings } from "./types.js";
import { requestContextMiddleware } from "./middleware/request-context.js";
import { ApiError, errorBody } from "./lib/errors.js";
import { mapDatabaseError } from "./lib/db-errors.js";
import { createSql } from "./lib/sql.js";
import { spacesRouter } from "./routes/spaces.js";
import { entitiesRouter } from "./routes/entities.js";
import { searchRouter } from "./routes/search.js";
import { contributeRouter } from "./routes/contribute.js";

export function createApp() {
  const app = new Hono<AppBindings>();

  app.use("*", requestContextMiddleware);

  app.get("/", (c) =>
    c.json({
      name: "arkeon-wiki",
      status: "ok",
    }),
  );

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

  app.route("/spaces", spacesRouter);
  app.route("/entities", entitiesRouter);
  app.route("/search", searchRouter);
  app.route("/contribute", contributeRouter);

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
