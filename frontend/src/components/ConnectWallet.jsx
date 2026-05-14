import { useEffect, useState } from "react";

import { Card } from "./ui/Card.jsx";
import { Button } from "./ui/Button.jsx";

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
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <Card className="w-full max-w-md text-center" padding="default">
        <Logo />

        <h1 className="mt-6 font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
          Health Data Platform
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          Securely store and share your medical records on the Ethereum
          blockchain. Your data, your consent, your control.
        </p>

        <div className="mt-8">
          {hasMetaMask ? (
            <>
              <Button
                onClick={handleConnect}
                disabled={connecting}
                loading={connecting}
                size="lg"
                className="w-full"
              >
                {!connecting && <ChainIcon />}
                {connecting ? "Connecting…" : "Connect MetaMask"}
              </Button>
              {error && (
                <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-300">
                  {error}
                </p>
              )}
            </>
          ) : (
            <NoMetaMask />
          )}
        </div>

        <p className="mt-6 text-xs text-slate-400 dark:text-slate-500">
          Make sure MetaMask is on Sepolia or Hardhat Local.
        </p>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------

function Logo() {
  return (
    <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-accent-500 text-3xl font-bold text-white shadow-md">
      <span aria-hidden>✚</span>
      <span className="sr-only">Medical cross logo</span>
    </div>
  );
}

function NoMetaMask() {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-5 text-left dark:border-amber-900/60 dark:bg-amber-900/20">
      <p className="mb-2 font-display font-semibold text-amber-900 dark:text-amber-200">
        Please install MetaMask
      </p>
      <p className="mb-4 text-sm text-amber-800 dark:text-amber-200/80">
        This dApp needs the MetaMask browser extension to interact with the
        Ethereum blockchain.
      </p>
      <a
        href="https://metamask.io/download/"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-amber-700"
      >
        Get MetaMask
      </a>
    </div>
  );
}

function ChainIcon() {
  return (
    <span aria-hidden className="text-base leading-none">
      ⛓
    </span>
  );
}
