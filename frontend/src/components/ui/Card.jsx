/**
 * Rounded-2xl card with header row + body. Use `action` to render a
 * right-aligned action slot (e.g. a Refresh button) next to the title.
 *
 *   <Card title="Foo" action={<Button…/>}>…</Card>
 *
 * `tone` colors the border subtly: 'default' | 'warning' | 'danger'.
 */
export function Card({
  title,
  action,
  children,
  padding = "default",
  tone = "default",
  className = "",
}) {
  const padCls =
    padding === "tight"
      ? "p-4"
      : padding === "none"
        ? ""
        : "p-6";

  const toneCls =
    tone === "warning"
      ? "border-amber-200 dark:border-amber-900/60"
      : tone === "danger"
        ? "border-red-200 dark:border-red-900/60"
        : "border-slate-200 dark:border-slate-800";

  return (
    <section
      className={
        "rounded-2xl border bg-white shadow-sm transition-shadow hover:shadow-md " +
        "dark:bg-surface-darkAlt " +
        toneCls +
        " " +
        padCls +
        " " +
        className
      }
    >
      {(title || action) && (
        <header className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
          {title && (
            <h3 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
              {title}
            </h3>
          )}
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export default Card;
