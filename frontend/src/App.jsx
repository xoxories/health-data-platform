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

// `Card` is still used by RoleErrorBanner (defined below). The other
// Stage-1 primitives that used to power the old <Header /> + <NoMetaMask />
// helpers are now imported directly by ConnectWallet / Sidebar / Topbar,
// not here.
import { Card } from "./components/ui/Card.jsx";

import { Sidebar } from "./components/shell/Sidebar.jsx";
import { Topbar } from "./components/shell/Topbar.jsx";

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

  // Phase 7 — Stage 3: which sub-view within the active role's sidebar is
  // selected. Defaults to 'overview' on every role-change. The dashboard
  // components RECEIVE this prop but are not required to consume it yet;
  // they continue to render their full current content regardless.
  const [route, setRoute] = useState("overview");
  // Reset route when the role flips so each role lands on its own
  // "Overview" entry rather than inheriting the previous role's key.
  useEffect(() => {
    setRoute("overview");
  }, [role]);

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

  // "Disconnect" the wallet (locally — MetaMask has no programmatic
  // disconnect API). Clears React state so the connect gate re-renders;
  // user can re-approve from MetaMask to come back.
  const disconnectWallet = useCallback(() => {
    setAccount(null);
    setRole(null);
    setRoute("overview");
  }, []);

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

  // Not-connected states (no MetaMask OR no account) render the hero
  // landing. ConnectWallet itself handles both cases inline:
  //   - hasMetaMask=true  → Connect button + How-it-works button
  //   - hasMetaMask=false → "Please install MetaMask" callout
  // The wrong-network banner is preserved at the very top of the page
  // so users see network mismatches even before connecting.
  if (!hasMetaMask || !account) {
    return (
      <div className="app">
        <div className="mesh-bg">
          <div className="mesh-c" />
        </div>
        {wrongNetwork && <WrongNetworkBanner chainId={chainId} />}
        <ConnectGate onConnect={connectWallet} />
      </div>
    );
  }

  // Connected but still resolving role. Brief intermediate state.
  if (detecting) {
    return (
      <div className="app">
        <div className="mesh-bg">
          <div className="mesh-c" />
        </div>
        {wrongNetwork && <WrongNetworkBanner chainId={chainId} />}
        <main
          style={{
            minHeight: "100vh",
            display: "grid",
            placeItems: "center",
          }}
        >
          <CenteredNotice>Detecting role…</CenteredNotice>
        </main>
      </div>
    );
  }

  // -------- Render: authenticated state → wrap in shell --------
  // Sidebar nav-set is keyed by role; for the "none" case (unregistered
  // user landing on PatientDashboard's register CTA), reuse the patient
  // sidebar so they see a navigation rail rather than a barren shell.
  const shellRole = role === "admin" || role === "doctor" ? role : "patient";
  const labelFromName = networkName(chainId);
  const networkLabel =
    chainId != null ? `${labelFromName} · ${chainId}` : labelFromName;

  const dashboardTitles = {
    admin: "Admin Panel",
    doctor: "Doctor Dashboard",
    patient: "Patient Dashboard",
  };
  const topbarTitle = dashboardTitles[shellRole] || "Dashboard";

  return (
    <div className="app">
      <div className="shell">
        <Sidebar
          role={shellRole}
          route={route}
          setRoute={setRoute}
          walletAddr={account}
          networkLabel={networkLabel}
        />
        <div className="main-col">
          <Topbar
            title={topbarTitle}
            networkLabel={networkLabel}
            onDisconnect={disconnectWallet}
          />
          <main className="content">
            {wrongNetwork && <WrongNetworkBanner chainId={chainId} />}
            {roleError && <RoleErrorBanner message={roleError} />}
            {role === "admin" ? (
              <AdminPanel
                account={account}
                contracts={contracts}
                route={route}
                setRoute={setRoute}
              />
            ) : role === "doctor" ? (
              <DoctorDashboard
                account={account}
                contracts={contracts}
                route={route}
                setRoute={setRoute}
              />
            ) : (
              // Default to PatientDashboard for both registered patients and
              // unregistered users so the dashboard can show a register-as-patient
              // CTA when role === "none".
              <PatientDashboard
                account={account}
                role={role}
                contracts={contracts}
                route={route}
                setRoute={setRoute}
              />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------

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
