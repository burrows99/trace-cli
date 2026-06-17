import React from "react";          // explicit import → classic JSX runtime works regardless of dev pre-bundling
import { createRoot } from "react-dom/client";
import { App } from "./App";

// The breakpoint in displayTotal (price.ts) hits on mount as the cart total is computed.
createRoot(document.getElementById("root")!).render(<App />);
