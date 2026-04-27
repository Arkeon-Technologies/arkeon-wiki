#!/bin/bash
# Full clean-room smoke test: nuke all local Arkeon state, build from
# source, pack a tarball, and install+run it in an isolated scratch
# directory — exactly as a first-time `npm install arkeon` user would.
#
# Usage: ./scripts/smoke-clean.sh [--keep]
#   --keep    Don't delete the scratch directory afterward (for debugging)
#
# WARNING: This wipes ~/.arkeon-wiki (embedded Postgres data, Meilisearch
# binary, secrets). If you have data you care about, back it up first.

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
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=true ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="$(mktemp -d -t arkeon-smoke-XXXXXX)"
LOGFILE="$SCRATCH/arkeon.log"
PORT=18000
PG_PORT=18433
MEILI_PORT=18700

cleanup() {
  step "Cleanup"
  # Stop Arkeon if running in the scratch env
  if [ -f "$SCRATCH/state/pids/api.pid" ] 2>/dev/null; then
    ARKEON_WIKI_HOME="$SCRATCH/state" npx arkeon down 2>/dev/null || true
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

# ---------------------------------------------------------------
# Phase 1: Nuke local Arkeon state
# ---------------------------------------------------------------
step "Phase 1: Clean slate"

# Stop any running instance
echo "Stopping any running Arkeon instance..."
cd "$ROOT"
npx tsx packages/arkeon/src/index.ts stop 2>/dev/null || true
# Kill anything on the ports we'll use
lsof -ti :$PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti :$PG_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti :$MEILI_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true

# Uninstall global arkeon if present
if npm list -g arkeon 2>/dev/null | grep -q arkeon; then
  echo "Removing global arkeon install..."
  npm uninstall -g arkeon
fi

# Wipe Arkeon home directory
if [ -d "$HOME/.arkeon-wiki" ]; then
  echo "Wiping ~/.arkeon-wiki..."
  rm -rf "$HOME/.arkeon-wiki"
  pass "~/.arkeon-wiki removed"
else
  echo "~/.arkeon-wiki does not exist, nothing to wipe"
fi

pass "Clean slate established"

# ---------------------------------------------------------------
# Phase 2: Build from source
# ---------------------------------------------------------------
step "Phase 2: Build from source"
cd "$ROOT"

echo "Clean install of monorepo dependencies..."
rm -rf node_modules packages/*/node_modules package-lock.json
npm install

echo "Building arkeon..."
npm run build -w packages/arkeon || fail "arkeon build"

pass "Build complete"

# Check dist size sanity (should be ~2.5-3MB, alarm at 5MB)
DIST_SIZE=$(du -sm packages/arkeon/dist | awk '{print $1}')
echo "dist/ size: ${DIST_SIZE}MB"
if [ "$DIST_SIZE" -gt 5 ]; then
  warn "dist/ is ${DIST_SIZE}MB — expected ~3MB. Possible bundling issue."
  echo "Largest files in dist/:"
  find packages/arkeon/dist -type f -exec du -k {} + | sort -rn | head -10
fi

# ---------------------------------------------------------------
# Phase 3: Pack tarball
# ---------------------------------------------------------------
step "Phase 3: Pack tarball"
cd "$ROOT/packages/arkeon"
TARBALL=$(npm pack 2>&1 | tail -1)
TARBALL_PATH="$ROOT/packages/arkeon/$TARBALL"

if [ ! -f "$TARBALL_PATH" ]; then
  fail "npm pack did not produce a tarball"
fi

TARBALL_SIZE=$(du -sm "$TARBALL_PATH" | awk '{print $1}')
echo "Tarball: $TARBALL (${TARBALL_SIZE}MB)"
pass "Tarball created"

# ---------------------------------------------------------------
# Phase 4: Install in clean scratch directory
# ---------------------------------------------------------------
step "Phase 4: Install in scratch directory"
cd "$SCRATCH"
npm init -y > /dev/null 2>&1
npm install "$TARBALL_PATH" || fail "npm install from tarball"

# Verify the binary is resolvable
if ! npx arkeon --version > /dev/null 2>&1; then
  # --version might not exist, try --help
  npx arkeon --help > /dev/null 2>&1 || fail "arkeon binary not resolvable after install"
fi
pass "arkeon installed from tarball"

# ---------------------------------------------------------------
# Phase 5: Run the full lifecycle
# ---------------------------------------------------------------
step "Phase 5: Lifecycle test"
export ARKEON_WIKI_HOME="$SCRATCH/state"

echo "arkeon init..."
npx arkeon init || fail "arkeon init"
pass "init"

echo "arkeon up (logging to $LOGFILE)..."
npx arkeon up --port $PORT --pg-port $PG_PORT --meili-port $MEILI_PORT > "$LOGFILE" 2>&1 &
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
    fail "arkeon up process exited unexpectedly"
  fi
  if [ $i -eq 60 ]; then
    echo "Last 50 lines of log:"
    tail -50 "$LOGFILE"
    fail "API did not become healthy within 120s"
  fi
  sleep 2
done

echo "Testing /health..."
HEALTH=$(curl -sf "http://localhost:$PORT/health")
echo "  $HEALTH"
pass "/health"

echo "Testing /openapi.json..."
curl -sf "http://localhost:$PORT/openapi.json" | head -c 200
echo
pass "/openapi.json"

echo "Testing /llms.txt..."
curl -sf "http://localhost:$PORT/llms.txt" | head -5
pass "/llms.txt"

echo "Testing /explore (explorer SPA)..."
EXPLORE_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "http://localhost:$PORT/explore")
if [ "$EXPLORE_STATUS" = "200" ]; then
  pass "/explore (status $EXPLORE_STATUS)"
else
  warn "/explore returned status $EXPLORE_STATUS (non-fatal)"
fi

# Seed and verify entities exist
echo "arkeon seed..."
ADMIN_KEY=$(grep "Admin API key" "$LOGFILE" | tail -1 | awk '{print $NF}')
if [ -z "$ADMIN_KEY" ]; then
  # Try reading from secrets.json
  ADMIN_KEY=$(cat "$ARKEON_WIKI_HOME/secrets.json" 2>/dev/null | grep -o '"adminKey":"[^"]*"' | cut -d'"' -f4)
fi

if [ -n "$ADMIN_KEY" ]; then
  npx arkeon seed || warn "arkeon seed failed (non-fatal)"

  echo "Testing GET /wikis..."
  WIKI_COUNT=$(curl -sf -H "X-API-Key: $ADMIN_KEY" "http://localhost:$PORT/wikis" | grep -o '"total":[0-9]*' | cut -d: -f2)
  if [ -n "$WIKI_COUNT" ] && [ "$WIKI_COUNT" -gt 0 ]; then
    pass "Wikis exist after seed (count: $WIKI_COUNT)"
  else
    warn "No wikis found after seed (may be expected if seed is empty)"
  fi
else
  warn "Could not extract admin key — skipping seed and entity check"
fi

echo "arkeon down..."
npx arkeon down || fail "arkeon down"
pass "Clean shutdown"

# ---------------------------------------------------------------
# Summary
# ---------------------------------------------------------------
echo ""
echo -e "${GREEN}${BOLD}Smoke test passed.${NC}"
echo "  Tarball: $TARBALL"
echo "  Size:    ${TARBALL_SIZE}MB (dist: ${DIST_SIZE}MB)"
echo "  Scratch: $SCRATCH"
[ "$KEEP" = true ] && echo "  (scratch directory preserved with --keep)"
