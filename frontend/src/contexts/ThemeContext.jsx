import { createContext, useCallback, useContext, useEffect, useState } from "react";

const ThemeContext = createContext(null);

const STORAGE_KEY = "hdp-theme";

function getInitialTheme() {
  if (typeof window === "undefined") return "light";
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // localStorage unavailable (private mode, etc.) — fall through.
  }
  if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
}

function applyTheme(theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  // Phase 7 — Stage 1: the design system reads `data-theme="dark"` /
  // `data-theme="light"`, not the legacy `dark` class. Set the attribute
  // and proactively clear the old class in case it's still lingering
  // from a previous build (avoids both selectors fighting each other).
  root.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
  root.classList.remove("dark");
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => getInitialTheme());

  // Apply on mount + whenever theme changes.
  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // ignore quota / private-mode errors
    }
  }, [theme]);

  const setTheme = useCallback((next) => {
    if (next === "light" || next === "dark") setThemeState(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Fallback no-op so components don't crash if rendered outside the
    // provider (e.g. during isolated tests).
    return { theme: "light", setTheme: () => {}, toggleTheme: () => {} };
  }
  return ctx;
}
