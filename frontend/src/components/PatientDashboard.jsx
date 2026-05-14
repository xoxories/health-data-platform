import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";

import { uploadEncrypted } from "../utils/ipfs.js";
import {
  deriveECIESKeypairFromSigner,
  unwrapKeyForSelf,
  wrapKeyForRecipient,
  bundleWrappedKeys,
  BUNDLE_MAX_ENTRIES,
} from "../utils/crypto.js";
import {
  readEventsChunked,
  shortAddr,
  timestampToRelative,
  toNumberSafe,
} from "../utils/events.js";

import { Card as UICard } from "./ui/Card.jsx";
import { Button as UIButton } from "./ui/Button.jsx";
import { StatusPill } from "./ui/StatusPill.jsx";
import { AddressDisplay } from "./ui/AddressDisplay.jsx";
// Namespace import so this works whether or not DEPLOY_BLOCK is exported
// from contract.js (older deploys won't have it; new ones will). A bare
// `import { DEPLOY_BLOCK } from "..."` would crash the whole module at
// load time in Vite 5's strict ESM mode when the name isn't exported.
import * as ContractConfig from "../config/contract.js";

const DEPLOY_BLOCK = ContractConfig.DEPLOY_BLOCK;

// Alchemy caps eth_getLogs at 50_000 blocks per call. Use a 49_000-block
// lookback window when DEPLOY_BLOCK isn't available yet.
const QUERY_FILTER_LOOKBACK_BLOCKS = 49000;

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

// Mirrors HealthRecordStorage.RecordCategory ordinals. Order MUST match
// the contract enum — patient-side and chain-side must agree on the
// numeric mapping.
const CATEGORIES = [
  { value: 0, label: "General" },
  { value: 1, label: "Blood Test" },
  { value: 2, label: "Imaging" },
  { value: 3, label: "Prescription" },
  { value: 4, label: "Mental Health" },
  { value: 5, label: "Genetic" },
  { value: 6, label: "Other" },
];

const ACCEPTED_FILE_TYPES = "application/pdf,image/*,text/plain";

const MAX_UPLOAD_MB = 5;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const SEPOLIA_ETHERSCAN_TX = "https://sepolia.etherscan.io/tx/";

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function describeError(err) {
  return (
    err?.reason ||
    err?.data?.message ||
    err?.error?.message ||
    err?.message ||
    "Unexpected error"
  );
}

function truncateCid(cid) {
  if (!cid) return "";
  if (cid.length <= 14) return cid;
  return `${cid.slice(0, 8)}…${cid.slice(-6)}`;
}

function truncateAddress(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function bnToNumber(bn) {
  if (bn == null) return 0;
  if (typeof bn === "number") return bn;
  if (typeof bn.toNumber === "function") return bn.toNumber();
  return Number(bn);
}

function formatTimestamp(bnSeconds) {
  const seconds = bnToNumber(bnSeconds);
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleString();
}

function categoryLabel(value) {
  if (value == null) return "";
  const numeric = typeof value === "bigint" ? Number(value) : Number(value);
  return CATEGORIES.find((c) => c.value === numeric)?.label || String(numeric);
}

/**
 * Map a thrown error to a user-readable upload-flow message, branching
 * on the `phase` the upload was in when it failed.
 */
function categorizeUploadError(err, phase) {
  // MetaMask / EIP-1193 user rejection. Two code paths in different
  // ethers versions / wallets.
  if (
    err?.code === 4001 ||
    err?.code === "ACTION_REJECTED" ||
    err?.error?.code === 4001
  ) {
    return "Transaction rejected by wallet";
  }

  // On-chain revert. ethers v5 surfaces this as code "CALL_EXCEPTION"
  // with a `reason` and/or `data.message` carrying the require message.
  if (err?.code === "CALL_EXCEPTION" || err?.reason) {
    const reason =
      err.reason ||
      err.data?.message ||
      err.error?.message ||
      err.error?.data?.message;
    return reason
      ? `Transaction reverted: ${reason}`
      : "Transaction reverted";
  }

  // Network / RPC layer errors.
  if (
    err?.code === "NETWORK_ERROR" ||
    err?.code === "TIMEOUT" ||
    err?.code === "SERVER_ERROR" ||
    err?.message?.includes("network")
  ) {
    return "Network error — please retry";
  }

  // Pinata-side error (uploadToIPFS throws with "Failed to upload to IPFS — …").
  if (phase === "uploading" || err?.message?.includes("Pinata")) {
    return "Failed to upload to IPFS — check your Pinata credentials";
  }

  if (phase === "encrypting") {
    return "Failed to encrypt file";
  }

  return err?.message || "Unexpected error during upload";
}

// ---------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------

export default function PatientDashboard({ contracts, account }) {
  // ---- Registration state ----
  const [isRegistered, setIsRegistered] = useState(null); // null = checking
  const [registrationCheckError, setRegistrationCheckError] = useState(null);

  // ---- Per-section state ----
  const [records, setRecords] = useState([]); // [{ index, ipfsCID, recordType, timestamp, isActive, uploadedBy }]
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsError, setRecordsError] = useState(null);

  const [pendingRequests, setPendingRequests] = useState([]);
  const [deniedRequests, setDeniedRequests] = useState(new Set());
  const [activeConsents, setActiveConsents] = useState([]);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState(null);

  // ---- ECIES keypair cache (Phase 2C) ----
  // The patient's encryption keypair is deterministic — derived from a
  // fixed signed message via deriveECIESKeypairFromSigner. We cache it
  // for the session so that upload AND grant-access don't each trigger
  // their own MetaMask signature prompt.
  const [patientKeypair, setPatientKeypair] = useState(null);

  const ensurePatientKeypair = useCallback(async () => {
    if (patientKeypair) return patientKeypair;
    if (!contracts?.patientRegistry) {
      throw new Error("PatientRegistry contract is not available.");
    }
    const signer = contracts.patientRegistry.signer;
    if (!signer || typeof signer.signMessage !== "function") {
      throw new Error("No signer available — reconnect your wallet.");
    }
    const kp = await deriveECIESKeypairFromSigner(signer);
    setPatientKeypair(kp);
    return kp;
  }, [patientKeypair, contracts]);

  // ---------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------

  const checkRegistration = useCallback(async () => {
    if (!account) {
      // Shouldn't happen — App.jsx renders this only when an account is
      // connected — but guard anyway.
      setIsRegistered(false);
      setRegistrationCheckError("No wallet account connected.");
      return;
    }
    if (!contracts?.patientRegistry) {
      // Surface a real error instead of staying in the `null` loading
      // state forever. This typically means the contract address is
      // empty or the user is on a network where the contract isn't
      // deployed.
      setIsRegistered(false);
      setRegistrationCheckError(
        "PatientRegistry contract is not available. Check that contract addresses in frontend/src/config/contract.js are set and that MetaMask is on the correct network."
      );
      return;
    }
    setRegistrationCheckError(null);
    try {
      const registered = await contracts.patientRegistry.isPatient(account);
      setIsRegistered(registered);
    } catch (err) {
      console.error("isPatient failed:", err);
      setIsRegistered(false);
      setRegistrationCheckError(describeError(err));
    }
  }, [contracts, account]);

  const loadRecords = useCallback(async () => {
    if (!contracts?.healthRecordStorage || !account) return;
    setRecordsLoading(true);
    setRecordsError(null);
    try {
      // Pair the records with their global recordIds (the contract uses
      // a global counter; getRecords returns records but not IDs, so we
      // fetch both in the same order and zip them).
      const [all, ids] = await Promise.all([
        contracts.healthRecordStorage.getRecords(account),
        contracts.healthRecordStorage.getRecordIdsForPatient(account),
      ]);
      const active = all
        .map((r, i) => ({
          recordId: ids[i] != null ? ids[i].toString() : null,
          ipfsCID: r.ipfsCID,
          category: r.category != null ? Number(r.category) : null,
          createdAt: r.createdAt,
          isActive: r.isActive,
          uploadedBy: r.uploadedBy,
        }))
        .filter((r) => r.isActive);
      setRecords(active);
    } catch (err) {
      console.error("getRecords failed:", err);
      setRecordsError(describeError(err));
    } finally {
      setRecordsLoading(false);
    }
  }, [contracts, account]);

  const loadAccessData = useCallback(async () => {
    if (!contracts?.consentManager || !account) return;
    setAccessLoading(true);
    setAccessError(null);
    try {
      const pending = await contracts.consentManager.getPendingRequests(
        account
      );

      // Active consents: query past AccessGranted events filtered by
      // patient (indexed), then re-check current consent state for each
      // unique doctor.
      //
      // We MUST pass an explicit fromBlock — ethers v5 defaults to 0 and
      // Alchemy refuses any eth_getLogs call spanning more than 50k
      // blocks. Prefer DEPLOY_BLOCK from contract.js (written by the
      // deploy script); fall back to a bounded lookback window when it
      // isn't present (e.g. if contract.js was generated before the
      // deploy script started recording it).
      const latestBlock =
        await contracts.consentManager.provider.getBlockNumber();
      const fromBlock =
        DEPLOY_BLOCK ??
        Math.max(0, latestBlock - QUERY_FILTER_LOOKBACK_BLOCKS);

      const filter = contracts.consentManager.filters.AccessGranted(
        account,
        null
      );
      const events = await contracts.consentManager.queryFilter(
        filter,
        fromBlock,
        "latest"
      );
      const uniqueDoctors = [...new Set(events.map((e) => e.args.doctor))];

      const consents = await Promise.all(
        uniqueDoctors.map(async (doctor) => {
          const c = await contracts.consentManager.getConsent(account, doctor);
          return { doctor, consent: c };
        })
      );

      const nowSec = Math.floor(Date.now() / 1000);
      const active = consents
        .filter(({ consent }) => {
          if (!consent.isActive) return false;
          const expiresAt = bnToNumber(consent.expiresAt);
          if (expiresAt === 0) return true;
          return nowSec < expiresAt;
        })
        .map(({ doctor, consent }) => ({
          doctor,
          grantedAt: consent.grantedAt,
          expiresAt: consent.expiresAt,
        }));

      setPendingRequests(pending);
      setActiveConsents(active);
    } catch (err) {
      console.error("loadAccessData failed:", err);
      setAccessError(describeError(err));
    } finally {
      setAccessLoading(false);
    }
  }, [contracts, account]);

  useEffect(() => {
    checkRegistration();
  }, [checkRegistration]);

  useEffect(() => {
    if (isRegistered) {
      loadRecords();
      loadAccessData();
    }
  }, [isRegistered, loadRecords, loadAccessData]);

  // ---------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------

  if (isRegistered === null) {
    return (
      <CenteredNotice>Checking registration…</CenteredNotice>
    );
  }

  return (
    <div className="space-y-8">
      <header>
        <h2 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
          Patient Dashboard
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Connected as <AddressDisplay address={account} />
        </p>
      </header>

      {registrationCheckError && (
        <ErrorBox>
          Failed to read registration status: {registrationCheckError}
        </ErrorBox>
      )}

      {!isRegistered ? (
        <RegistrationSection
          contracts={contracts}
          onRegistered={checkRegistration}
        />
      ) : (
        <>
          <UploadSection
            contracts={contracts}
            account={account}
            ensurePatientKeypair={ensurePatientKeypair}
            onUploaded={loadRecords}
          />

          <RecordsSection
            records={records}
            loading={recordsLoading}
            error={recordsError}
            contracts={contracts}
            onChanged={loadRecords}
          />

          <AccessManagementSection
            pendingRequests={pendingRequests.filter(
              (d) => !deniedRequests.has(d.toLowerCase())
            )}
            activeConsents={activeConsents}
            loading={accessLoading}
            error={accessError}
            contracts={contracts}
            account={account}
            ensurePatientKeypair={ensurePatientKeypair}
            onDeny={(doctor) =>
              setDeniedRequests((prev) => {
                const next = new Set(prev);
                next.add(doctor.toLowerCase());
                return next;
              })
            }
            onChanged={loadAccessData}
          />

          <AccessHistorySection
            contracts={contracts}
            account={account}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------

function RegistrationSection({ contracts, onRegistered }) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [txHash, setTxHash] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Please enter a name.");
      return;
    }
    if (!contracts?.patientRegistry) {
      setError("Patient registry contract is not available.");
      return;
    }
    setError(null);
    setTxHash(null);
    setPending(true);
    try {
      const tx = await contracts.patientRegistry.registerPatient(name.trim());
      setTxHash(tx.hash);
      await tx.wait();
      onRegistered();
    } catch (err) {
      console.error("registerPatient failed:", err);
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card title="Register as Patient">
      <p className="mb-4 text-sm text-slate-600">
        You're not yet registered. Enter your display name to register on-chain.
      </p>
      <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label className="mb-1 block text-xs font-medium text-slate-700">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={pending}
            placeholder="e.g. Alice Adebayo"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-100"
          />
        </div>
        <PrimaryButton type="submit" disabled={pending}>
          {pending ? <Spinner /> : null}
          {pending ? "Registering…" : "Register as Patient"}
        </PrimaryButton>
      </form>

      {txHash && !pending && (
        <SuccessBox>
          Registered. Tx hash:{" "}
          <span className="font-mono text-xs">{txHash}</span>
        </SuccessBox>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
    </Card>
  );
}

// ---------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------

/**
 * Embed a JSON metadata header into the plaintext before encryption, so
 * the doctor can recover the original filename + mimetype at view time
 * (the contract stores none of this — only the IPFS CID).
 *
 * Format: utf8(headerJson) || 0x00 0x00 || originalFileBytes
 *
 * JSON cannot contain raw 0x00 bytes, so the first 0x00 0x00 pair is an
 * unambiguous separator. The original file bytes may contain any byte
 * sequence — they're after the separator.
 */
async function wrapFileWithFilenameHeader(plainFile) {
  const header = {
    filename: plainFile.name || "record",
    mimetype: plainFile.type || "application/octet-stream",
    size: plainFile.size,
    createdAt: Math.floor(Date.now() / 1000),
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const fileBytes = new Uint8Array(await plainFile.arrayBuffer());

  const payload = new Uint8Array(headerBytes.length + 2 + fileBytes.length);
  payload.set(headerBytes, 0);
  // 0x00 0x00 separator
  payload[headerBytes.length] = 0;
  payload[headerBytes.length + 1] = 0;
  payload.set(fileBytes, headerBytes.length + 2);

  // Preserve the original .name so uploadEncrypted's Pinata pin label
  // stays meaningful (final pin name will be "<orig>.enc").
  return new File([payload], plainFile.name, { type: plainFile.type });
}

function UploadSection({ contracts, account, ensurePatientKeypair, onUploaded }) {
  const [file, setFile] = useState(null);
  const [category, setCategory] = useState(CATEGORIES[0].value);
  // null | "encrypting" | "uploading" | "wrapping" | "signing" | "confirming" | "done"
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [cid, setCid] = useState(null);
  const [txHash, setTxHash] = useState(null);
  const [recordId, setRecordId] = useState(null);

  const pending = status !== null && status !== "done";

  const statusLabel = {
    encrypting: "Encrypting…",
    uploading: "Uploading to IPFS…",
    wrapping: "Wrapping key for you…",
    signing: "Waiting for wallet confirmation…",
    confirming: "Confirming transaction…",
  }[status] || "Upload Record";

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setCid(null);
    setTxHash(null);
    setRecordId(null);

    if (!file) {
      setError("Please select a file.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      const mb = (file.size / 1024 / 1024).toFixed(2);
      setError(`File is ${mb} MB — max ${MAX_UPLOAD_MB} MB.`);
      return;
    }
    if (!contracts?.healthRecordStorage) {
      setError("Storage contract is not available.");
      return;
    }

    // ethers v5: contracts built with a signer expose it via .signer.
    const signer = contracts.healthRecordStorage.signer;
    if (!signer || typeof signer.signMessage !== "function") {
      setError("No signer available — reconnect your wallet.");
      return;
    }

    let phase = "encrypting";
    try {
      // Ensure the patient's ECIES keypair is derived ONCE per session.
      // This may pop a MetaMask sign prompt on the first call; subsequent
      // calls (and the grant-access flow) reuse the cached keypair.
      phase = "encrypting";
      setStatus("encrypting");
      const keypair = await ensurePatientKeypair();

      // Embed filename + mimetype in the plaintext so the doctor can
      // recover them at view time.
      const wrappedFile = await wrapFileWithFilenameHeader(file);

      // Steps inside uploadEncrypted: encrypt → upload → wrap-key.
      // We already have the keypair, so uploadEncrypted skips its own
      // signature prompt.
      const result = await uploadEncrypted(
        wrappedFile,
        undefined,
        signer,
        (next) => {
          phase = next;
          // Ignore "done" — we'll transition to "signing" next.
          if (next !== "done") setStatus(next);
        },
        keypair
      );
      setCid(result.cid);

      // Step 5: contract write. The MetaMask popup appears here.
      phase = "signing";
      setStatus("signing");
      const encryptedKeyHex = ethers.utils.hexlify(result.encryptedKey);
      const tx = await contracts.healthRecordStorage.storeRecord(
        result.cid,
        category,
        encryptedKeyHex
      );
      setTxHash(tx.hash);

      // Step 6: wait for mining.
      phase = "confirming";
      setStatus("confirming");
      const receipt = await tx.wait();

      // Extract the global recordId from the RecordStored event for the
      // success message. ethers v5 attaches parsed events at receipt.events.
      const ev = receipt.events?.find((e) => e.event === "RecordStored");
      if (ev?.args?.recordId != null) {
        setRecordId(ev.args.recordId.toString());
      }

      setStatus("done");
      setFile(null);
      onUploaded();
    } catch (err) {
      console.error(`[upload] failed (phase: ${phase}):`, err);
      setError(categorizeUploadError(err, phase));
      setStatus(null);
    }
  }

  return (
    <Card title="Upload Health Record">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">
            File <span className="text-slate-400">(max {MAX_UPLOAD_MB} MB)</span>
          </label>
          <input
            type="file"
            accept={ACCEPTED_FILE_TYPES}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={pending}
            className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-brand-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-brand-700 hover:file:bg-brand-100 disabled:opacity-50 dark:text-slate-300 dark:file:bg-brand-900/30 dark:file:text-brand-300 dark:hover:file:bg-brand-900/50"
          />
          {file && (
            <p className="mt-1 text-xs text-slate-500">
              {file.name} ({Math.round(file.size / 1024)} KB)
            </p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">
            Category
          </label>
          <select
            value={category}
            onChange={(e) => setCategory(Number(e.target.value))}
            disabled={pending}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-100"
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <PrimaryButton type="submit" disabled={pending}>
          {pending ? <Spinner /> : null}
          {statusLabel}
        </PrimaryButton>
      </form>

      {status === "done" && cid && txHash && (
        <SuccessBox>
          Record uploaded
          {recordId ? ` (id #${recordId})` : ""}.
          <div className="mt-1 text-xs">
            CID: <span className="font-mono">{cid}</span>
          </div>
          <div className="text-xs">
            Tx:{" "}
            <a
              href={`${SEPOLIA_ETHERSCAN_TX}${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono underline hover:text-emerald-900"
            >
              {txHash.slice(0, 10)}…{txHash.slice(-8)}
            </a>
          </div>
        </SuccessBox>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
    </Card>
  );
}

// ---------------------------------------------------------------------
// Records table
// ---------------------------------------------------------------------

function RecordsSection({ records, loading, error, contracts, onChanged }) {
  const [deletingId, setDeletingId] = useState(null);
  const [deleteError, setDeleteError] = useState(null);

  async function deleteRecord(recordId) {
    if (!contracts?.healthRecordStorage) return;
    setDeleteError(null);
    setDeletingId(recordId);
    try {
      const tx = await contracts.healthRecordStorage.deleteRecord(recordId);
      await tx.wait();
      onChanged();
    } catch (err) {
      console.error("deleteRecord failed:", err);
      setDeleteError(describeError(err));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Card title="My Records">
      {loading && <CenteredNotice>Loading records…</CenteredNotice>}
      {error && <ErrorBox>{error}</ErrorBox>}
      {deleteError && <ErrorBox>{deleteError}</ErrorBox>}

      {!loading && !error && records.length === 0 && (
        <p className="text-sm text-slate-500">No active records yet.</p>
      )}

      {!loading && records.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-800">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2">ID</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Uploaded</th>
                <th className="px-4 py-2">IPFS CID</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white dark:divide-slate-800 dark:bg-transparent">
              {records.map((r) => (
                <tr key={r.recordId}>
                  <td className="px-4 py-3 font-mono text-xs text-slate-700">
                    #{r.recordId}
                  </td>
                  <td className="px-4 py-3">{categoryLabel(r.category)}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {formatTimestamp(r.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <CidCell cid={r.ipfsCID} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <DangerButton
                      onClick={() => deleteRecord(r.recordId)}
                      disabled={deletingId === r.recordId}
                    >
                      {deletingId === r.recordId ? "Deleting…" : "Delete"}
                    </DangerButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function CidCell({ cid }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(cid);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("clipboard write failed:", err);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono text-xs">{truncateCid(cid)}</span>
      <button
        type="button"
        onClick={copy}
        className="rounded border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------
// Access management
// ---------------------------------------------------------------------

function AccessManagementSection({
  pendingRequests,
  activeConsents,
  loading,
  error,
  contracts,
  account,
  ensurePatientKeypair,
  onDeny,
  onChanged,
}) {
  return (
    <Card title="Access Management">
      {loading && <CenteredNotice>Loading consents…</CenteredNotice>}
      {error && <ErrorBox>{error}</ErrorBox>}

      <SubSection title="Pending Requests">
        {pendingRequests.length === 0 ? (
          <p className="text-sm text-slate-500">No pending requests.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {pendingRequests.map((doctor) => (
              <PendingRequestRow
                key={doctor}
                doctor={doctor}
                contracts={contracts}
                account={account}
                ensurePatientKeypair={ensurePatientKeypair}
                onDeny={() => onDeny(doctor)}
                onGranted={onChanged}
              />
            ))}
          </ul>
        )}
      </SubSection>

      <SubSection title="Active Consents">
        {activeConsents.length === 0 ? (
          <p className="text-sm text-slate-500">No active consents.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {activeConsents.map((c) => (
              <ActiveConsentRow
                key={c.doctor}
                consent={c}
                contracts={contracts}
                onRevoked={onChanged}
              />
            ))}
          </ul>
        )}
      </SubSection>
    </Card>
  );
}

/**
 * Render a pending access request from a doctor + the form to approve it
 * (with category multiselect + expiry).
 *
 * Approve flow:
 *   1. Fetch doctor's encryption pubkey (PatientRegistry.getDoctorEncryptionPubKey).
 *      If empty, abort with a clear message — doctor hasn't signed in yet.
 *   2. Fetch all the patient's records; filter to those whose category is
 *      in the granted set.
 *   3. Unwrap each record's encryptedKey with the patient's own ECIES
 *      private key, then re-wrap each AES key for the doctor.
 *   4. Per granted category, bundle the wraps via crypto.bundleWrappedKeys
 *      (binary blob: count + [recordId(32) || wrap(93)]*). The bundle is
 *      what gets stored at doctorWrappedKeys[patient][doctor][category].
 *   5. Call consentManager.grantAccess(doctor, categoryArr, expiryDays, bundleArr).
 *
 * Constraint: BUNDLE_MAX_ENTRIES (16) records per category. If a category
 * has more, the grant is rejected and the user is told to revoke + re-grant
 * with a narrower scope.
 */
function PendingRequestRow({
  doctor,
  contracts,
  account,
  ensurePatientKeypair,
  onDeny,
  onGranted,
}) {
  // Default to "all categories" so the patient doesn't have to click each
  // checkbox — they can untick what they don't want to share.
  const [selectedCategories, setSelectedCategories] = useState(
    () => new Set(CATEGORIES.map((c) => c.value))
  );
  const [expiryDays, setExpiryDays] = useState("7");
  // Granular phase tracking so the patient sees what's happening during
  // the (potentially many-second) wrap-and-grant pipeline.
  // null | "checking" | "deriving" | "wrapping" | "signing" | "confirming"
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  const granting = status !== null;

  function toggleCategory(value) {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  async function grant() {
    setError(null);

    if (!contracts?.consentManager || !contracts?.patientRegistry || !contracts?.healthRecordStorage) {
      setError("Contracts are not available.");
      return;
    }
    if (selectedCategories.size === 0) {
      setError("Pick at least one category to share.");
      return;
    }
    const days = parseInt(expiryDays, 10);
    if (Number.isNaN(days) || days < 0) {
      setError("Expiry must be a non-negative integer (0 = permanent).");
      return;
    }

    try {
      // ---- 1. Verify the doctor has published their encryption pubkey ----
      setStatus("checking");
      const doctorPubKeyHex =
        await contracts.patientRegistry.getDoctorEncryptionPubKey(doctor);
      if (!doctorPubKeyHex || doctorPubKeyHex === "0x") {
        setError(
          "Doctor hasn't published their encryption key yet. Ask them to sign in once."
        );
        setStatus(null);
        return;
      }
      const doctorPubKey = ethers.utils.arrayify(doctorPubKeyHex);
      // Pubkey on-chain is the 64-byte uncompressed form (x || y, no
      // prefix). wrapKeyForRecipient wants the 33-byte compressed form,
      // so prefix with 0x02 / 0x03 based on the y parity (last byte of y).
      const compressedDoctorPubKey = new Uint8Array(33);
      compressedDoctorPubKey[0] = (doctorPubKey[63] & 1) === 0 ? 0x02 : 0x03;
      compressedDoctorPubKey.set(doctorPubKey.slice(0, 32), 1);

      // ---- 2. Derive (or reuse cached) patient keypair ----
      setStatus("deriving");
      const patientKp = await ensurePatientKeypair();

      // ---- 3. Fetch all the patient's records, filter by granted category ----
      setStatus("wrapping");
      const ids = await contracts.healthRecordStorage.getRecordIdsForPatient(
        account
      );

      // Group records by category, picking only granted ones.
      const byCategory = new Map(); // categoryNumber -> Array<{recordId, wrapped}>
      for (const idBN of ids) {
        const recordId = BigInt(idBN.toString());
        const rec = await contracts.healthRecordStorage.getRecord(recordId);
        if (!rec.isActive) continue;
        const cat = Number(rec.category);
        if (!selectedCategories.has(cat)) continue;

        // Unwrap the patient-wrapped AES key with the patient's privkey,
        // then re-wrap it for the doctor.
        const patientWrapped = ethers.utils.arrayify(rec.encryptedKey);
        const rawAESKey = unwrapKeyForSelf(patientWrapped, patientKp.privateKey);
        const doctorWrapped = wrapKeyForRecipient(
          rawAESKey,
          compressedDoctorPubKey
        );

        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat).push({ recordId, wrapped: doctorWrapped });
      }

      // Skip categories where the patient has zero records — the contract
      // rejects empty wrappedKey entries.
      const categoryArr = [];
      const wrappedArr = [];
      for (const cat of Array.from(selectedCategories).sort((a, b) => a - b)) {
        const entries = byCategory.get(cat);
        if (!entries || entries.length === 0) continue;
        if (entries.length > BUNDLE_MAX_ENTRIES) {
          throw new Error(
            `Category "${categoryLabel(cat)}" has ${entries.length} records — max ${BUNDLE_MAX_ENTRIES} per category bundle.`
          );
        }
        categoryArr.push(cat);
        wrappedArr.push(ethers.utils.hexlify(bundleWrappedKeys(entries)));
      }

      if (categoryArr.length === 0) {
        setError(
          "You have no records in the selected categories to share."
        );
        setStatus(null);
        return;
      }

      // ---- 4. grantAccess on-chain ----
      setStatus("signing");
      const tx = await contracts.consentManager.grantAccess(
        doctor,
        categoryArr,
        days,
        wrappedArr
      );

      setStatus("confirming");
      await tx.wait();

      setStatus(null);
      onGranted();
    } catch (err) {
      console.error("[grantAccess] failed:", err);
      setError(describeError(err));
      setStatus(null);
    }
  }

  const buttonLabel = {
    checking: "Checking doctor's key…",
    deriving: "Deriving your encryption key…",
    wrapping: "Wrapping record keys…",
    signing: "Waiting for wallet…",
    confirming: "Confirming transaction…",
  }[status] || "Grant Access";

  return (
    <li className="py-3">
      <div className="space-y-3">
        <div className="font-mono text-sm text-slate-700">
          {truncateAddress(doctor)}
        </div>

        <div>
          <div className="mb-1 text-xs font-medium text-slate-700">
            Categories to share
          </div>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => {
              const checked = selectedCategories.has(c.value);
              return (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => toggleCategory(c.value)}
                  disabled={granting}
                  className={
                    "rounded-full border px-3 py-1 text-xs transition " +
                    (checked
                      ? "border-brand-300 bg-brand-50 text-brand-800 dark:border-brand-700 dark:bg-brand-900/30 dark:text-brand-300"
                      : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50")
                  }
                >
                  {checked ? "✓ " : ""}
                  {c.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            min="0"
            value={expiryDays}
            onChange={(e) => setExpiryDays(e.target.value)}
            disabled={granting}
            className="w-20 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-100"
            placeholder="days"
          />
          <span className="text-xs text-slate-500">days (0 = permanent)</span>
          <PrimaryButton size="sm" onClick={grant} disabled={granting}>
            {granting ? <Spinner /> : null}
            {buttonLabel}
          </PrimaryButton>
          <SecondaryButton size="sm" onClick={onDeny} disabled={granting}>
            Deny
          </SecondaryButton>
        </div>
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
    </li>
  );
}

function ActiveConsentRow({ consent, contracts, onRevoked }) {
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState(null);

  async function revoke() {
    if (!contracts?.consentManager) return;
    setError(null);
    setRevoking(true);
    try {
      const tx = await contracts.consentManager.revokeAccess(consent.doctor);
      await tx.wait();
      onRevoked();
    } catch (err) {
      console.error("revokeAccess failed:", err);
      setError(describeError(err));
    } finally {
      setRevoking(false);
    }
  }

  const expiresAt = bnToNumber(consent.expiresAt);

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <div className="font-mono text-slate-700">
            {truncateAddress(consent.doctor)}
          </div>
          <div className="text-xs text-slate-500">
            Granted {formatTimestamp(consent.grantedAt)} ·{" "}
            {expiresAt === 0
              ? "permanent"
              : `expires ${formatTimestamp(consent.expiresAt)}`}
          </div>
        </div>
        <DangerButton size="sm" onClick={revoke} disabled={revoking}>
          {revoking ? "Revoking…" : "Revoke"}
        </DangerButton>
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
    </li>
  );
}

// ---------------------------------------------------------------------
// Shared UI primitives
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// Local primitives now wrap the shared UI library — call sites unchanged.
// ---------------------------------------------------------------------

function Card({ title, children, ...rest }) {
  return (
    <UICard title={title} {...rest}>
      {children}
    </UICard>
  );
}

function SubSection({ title, children }) {
  return (
    <div className="mb-6 last:mb-0">
      <h4 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
        {title}
      </h4>
      {children}
    </div>
  );
}

function PrimaryButton({ children, size = "md", ...rest }) {
  return (
    <UIButton variant="primary" size={size} {...rest}>
      {children}
    </UIButton>
  );
}

function SecondaryButton({ children, size = "md", ...rest }) {
  return (
    <UIButton variant="secondary" size={size} {...rest}>
      {children}
    </UIButton>
  );
}

function DangerButton({ children, size = "md", ...rest }) {
  return (
    <UIButton variant="danger" size={size} {...rest}>
      {children}
    </UIButton>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
      aria-hidden
    />
  );
}

function ErrorBox({ children }) {
  return (
    <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-300">
      {children}
    </div>
  );
}

function SuccessBox({ children }) {
  return (
    <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-900/20 dark:text-emerald-300">
      {children}
    </div>
  );
}

function CenteredNotice({ children }) {
  return (
    <div className="flex justify-center py-8 text-sm text-slate-500 dark:text-slate-400">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------
// Access History (Phase 4)
// ---------------------------------------------------------------------

/**
 * Reads three event streams for the patient's audit trail:
 *
 *   1. HealthRecordStorage.RecordAccessed         — normal doctor reads
 *   2. HealthRecordStorage.EmergencyRecordAccessed — emergency break-glass reads
 *   3. ConsentManager.EmergencyAccessInvoked       — emergency-window
 *                                                    invocations (carry the
 *                                                    doctor's justification)
 *
 * The emergency record-access events carry the recordId; the invocation
 * events carry the justification string. We correlate them in JS so each
 * emergency row in the timeline has BOTH (which record was read AND why
 * emergency access was claimed) — neither event by itself carries both.
 *
 * Normal access and emergency access are mutually exclusive on the
 * HealthRecordStorage side (one read fires exactly one of the two),
 * so there's no double-counting.
 */
function AccessHistorySection({ contracts, account }) {
  const [entries, setEntries] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (
      !contracts?.healthRecordStorage ||
      !contracts?.consentManager ||
      !account
    ) {
      return;
    }
    setError(null);
    setRefreshing(true);
    try {
      const hrs = contracts.healthRecordStorage;
      const cm = contracts.consentManager;
      const fromBlock = ContractConfig.DEPLOY_BLOCK ?? 0;

      // All four reads in parallel.
      // Filters: indexed positions match the .sol event signatures —
      //   RecordAccessed              (patient, doctor, recordId)
      //   EmergencyRecordAccessed     (patient, doctor, recordId)
      //   EmergencyAccessInvoked      (doctor, patient)     ← doctor first
      //   RecordStored                (patient, recordId)
      const [normalRes, emergencyRes, invokedRes, storedRes] =
        await Promise.all([
          readEventsChunked(
            hrs,
            hrs.filters.RecordAccessed(account, null, null),
            fromBlock,
            "latest"
          ),
          readEventsChunked(
            hrs,
            hrs.filters.EmergencyRecordAccessed(account, null, null),
            fromBlock,
            "latest"
          ),
          readEventsChunked(
            cm,
            cm.filters.EmergencyAccessInvoked(null, account),
            fromBlock,
            "latest"
          ),
          readEventsChunked(
            hrs,
            hrs.filters.RecordStored(account, null),
            fromBlock,
            "latest"
          ),
        ]);

      // recordId → category (numeric enum). Built from RecordStored
      // events filtered by this patient; covers active AND soft-deleted
      // records since the event log is immutable.
      const categoryMap = new Map();
      for (const ev of storedRes.events) {
        categoryMap.set(
          ev.args.recordId.toString(),
          Number(ev.args.category)
        );
      }

      // For an emergency record-access at time T by doctor D, the
      // justification is the most recent EmergencyAccessInvoked event
      // from D against this patient with timestamp <= T. (The contract's
      // emergency window is 24h; we don't enforce that here — any prior
      // invocation by the same doctor wins, newest first.)
      function findJustification(doctor, atTime) {
        let best = null;
        let bestTs = -1;
        for (const ev of invokedRes.events) {
          if (ev.args.doctor.toLowerCase() !== doctor.toLowerCase()) continue;
          const ts = toNumberSafe(ev.args.timestamp);
          if (ts > atTime) continue;
          if (ts > bestTs) {
            best = ev;
            bestTs = ts;
          }
        }
        return best ? best.args.reason : null;
      }

      const normalEntries = normalRes.events.map((e) => ({
        kind: "normal",
        recordId: e.args.recordId.toString(),
        doctor: e.args.doctor,
        timestamp: toNumberSafe(e.args.timestamp),
        category:
          categoryMap.get(e.args.recordId.toString()) ?? null,
        justification: null,
        key: `n-${e.blockNumber}-${e.logIndex}`,
      }));

      const emergencyEntries = emergencyRes.events.map((e) => {
        const ts = toNumberSafe(e.args.timestamp);
        return {
          kind: "emergency",
          recordId: e.args.recordId.toString(),
          doctor: e.args.doctor,
          timestamp: ts,
          category:
            categoryMap.get(e.args.recordId.toString()) ?? null,
          justification: findJustification(e.args.doctor, ts),
          key: `e-${e.blockNumber}-${e.logIndex}`,
        };
      });

      const merged = [...normalEntries, ...emergencyEntries].sort(
        (a, b) => b.timestamp - a.timestamp
      );

      if (
        normalRes.partial ||
        emergencyRes.partial ||
        invokedRes.partial ||
        storedRes.partial
      ) {
        setError(
          "Partial history — some older events may be missing. Click Refresh to retry."
        );
      }

      setEntries(merged);
    } catch (err) {
      console.error("[history] load failed:", err);
      setError(describeError(err));
      setEntries([]);
    } finally {
      setRefreshing(false);
    }
  }, [contracts, account]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Card title="Access History">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-3xl text-sm text-slate-600">
          Every time a doctor reads one of your records the event is
          logged on-chain. Emergency (break-glass) reads — invoked by a
          doctor without prior consent — also appear here, annotated
          with the doctor's stated justification.
        </p>
        <SecondaryButton
          size="sm"
          onClick={load}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </SecondaryButton>
      </div>

      {error && <ErrorBox>{error}</ErrorBox>}

      {entries === null && (
        <CenteredNotice>
          <Spinner /> Loading access history…
        </CenteredNotice>
      )}

      {entries && entries.length === 0 && !error && (
        <p className="text-sm text-slate-500">
          No access yet. When a doctor views one of your records, it
          will appear here. Emergency (break-glass) accesses are also
          logged here with the doctor's justification.
        </p>
      )}

      {entries && entries.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {entries.map((e) => (
            <AccessHistoryRow key={e.key} entry={e} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function AccessHistoryRow({ entry }) {
  const absoluteTime =
    entry.timestamp > 0
      ? new Date(entry.timestamp * 1000).toISOString()
      : "";

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <div className="flex flex-wrap items-baseline gap-2">
          <StatusPill
            status={entry.kind === "emergency" ? "emergency" : "access"}
          />
          <AddressDisplay address={entry.doctor} />
          <span className="text-slate-700 dark:text-slate-300">
            record <span className="font-mono">#{entry.recordId}</span>
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300">
            {entry.category == null
              ? "Unknown"
              : categoryLabel(entry.category)}
          </span>
        </div>
        <span
          className="text-xs text-slate-400 dark:text-slate-500"
          title={absoluteTime}
        >
          {timestampToRelative(entry.timestamp)}
        </span>
      </div>

      {entry.kind === "emergency" && (
        <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
          <span className="font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
            Justification:
          </span>{" "}
          {entry.justification ? (
            <span className="italic whitespace-pre-wrap break-words">
              {entry.justification}
            </span>
          ) : (
            <span className="italic text-amber-700/70 dark:text-amber-300/70">
              (no matching EmergencyAccessInvoked event found within the
              audit window — the doctor's reason may have expired or be
              outside the chunk lookback)
            </span>
          )}
        </div>
      )}
    </li>
  );
}
