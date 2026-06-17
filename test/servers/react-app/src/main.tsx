import { createRoot } from "react-dom/client";
import { App } from "./App";

// Render with fixed inputs so the trace is deterministic — the breakpoint in priceFor hits on mount.
createRoot(document.getElementById("root")!).render(<App qty={3} code="SAVE10" />);
