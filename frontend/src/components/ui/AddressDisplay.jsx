import { useState } from "react";
import { Icon } from "./Icon.jsx";

/**
 * Click-to-copy address chip. Ported from the prototype, with an
 * additional `copyable={false}` opt-out for backward compatibility
 * with any caller that wanted a non-interactive label (the design-system
 * version always copies, but we preserve the older API).
 */
export function AddressDisplay({
  address,
  size = "md",
  label,
  copyable = true,
}) {
  const [copied, setCopied] = useState(false);
  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "";

  function copy(e) {
    e?.stopPropagation();
    if (!address) return;
    navigator.clipboard?.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  const cls = `addr${size === "lg" ? " lg" : ""}`;

  if (!copyable || !address) {
    return (
      <span className={cls} title={address}>
        {label && <span style={{ color: "var(--ink-3)", marginRight: 4 }}>{label}</span>}
        <span>{short || "—"}</span>
      </span>
    );
  }

  return (
    <button className={cls} onClick={copy} title={address} type="button">
      {label && <span style={{ color: "var(--ink-3)", marginRight: 4 }}>{label}</span>}
      <span>{short}</span>
      <Icon name={copied ? "check" : "copy"} className="copy-ico" />
    </button>
  );
}

export default AddressDisplay;
