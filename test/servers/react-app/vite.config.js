import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server with source maps (default in dev) so `trace run --chrome` can resolve a `.tsx`
// breakpoint back to App.tsx through the map Vite reports on each module.
export default defineConfig({
  plugins: [react()],
  server: { port: 5180, strictPort: true },
});
