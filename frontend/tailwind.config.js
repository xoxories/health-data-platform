import defaultTheme from "tailwindcss/defaultTheme";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        display: ["'Sora Variable'", ...defaultTheme.fontFamily.sans],
        sans: ["'Inter Variable'", ...defaultTheme.fontFamily.sans],
        mono: ["'Geist Mono Variable'", ...defaultTheme.fontFamily.mono],
      },
      colors: {
        // Medical-blue scale — aliased so future palette tweaks
        // are a one-line config change. Values mirror Tailwind's
        // `sky` scale (chosen for its clean, clinical hue).
        brand: {
          50: "#f0f9ff",
          100: "#e0f2fe",
          200: "#bae6fd",
          300: "#7dd3fc",
          400: "#38bdf8",
          500: "#0ea5e9",
          600: "#0284c7",
          700: "#0369a1",
          800: "#075985",
          900: "#0c4a6e",
          950: "#082f49",
        },
        // Healthcare cyan accent — used sparingly for highlights.
        accent: {
          50: "#ecfeff",
          100: "#cffafe",
          200: "#a5f3fc",
          300: "#67e8f9",
          400: "#22d3ee",
          500: "#06b6d4",
          600: "#0891b2",
          700: "#0e7490",
          800: "#155e75",
          900: "#164e63",
          950: "#083344",
        },
        surface: {
          DEFAULT: "#ffffff",
          alt: "#f8fafc",
          dark: "#0f172a",
          darkAlt: "#1e293b",
        },
      },
    },
  },
  plugins: [],
};
