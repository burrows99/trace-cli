#!/usr/bin/env bash
# All-in-one demo entrypoint. This single container IS the whole demo: it starts every target on its own
# loopback (one container = one network namespace, so each server is on 127.0.0.1 exactly as scenarios.sh
# expects), waits for them + the collector, then runs all 5 scenarios once and exits. Replaces the old
# six-service demo group (node-api / python-api / react-app / chrome + a shared-netns anchor + this runner).
set -u
C="${TRACE_COLLECTOR_URL:-http://trace-collector:4747}"

echo "[demo] starting targets…"

# 1) Node order-API / BFF (:3100) under the inspector (:9230). No deps — pure node:http.
PORT=3100 TAX_SVC=http://127.0.0.1:3101 \
  node --inspect=9230 test/servers/node-api/server.js &

# 2) Python tax service (:3101), debugpy on :5679. debugpy.listen() doesn't block, so it's traceable at once.
PORT=3101 DEBUG_PORT=5679 \
  python3 test/servers/python-api/server.py &

# 3) React/Vite checkout UI (:5180). The app source is bind-mounted read-only and vite writes a cache, so
#    serve from a writable copy. Same files → same source maps, so scenario #5's `--root test/servers/
#    react-app` breakpoint still resolves. --host 0.0.0.0: bind all interfaces (vite defaults to ::1).
cp -r test/servers/react-app /tmp/react-app
( cd /tmp/react-app && npm install --no-audit --no-fund && npm run dev -- --host 0.0.0.0 ) &

# 4) Headless Chrome being traced (CDP :9334).
/usr/bin/chromium --headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu \
  --remote-debugging-port=9334 --remote-debugging-address=127.0.0.1 \
  --remote-allow-origins='*' --user-data-dir=/tmp/chrome-trace about:blank &

wait_http() { local url="$1" name="$2"; for _ in $(seq 1 120); do
    if curl -sf -o /dev/null "$url"; then echo "[demo] ready: $name"; return 0; fi; sleep 1; done
  echo "[demo] TIMEOUT waiting for $name ($url)"; return 1; }
wait_tcp() { local port="$1" name="$2"; for _ in $(seq 1 120); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then exec 3>&- 3<&-; echo "[demo] ready: $name (:$port)"; return 0; fi; sleep 1; done
  echo "[demo] TIMEOUT waiting for $name (:$port)"; return 1; }

echo "[demo] waiting for targets + collector…"
wait_http "http://127.0.0.1:3100/price?qty=1"             "node-api"     || exit 1
wait_http "http://127.0.0.1:3101/tax?amount=10&region=US" "python-api"   || exit 1
wait_http "http://127.0.0.1:5180/"                        "react-app"    || exit 1
wait_http "http://127.0.0.1:9334/json/version"            "chrome"       || exit 1
wait_tcp  9230 "node --inspect"                                          || exit 1
wait_tcp  5679 "debugpy"                                                 || exit 1
wait_http "$C/api/sessions"                               "collector"    || exit 1

echo "[demo] all targets ready — running scenarios → $C"
exec bash test/servers/scenarios.sh
