-- Copyright (c) 2026 Arkeon Technologies, Inc.
-- SPDX-License-Identifier: Apache-2.0
--
-- Agent-applied tags on entities.
--
-- `properties` is file-derived (rebuilt by syncFile() from <meta> tags).
-- `tags` is agent-applied bookkeeping — a separate JSON bag the sync
-- path never touches, so an editor agent's `editor.processed_hash`
-- survives file re-syncs and is cleared only when the entity itself
-- is deleted (or the DB is wiped).

ALTER TABLE entities ADD COLUMN tags TEXT NOT NULL DEFAULT '{}';
