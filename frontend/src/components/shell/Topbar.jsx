import { Icon } from "../ui/Icon.jsx";
import { Button } from "../ui/Button.jsx";
import { ThemeToggle } from "../ui/ThemeToggle.jsx";

/**
 * Top action bar. Ported from frontend/_design-reference/shell.jsx with:
 *   - hardcoded "Sepolia · 11155111" pill replaced by a real
 *     `networkLabel` prop computed by App.jsx
 *   - disconnect button wired to a real `onDisconnect` handler
 *   - search input rendered but NOT wired in this phase (visual-only)
 *
 * Props:
 *   title         — breadcrumb / page heading text
 *   sub           — small text under the title (optional)
 *   networkLabel  — e.g. "Sepolia · 11155111" or "Hardhat · 31337"
 *   onDisconnect  — optional click handler; the button is hidden if omitted
 */
export function Topbar({ title, sub, networkLabel, onDisconnect }) {
  return (
    <header className="topbar">
      <div className="crumb">
        <div style={{ minWidth: 0 }}>
          <div className="crumb-title">{title}</div>
          {sub && <div className="crumb-sub">{sub}</div>}
        </div>
      </div>

      <div className="topbar-actions">
        {/* Search input is decorative in this phase — kept as a visual
            placeholder while we focus on the shell migration. Wiring is
            a later phase. */}
        <div className="input-with-icon" style={{ width: 280 }}>
          <Icon name="search" className="ico" size={14} />
          <input
            className="input"
            placeholder="Search records, addresses…"
            aria-label="Search (not wired)"
          />
        </div>

        {networkLabel && (
          <span className="pill">
            <span className="dot" /> {networkLabel}
          </span>
        )}

        <button className="icon-btn" aria-label="Notifications" type="button">
          <Icon name="bell" size={16} />
        </button>

        <ThemeToggle />

        {onDisconnect && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onDisconnect}
            title="Disconnect wallet"
            aria-label="Disconnect"
          >
            Log out
          </Button>
        )}
      </div>
    </header>
  );
}

export default Topbar;
