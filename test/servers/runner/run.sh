#!/usr/bin/env bash
# Demo entrypoint: wait until every target (shared localhost) and the collector are up, then run all
# scenarios once. The runner shares the demo network namespace, so the targets are reachable on
# 127.0.0.1 exactly as scenarios.sh expects — no edits to scenarios.sh needed.
set -u
C="${TRACE_COLLECTOR_URL:-http://trace-collector:4747}"

wait_http() { local url="$1" name="$2"; for _ in $(seq 1 120); do
    if curl -sf -o /dev/null "$url"; then echo "[runner] ready: $name"; return 0; fi; sleep 1; done
  echo "[runner] TIMEOUT waiting for $name ($url)"; return 1; }
wait_tcp() { local port="$1" name="$2"; for _ in $(seq 1 120); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then exec 3>&- 3<&-; echo "[runner] ready: $name (:$port)"; return 0; fi; sleep 1; done
  echo "[runner] TIMEOUT waiting for $name (:$port)"; return 1; }

echo "[runner] waiting for demo targets + collector…"
wait_http "http://127.0.0.1:3100/price?qty=1"             "node-api"     || exit 1
wait_http "http://127.0.0.1:3101/tax?amount=10&region=US" "python-api"   || exit 1
wait_http "http://127.0.0.1:5180/"                        "react-app"    || exit 1
wait_http "http://127.0.0.1:9334/json/version"            "chrome"       || exit 1
wait_tcp  9230 "node --inspect"                                          || exit 1
wait_tcp  5679 "debugpy"                                                 || exit 1
wait_http "$C/api/sessions"                               "collector"    || exit 1

echo "[runner] all targets ready — running scenarios → $C"
exec bash test/servers/scenarios.sh
