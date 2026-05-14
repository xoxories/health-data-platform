import { Icon } from "./Icon.jsx";

/**
 * Card with header row + body. Ported from the prototype.
 *
 * Props (superset of the previous Phase-6 Card so existing call sites
 * keep working):
 *   title    — heading text (or node)
 *   sub      — subtitle text under the title
 *   icon     — Icon name shown in a tinted square next to the title
 *   action   — node rendered on the right of the header row (e.g. Refresh button)
 *   tone     — 'default' | 'warning' | 'danger' (mapped to `tone-warning`/`tone-danger` CSS classes)
 *   flush    — render `.card-body-flush` (no body padding)
 *   padding  — 'compact' shrinks body padding to 14px
 *   glass    — adds a frosted-glass background variant
 *   children — body content
 */
export function Card({
  title,
  sub,
  icon,
  action,
  tone,
  flush,
  padding,
  glass,
  children,
  className = "",
}) {
  const toneCls = tone ? ` tone-${tone}` : "";
  const glassCls = glass ? " glass" : "";
  return (
    <section className={`card${toneCls}${glassCls} ${className}`}>
      {(title || action) && (
        <header className="card-header">
          {icon ? (
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 10,
                display: "grid",
                placeItems: "center",
                background: "var(--brand-soft)",
                color: "var(--brand)",
                flex: "none",
              }}
            >
              <Icon name={icon} size={16} />
            </div>
          ) : null}
          <div style={{ minWidth: 0 }}>
            {title && <div className="card-title">{title}</div>}
            {sub && <div className="card-sub">{sub}</div>}
          </div>
          {action && <div className="card-action">{action}</div>}
        </header>
      )}
      <div
        className={flush ? "card-body-flush" : "card-body"}
        style={padding === "compact" ? { padding: 14 } : undefined}
      >
        {children}
      </div>
    </section>
  );
}

export default Card;
