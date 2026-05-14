/**
 * Horizontal stepper for multi-phase txs.
 *
 *   <StatusPipeline
 *     current="confirming"
 *     steps={[
 *       { key: "encrypting",  label: "Encrypting" },
 *       { key: "uploading",   label: "Uploading"  },
 *       { key: "signing",     label: "Wallet"     },
 *       { key: "confirming",  label: "Confirming" },
 *       { key: "done",        label: "Done"       },
 *     ]}
 *   />
 *
 * `current` is one of the step keys, or `null` (idle), or `"error"`.
 * Steps before the current one render checked; the current step shows
 * a spinner; later steps render as outlined circles.
 *
 * The component does NOT own phase state — the parent passes `current`
 * straight from its existing status state machine. Phase keys are
 * preserved verbatim from each call site (so e.g. "uploading" stays
 * "uploading"); only the visual rendering changes.
 */
export function StatusPipeline({ current, steps }) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const currentIdx = steps.findIndex((s) => s.key === current);
  const isDone = current === "done";
  const isError = current === "error";

  return (
    <ol
      role="list"
      className="flex flex-wrap items-center gap-x-2 gap-y-2 text-xs"
    >
      {steps.map((step, i) => {
        let phase;
        if (isError) {
          phase = "error";
        } else if (isDone) {
          phase = "done";
        } else if (currentIdx === -1) {
          phase = "pending";
        } else if (i < currentIdx) {
          phase = "done";
        } else if (i === currentIdx) {
          phase = "active";
        } else {
          phase = "pending";
        }

        return (
          <li key={step.key} className="flex items-center gap-2">
            <Marker phase={phase} index={i + 1} />
            <span
              className={
                phase === "active"
                  ? "font-medium text-brand-700 dark:text-brand-300"
                  : phase === "done"
                    ? "text-slate-600 dark:text-slate-400"
                    : phase === "error"
                      ? "text-red-700 dark:text-red-300"
                      : "text-slate-400 dark:text-slate-500"
              }
            >
              {step.label}
            </span>
            {i < steps.length - 1 && (
              <span
                aria-hidden
                className={
                  "hidden h-px w-6 sm:inline-block " +
                  (phase === "done"
                    ? "bg-brand-300 dark:bg-brand-700"
                    : "bg-slate-200 dark:bg-slate-700")
                }
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Marker({ phase }) {
  const baseCls =
    "inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold ";

  if (phase === "done") {
    return (
      <span
        className={
          baseCls + "bg-brand-600 text-white dark:bg-brand-500"
        }
        aria-label="completed"
      >
        ✓
      </span>
    );
  }
  if (phase === "active") {
    return (
      <span
        className={
          baseCls +
          "border-2 border-brand-500 bg-white text-brand-700 dark:bg-surface-darkAlt dark:text-brand-300"
        }
        aria-label="in progress"
      >
        <span className="block h-2 w-2 animate-spin rounded-full border-2 border-current border-t-transparent" />
      </span>
    );
  }
  if (phase === "error") {
    return (
      <span
        className={baseCls + "bg-red-600 text-white"}
        aria-label="error"
      >
        !
      </span>
    );
  }
  // pending
  return (
    <span
      className={
        baseCls +
        "border border-slate-300 text-slate-400 dark:border-slate-600 dark:text-slate-500"
      }
      aria-hidden
    >
      ○
    </span>
  );
}

export default StatusPipeline;
