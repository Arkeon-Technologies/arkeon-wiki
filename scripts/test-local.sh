#!/bin/bash
# Run the same checks as CI locally before pushing.
# Usage: ./scripts/test-local.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

step() { echo -e "\n${BOLD}=== $1 ===${NC}"; }
pass() { echo -e "${GREEN}PASS${NC}: $1"; }
fail() { echo -e "${RED}FAIL${NC}: $1"; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# A scratch ARKEON_WIKI_HOME so we don't stomp on the developer's real ~/.arkeon-wiki
SCRATCH_DIR="$(mktemp -d -t arkeon-test-XXXXXX)"
PIDFILE="/tmp/arkeon-test-local.$$.pid"
LOGFILE="/tmp/arkeon-test-local.$$.log"
cleanup() {
  if [ -f "$PIDFILE" ]; then
    kill -TERM "$(cat "$PIDFILE")" 2>/dev/null || true
  fi
  rm -rf "$SCRATCH_DIR" "$PIDFILE" "$LOGFILE"
}
trap cleanup EXIT

# Typecheck the single arkeon package
step "Typecheck: arkeon"
npm run typecheck -w packages/arkeon || fail "arkeon typecheck"
pass "arkeon typecheck"

# Unit tests
step "Unit tests: arkeon"
npm test -w packages/arkeon || fail "arkeon unit tests"
pass "arkeon unit tests"

# Start Arkeon stack via the CLI in the background. The explorer SPA
# is built automatically by arkeon's build pipeline (bundle-explorer),
# but here we run via tsx against src/, so the CLI falls back to
# packages/explorer/dist — build it first.
step "Build: Explorer"
npm run build -w packages/explorer || fail "Explorer build"
pass "Explorer build"

step "Starting Arkeon stack"
ARKEON_WIKI_HOME="$SCRATCH_DIR" nohup npx tsx packages/arkeon/src/index.ts start \
  --port 8000 --pg-port 15433 --meili-port 17700 \
  > "$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"

step "Waiting for API health"
for i in $(seq 1 60); do
  if curl -sf http://localhost:8000/health > /dev/null 2>&1; then
    pass "API is healthy"
    break
  fi
  if [ $i -eq 60 ]; then
    echo "Logs:"
    tail -100 "$LOGFILE"
    fail "API did not start within 120s"
  fi
  sleep 2
done

# E2E tests — the admin key is generated on first start, read it from the log
ADMIN_KEY=$(grep "Admin API key" "$LOGFILE" | tail -1 | awk '{print $NF}')
step "Running e2e tests"
E2E_BASE_URL=http://localhost:8000 \
ADMIN_BOOTSTRAP_KEY="$ADMIN_KEY" \
npm run test:e2e -w packages/arkeon || fail "E2E tests"
pass "E2E tests"

echo -e "\n${GREEN}${BOLD}All checks passed.${NC} Safe to push."
