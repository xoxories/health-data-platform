import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";

import {
  PATIENT_REGISTRY_ADDRESS,
  CONSENT_MANAGER_ADDRESS,
  HEALTH_RECORD_STORAGE_ADDRESS,
  PatientRegistryABI,
  ConsentManagerABI,
  HealthRecordStorageABI,
} from "../config/contract.js";

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

const EMPTY_CONTRACTS = Object.freeze({
  patientRegistry: null,
  consentManager: null,
  healthRecordStorage: null,
});

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function buildContract(address, abi, signerOrProvider) {
  if (!address || !Array.isArray(abi) || abi.length === 0) return null;
  return new ethers.Contract(address, abi, signerOrProvider);
}

/**
 * Instantiate the three platform contracts bound to the given signer.
 * Returned object always has the same shape; missing addresses/ABIs
 * resolve to `null` so callers can guard with simple truthy checks.
 */
export function getContracts(signer) {
  if (!signer) return { ...EMPTY_CONTRACTS };
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
}

function logConnection(account) {
  console.log("[useContract] Connected:", account);
  console.log("[useContract] Contract addresses:", {
    PatientRegistry: PATIENT_REGISTRY_ADDRESS,
    ConsentManager: CONSENT_MANAGER_ADDRESS,
    HealthRecordStorage: HEALTH_RECORD_STORAGE_ADDRESS,
  });
}

// ---------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------

/**
 * Centralises wallet + contract state for the dApp.
 *
 * Returns:
 *   provider       — ethers.js provider (or null)
 *   signer         — ethers.js signer (or null)
 *   account        — checksummed address of the connected account (or null)
 *   contracts      — { patientRegistry, consentManager, healthRecordStorage }
 *   isConnecting   — true while connectWallet() is in flight
 *   error          — user-readable error string, or null
 *   connectWallet  — () => Promise<void> — triggers the MetaMask connect prompt
 */
export default function useContract() {
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [account, setAccount] = useState(null);
  const [contracts, setContracts] = useState({ ...EMPTY_CONTRACTS });
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState(null);

  // Build provider/signer/contracts/account from a raw address.
  const applyAccount = useCallback((rawAddress) => {
    const nextProvider = new ethers.providers.Web3Provider(window.ethereum);
    const nextSigner = nextProvider.getSigner();
    const nextAccount = ethers.utils.getAddress(rawAddress);
    const nextContracts = getContracts(nextSigner);

    setProvider(nextProvider);
    setSigner(nextSigner);
    setAccount(nextAccount);
    setContracts(nextContracts);
    return nextAccount;
  }, []);

  const clearWalletState = useCallback(() => {
    setProvider(null);
    setSigner(null);
    setAccount(null);
    setContracts({ ...EMPTY_CONTRACTS });
  }, []);

  // ---- connectWallet ----

  const connectWallet = useCallback(async () => {
    setError(null);

    if (typeof window === "undefined" || !window.ethereum) {
      setError(
        "MetaMask is not installed. Please install the MetaMask browser extension to continue."
      );
      return;
    }

    setIsConnecting(true);
    try {
      const accs = await window.ethereum.request({
        method: "eth_requestAccounts",
      });
      if (!accs || accs.length === 0) {
        throw new Error("MetaMask returned no accounts.");
      }

      const connected = applyAccount(accs[0]);
      logConnection(connected);
    } catch (err) {
      console.error("[useContract] connectWallet failed:", err);
      // EIP-1193 codes: 4001 = user rejected, -32002 = request pending.
      if (err?.code === 4001) {
        setError("Connection request rejected in MetaMask.");
      } else if (err?.code === -32002) {
        setError(
          "A MetaMask connection request is already pending — check the extension."
        );
      } else {
        setError(
          err?.message
            ? `Failed to connect: ${err.message}`
            : "Failed to connect to MetaMask."
        );
      }
    } finally {
      setIsConnecting(false);
    }
  }, [applyAccount]);

  // ---- Silent re-connect + event listeners ----

  useEffect(() => {
    if (typeof window === "undefined" || !window.ethereum) return undefined;
    const { ethereum } = window;
    let cancelled = false;

    // Silent re-connect: if MetaMask already has an authorised account for
    // this site, hydrate state without prompting the user. eth_accounts
    // (unlike eth_requestAccounts) never opens a popup.
    (async () => {
      try {
        const accs = await ethereum.request({ method: "eth_accounts" });
        if (!cancelled && accs && accs.length > 0) {
          const connected = applyAccount(accs[0]);
          logConnection(connected);
        }
      } catch (err) {
        console.error("[useContract] silent reconnect failed:", err);
      }
    })();

    const handleAccountsChanged = (accs) => {
      if (!accs || accs.length === 0) {
        // User locked MetaMask or revoked permissions.
        clearWalletState();
        return;
      }
      try {
        applyAccount(accs[0]);
      } catch (err) {
        console.error("[useContract] account change failed:", err);
        setError("Failed to refresh after account change.");
      }
    };

    const handleChainChanged = () => {
      // The ethers Provider is bound to a specific network at construction
      // time, so refresh provider/signer/contracts whenever the chain flips.
      try {
        const nextProvider = new ethers.providers.Web3Provider(ethereum);
        const nextSigner = nextProvider.getSigner();
        setProvider(nextProvider);
        setSigner(nextSigner);
        setContracts(getContracts(nextSigner));
        console.log("[useContract] Network changed; provider refreshed.");
      } catch (err) {
        console.error("[useContract] chain change failed:", err);
        setError("Failed to refresh after network change.");
      }
    };

    ethereum.on("accountsChanged", handleAccountsChanged);
    ethereum.on("chainChanged", handleChainChanged);

    return () => {
      cancelled = true;
      ethereum.removeListener("accountsChanged", handleAccountsChanged);
      ethereum.removeListener("chainChanged", handleChainChanged);
    };
  }, [applyAccount, clearWalletState]);

  return {
    provider,
    signer,
    account,
    contracts,
    isConnecting,
    error,
    connectWallet,
  };
}
