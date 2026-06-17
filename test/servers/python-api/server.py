"""Python tax service for the end-to-end demo. The Node order-API calls /tax. Two planted faults:
  - compute_tax COMPOUNDS tax across phases (a runaway accumulator) instead of taxing once.
  - an unknown region raises KeyError → 500, which the Node side surfaces as a cascading 502.
Run it (it serves :3101, debugpy on :5678):  python3 test/servers/python-api/server.py
"""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import debugpy

DISCOUNTS = {"SAVE10": 0.10, "HALF": 0.5}
RATES = {"US": 0.07, "EU": 0.20, "CA": 0.12}


# ---- original price demo (kept) ---------------------------------------------------------------
def discount(code):
    return DISCOUNTS.get(code, 0.0)


def price_for(qty, unit, code):
    subtotal = qty * unit
    rate = discount(code)
    total = subtotal * (1 - rate)
    return {"subtotal": subtotal, "rate": rate, "total": round(total, 2)}


# ---- tax service (the e2e demo) ---------------------------------------------------------------
def compute_tax(amount, region):
    rate = RATES[region]              # KeyError on an unknown region (e.g. MARS) → 500 → Node 502
    taxable = amount
    tax = 0.0
    for phase in range(3):            # BUG: feeds tax back into `taxable`, so `tax` balloons each phase
        tax = tax + taxable * rate
        taxable = taxable + tax
    return round(tax, 2)


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path == "/price":
                qty = int(q.get("qty", ["1"])[0])
                code = q.get("code", [""])[0]
                return self._json(200, price_for(qty, 9.99, code))
            if u.path == "/tax":
                amount = float(q.get("amount", ["0"])[0])
                region = q.get("region", ["US"])[0]
                tax = compute_tax(amount, region)
                return self._json(200, {"amount": amount, "region": region, "tax": tax})
            self._json(404, {"error": "not found"})
        except Exception as e:                      # unknown region etc. → surface as 500
            self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    debug_port = int(os.environ.get("DEBUG_PORT", "5678"))
    http_port = int(os.environ.get("PORT", "3101"))
    debugpy.listen(("127.0.0.1", debug_port))
    print(f"[python-api] http://127.0.0.1:{http_port} (debugpy :{debug_port})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", http_port), Handler).serve_forever()
