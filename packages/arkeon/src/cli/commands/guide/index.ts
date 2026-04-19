// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Command } from "commander";

import {
  WHAT_IS_ARKEON,
  CORE_CONCEPTS,
  AUTHENTICATION,
  AUTH_PROFILES,
  BEST_PRACTICES,
  FILTERING_HINT,
} from "../../../shared/index.js";

const CLI_GUIDE = `# Arkeon CLI — Getting Started

## What is Arkeon?

${WHAT_IS_ARKEON}

## Core Concepts

${CORE_CONCEPTS}

## Authentication

${AUTHENTICATION}

Set up the CLI:
  arkeon config set-url https://your-instance.arkeon.tech
  arkeon auth set-api-key <your-key>
  arkeon auth status                    # verify you're authenticated

Or use environment variables:
  export ARKE_API_URL=https://your-instance.arkeon.tech
  export ARKE_API_KEY=<your-key>

## Your First Workflow

1. Create an entity
   arkeon wiki create --type note --properties '{"title":"Hello","body":"My first entity."}'

2. List entities
   arkeon wiki list

3. Create a relationship (source entity is the path argument, target is a flag)
   arkeon relationships create <source-entity-id> --predicate references --target-id <target-entity-id>

4. Search
   arkeon search query --q hello

## Working with Files

Arkeon can ingest and manage files on disk, keeping them in sync with the
knowledge graph.

Initialize a repo:
  arkeon init <space-name>

This binds the current directory to a space and creates .arkeon/state.json
to track the binding.

Ingest files into the graph:
  arkeon add <paths>

Raw documents are posted to the wiki pipeline. Files with YAML frontmatter
are treated as entity definitions and upserted directly.

Download graph entities to disk:
  arkeon pull

Writes wiki entities as wiki/<type>/<slug>.md files with YAML frontmatter.
You can then edit these files locally and push changes back.

Compare disk state with the graph:
  arkeon diff

Remove documents and their extracted children:
  arkeon rm <paths>

The typical workflow is: pull entities, edit on disk, then add the changed
files to push updates back to the graph.

## Working Within a Space

Spaces are organizational containers with their own access controls. Set a
default space so that every entity and relationship you create is automatically
added to it:

  arkeon config set-space <space-id>

Now entity and relationship creates automatically include space_id:
  arkeon entities create --type note --properties '{"title":"Hello"}'
  # ^ this entity is added to your configured space atomically

You can also pass --space-id per-command or as a global flag:
  arkeon --space-id <id> entities create --type note --properties '{"title":"Hello"}'

To grant permissions on an entity at creation time, pass --permissions:
  arkeon entities create --type note --properties '{"title":"Hello"}' --permissions '[{"grantee_type":"actor","grantee_id":"<id>","role":"editor"}]'

Override priority: --space-id flag > ARKE_SPACE_ID env var > config set-space

View or clear your space config:
  arkeon config get-space
  arkeon config clear-space

## Auth Profiles

${AUTH_PROFILES}

List profiles for the current instance:
  arkeon auth profiles

Switch the active profile:
  arkeon auth use <name>

Create a new actor and register it as a local profile (requires admin):
  arkeon auth add <name>

Self-service registration (no admin required):
  arkeon auth register

## Filtering

${FILTERING_HINT}

Example:
  arkeon wiki list --filter 'kind:entity,properties.subject_type:book,created_at>2026-01-01'

## Best Practices

${BEST_PRACTICES}

## Getting More Help

arkeon --help                             List all command groups
arkeon <group> --help                     List commands in a group
arkeon <group> <command> --help           Full usage, params, and route info

If a command fails, run --help for that command to see the exact parameters.
`;

export function registerGuideCommand(program: Command): void {
  program
    .command("guide")
    .description("Show the Arkeon getting-started guide")
    .action(() => {
      process.stdout.write(CLI_GUIDE);
    });
}
