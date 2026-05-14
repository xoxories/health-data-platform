import { useTheme } from "../../contexts/ThemeContext.jsx";

/**
 * Single-button light/dark switcher. Sun in dark mode (click to go light),
 * moon in light mode (click to go dark). Keyboard accessible, has an
 * aria-label that always describes the *destination* state.
 */
export function ThemeToggle({ className = "" }) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
      className={
        "inline-flex h-9 w-9 items-center justify-center rounded-lg " +
        "border border-slate-200 bg-white text-slate-600 shadow-sm transition " +
        "hover:bg-slate-50 hover:text-slate-900 " +
        "dark:border-slate-700 dark:bg-surface-darkAlt dark:text-slate-300 " +
        "dark:hover:bg-slate-800 dark:hover:text-slate-100 " +
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 " +
        "focus-visible:ring-offset-2 dark:focus-visible:ring-offset-surface-dark " +
        className
      }
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export default ThemeToggle;
