#!/usr/bin/env bash
# End-to-end debug scenarios across Node · React, each emitted to the trace dashboard.
# Every server below has a planted bug so the tracer has something to reveal.
#
# Setup (in separate terminals, or background them):
#   docker compose up                                          # collector UI :4747 + mock-aws S3 :9000
#   PORT=3100 node --inspect=9230 test/servers/node-api/server.js              # order API
#   ( cd test/servers/react-app && npm install && npm run dev )                # checkout UI :5180
#   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
#     --headless=new --remote-debugging-port=9334 --user-data-dir=/tmp/chrome-trace about:blank &
#
# Then:  bash test/servers/scenarios.sh        # open http://localhost:4747 to watch them land live
set -u
T="node bin/trace run"
# Emission to the collector is driven by TRACE_COLLECTOR_URL (every run POSTs its envelope); export it so the
# CLI sees it. (There is no --emit flag — the env var is the contract; see README.)
export TRACE_COLLECTOR_URL="${TRACE_COLLECTOR_URL:-http://localhost:4747}"
C="$TRACE_COLLECTOR_URL"
export S3_ENDPOINT="${S3_ENDPOINT:-http://localhost:9000}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-minioadmin}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-minioadmin}"

echo "# 1 — Node checkout subtotal loop: subtotal accumulates per line item → LINEAGE (coupon bug shows in the response)"
$T --node 9230 --max-hits 10 \
  --curl 'curl -s "http://127.0.0.1:3100/checkout?cart=widget:2,gadget:1,gizmo:3&coupon=SAVE10&region=US"' \
  --breakpoint "test/servers/node-api/server.js@subtotal += it.lineTotal" \
  --expression subtotal --expression 'it.sku' --expression 'it.lineTotal'

echo "# 2 — Node error: unknown region → throws → 502 (bad input visible just before the throw)"
$T --node 9230 \
  --curl 'curl -s "http://127.0.0.1:3100/checkout?cart=widget:2&coupon=SAVE10&region=MARS"' \
  --breakpoint "test/servers/node-api/server.js@const rate = RATES[region]" --expression region --expression 'Object.keys(RATES)'

echo "# 3 — React parseInt bug: cart total drops the cents (sum: 0 → 19 → 43); records a video to S3"
$T --chrome 9334 --url http://localhost:5180 --root test/servers/react-app --max-hits 5 \
  --breakpoint "src/price.ts@sum = sum + parseInt" --expression sum --expression 'it.lineTotal'

echo "# done — open $C"
