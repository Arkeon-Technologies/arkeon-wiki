// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { ApiError } from "./errors";

export type EntityView = "full" | "summary" | "expanded";

export interface Projection {
  view: EntityView;
  fields: string[] | null;
}

export function parseProjection(viewRaw: string | undefined, fieldsRaw: string | undefined): Projection {
  if (fieldsRaw) {
    const fields = fieldsRaw
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean);

    if (!fields.length) {
      throw new ApiError(400, "invalid_query", "Invalid fields");
    }

    return {
      view: "full",
      fields,
    };
  }

  if (!viewRaw) {
    return { view: "full", fields: null };
  }

  if (viewRaw === "summary") {
    return { view: "summary", fields: null };
  }

  if (viewRaw === "expanded") {
    return { view: "expanded", fields: null };
  }

  throw new ApiError(400, "invalid_query", "Invalid view", {
    view: viewRaw,
  });
}

export function projectEntity<T extends Record<string, unknown>>(entity: T, projection: Projection) {
  const properties = (entity.properties ?? {}) as Record<string, unknown>;

  if (projection.fields) {
    const subset: Record<string, unknown> = {};
    for (const field of projection.fields) {
      if (Object.hasOwn(properties, field)) {
        subset[field] = properties[field];
      }
    }

    return {
      ...entity,
      properties: subset,
    };
  }

  if (projection.view === "summary") {
    return {
      id: entity.id,
      kind: entity.kind,
      type: entity.type,
      ver: entity.ver,
      owner_id: entity.owner_id,
      properties: {
        label: properties.label,
      },
      updated_at: entity.updated_at,
    };
  }

  return entity;
}
