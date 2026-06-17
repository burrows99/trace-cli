"""A tiny zero-dependency Python API to trace. It opens a debugpy DAP server, then serves HTTP. Point
`trace dynamic --python` at the DAP port and trigger it with a curl:

    python3 test/servers/python-api/server.py            # serves :3001, debugpy on :5678
    trace dynamic --python \
      --curl 'curl -s "http://127.0.0.1:3001/price?qty=3&code=SAVE10"' \
      --bp test/servers/python-api/server.py@'total =' \
      --expr rate --expr subtotal

The business logic mirrors test/servers/node-api/server.js line-for-line, so the SAME breakpoint/trace
shape works across languages — CDP for Node, DAP (debugpy) for Python.
"""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import debugpy

DISCOUNTS = {"SAVE10": 0.10, "HALF": 0.5}


def discount(code):
    return DISCOUNTS.get(code, 0.0)


def price_for(qty, unit, code):
    subtotal = qty * unit
    rate = discount(code)
    total = subtotal * (1 - rate)
    return {"subtotal": subtotal, "rate": rate, "total": round(total, 2)}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/price":
            q = parse_qs(u.query)
            qty = int(q.get("qty", ["1"])[0])
            code = q.get("code", [""])[0]
            result = price_for(qty, 9.99, code)
            body = json.dumps(result).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"not found")

    def log_message(self, *args):  # keep the trace output clean
        pass


if __name__ == "__main__":
    debug_port = int(os.environ.get("DEBUG_PORT", "5678"))
    http_port = int(os.environ.get("PORT", "3001"))
    debugpy.listen(("127.0.0.1", debug_port))
    print(f"[python-api] http://127.0.0.1:{http_port} (debugpy :{debug_port})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", http_port), Handler).serve_forever()
