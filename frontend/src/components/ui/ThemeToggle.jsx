import { Icon } from "./Icon.jsx";
import { useTheme } from "../../contexts/ThemeContext.jsx";

/**
 * Single-button light/dark switcher. Wired to the app's ThemeContext
 * (NOT the prototype's local-state version) so a single source of truth
 * drives the data-theme attribute, localStorage persistence, and the
 * system-preference fallback on first paint.
 *
 * Uses design-system.css `.icon-btn` so styling matches the rest of the
 * topbar action row.
 */
export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const next = theme === "light" ? "dark" : "light";
  return (
    <button
      type="button"
      className="icon-btn"
      onClick={toggleTheme}
      aria-label="Toggle theme"
      title={`Switch to ${next} mode`}
    >
      <Icon name={theme === "light" ? "moon" : "sun"} size={16} />
    </button>
  );
}

export default ThemeToggle;
