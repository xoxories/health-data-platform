/**
 * Compact colored pill for record/consent statuses.
 *
 *   <StatusPill status="active">Active</StatusPill>
 *
 * If no children are passed, a default label per status is used.
 */
export function StatusPill({ status = "default", children, size = "sm" }) {
  const sizing =
    size === "xs"
      ? "px-1.5 py-0.5 text-[10px]"
      : "px-2 py-0.5 text-xs";

  const palette = palettes[status] || palettes.default;

  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-full font-medium " +
        sizing +
        " " +
        palette.cls
      }
    >
      <Dot color={palette.dot} />
      {children ?? palette.label}
    </span>
  );
}

const palettes = {
  active: {
    cls: "bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
    dot: "bg-emerald-500",
    label: "Active",
  },
  revoked: {
    cls: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    dot: "bg-slate-400",
    label: "Revoked",
  },
  pending: {
    cls: "bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200",
    dot: "bg-amber-500",
    label: "Pending",
  },
  emergency: {
    cls: "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300",
    dot: "bg-red-500",
    label: "Emergency",
  },
  access: {
    cls: "bg-brand-50 text-brand-800 dark:bg-brand-900/30 dark:text-brand-300",
    dot: "bg-brand-500",
    label: "Access",
  },
  granted: {
    cls: "bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
    dot: "bg-emerald-500",
    label: "Granted",
  },
  stored: {
    cls: "bg-brand-50 text-brand-800 dark:bg-brand-900/30 dark:text-brand-300",
    dot: "bg-brand-500",
    label: "Stored",
  },
  default: {
    cls: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    dot: "bg-slate-400",
    label: "Unknown",
  },
};

function Dot({ color }) {
  return (
    <span
      className={"inline-block h-1.5 w-1.5 rounded-full " + color}
      aria-hidden
    />
  );
}

export default StatusPill;
