/**
 * Primary / secondary / danger / ghost button with size + loading variants.
 *
 *   <Button>Click me</Button>
 *   <Button variant="danger" size="sm" loading>Confirming…</Button>
 *
 * Loading state shows an inline spinner and forces disabled. Any other
 * props (type, onClick, form, aria-*) pass through to the underlying
 * <button>.
 */
export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled = false,
  children,
  className = "",
  ...rest
}) {
  const sizing =
    size === "sm"
      ? "px-3 py-1.5 text-xs"
      : size === "lg"
        ? "px-5 py-3 text-base"
        : "px-4 py-2 text-sm";

  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg font-medium " +
    "shadow-sm transition focus:outline-none focus-visible:ring-2 " +
    "focus-visible:ring-brand-500 focus-visible:ring-offset-2 " +
    "dark:focus-visible:ring-offset-surface-dark " +
    "disabled:cursor-not-allowed disabled:opacity-60";

  const palette =
    variant === "primary"
      ? "bg-brand-600 text-white hover:bg-brand-700 " +
        "disabled:bg-brand-400"
      : variant === "danger"
        ? "bg-red-600 text-white hover:bg-red-700 " +
          "disabled:bg-red-400"
        : variant === "ghost"
          ? "bg-transparent text-slate-600 hover:bg-slate-100 " +
            "dark:text-slate-300 dark:hover:bg-surface-darkAlt " +
            "shadow-none"
          : // secondary
            "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 " +
            "dark:border-slate-700 dark:bg-surface-darkAlt dark:text-slate-200 " +
            "dark:hover:bg-slate-800";

  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={base + " " + sizing + " " + palette + " " + className}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
      aria-hidden
    />
  );
}

export default Button;
