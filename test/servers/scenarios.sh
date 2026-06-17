#!/usr/bin/env bash
# End-to-end debug scenarios across Node · Python · React, each emitted to the trace dashboard.
# Every server below has a planted bug so the tracer has something to reveal.
#
# Setup (in separate terminals, or background them):
#   docker compose up                                          # collector UI :4747 + mock-aws S3 :9000
#   PORT=3101 DEBUG_PORT=5679 python3 test/servers/python-api/server.py        # tax service
#   PORT=3100 TAX_SVC=http://127.0.0.1:3101 node --inspect=9230 test/servers/node-api/server.js   # order API
#   ( cd test/servers/react-app && npm install && npm run dev )                # checkout UI :5180
#   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
#     --headless=new --remote-debugging-port=9334 --user-data-dir=/tmp/chrome-trace about:blank &
#
# Then:  bash test/servers/scenarios.sh        # open http://localhost:4747 to watch them land live
set -u
T="node bin/trace dynamic"
C="${TRACE_COLLECTOR_URL:-http://localhost:4747}"
export S3_ENDPOINT="${S3_ENDPOINT:-http://localhost:9000}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-minioadmin}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-minioadmin}"

echo "# 1 — Node checkout subtotal loop: subtotal accumulates per line item → LINEAGE (coupon bug shows in the response)"
$T --node 9230 --emit "$C" --max-hits 10 \
  --curl 'curl -s "http://127.0.0.1:3100/checkout?cart=widget:2,gadget:1,gizmo:3&coupon=SAVE10&region=US"' \
  --bp "test/servers/node-api/server.js@subtotal += it.lineTotal" \
  --expr subtotal --expr 'it.sku' --expr 'it.lineTotal'

echo "# 2 — Python tax compounding bug: tax balloons across phases (mutation lineage tells the story)"
$T --python 5679 --emit "$C" --max-hits 5 \
  --curl 'curl -s "http://127.0.0.1:3101/tax?amount=40&region=US"' \
  --bp "test/servers/python-api/server.py@tax = tax + taxable * rate" --expr tax --expr taxable

echo "# 3 — Python error: unknown region → KeyError → 500 (bad input visible just before the throw)"
$T --python 5679 --emit "$C" \
  --curl 'curl -s "http://127.0.0.1:3101/tax?amount=40&region=MARS"' \
  --bp "test/servers/python-api/server.py@rate = RATES[region]" --expr region --expr 'list(RATES.keys())'

echo "# 4 — Node cascade: the tax-service 500 propagates to a 502 (res.status + failing URL captured)"
$T --node 9230 --emit "$C" \
  --curl 'curl -s "http://127.0.0.1:3100/checkout?cart=widget:2&coupon=SAVE10&region=MARS"' \
  --bp "test/servers/node-api/server.js@!res.ok" --expr 'res.status' --expr 'res.url'

echo "# 5 — React parseInt bug: cart total drops the cents (sum: 0 → 19 → 43); records a video to S3"
$T --chrome 9334 --url http://localhost:5180 --root test/servers/react-app --max-hits 5 --emit "$C" \
  --bp "src/price.ts@sum = sum + parseInt" --expr sum --expr 'it.lineTotal'

echo "# done — open $C"
