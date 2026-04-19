#!/usr/bin/env bash
# Run the manual resolve test suite against a real LLM.
#
# Prereqs:
#   - An LLM API key, via one of:
#       * OPENAI_API_KEY env var
#       * ~/.arkeon-wiki/llm.json (written by `arkeon init --llm-*`)
#   - Either a running `arkeon up` daemon, or let this script spin up a
#     fresh scratch stack on isolated ports.
#
# Usage:
#   OPENAI_API_KEY=sk-... ./scripts/test-resolve-live.sh
#   # or, with an already-running stack:
#   ADMIN_BOOTSTRAP_KEY=ak-... E2E_BASE_URL=http://localhost:8000 ./scripts/test-resolve-live.sh --use-running

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

step() { echo -e "\n${BOLD}=== $1 ===${NC}"; }
pass() { echo -e "${GREEN}PASS${NC}: $1"; }
fail() { echo -e "${RED}FAIL${NC}: $1"; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# --- Flag parsing ---
USE_RUNNING=false
for arg in "$@"; do
  case "$arg" in
    --use-running) USE_RUNNING=true ;;
    *) echo "Unknown arg: $arg"; exit 2 ;;
  esac
done

# --- Preflight: LLM config check ---
if [ -z "${OPENAI_API_KEY:-}" ] && [ ! -f "${HOME}/.arkeon-wiki/llm.json" ]; then
  fail "No LLM config. Set OPENAI_API_KEY or run: arkeon init --llm-provider openai --llm-base-url https://api.openai.com/v1 --llm-api-key sk-... --llm-model gpt-5.4-nano"
fi

# --- Path A: use an already-running stack ---
if [ "$USE_RUNNING" = true ]; then
  if [ -z "${ADMIN_BOOTSTRAP_KEY:-}" ]; then
    fail "--use-running requires ADMIN_BOOTSTRAP_KEY to be set (the admin key of the running stack)"
  fi
  step "Using running stack at ${E2E_BASE_URL:-http://localhost:8000}"
  npm run test:manual -w packages/arkeon -- wiki-resolve.test.ts || fail "resolve tests"
  pass "resolve tests"
  exit 0
fi

# --- Path B: spin up a scratch stack ---
SCRATCH_DIR="$(mktemp -d -t arkeon-resolve-test-XXXXXX)"
PIDFILE="/tmp/arkeon-resolve-test.$$.pid"
LOGFILE="/tmp/arkeon-resolve-test.$$.log"
API_PORT=18000
PG_PORT=18433
MEILI_PORT=18700

cleanup() {
  if [ -f "$PIDFILE" ]; then
    kill -TERM "$(cat "$PIDFILE")" 2>/dev/null || true
  fi
  rm -rf "$SCRATCH_DIR" "$PIDFILE" "$LOGFILE" 2>/dev/null || true
}
trap cleanup EXIT

step "Build: Explorer"
npm run build -w packages/explorer > /dev/null || fail "Explorer build"
pass "Explorer build"

step "Starting scratch Arkeon stack on ports ${API_PORT}/${PG_PORT}/${MEILI_PORT}"
# Pass OPENAI_API_KEY through to the child process so the server can use it.
# If the user has ~/.arkeon-wiki/llm.json instead, that's picked up automatically
# via ARKEON_WIKI_HOME (scratch dir) — but we don't want to leak the user's real
# llm.json into the scratch run, so we copy it in if it exists.
if [ -f "${HOME}/.arkeon-wiki/llm.json" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
  cp "${HOME}/.arkeon-wiki/llm.json" "${SCRATCH_DIR}/llm.json"
fi

ARKEON_WIKI_HOME="$SCRATCH_DIR" nohup npx tsx packages/arkeon/src/index.ts start \
  --port "$API_PORT" --pg-port "$PG_PORT" --meili-port "$MEILI_PORT" \
  > "$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"

step "Waiting for API health"
for i in $(seq 1 60); do
  if curl -sf "http://localhost:${API_PORT}/health" > /dev/null 2>&1; then
    pass "API is healthy"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "Logs:"
    tail -100 "$LOGFILE"
    fail "API did not start within 120s"
  fi
  sleep 2
done

# Extract the admin key the daemon generated on first start
ADMIN_KEY=$(grep "Admin API key" "$LOGFILE" | tail -1 | awk '{print $NF}')
if [ -z "$ADMIN_KEY" ]; then
  echo "Logs:"
  tail -50 "$LOGFILE"
  fail "Could not extract admin key from log"
fi

step "Running manual resolve tests"
E2E_BASE_URL="http://localhost:${API_PORT}" \
ADMIN_BOOTSTRAP_KEY="$ADMIN_KEY" \
OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  npm run test:manual -w packages/arkeon -- wiki-resolve.test.ts \
  || fail "resolve tests"

pass "resolve tests"
echo -e "\n${GREEN}${BOLD}All checks passed.${NC}"
