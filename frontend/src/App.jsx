import { useCallback, useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";

import {
  PATIENT_REGISTRY_ADDRESS,
  CONSENT_MANAGER_ADDRESS,
  HEALTH_RECORD_STORAGE_ADDRESS,
  PatientRegistryABI,
  ConsentManagerABI,
  HealthRecordStorageABI,
} from "./config/contract.js";

import ConnectWallet from "./components/ConnectWallet.jsx";
import PatientDashboard from "./components/PatientDashboard.jsx";
import DoctorDashboard from "./components/DoctorDashboard.jsx";
import AdminPanel from "./components/AdminPanel.jsx";

import { Card } from "./components/ui/Card.jsx";
import { Button } from "./components/ui/Button.jsx";
import { AddressDisplay } from "./components/ui/AddressDisplay.jsx";
import { ThemeToggle } from "./components/ui/ThemeToggle.jsx";

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

const SEPOLIA_CHAIN_ID = 11155111;
const HARDHAT_CHAIN_ID = 31337;
const SUPPORTED_CHAIN_IDS = [SEPOLIA_CHAIN_ID, HARDHAT_CHAIN_ID];

const NETWORK_NAMES = {
  1: "Ethereum Mainnet",
  5: "Goerli",
  11155111: "Sepolia",
  31337: "Hardhat",
  1337: "Localhost",
};

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * Normalise the various shapes MetaMask / wallet providers return for a
 * chain id (hex string "0xaa36a7", decimal string "11155111", number,
 * bigint) into a plain JS number, or null if it can't be parsed.
 */
function parseChainId(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    const parsed = lower.startsWith("0x")
      ? parseInt(lower, 16)
      : parseInt(lower, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function networkName(chainId) {
  if (chainId == null) return "Detecting…";
  return NETWORK_NAMES[chainId] || `Chain ${chainId}`;
}

function truncateAddress(address) {
  if (!address) return "";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function buildContract(address, abi, signerOrProvider) {
  if (!address || !Array.isArray(abi) || abi.length === 0) return null;
  return new ethers.Contract(address, abi, signerOrProvider);
}

// ---------------------------------------------------------------------
// App
// ---------------------------------------------------------------------

export default function App() {
  const [hasMetaMask, setHasMetaMask] = useState(true);
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [signer, setSigner] = useState(null);
  const [role, setRole] = useState(null); // 'admin' | 'doctor' | 'patient' | 'none'
  const [detecting, setDetecting] = useState(false);
  const [roleError, setRoleError] = useState(null);

  const wrongNetwork =
    chainId != null && !SUPPORTED_CHAIN_IDS.includes(chainId);

  // -------- MetaMask detection + initial state + listeners --------

  useEffect(() => {
    const ethereum =
      typeof window !== "undefined" ? window.ethereum : undefined;

    if (!ethereum) {
      setHasMetaMask(false);
      return undefined;
    }

    let cancelled = false;

    (async () => {
      try {
        // Fetch chain id and accounts in parallel so the UI never has to
        // render an "Unknown network" badge while waiting for chainId.
        const [accounts, cid] = await Promise.all([
          ethereum.request({ method: "eth_accounts" }),
          ethereum.request({ method: "eth_chainId" }),
        ]);
        if (cancelled) return;
        setChainId(parseChainId(cid));
        if (accounts && accounts.length > 0) {
          setAccount(ethers.utils.getAddress(accounts[0]));
        }
      } catch (err) {
        console.error("Failed to read MetaMask state:", err);
      }
    })();

    const handleAccountsChanged = (accs) => {
      setAccount(
        accs && accs[0] ? ethers.utils.getAddress(accs[0]) : null
      );
    };
    const handleChainChanged = () => {
      // Hard reload on chain change. setState-in-place would leave any
      // already-built Web3Provider / Contract instances bound to the
      // previous network's RPC — reads would return stale data or
      // CALL_EXCEPTION until the user manually refreshed. A reload
      // guarantees a clean React tree with fresh provider/contracts for
      // the new chain.
      window.location.reload();
    };

    ethereum.on("accountsChanged", handleAccountsChanged);
    ethereum.on("chainChanged", handleChainChanged);

    return () => {
      cancelled = true;
      ethereum.removeListener("accountsChanged", handleAccountsChanged);
      ethereum.removeListener("chainChanged", handleChainChanged);
    };
  }, []);

  // -------- Signer (rebuilt when account or chain changes) --------

  useEffect(() => {
    if (!account || typeof window === "undefined" || !window.ethereum) {
      setSigner(null);
      return;
    }
    try {
      const provider = new ethers.providers.Web3Provider(window.ethereum);
      setSigner(provider.getSigner());
    } catch (err) {
      console.error("Failed to build signer:", err);
      setSigner(null);
    }
  }, [account, chainId]);

  // -------- Contract instances --------

  const contracts = useMemo(() => {
    if (!signer) {
      return {
        patientRegistry: null,
        consentManager: null,
        healthRecordStorage: null,
      };
    }
    return {
      patientRegistry: buildContract(
        PATIENT_REGISTRY_ADDRESS,
        PatientRegistryABI,
        signer
      ),
      consentManager: buildContract(
        CONSENT_MANAGER_ADDRESS,
        ConsentManagerABI,
        signer
      ),
      healthRecordStorage: buildContract(
        HEALTH_RECORD_STORAGE_ADDRESS,
        HealthRecordStorageABI,
        signer
      ),
    };
  }, [signer]);

  // -------- Role detection (re-runs on account / chain / contracts change) --------

  useEffect(() => {
    if (!account || !contracts.patientRegistry) {
      setRole(null);
      setRoleError(null);
      setDetecting(false);
      return undefined;
    }

    let cancelled = false;
    setDetecting(true);
    setRoleError(null);

    (async () => {
      try {
        const registry = contracts.patientRegistry;
        let detected = "none";

        // Admin = contract owner. owner() comes from OpenZeppelin Ownable.
        try {
          const ownerAddr = await registry.owner();
          if (ownerAddr.toLowerCase() === account.toLowerCase()) {
            detected = "admin";
          }
        } catch (_err) {
          // owner() may not be on the ABI; fall through silently.
        }

        if (detected === "none") {
          const [isPatientResult, isDoctorResult] = await Promise.all([
            registry.isPatient(account),
            registry.isDoctor(account),
          ]);
          if (isDoctorResult) detected = "doctor";
          else if (isPatientResult) detected = "patient";
        }

        if (!cancelled) setRole(detected);
      } catch (err) {
        console.error("Role detection failed:", err);
        if (!cancelled) {
          // Surface the failure so the user sees a real error instead of a
          // dashboard that silently can't reach the contract. This typically
          // means the contract address in config/contract.js doesn't have a
          // contract at it on the currently-selected network.
          setRoleError(
            err?.reason ||
              err?.data?.message ||
              err?.error?.message ||
              err?.message ||
              "Could not read role from PatientRegistry."
          );
          setRole("none");
        }
      } finally {
        if (!cancelled) setDetecting(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [account, chainId, contracts]);

  // -------- Connect handler --------
  // Defined before the return so it's in scope when passed to <ConnectWallet>.
  // (const-declared arrow functions are not hoisted — referencing it from
  // JSX defined above this line would throw a TDZ error.)

  const connectWallet = useCallback(async () => {
    if (typeof window === "undefined" || !window.ethereum) {
      throw new Error("MetaMask is not installed.");
    }
    const accs = await window.ethereum.request({
      method: "eth_requestAccounts",
    });
    if (!accs || accs.length === 0) {
      throw new Error("MetaMask returned no accounts.");
    }
    setAccount(ethers.utils.getAddress(accs[0]));

    // Also refresh chainId in case the user just installed MetaMask or
    // we never resolved it on mount.
    try {
      const cid = await window.ethereum.request({ method: "eth_chainId" });
      setChainId(parseChainId(cid));
    } catch (err) {
      console.error("Failed to read chainId after connect:", err);
    }
  }, []);

  // -------- Render --------

  return (
    <div className="min-h-screen bg-surface-alt text-slate-900 dark:bg-surface-dark dark:text-slate-100">
      <Header account={account} chainId={chainId} />

      {wrongNetwork && <WrongNetworkBanner chainId={chainId} />}

      <main className="mx-auto max-w-6xl px-6 py-10">
        {!hasMetaMask ? (
          <NoMetaMask />
        ) : !account ? (
          <ConnectGate onConnect={connectWallet} />
        ) : detecting ? (
          <CenteredNotice>Detecting role…</CenteredNotice>
        ) : (
          <>
            {roleError && <RoleErrorBanner message={roleError} />}
            {role === "admin" ? (
              <AdminPanel account={account} contracts={contracts} />
            ) : role === "doctor" ? (
              <DoctorDashboard account={account} contracts={contracts} />
            ) : (
              // Default to PatientDashboard for both registered patients and
              // unregistered users so the dashboard can show a register-as-patient
              // CTA when role === "none".
              <PatientDashboard
                account={account}
                role={role}
                contracts={contracts}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------

function Header({ account, chainId }) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-surface-dark/95">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 font-display font-bold text-white shadow-sm">
            H
          </div>
          <div>
            <h1 className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-slate-50">
              Health Data Platform
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Decentralized health-record sharing
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {account && (
            <>
              <span className="hidden rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700 dark:bg-brand-900/30 dark:text-brand-300 sm:inline-block">
                {networkName(chainId)}
              </span>
              <span className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1 dark:border-slate-700 dark:bg-surface-darkAlt">
                <AddressDisplay address={account} size="sm" />
              </span>
            </>
          )}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

function WrongNetworkBanner({ chainId }) {
  return (
    <div className="border-b border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-900/20 dark:text-amber-200">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-3 text-sm">
        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-amber-500 text-xs font-bold text-white">
          !
        </span>
        <p>
          <span className="font-semibold">Wrong network.</span> Please switch
          MetaMask to <span className="font-mono">Sepolia</span> (chain ID{" "}
          {SEPOLIA_CHAIN_ID}) or{" "}
          <span className="font-mono">Hardhat Local</span> (chain ID{" "}
          {HARDHAT_CHAIN_ID}). Currently connected to{" "}
          <span className="font-mono">{networkName(chainId)}</span>.
        </p>
      </div>
    </div>
  );
}

function RoleErrorBanner({ message }) {
  return (
    <Card tone="danger" className="mb-6">
      <p className="font-display font-semibold text-red-800 dark:text-red-300">
        Could not read your role from the contract.
      </p>
      <p className="mt-1 text-sm text-red-700 dark:text-red-300/90">{message}</p>
      <p className="mt-2 text-xs text-red-700/80 dark:text-red-300/70">
        This usually means the contract addresses in{" "}
        <span className="font-mono">frontend/src/config/contract.js</span>{" "}
        don't have deployed contracts on the currently-selected network.
        Make sure MetaMask is on the same network the contracts were
        deployed to (Sepolia, chain ID {SEPOLIA_CHAIN_ID}, or your local
        Hardhat node).
      </p>
    </Card>
  );
}

function NoMetaMask() {
  return (
    <Card tone="warning" className="mx-auto max-w-md text-center">
      <h2 className="font-display text-lg font-semibold text-amber-900 dark:text-amber-200">
        MetaMask is not installed
      </h2>
      <p className="mt-2 mb-5 text-sm text-amber-800 dark:text-amber-200/80">
        This dApp requires the MetaMask browser extension to interact with the
        Ethereum blockchain.
      </p>
      <a
        href="https://metamask.io/download/"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block rounded-lg bg-amber-600 px-5 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-amber-700"
      >
        Install MetaMask
      </a>
    </Card>
  );
}

function ConnectGate({ onConnect }) {
  // ConnectWallet renders the full landing card itself (logo, title,
  // description, connect button, install-fallback) — no outer wrapper
  // needed.
  return <ConnectWallet onConnect={onConnect} />;
}

function CenteredNotice({ children }) {
  return (
    <div className="flex justify-center py-16 text-sm text-slate-500 dark:text-slate-400">
      {children}
    </div>
  );
}
