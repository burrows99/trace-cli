# react-app — Chrome (CDP) trace fixture

A tiny Vite + React + TS app whose price logic mirrors `test/servers/{node-api,python-api}` — so the *same*
trace works on the frontend (Chrome/CDP) as on the backends (Node/CDP, Python/DAP). The traceable logic
lives in `src/price.ts` (plain TS → a clean esbuild source map), imported by `src/App.tsx`.

```bash
# 1) install + run the dev server (serves on :5180 with source maps)
cd test/servers/react-app && npm install && npm run dev

# 2) launch Chrome with remote debugging
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9334 --user-data-dir=/tmp/chrome-trace about:blank &

# 3) trace the render — the .ts breakpoint resolves through Vite's source map
trace dynamic --chrome 9334 --url http://localhost:5180 \
  --root test/servers/react-app \
  --bp "src/price.ts@total = subtotal" \
  --expr qty --expr code \
  --emit http://localhost:4747            # ← show it live in the UI
```

The hit shows the React render stack (`priceFor ← App ← renderWithHooks ← beginWork`) with the component
props in scope. Source-map resolution is the engine's job — no build-layout config needed.
