import { Icon } from "./Icon.jsx";

/**
 * Stat card — big number + label + optional icon + optional delta.
 *
 *   <Stat label="Active Doctors" value={3} icon="doctor" tone="brand"
 *         delta="+2" deltaDirection="up" />
 */
export function Stat({ label, value, icon, tone, delta, deltaDirection }) {
  return (
    <div
      className={`stat${tone ? " tone-" + tone : ""}`}
      style={{ position: "relative" }}
    >
      <div style={{ position: "relative", zIndex: 1 }}>
        <div className="stat-label">
          {icon && <Icon name={icon} className="ico" />}
          {label}
        </div>
        <div className="stat-value">{value}</div>
        {delta && (
          <div className={`stat-delta${deltaDirection ? " " + deltaDirection : ""}`}>
            {deltaDirection === "up" && <Icon name="arrowUpRight" size={12} />}
            {delta}
          </div>
        )}
      </div>
    </div>
  );
}

export default Stat;
