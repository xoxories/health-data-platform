import { Icon } from "./Icon.jsx";

/**
 * Ported from frontend/_design-reference/ui.jsx into an ES module.
 * Uses the design-system.css class set: `.btn.btn-primary`, `.btn-sm`,
 * `.btn-lg`, etc. The `.sp` class is the design system's spinner.
 *
 * Backward-compatible with the previous Phase-6 Button — same call sites
 * (variant, size, loading, disabled, children, onClick, type, etc.).
 */
export function Button({
  variant = "primary",
  size = "md",
  loading,
  icon,
  iconRight,
  children,
  className = "",
  ...rest
}) {
  const cls =
    `btn btn-${variant}` +
    (size === "sm" ? " btn-sm" : size === "lg" ? " btn-lg" : "") +
    (className ? " " + className : "");
  return (
    <button className={cls} disabled={loading || rest.disabled} {...rest}>
      {loading ? (
        <span className="sp" />
      ) : icon ? (
        <Icon name={icon} size={size === "sm" ? 14 : 16} />
      ) : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={size === "sm" ? 14 : 16} /> : null}
    </button>
  );
}

export default Button;
