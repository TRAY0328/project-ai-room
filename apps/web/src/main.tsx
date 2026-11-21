import { createRoot } from "react-dom/client";
import "@ai-room/design-system/base.css";
import "./styles/app.css";
import { App } from "./app/App.js";

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

// Theme colours are applied by ThemeProvider before first paint of interactive UI.
createRoot(container).render(<App />);
