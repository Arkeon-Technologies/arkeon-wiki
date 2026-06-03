# syntax=docker/dockerfile:1.7
# Copyright (c) 2026 Arkeon Technologies, Inc.
# SPDX-License-Identifier: Apache-2.0

# ----------------------------------------------------------------------------
# Builder: compile TypeScript, bundle extractor scripts + schema, pack tarball.
# ----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /src

# Workspace package manifests first — keeps the npm-ci layer cacheable
# across source-only changes.
COPY package.json package-lock.json ./
COPY packages/arkeon/package.json packages/arkeon/package.json

RUN npm ci --workspaces --include-workspace-root

COPY packages/arkeon ./packages/arkeon

RUN npm run build -w packages/arkeon \
 && npm pack -w packages/arkeon --pack-destination /tmp

# ----------------------------------------------------------------------------
# Runtime: slim node base + python venv + global arkeon-wiki install.
# ----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# System deps:
#   python3 + venv  → PyMuPDF runtime for the PDF extractor.
#   gosu            → drop privileges to PUID/PGID in the entrypoint.
#   tini            → PID 1 signal forwarding (so SIGTERM reaches node).
#   ca-certificates → outbound HTTPS for future extractor fetches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        python3 \
        python3-venv \
        python3-pip \
        gosu \
        tini \
        ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ----- Bake Python venv at a known absolute path -----
# Handlers shell out to ${ARKEON_WIKI_VENV}/bin/python; the path lands
# in /opt/arkeon-wiki/adapters.json below so the runtime sees it
# regardless of $ARKEON_WIKI_HOME.
ENV ARKEON_WIKI_VENV=/opt/arkeon-wiki/python

COPY packages/arkeon/src/server/extractors/python/requirements.lock /tmp/requirements.lock

RUN python3 -m venv "${ARKEON_WIKI_VENV}" \
 && "${ARKEON_WIKI_VENV}/bin/pip" install --no-cache-dir --upgrade pip \
 && "${ARKEON_WIKI_VENV}/bin/pip" install --no-cache-dir --require-hashes -r /tmp/requirements.lock \
 && rm /tmp/requirements.lock

# ----- Install arkeon-wiki globally from the packed tarball -----
# Native modules (better-sqlite3) need to fetch their prebuilds, so
# scripts must run — do NOT pass --ignore-scripts.
COPY --from=builder /tmp/arkeon-wiki-*.tgz /tmp/
RUN npm install -g /tmp/arkeon-wiki-*.tgz \
 && rm /tmp/arkeon-wiki-*.tgz

# ----- Bake the adapters manifest at a known path -----
# Mirrors the AdaptersManifest TypeScript shape. The runtime reads this
# via $ARKEON_WIKI_ADAPTERS_PATH (set below). PYMUPDF_VERSION is a build
# arg so a one-line bump tracks the lockfile.
ARG PYMUPDF_VERSION=1.27.2.3
RUN PY_VER="$(${ARKEON_WIKI_VENV}/bin/python --version | sed 's/^Python //')" \
 && GEN_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
 && mkdir -p /opt/arkeon-wiki \
 && printf '%s\n' \
      '{' \
      '  "schema_version": 1,' \
      "  \"python\": { \"path\": \"${ARKEON_WIKI_VENV}/bin/python\", \"version\": \"${PY_VER}\" }," \
      '  "system_binaries": {},' \
      "  \"python_packages\": { \"pymupdf\": { \"version\": \"${PYMUPDF_VERSION}\" } }," \
      "  \"generated_at\": \"${GEN_AT}\"" \
      '}' \
      > /opt/arkeon-wiki/adapters.json

# ----- User + dirs -----
# node:22-bookworm-slim ships with a pre-existing `node` user at 1000.
# Remove it so `arkeon` owns uid 1000 by default; entrypoint can remap
# via PUID/PGID at runtime to match the host's bind-mount owner.
RUN userdel -r node 2>/dev/null || true \
 && groupdel node 2>/dev/null || true \
 && groupadd --gid 1000 arkeon \
 && useradd --uid 1000 --gid arkeon --shell /bin/bash --create-home arkeon \
 && mkdir -p /watch /state \
 && chown -R arkeon:arkeon /watch /state /opt/arkeon-wiki

# ----- Environment -----
ENV ARKEON_WIKI_IN_CONTAINER=1 \
    ARKEON_WIKI_HOME=/state \
    ARKEON_WIKI_WATCH_DIR=/watch \
    ARKEON_WIKI_HOST=0.0.0.0 \
    ARKEON_WIKI_ADAPTERS_PATH=/opt/arkeon-wiki/adapters.json \
    PORT=8062

EXPOSE 8062
VOLUME ["/watch", "/state"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8062)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

COPY docker/entrypoint.sh /usr/local/bin/arkeon-wiki-entrypoint
RUN chmod +x /usr/local/bin/arkeon-wiki-entrypoint

# tini reaps zombies and forwards SIGTERM cleanly. The entrypoint
# defaults to `start` (foreground daemon mode), matching the launchd /
# systemd contract.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/arkeon-wiki-entrypoint"]
CMD ["start"]
