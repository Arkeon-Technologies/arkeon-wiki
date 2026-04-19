#!/bin/bash
# CI-safe pack smoke test: build a tarball, install it in a scratch
# directory, and run the full lifecycle — without touching ~/.arkeon-wiki
# or the developer's running instance.
#
# Usage: ./scripts/smoke-pack.sh [--keep] [--skip-build]
#   --keep         Don't delete the scratch directory afterward (for debugging)
#   --skip-build   Use npm pack --ignore-scripts (skip prepack build, useful
#                  when CI already built the package)
#
# Unlike smoke-clean.sh, this script:
#   - Never wipes ~/.arkeon-wiki or global state
#   - Uses unique ports (19000/19433/19700) to avoid conflicts
#   - Validates tarball contents before installing
#   - Tests CLI commands (status, seed, entities, actors, docs)
#   - Validates the explorer SPA serves correctly
#   - Can reuse a cached Meilisearch binary via MEILI_CACHE_DIR

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

step()  { echo -e "\n${BOLD}=== $1 ===${NC}"; }
pass()  { echo -e "${GREEN}PASS${NC}: $1"; }
fail()  { echo -e "${RED}FAIL${NC}: $1"; exit 1; }
warn()  { echo -e "${YELLOW}WARN${NC}: $1"; }

KEEP=false
SKIP_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=true ;;
    --skip-build) SKIP_BUILD=true ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="$(mktemp -d -t arkeon-smoke-pack-XXXXXX)"
LOGFILE="$SCRATCH/arkeon.log"
PORT=19000
PG_PORT=19433
MEILI_PORT=19700

# Allow CI to point at a cached Meilisearch binary directory
MEILI_CACHE_DIR="${MEILI_CACHE_DIR:-$HOME/.arkeon-wiki/bin}"

cleanup() {
  step "Cleanup"
  # Stop Arkeon if running in the scratch env (HOME override for Conf isolation)
  if [ -f "$SCRATCH/state/pids/api.pid" ] 2>/dev/null; then
    HOME="$SCRATCH" ARKEON_WIKI_HOME="$SCRATCH/state" npx arkeon-wiki down 2>/dev/null || true
  fi
  # Also try killing by port in case graceful shutdown fails
  lsof -ti :$PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
  lsof -ti :$PG_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
  lsof -ti :$MEILI_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true

  if [ "$KEEP" = true ]; then
    echo "Scratch directory kept at: $SCRATCH"
  else
    rm -rf "$SCRATCH"
    pass "Scratch directory cleaned"
  fi
}
trap cleanup EXIT

# Kill anything on our ports to avoid bind conflicts
lsof -ti :$PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti :$PG_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti :$MEILI_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true

# ---------------------------------------------------------------
# Phase 1: Pack tarball
# ---------------------------------------------------------------
step "Phase 1: Pack tarball"
cd "$ROOT/packages/arkeon"

if [ "$SKIP_BUILD" = true ]; then
  # prepack runs `npm run build` — skip it since we already built
  TARBALL=$(npm pack --ignore-scripts 2>&1 | tail -1)
else
  # Let prepack build everything
  TARBALL=$(npm pack 2>&1 | tail -1)
fi
TARBALL_PATH="$ROOT/packages/arkeon/$TARBALL"

if [ ! -f "$TARBALL_PATH" ]; then
  fail "npm pack did not produce a tarball"
fi

TARBALL_SIZE=$(du -sm "$TARBALL_PATH" | awk '{print $1}')
echo "Tarball: $TARBALL (${TARBALL_SIZE}MB)"
pass "Tarball created"

# ---------------------------------------------------------------
# Phase 3: Validate tarball contents
# ---------------------------------------------------------------
step "Phase 2: Validate tarball contents"

TARBALL_LISTING=$(tar tzf "$TARBALL_PATH")

assert_in_tarball() {
  if echo "$TARBALL_LISTING" | grep -q "$1"; then
    pass "tarball contains $1"
  else
    fail "tarball missing $1"
  fi
}

assert_in_tarball "package/dist/index.js"
assert_in_tarball "package/dist/explorer/index.html"
assert_in_tarball "package/dist/spec/openapi.snapshot.json"
assert_in_tarball "package/dist/schema/"

# Check dist size sanity (should be ~2.5-3MB, alarm at 5MB)
if [ -d "$ROOT/packages/arkeon/dist" ]; then
  DIST_SIZE=$(du -sm "$ROOT/packages/arkeon/dist" | awk '{print $1}')
  echo "dist/ size: ${DIST_SIZE}MB"
  if [ "$DIST_SIZE" -gt 5 ]; then
    warn "dist/ is ${DIST_SIZE}MB — expected ~3MB. Possible bundling issue."
  fi
fi

# ---------------------------------------------------------------
# Phase 4: Install in clean scratch directory
# ---------------------------------------------------------------
step "Phase 3: Install in scratch directory"
cd "$SCRATCH"
npm init -y > /dev/null 2>&1
npm install "$TARBALL_PATH" || fail "npm install from tarball"

# Verify the binary is resolvable
npx arkeon-wiki --help > /dev/null 2>&1 || fail "arkeon-wiki binary not resolvable after install"
pass "arkeon-wiki installed and binary resolves"

# ---------------------------------------------------------------
# Phase 5: Run the full lifecycle
# ---------------------------------------------------------------
step "Phase 4: Lifecycle test"
export ARKEON_WIKI_HOME="$SCRATCH/state"

# Pre-populate Meilisearch binary cache if available
if [ -d "$MEILI_CACHE_DIR" ] && [ "$(ls -A "$MEILI_CACHE_DIR" 2>/dev/null)" ]; then
  mkdir -p "$ARKEON_WIKI_HOME/bin"
  cp -a "$MEILI_CACHE_DIR"/* "$ARKEON_WIKI_HOME/bin/" 2>/dev/null || true
  echo "Pre-populated Meilisearch binary from cache"
fi

echo "arkeon-wiki up (logging to $LOGFILE)..."
npx arkeon-wiki up --port $PORT --pg-port $PG_PORT --meili-port $MEILI_PORT > "$LOGFILE" 2>&1 &
UP_PID=$!

echo "Waiting for API health (up to 120s)..."
for i in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
    pass "API is healthy"
    break
  fi
  if ! kill -0 $UP_PID 2>/dev/null; then
    echo "Process died. Last 50 lines of log:"
    tail -50 "$LOGFILE"
    fail "arkeon-wiki up process exited unexpectedly"
  fi
  if [ $i -eq 60 ]; then
    echo "Last 50 lines of log:"
    tail -50 "$LOGFILE"
    fail "API did not become healthy within 120s"
  fi
  sleep 2
done

# ---------------------------------------------------------------
# Phase 6: HTTP endpoint checks
# ---------------------------------------------------------------
step "Phase 5: HTTP endpoint checks"

echo "Testing /health..."
HEALTH=$(curl -sf "http://localhost:$PORT/health")
echo "  $HEALTH"
pass "/health"

echo "Testing /openapi.json..."
OPENAPI_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "http://localhost:$PORT/openapi.json")
if [ "$OPENAPI_STATUS" = "200" ]; then
  pass "/openapi.json (status 200)"
else
  fail "/openapi.json returned status $OPENAPI_STATUS"
fi

echo "Testing /llms.txt..."
LLMS_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "http://localhost:$PORT/llms.txt")
if [ "$LLMS_STATUS" = "200" ]; then
  pass "/llms.txt (status 200)"
else
  fail "/llms.txt returned status $LLMS_STATUS"
fi

echo "Testing /explore (explorer SPA)..."
EXPLORE_BODY=$(curl -sf "http://localhost:$PORT/explore")
EXPLORE_STATUS=$?
if [ $EXPLORE_STATUS -eq 0 ]; then
  pass "/explore returns 200"
  # Validate the SPA actually loaded (not an error page)
  if echo "$EXPLORE_BODY" | grep -q '<div id="root"'; then
    pass "/explore contains React mount point"
  else
    warn "/explore missing <div id=\"root\"> — SPA may not render"
  fi
  if echo "$EXPLORE_BODY" | grep -q '<script'; then
    pass "/explore contains <script> tag"
  else
    warn "/explore missing <script> tag — JS bundle may not load"
  fi
else
  warn "/explore failed (non-fatal, status $EXPLORE_STATUS)"
fi

# ---------------------------------------------------------------
# Phase 7: CLI command tests
# ---------------------------------------------------------------
step "Phase 6: CLI command tests"

# Extract admin key for authenticated commands
ADMIN_KEY=$(grep "Admin API key" "$LOGFILE" | tail -1 | awk '{print $NF}')
if [ -z "$ADMIN_KEY" ]; then
  ADMIN_KEY=$(cat "$ARKEON_WIKI_HOME/secrets.json" 2>/dev/null | grep -o '"adminKey":"[^"]*"' | cut -d'"' -f4)
fi

if [ -z "$ADMIN_KEY" ]; then
  fail "Could not extract admin key — cannot run CLI tests"
fi

# Configure the CLI to talk to our instance
# ARKE_API_URL: read by config.get("apiUrl") for all CLI commands
# ARKE_API_KEY: read by credentials.getApiKey() for authenticated commands
# HOME: isolate the Conf config store (~/.config or ~/Library/Preferences)
#   so global user config (e.g. spaceId) doesn't leak into the smoke test
export ARKE_API_URL="http://localhost:$PORT"
export ARKE_API_KEY="$ADMIN_KEY"
export HOME="$SCRATCH"

echo "arkeon-wiki status..."
npx arkeon-wiki status --port $PORT || fail "arkeon-wiki status"
pass "status"

echo "arkeon-wiki seed..."
npx arkeon-wiki seed || fail "arkeon-wiki seed"
pass "seed"

echo "arkeon-wiki seed (idempotent)..."
npx arkeon-wiki seed || fail "arkeon-wiki seed (second run)"
pass "seed idempotent"

echo "arkeon-wiki wiki list..."
ENTITIES_OUT=$(npx arkeon-wiki wiki list --raw 2>&1) || fail "arkeon-wiki wiki list"
if echo "$ENTITIES_OUT" | grep -q '"entities"'; then
  # Count entities in the response (non-empty array means seed data is visible)
  # Use `|| true` because grep returns exit 1 when no matches, which kills set -eo pipefail
  ENTITY_COUNT=$(echo "$ENTITIES_OUT" | grep -o '"id"' | wc -l | tr -d ' ' || true)
  if [ -n "$ENTITY_COUNT" ] && [ "$ENTITY_COUNT" -gt 0 ]; then
    pass "wiki list returns $ENTITY_COUNT entities"
  else
    fail "wiki list returned empty array — auth or RLS issue"
  fi
else
  fail "wiki list output missing 'entities' key"
fi

echo "arkeon-wiki actors list..."
ACTORS_OUT=$(npx arkeon-wiki actors list --raw 2>&1) || fail "arkeon-wiki actors list"
if echo "$ACTORS_OUT" | grep -q '"actors"'; then
  pass "actors list returns actors array"
elif echo "$ACTORS_OUT" | grep -q '"data"'; then
  pass "actors list returns data"
else
  warn "actors list output unexpected: $(echo "$ACTORS_OUT" | head -3)"
fi

echo "arkeon-wiki wiki create..."
CREATE_OUT=$(npx arkeon-wiki wiki create --label "Smoke Test Entity" --short-description "A smoke test entity" --keywords '["smoke"]' --content "Smoke test content." --type person --raw 2>&1) || fail "arkeon-wiki wiki create"
# grep returns exit 1 when no match — use || true to prevent set -eo pipefail from killing the script
# --raw output uses "id": "..." (with spaces), so match both formats
ENTITY_ID=$(echo "$CREATE_OUT" | grep -oE '"id"\s*:\s*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)
if [ -n "$ENTITY_ID" ]; then
  pass "wiki create returned id: $ENTITY_ID"

  echo "arkeon-wiki wiki get $ENTITY_ID..."
  GET_OUT=$(npx arkeon-wiki wiki get "$ENTITY_ID" --raw 2>&1) || fail "arkeon-wiki wiki get"
  if echo "$GET_OUT" | grep -q "Smoke Test Entity"; then
    pass "wiki get returns correct entity"
  else
    warn "wiki get — entity data mismatch"
  fi
else
  fail "wiki create — could not extract entity id. Output: $(echo "$CREATE_OUT" | head -5)"
fi

echo "arkeon-wiki docs..."
npx arkeon-wiki docs > /dev/null 2>&1 || fail "arkeon-wiki docs"
pass "docs"

# ---------------------------------------------------------------
# Phase 8: Clean shutdown
# ---------------------------------------------------------------
step "Phase 7: Clean shutdown"

echo "arkeon-wiki down..."
npx arkeon-wiki down || fail "arkeon-wiki down"
pass "Clean shutdown"

# Verify ports are freed
sleep 1
if lsof -ti :$PORT > /dev/null 2>&1; then
  warn "Port $PORT still in use after shutdown"
else
  pass "Port $PORT freed"
fi

# ---------------------------------------------------------------
# Summary
# ---------------------------------------------------------------
echo ""
echo -e "${GREEN}${BOLD}Smoke test passed.${NC}"
echo "  Tarball: $TARBALL"
echo "  Size:    ${TARBALL_SIZE}MB"
echo "  Scratch: $SCRATCH"
if [ "$KEEP" = true ]; then
  echo "  (scratch directory preserved with --keep)"
fi
