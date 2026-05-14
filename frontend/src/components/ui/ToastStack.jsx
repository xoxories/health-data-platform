import { Icon } from "./Icon.jsx";

/**
 * Stacked toast notifications.
 *
 *   <ToastStack items={[{ id, tone: 'danger'|'warn'|undefined, title, body }]} />
 *
 * Tone defaults to the design-system's accent (no override) when omitted.
 */
export function ToastStack({ items }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="toast-stack">
      {items.map((t) => (
        <div key={t.id} className="toast">
          <div
            className="t-ico"
            style={
              t.tone === "danger"
                ? { background: "var(--danger-soft)", color: "var(--danger)" }
                : t.tone === "warn"
                  ? { background: "var(--warn-soft)", color: "var(--warn)" }
                  : undefined
            }
          >
            <Icon
              name={
                t.tone === "danger"
                  ? "warning"
                  : t.tone === "warn"
                    ? "info"
                    : "check"
              }
              size={14}
            />
          </div>
          <div>
            <div className="t-title">{t.title}</div>
            {t.body && <div className="t-body">{t.body}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

export default ToastStack;
