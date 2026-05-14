/**
 * Status pill. Maps `status` → design-system class on `.spill.<status>`.
 *
 * Backward-compat: existing call sites pass `<StatusPill status="active" />`
 * with NO children — we preserve the default-label fallback that the
 * Phase-6 version had, so those call sites keep rendering "Active" /
 * "Revoked" / "Access" / "Emergency" / "Pending" / "Granted" / "Stored"
 * without any change.
 *
 * Pass children to override the default label.
 */
export function StatusPill({ status = "default", children, className = "" }) {
  const label = children ?? DEFAULT_LABELS[status] ?? "Unknown";
  return (
    <span className={`spill ${status} ${className}`.trim()}>
      <span className="dt" />
      {label}
    </span>
  );
}

const DEFAULT_LABELS = {
  active: "Active",
  revoked: "Revoked",
  pending: "Pending",
  emergency: "Emergency",
  access: "Access",
  granted: "Granted",
  stored: "Stored",
  brand: "Info",
  default: "Unknown",
};

export default StatusPill;
