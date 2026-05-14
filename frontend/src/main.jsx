import React from "react";
import ReactDOM from "react-dom/client";

// Variable fonts — load before app styles so first paint has the right metrics.
import "@fontsource-variable/sora";
import "@fontsource-variable/inter";
import "@fontsource-variable/geist-mono";

import App from "./App.jsx";
import { ThemeProvider } from "./contexts/ThemeContext.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
