import { Icon } from "../ui/Icon.jsx";
import { AddressDisplay } from "../ui/AddressDisplay.jsx";

/**
 * Left navigation rail. Ported from frontend/_design-reference/shell.jsx
 * with the prototype's "Demo · View as" role-switcher REMOVED — the real
 * role comes from App.jsx's owner()/isDoctor()/isPatient() detection and
 * is passed in as a prop.
 *
 * Props:
 *   role         — 'patient' | 'doctor' | 'admin' | 'none'
 *   route        — current sub-route key within the role
 *   setRoute     — setter for the route state
 *   walletAddr   — real connected account (for the wallet line)
 *   networkLabel — real network display string (e.g. "Sepolia · 11155111")
 */
const NAV_BY_ROLE = {
  patient: [
    { key: "overview", label: "Overview", icon: "dashboard" },
    { key: "upload", label: "Upload Record", icon: "upload" },
    { key: "records", label: "My Records", icon: "records" },
    { key: "consents", label: "Consents", icon: "shield" },
    { key: "requests", label: "Pending Requests", icon: "bell" },
    { key: "history", label: "Access History", icon: "history" },
  ],
  doctor: [
    { key: "overview", label: "Overview", icon: "dashboard" },
    { key: "request", label: "Request Access", icon: "send" },
    { key: "consents", label: "My Consents", icon: "shield" },
    { key: "history", label: "Access History", icon: "history" },
    { key: "key", label: "Encryption Key", icon: "key" },
  ],
  admin: [
    { key: "overview", label: "Overview", icon: "dashboard" },
    { key: "doctors", label: "Doctors", icon: "doctor" },
    { key: "register", label: "Register Doctor", icon: "plus" },
    { key: "emergency", label: "Emergency Audit", icon: "emergency" },
    { key: "activity", label: "Activity Feed", icon: "activity" },
  ],
};

const ROLE_TITLES = {
  patient: "Patient",
  doctor: "Doctor",
  admin: "Administrator",
};

export function Sidebar({ role, route, setRoute, walletAddr, networkLabel }) {
  const items = NAV_BY_ROLE[role] || [];

  return (
    <aside className="sidebar">
      <div className="brand-row">
        <div className="brand-mark">
          <Icon name="cross" size={20} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="brand-name">Health Data Platform</div>
          <div className="brand-sub">Decentralized · v1.0</div>
        </div>
      </div>

      <div className="nav-group">
        <div className="nav-label">{ROLE_TITLES[role] || "Account"}</div>
        {items.map((it) => (
          <button
            key={it.key}
            className={`nav-item${route === it.key ? " active" : ""}`}
            onClick={() => setRoute?.(it.key)}
          >
            <Icon name={it.icon} className="ico" />
            <span>{it.label}</span>
          </button>
        ))}
      </div>

      {/* Wallet + network footer. NO demo role-switcher — the real role
          comes from App.jsx's contract-driven detection. */}
      <div className="role-panel">
        <div className="role-meta">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="wallet" size={13} style={{ color: "var(--ink-3)" }} />
            <AddressDisplay address={walletAddr} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="network" size={13} style={{ color: "var(--ink-3)" }} />
            <span style={{ fontSize: 12, color: "var(--ink-2)" }}>
              {networkLabel || "—"}
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}

export default Sidebar;
