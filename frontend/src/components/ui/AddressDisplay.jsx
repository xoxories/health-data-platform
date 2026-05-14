import { useState } from "react";
import { shortAddr } from "../../utils/events.js";

/**
 * Standard treatment for any Ethereum address (or arbitrary hex string).
 * Renders 0xAAAA…BBBB in mono, with click-to-copy + 2-second "Copied!"
 * feedback. The full value is in the title attribute for hover-inspect.
 *
 *   <AddressDisplay address={0x…} />
 *   <AddressDisplay address={tx.hash} label="tx" />
 *
 * Pass `copyable={false}` to render a non-interactive label.
 */
export function AddressDisplay({
  address,
  copyable = true,
  className = "",
  size = "sm",
}) {
  const [copied, setCopied] = useState(false);

  async function copy(e) {
    e.stopPropagation();
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard failures
    }
  }

  const text = shortAddr(address) || "—";
  const textCls =
    size === "xs"
      ? "text-[10px]"
      : size === "md"
        ? "text-sm"
        : "text-xs";

  const baseCls =
    "inline-flex items-center gap-1 font-mono " +
    textCls +
    " text-slate-700 dark:text-slate-300";

  if (!copyable || !address) {
    return <span className={baseCls + " " + className}>{text}</span>;
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={address}
      className={
        baseCls +
        " " +
        "underline-offset-2 hover:underline focus:outline-none " +
        "focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:rounded-sm " +
        className
      }
    >
      {text}
      {copied && (
        <span className="text-[10px] font-sans text-emerald-700 dark:text-emerald-400">
          Copied!
        </span>
      )}
    </button>
  );
}

export default AddressDisplay;
