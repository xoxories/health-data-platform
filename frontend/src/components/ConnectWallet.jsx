import { useEffect, useState } from "react";

import { Button } from "./ui/Button.jsx";
import { Icon } from "./ui/Icon.jsx";
import { StatusPill } from "./ui/StatusPill.jsx";
import { ThemeToggle } from "./ui/ThemeToggle.jsx";

/**
 * Hero landing screen. Visual structure mirrors
 * frontend/_design-reference/screen-connect.jsx (split hero-card, mesh
 * background, eyebrow + title + body + feature grid, decorative chain
 * receipt + floating stat chips on the right).
 *
 * REAL logic preserved verbatim from the previous Phase-6 implementation:
 *   - `hasMetaMask` detected via window.ethereum on mount
 *   - `handleConnect` awaits the parent-supplied real `onConnect`
 *   - loading state on the button while the MetaMask popup is open
 *   - EIP-1193 code 4001 (user-rejected) gets a friendly message
 *   - any other error falls through to `err.message`
 *   - MetaMask-not-installed branch shows an install card inline
 *
 * NO fake setTimeout — the loading flip is driven by the real promise
 * resolving / rejecting. The "How it works" button is a no-op placeholder
 * (documented in code) and the right-side "chain receipt" + floating
 * chips are static marketing visuals.
 */
export default function ConnectWallet({ onConnect }) {
  const [hasMetaMask, setHasMetaMask] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const present =
      typeof window !== "undefined" && Boolean(window.ethereum);
    setHasMetaMask(present);
  }, []);

  async function handleConnect() {
    setError(null);
    setConnecting(true);
    try {
      await onConnect();
    } catch (err) {
      console.error("ConnectWallet onConnect failed:", err);
      // EIP-1193 code 4001 = user rejected the request.
      if (err?.code === 4001) {
        setError("Connection request rejected in MetaMask.");
      } else {
        setError(err?.message || "Failed to connect.");
      }
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="hero-wrap">
      {/* Top-left brand */}
      <div
        style={{
          position: "absolute",
          top: 24,
          left: 24,
          zIndex: 2,
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div
          className="brand-mark"
          style={{ width: 36, height: 36, borderRadius: 11 }}
        >
          <Icon name="cross" size={18} />
        </div>
        <div>
          <div
            style={{
              fontFamily: "'Sora Variable', Sora, sans-serif",
              fontWeight: 700,
              fontSize: 14,
              color: "var(--ink)",
            }}
          >
            Health Data Platform
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--ink-3)",
              letterSpacing: ".04em",
            }}
          >
            Decentralized · Patient‑Owned
          </div>
        </div>
      </div>

      {/* Top-right theme toggle */}
      <div style={{ position: "absolute", top: 24, right: 24, zIndex: 2 }}>
        <ThemeToggle />
      </div>

      <div className="hero-card">
        {/* Left column: copy + features + actions */}
        <div className="hero-left">
          <span className="eyebrow">
            <span className="dt" /> Web3 · Healthcare
          </span>
          <h1 className="hero-title">
            Your medical records, <em>on‑chain</em> &amp; under your consent.
          </h1>
          <p className="hero-body">
            End‑to‑end encrypted records stored on IPFS, with
            patient‑mediated consent enforced cryptographically. Every
            access is auditable and revocable. No middleman holds a key
            you didn't give them.
          </p>

          <div className="feature-row">
            <div className="feature">
              <div className="ico">
                <Icon name="lock" size={14} />
              </div>
              <div>
                <div className="ft-title">Client‑side AES‑GCM</div>
                <div className="ft-sub">
                  Files encrypted before they leave you.
                </div>
              </div>
            </div>
            <div className="feature">
              <div className="ico">
                <Icon name="key" size={14} />
              </div>
              <div>
                <div className="ft-title">ECIES key wrap</div>
                <div className="ft-sub">
                  No wrapped key — no plaintext path.
                </div>
              </div>
            </div>
            <div className="feature">
              <div className="ico">
                <Icon name="audit" size={14} />
              </div>
              <div>
                <div className="ft-title">On‑chain audit</div>
                <div className="ft-sub">
                  Every view is an immutable event.
                </div>
              </div>
            </div>
            <div className="feature">
              <div className="ico">
                <Icon name="shieldcheck" size={14} />
              </div>
              <div>
                <div className="ft-title">Granular consent</div>
                <div className="ft-sub">
                  Per‑category, time‑limited grants.
                </div>
              </div>
            </div>
          </div>

          {/* Actions row — preserves the MetaMask-not-installed fork
              from the previous implementation. */}
          {hasMetaMask ? (
            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              <Button
                size="lg"
                icon="wallet"
                loading={connecting}
                onClick={handleConnect}
              >
                {connecting ? "Connecting…" : "Connect Wallet"}
              </Button>
              {/* `How it works` is a static no-op placeholder for now;
                  wiring documentation / marketing copy is a later phase. */}
              <Button
                variant="secondary"
                size="lg"
                icon="info"
                onClick={() => {
                  /* intentional no-op */
                }}
              >
                How it works
              </Button>
            </div>
          ) : (
            <NoMetaMaskCallout />
          )}

          {error && (
            <div
              role="alert"
              style={{
                marginTop: 12,
                padding: "10px 14px",
                borderRadius: 12,
                background: "var(--danger-soft)",
                color: "var(--danger)",
                fontSize: 13,
                fontWeight: 500,
                border:
                  "1px solid color-mix(in oklch, var(--danger) 28%, transparent)",
              }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 12,
              marginTop: 6,
              fontSize: 12,
              color: "var(--ink-3)",
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span className="pill" style={{ padding: "3px 8px", fontSize: 11 }}>
                Sepolia
              </span>
            </span>
            <span>·</span>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span className="pill" style={{ padding: "3px 8px", fontSize: 11 }}>
                Hardhat Local
              </span>
            </span>
            <span>·</span>
            <span>Make sure your wallet is on a supported network.</span>
          </div>
        </div>

        {/* Right column: decorative chain-receipt + floating chips.
            Static marketing visual — not wired to real data. */}
        <div className="hero-right">
          <div className="grid-overlay" />
          <div className="ring r1" />
          <div className="ring r2" />
          <div className="hero-mark">
            <Icon name="cross" size={28} />
          </div>

          <div
            style={{
              position: "absolute",
              top: 130,
              right: 36,
              left: 36,
              zIndex: 2,
            }}
          >
            <div
              style={{
                background:
                  "color-mix(in oklch, var(--surface) 78%, transparent)",
                backdropFilter: "blur(14px)",
                border: "1px solid var(--line)",
                borderRadius: 14,
                padding: 14,
                boxShadow: "var(--shadow-md)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--brand)",
                  }}
                >
                  <Icon name="link" size={12} /> CONSENT GRANT
                </div>
                <StatusPill status="active">Confirmed</StatusPill>
              </div>
              <div
                style={{
                  marginTop: 10,
                  fontFamily: "'Sora Variable', Sora, sans-serif",
                  fontWeight: 600,
                  fontSize: 13.5,
                  color: "var(--ink)",
                }}
              >
                grantAccess(doctor, BloodTest|Imaging, +30d)
              </div>
              <div
                style={{
                  marginTop: 10,
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  fontFamily: "'Geist Mono Variable', monospace",
                  fontSize: 11,
                  color: "var(--ink-3)",
                }}
              >
                <span>tx: 0xf18a…9d4c</span>
                <span>·</span>
                <span>block 8,402,113</span>
                <span>·</span>
                <span>gas 84,231</span>
              </div>
            </div>
          </div>

          <div
            className="floating-stat"
            style={{ alignSelf: "flex-start", marginTop: "auto" }}
          >
            <div className="fs-ico">
              <Icon name="shieldcheck" size={16} />
            </div>
            <div>
              <div className="fs-title">Cryptographically enforced</div>
              <div className="fs-sub">93‑byte ECIES envelope per record</div>
            </div>
          </div>
          <div className="floating-stat fs-cyan">
            <div className="fs-ico">
              <Icon name="ipfs" size={16} />
            </div>
            <div>
              <div className="fs-title">IPFS via Pinata</div>
              <div className="fs-sub">
                Ciphertext only · tag‑verified on decrypt
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 18,
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: 11.5,
          color: "var(--ink-3)",
          zIndex: 2,
        }}
      >
        Health Data Platform · Patient‑owned health‑record sharing on Ethereum
      </div>
    </div>
  );
}

/**
 * Shown inline inside hero-left when window.ethereum is absent. Replaces
 * the Connect/How it works button row.
 */
function NoMetaMaskCallout() {
  return (
    <div
      style={{
        marginTop: 8,
        padding: "14px 16px",
        borderRadius: 14,
        background: "var(--warn-soft)",
        color: "var(--warn)",
        border:
          "1px solid color-mix(in oklch, var(--warn) 30%, transparent)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontWeight: 700,
          fontSize: 13,
        }}
      >
        <Icon name="warning" size={14} />
        Please install MetaMask
      </div>
      <div style={{ marginTop: 6, fontSize: 12.5, lineHeight: 1.5 }}>
        This dApp needs the MetaMask browser extension to interact with
        the Ethereum blockchain.
      </div>
      <a
        href="https://metamask.io/download/"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          marginTop: 10,
          padding: "8px 14px",
          borderRadius: 10,
          background: "var(--warn)",
          color: "#fff",
          fontSize: 13,
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        <Icon name="arrowUpRight" size={13} />
        Get MetaMask
      </a>
    </div>
  );
}
