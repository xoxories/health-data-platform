import { Icon } from "./Icon.jsx";

/**
 * Multi-step phase tracker ported from the prototype.
 *
 *   <Pipeline current="signing" steps={[
 *     { key: 'validating', label: 'Validating' },
 *     { key: 'signing',    label: 'Waiting for wallet' },
 *     { key: 'confirming', label: 'Confirming' },
 *     { key: 'done',       label: 'Done' },
 *   ]} />
 *
 * Exported as both `Pipeline` (the design-system name, used by new code)
 * and `StatusPipeline` (the legacy alias kept so existing imports —
 * e.g. AdminPanel.jsx — continue to resolve). Same component either way.
 */
export function Pipeline({ steps, current }) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const idx = steps.findIndex((s) => s.key === current);
  return (
    <div className="pipeline">
      {steps.map((s, i) => {
        const state = i < idx ? "done" : i === idx ? "current" : "pending";
        return (
          <div key={s.key} className={`step ${state}`}>
            <div className="indicator">
              {state === "done" ? (
                <Icon name="check" size={12} />
              ) : state === "current" ? (
                ""
              ) : (
                i + 1
              )}
            </div>
            <div className="step-label">{s.label}</div>
          </div>
        );
      })}
    </div>
  );
}

// Legacy alias — keep AdminPanel.jsx's existing import valid.
export const StatusPipeline = Pipeline;

export default Pipeline;
