import { useCallback, useEffect, useRef, useState } from "react";
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
import { Icon } from "./ui/Icon.jsx";
import { Stat as UIStat } from "./ui/Stat.jsx";
import { Modal as UIModal } from "./ui/Modal.jsx";
import { Empty } from "./ui/Empty.jsx";
import { Pipeline } from "./ui/StatusPipeline.jsx";
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
  { value: 0, label: "General", icon: "file" },
  { value: 1, label: "Blood Test", icon: "activity" },
  { value: 2, label: "Imaging", icon: "image" },
  { value: 3, label: "Prescription", icon: "pill" },
  { value: 4, label: "Mental Health", icon: "brain" },
  { value: 5, label: "Genetic", icon: "hash" },
  { value: 6, label: "Other", icon: "file" },
];

const ACCEPTED_FILE_TYPES = "application/pdf,image/*,text/plain";

const MAX_UPLOAD_MB = 5;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const SEPOLIA_ETHERSCAN_TX = "https://sepolia.etherscan.io/tx/";

// Pipeline step list shown inside the upload modal — keys MUST match the
// REAL phase keys used by the upload state machine in `submitUpload()`.
// `done` is intentionally omitted from the visible pipeline (we swap the
// modal body to the success view when the real flow transitions to it).
const UPLOAD_STEPS = [
  { key: "encrypting", label: "Encrypting" },
  { key: "uploading", label: "Uploading to IPFS" },
  { key: "wrapping", label: "Wrapping AES key" },
  { key: "signing", label: "Awaiting signature" },
  { key: "confirming", label: "Confirming tx" },
];

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

function categoryIcon(value) {
  if (value == null) return "file";
  const numeric = typeof value === "bigint" ? Number(value) : Number(value);
  return CATEGORIES.find((c) => c.value === numeric)?.icon || "file";
}

function formatBytes(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function daysFromSeconds(unixSeconds) {
  const sec = bnToNumber(unixSeconds);
  if (!sec) return null;
  const diffMs = sec * 1000 - Date.now();
  return Math.max(0, Math.round(diffMs / 86400000));
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
    return reason ? `Transaction reverted: ${reason}` : "Transaction reverted";
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

// ---------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------

const ROUTE_TITLES = {
  overview: "Patient Dashboard",
  upload: "Upload health record",
  records: "My records",
  consents: "Active consents",
  requests: "Pending access requests",
  history: "Access history",
};

export default function PatientDashboard({
  contracts,
  account,
  route = "overview",
  setRoute = () => {},
}) {
  // ---- Registration state ----
  const [isRegistered, setIsRegistered] = useState(null); // null = checking
  const [registrationCheckError, setRegistrationCheckError] = useState(null);

  // ---- Per-section state ----
  const [records, setRecords] = useState([]); // [{ recordId, ipfsCID, category, createdAt, isActive, uploadedBy }]
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsError, setRecordsError] = useState(null);

  const [pendingRequests, setPendingRequests] = useState([]);
  const [deniedRequests, setDeniedRequests] = useState(new Set());
  const [activeConsents, setActiveConsents] = useState([]);
  // Doctor address (lowercase) → { hospital }. Filled from
  // PatientRegistry.getDoctorInfo for every doctor that appears in
  // pendingRequests or activeConsents. Real chain data, not mock.
  const [doctorInfo, setDoctorInfo] = useState(new Map());
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState(null);

  // Access history (Phase 4)
  const [historyEntries, setHistoryEntries] = useState(null); // null = loading
  const [historyError, setHistoryError] = useState(null);
  const [historyRefreshing, setHistoryRefreshing] = useState(false);

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
      setIsRegistered(false);
      setRegistrationCheckError("No wallet account connected.");
      return;
    }
    if (!contracts?.patientRegistry) {
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
        DEPLOY_BLOCK ?? Math.max(0, latestBlock - QUERY_FILTER_LOOKBACK_BLOCKS);

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

      // Look up hospital affiliations for every distinct doctor on
      // either list — purely informational (the prototype shows it
      // alongside the address). Falls back silently if a lookup fails.
      const allDoctors = [
        ...new Set([
          ...pending.map((a) => a.toLowerCase()),
          ...active.map((c) => c.doctor.toLowerCase()),
        ]),
      ];
      if (allDoctors.length > 0 && contracts?.patientRegistry) {
        try {
          const infos = await Promise.all(
            allDoctors.map((a) => contracts.patientRegistry.getDoctorInfo(a))
          );
          const next = new Map(doctorInfo);
          allDoctors.forEach((addr, i) => {
            next.set(addr, {
              hospital: infos[i]?.hospitalAffiliation || "",
              isActive: !!infos[i]?.isActive,
            });
          });
          setDoctorInfo(next);
        } catch (err) {
          console.warn("[doctorInfo] partial load failed:", err);
        }
      }
    } catch (err) {
      console.error("loadAccessData failed:", err);
      setAccessError(describeError(err));
    } finally {
      setAccessLoading(false);
    }
  }, [contracts, account, doctorInfo]);

  const loadHistory = useCallback(async () => {
    if (
      !contracts?.healthRecordStorage ||
      !contracts?.consentManager ||
      !account
    ) {
      return;
    }
    setHistoryError(null);
    setHistoryRefreshing(true);
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

      const categoryMap = new Map();
      for (const ev of storedRes.events) {
        categoryMap.set(ev.args.recordId.toString(), Number(ev.args.category));
      }

      // For an emergency record-access at time T by doctor D, the
      // justification is the most recent EmergencyAccessInvoked event
      // from D against this patient with timestamp <= T.
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
        category: categoryMap.get(e.args.recordId.toString()) ?? null,
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
          category: categoryMap.get(e.args.recordId.toString()) ?? null,
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
        setHistoryError(
          "Partial history — some older events may be missing. Click Refresh to retry."
        );
      }

      setHistoryEntries(merged);
    } catch (err) {
      console.error("[history] load failed:", err);
      setHistoryError(describeError(err));
      setHistoryEntries([]);
    } finally {
      setHistoryRefreshing(false);
    }
  }, [contracts, account]);

  useEffect(() => {
    checkRegistration();
  }, [checkRegistration]);

  useEffect(() => {
    if (isRegistered) {
      loadRecords();
      loadAccessData();
      loadHistory();
    }
    // doctorInfo is intentionally omitted — loadAccessData updates it
    // and we don't want a recursive reload loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRegistered]);

  // ---------------------------------------------------------------
  // Upload state machine — REAL pipeline, NOT mock setTimeout.
  // Kept at the top level so it's shared between the modal, the
  // overview "Upload record" CTA, and the dedicated upload route.
  // ---------------------------------------------------------------

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadCategory, setUploadCategory] = useState(CATEGORIES[0].value);
  // null | "encrypting" | "uploading" | "wrapping" | "signing" | "confirming" | "done"
  const [uploadStatus, setUploadStatus] = useState(null);
  const [uploadError, setUploadError] = useState(null);
  const [uploadCid, setUploadCid] = useState(null);
  const [uploadTxHash, setUploadTxHash] = useState(null);
  const [uploadRecordId, setUploadRecordId] = useState(null);

  const uploadPending = uploadStatus !== null && uploadStatus !== "done";

  function openUpload() {
    // Don't clobber an in-flight upload. The modal is also re-openable
    // post-success — no reset there either, so the user sees the success
    // info until they click "Upload another" or close.
    setUploadOpen(true);
  }

  function resetUploadForm() {
    setUploadFile(null);
    setUploadStatus(null);
    setUploadError(null);
    setUploadCid(null);
    setUploadTxHash(null);
    setUploadRecordId(null);
  }

  function closeUpload() {
    if (uploadPending) return; // don't allow close mid-flight
    setUploadOpen(false);
    // Reset on close so the next open starts clean. Success info has
    // already been shown.
    if (uploadStatus === "done") resetUploadForm();
  }

  async function submitUpload() {
    setUploadError(null);
    setUploadCid(null);
    setUploadTxHash(null);
    setUploadRecordId(null);

    if (!uploadFile) {
      setUploadError("Please select a file.");
      return;
    }
    if (uploadFile.size > MAX_UPLOAD_BYTES) {
      const mb = (uploadFile.size / 1024 / 1024).toFixed(2);
      setUploadError(`File is ${mb} MB — max ${MAX_UPLOAD_MB} MB.`);
      return;
    }
    if (!contracts?.healthRecordStorage) {
      setUploadError("Storage contract is not available.");
      return;
    }

    // ethers v5: contracts built with a signer expose it via .signer.
    const signer = contracts.healthRecordStorage.signer;
    if (!signer || typeof signer.signMessage !== "function") {
      setUploadError("No signer available — reconnect your wallet.");
      return;
    }

    let phase = "encrypting";
    try {
      // Ensure the patient's ECIES keypair is derived ONCE per session.
      // This may pop a MetaMask sign prompt on the first call; subsequent
      // calls (and the grant-access flow) reuse the cached keypair.
      phase = "encrypting";
      setUploadStatus("encrypting");
      const keypair = await ensurePatientKeypair();

      // Embed filename + mimetype in the plaintext so the doctor can
      // recover them at view time.
      const wrappedFile = await wrapFileWithFilenameHeader(uploadFile);

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
          if (next !== "done") setUploadStatus(next);
        },
        keypair
      );
      setUploadCid(result.cid);

      // Step 5: contract write. The MetaMask popup appears here.
      phase = "signing";
      setUploadStatus("signing");
      const encryptedKeyHex = ethers.utils.hexlify(result.encryptedKey);
      const tx = await contracts.healthRecordStorage.storeRecord(
        result.cid,
        uploadCategory,
        encryptedKeyHex
      );
      setUploadTxHash(tx.hash);

      // Step 6: wait for mining.
      phase = "confirming";
      setUploadStatus("confirming");
      const receipt = await tx.wait();

      // Extract the global recordId from the RecordStored event for the
      // success message. ethers v5 attaches parsed events at receipt.events.
      const ev = receipt.events?.find((e) => e.event === "RecordStored");
      if (ev?.args?.recordId != null) {
        setUploadRecordId(ev.args.recordId.toString());
      }

      setUploadStatus("done");
      loadRecords();
    } catch (err) {
      console.error(`[upload] failed (phase: ${phase}):`, err);
      setUploadError(categorizeUploadError(err, phase));
      setUploadStatus(null);
    }
  }

  // ---------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------

  if (isRegistered === null) {
    return <CenteredNotice>Checking registration…</CenteredNotice>;
  }

  if (!isRegistered) {
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
        <RegistrationSection
          contracts={contracts}
          onRegistered={checkRegistration}
        />
      </div>
    );
  }

  const filteredPending = pendingRequests.filter(
    (d) => !deniedRequests.has(d.toLowerCase())
  );

  // -- per-route body --
  let body;
  if (route === "upload") {
    body = <UploadPanel onOpen={openUpload} />;
  } else if (route === "records") {
    body = (
      <UICard
        title="My records"
        icon="records"
        sub={`${records.length} encrypted record${
          records.length === 1 ? "" : "s"
        } on IPFS`}
        action={
          <UIButton size="sm" icon="upload" onClick={openUpload}>
            Upload record
          </UIButton>
        }
        flush
      >
        <RecordsTable
          records={records}
          loading={recordsLoading}
          error={recordsError}
          contracts={contracts}
          onChanged={loadRecords}
        />
      </UICard>
    );
  } else if (route === "consents") {
    body = (
      <UICard
        title="Active consents"
        icon="shield"
        sub={`${activeConsents.length} doctor${
          activeConsents.length === 1 ? "" : "s"
        } currently authorized`}
        flush
      >
        <ConsentsList
          consents={activeConsents}
          doctorInfo={doctorInfo}
          contracts={contracts}
          loading={accessLoading}
          error={accessError}
          onRevoked={loadAccessData}
        />
      </UICard>
    );
  } else if (route === "requests") {
    body = (
      <UICard
        title="Pending access requests"
        icon="bell"
        sub={`${filteredPending.length} awaiting your action`}
      >
        <PendingRequestsList
          pending={filteredPending}
          doctorInfo={doctorInfo}
          contracts={contracts}
          account={account}
          ensurePatientKeypair={ensurePatientKeypair}
          loading={accessLoading}
          error={accessError}
          onDeny={(doctor) =>
            setDeniedRequests((prev) => {
              const next = new Set(prev);
              next.add(doctor.toLowerCase());
              return next;
            })
          }
          onGranted={loadAccessData}
        />
      </UICard>
    );
  } else if (route === "history") {
    body = (
      <UICard
        title="Access history"
        icon="history"
        sub="Complete audit log"
        action={
          <UIButton
            size="sm"
            variant="ghost"
            icon="refresh"
            onClick={loadHistory}
            disabled={historyRefreshing}
          >
            {historyRefreshing ? "Refreshing…" : "Refresh"}
          </UIButton>
        }
        flush
      >
        <AccessTimeline
          entries={historyEntries}
          loading={historyEntries === null && historyRefreshing}
          error={historyError}
        />
      </UICard>
    );
  } else {
    // overview
    body = (
      <Overview
        records={records}
        recordsLoading={recordsLoading}
        recordsError={recordsError}
        contracts={contracts}
        onRecordsChanged={loadRecords}
        pending={filteredPending}
        consents={activeConsents}
        doctorInfo={doctorInfo}
        account={account}
        accessLoading={accessLoading}
        accessError={accessError}
        ensurePatientKeypair={ensurePatientKeypair}
        onAccessChanged={loadAccessData}
        onDeny={(doctor) =>
          setDeniedRequests((prev) => {
            const next = new Set(prev);
            next.add(doctor.toLowerCase());
            return next;
          })
        }
        historyEntries={historyEntries}
        historyError={historyError}
        openUpload={openUpload}
        setRoute={setRoute}
      />
    );
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            {ROUTE_TITLES[route] || ROUTE_TITLES.overview}
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Connected as <AddressDisplay address={account} />
          </p>
        </div>
        {route === "overview" && (
          <UIButton size="sm" icon="upload" onClick={openUpload}>
            Upload record
          </UIButton>
        )}
      </header>

      {registrationCheckError && (
        <ErrorBox>
          Failed to read registration status: {registrationCheckError}
        </ErrorBox>
      )}

      {body}

      <UploadModal
        open={uploadOpen}
        onClose={closeUpload}
        file={uploadFile}
        setFile={setUploadFile}
        category={uploadCategory}
        setCategory={setUploadCategory}
        status={uploadStatus}
        error={uploadError}
        cid={uploadCid}
        txHash={uploadTxHash}
        recordId={uploadRecordId}
        pending={uploadPending}
        submit={submitUpload}
        reset={resetUploadForm}
      />
    </div>
  );
}

// ---------------------------------------------------------------------
// Overview composition
// ---------------------------------------------------------------------

function Overview({
  records,
  recordsLoading,
  recordsError,
  contracts,
  onRecordsChanged,
  pending,
  consents,
  doctorInfo,
  account,
  accessLoading,
  accessError,
  ensurePatientKeypair,
  onAccessChanged,
  onDeny,
  historyEntries,
  historyError,
  openUpload,
  setRoute,
}) {
  return (
    <>
      <div className="stats-grid">
        <UIStat label="Total records" icon="records" value={records.length} />
        <UIStat
          label="Active consents"
          icon="shield"
          value={consents.length}
          tone="ok"
        />
        <UIStat
          label="Pending requests"
          icon="bell"
          value={pending.length}
          tone="warn"
        />
        <UIStat
          label="Records accessed"
          icon="eye"
          value={historyEntries?.length ?? 0}
          tone="cyan"
        />
      </div>

      <div className="split-3-2">
        <UICard
          title="Your records"
          sub="Encrypted, stored on IPFS, indexed on‑chain"
          icon="records"
          action={
            <UIButton size="sm" icon="upload" onClick={openUpload}>
              Upload
            </UIButton>
          }
          flush
        >
          <RecordsTable
            records={records.slice(0, 5)}
            loading={recordsLoading}
            error={recordsError}
            contracts={contracts}
            onChanged={onRecordsChanged}
            compact
          />
          {records.length > 5 && (
            <div
              style={{
                padding: "12px 20px",
                borderTop: "1px solid var(--line)",
                display: "flex",
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                className="linkbtn"
                onClick={() => setRoute("records")}
              >
                View all {records.length} records{" "}
                <Icon name="arrowRight" size={12} />
              </button>
            </div>
          )}
        </UICard>

        <UICard
          title="Pending access requests"
          icon="bell"
          sub={`${pending.length} doctor${
            pending.length === 1 ? "" : "s"
          } awaiting consent`}
        >
          <PendingRequestsList
            pending={pending}
            doctorInfo={doctorInfo}
            contracts={contracts}
            account={account}
            ensurePatientKeypair={ensurePatientKeypair}
            loading={accessLoading}
            error={accessError}
            onDeny={onDeny}
            onGranted={onAccessChanged}
            compact
          />
        </UICard>
      </div>

      <div className="split-3-2">
        <UICard
          title="Access history"
          icon="history"
          sub="Every record view — normal and emergency"
          flush
        >
          <AccessTimeline
            entries={historyEntries ? historyEntries.slice(0, 6) : null}
            loading={historyEntries === null}
            error={historyError}
          />
          {historyEntries && historyEntries.length > 6 && (
            <div
              style={{
                padding: "12px 20px",
                borderTop: "1px solid var(--line)",
                display: "flex",
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                className="linkbtn"
                onClick={() => setRoute("history")}
              >
                View full history <Icon name="arrowRight" size={12} />
              </button>
            </div>
          )}
        </UICard>

        <UICard
          title="Active consents"
          icon="shield"
          sub="Currently granted access"
          flush
        >
          <ConsentsList
            consents={consents}
            doctorInfo={doctorInfo}
            contracts={contracts}
            loading={accessLoading}
            error={accessError}
            onRevoked={onAccessChanged}
          />
        </UICard>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------
// Upload route panel — dropzone + visual pipeline (real flow runs in modal)
// ---------------------------------------------------------------------

function UploadPanel({ onOpen }) {
  return (
    <UICard
      title="Upload health record"
      icon="upload"
      sub="Encrypted in‑browser before it leaves your device"
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.2fr 1fr",
          gap: 18,
        }}
      >
        <div>
          <button
            type="button"
            className="dropzone"
            onClick={onOpen}
            style={{
              width: "100%",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            <div className="dz-ico">
              <Icon name="upload" size={20} />
            </div>
            <div className="dz-title">Click to pick a file</div>
            <div className="dz-sub">
              PDF, JPG, PNG, plain text up to {MAX_UPLOAD_MB} MB · AES‑256‑GCM
              encrypted client‑side
            </div>
          </button>
          <div style={{ marginTop: 16 }}>
            <div className="label" style={{ marginBottom: 6 }}>
              Categories available
            </div>
            <div className="chip-row">
              {CATEGORIES.map((c) => (
                <span key={c.value} className="chip">
                  <Icon name={c.icon} size={12} />
                  {c.label}
                </span>
              ))}
            </div>
          </div>
        </div>
        <div
          style={{
            background: "var(--surface-inset)",
            borderRadius: 12,
            padding: 16,
            border: "1px solid var(--line)",
          }}
        >
          <div
            style={{
              fontFamily: "'Sora Variable', Sora, sans-serif",
              fontWeight: 600,
              fontSize: 13,
              color: "var(--ink)",
            }}
          >
            Encryption pipeline
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--ink-3)",
              marginTop: 4,
              marginBottom: 14,
            }}
          >
            Your file is encrypted before upload. Only wallets you grant consent
            to can decrypt.
          </div>
          <ol
            style={{
              margin: 0,
              padding: 0,
              listStyle: "none",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            {[
              {
                i: 1,
                t: "Generate AES‑256 key",
                s: "Random per file · 96‑bit IV",
              },
              {
                i: 2,
                t: "AES‑GCM encrypt the file",
                s: "Tag verifies on decrypt",
              },
              {
                i: 3,
                t: "Upload ciphertext to IPFS",
                s: "Pinata gateway · returns CID",
              },
              {
                i: 4,
                t: "Wrap AES key with your pubkey",
                s: "93‑byte ECIES envelope",
              },
              {
                i: 5,
                t: "storeRecord(CID, category, wrappedKey)",
                s: "On‑chain transaction",
              },
            ].map((s) => (
              <li
                key={s.i}
                style={{ display: "flex", alignItems: "flex-start", gap: 10 }}
              >
                <span
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 6,
                    background: "var(--surface)",
                    border: "1px solid var(--line)",
                    display: "grid",
                    placeItems: "center",
                    fontSize: 11,
                    fontWeight: 700,
                    color: "var(--brand)",
                    flex: "none",
                  }}
                >
                  {s.i}
                </span>
                <div>
                  <div
                    style={{
                      fontSize: 12.5,
                      color: "var(--ink)",
                      fontWeight: 500,
                    }}
                  >
                    {s.t}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                    {s.s}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </UICard>
  );
}

// ---------------------------------------------------------------------
// Upload modal — wraps the REAL pipeline submitUpload() from the parent
// ---------------------------------------------------------------------

function UploadModal({
  open,
  onClose,
  file,
  setFile,
  category,
  setCategory,
  status,
  error,
  cid,
  txHash,
  recordId,
  pending,
  submit,
  reset,
}) {
  const fileInputRef = useRef(null);

  function pickFile() {
    fileInputRef.current?.click();
  }

  function onFileChange(e) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
  }

  function uploadAnother() {
    reset();
    pickFile();
  }

  // Modal footer changes based on which view we're showing in the body.
  let footer;
  if (status === "done") {
    footer = (
      <>
        <UIButton variant="ghost" onClick={onClose}>
          Close
        </UIButton>
        <UIButton icon="upload" onClick={uploadAnother}>
          Upload another
        </UIButton>
      </>
    );
  } else if (status === null) {
    footer = (
      <>
        <UIButton variant="ghost" onClick={onClose} disabled={pending}>
          Cancel
        </UIButton>
        <UIButton icon="lock" onClick={submit} disabled={!file}>
          Encrypt &amp; upload
        </UIButton>
      </>
    );
  } else {
    footer = null; // mid-flight: no manual exit
  }

  return (
    <UIModal
      open={open}
      onClose={pending ? undefined : onClose}
      title="Upload health record"
      subtitle="Encrypted client‑side · stored on IPFS · indexed on‑chain"
      width={640}
      footer={footer}
    >
      {/* Form view — visible when no flow is in progress and no success yet */}
      {status === null && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_FILE_TYPES}
            onChange={onFileChange}
            style={{ display: "none" }}
          />

          <button
            type="button"
            className="dropzone"
            onClick={pickFile}
            style={{
              width: "100%",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            <div className="dz-ico">
              <Icon name={file ? "file" : "upload"} size={20} />
            </div>
            <div className="dz-title">
              {file ? file.name : "Click to pick a file"}
            </div>
            <div className="dz-sub">
              {file
                ? `${formatBytes(file.size)} · ${
                    file.type || "application/octet-stream"
                  } · ready to encrypt`
                : `PDF, JPG, PNG, plain text up to ${MAX_UPLOAD_MB} MB`}
            </div>
          </button>

          <div className="field" style={{ marginTop: 14 }}>
            <span className="label">Category</span>
            <div className="chip-row">
              {CATEGORIES.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  className={`chip${category === c.value ? " on" : ""}`}
                  onClick={() => setCategory(c.value)}
                >
                  <Icon name={c.icon} size={12} />
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          {error && <ErrorBox>{error}</ErrorBox>}
        </>
      )}

      {/* In-flight view — REAL phase fed straight into the Pipeline */}
      {status !== null && status !== "done" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Pipeline current={status} steps={UPLOAD_STEPS} />
          <div
            style={{
              background: "var(--surface-inset)",
              borderRadius: 10,
              padding: 14,
              border: "1px solid var(--line)",
            }}
          >
            <div
              style={{
                fontSize: 12,
                color: "var(--ink-3)",
                marginBottom: 6,
              }}
            >
              Status
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontWeight: 600,
                fontSize: 13.5,
                color: "var(--ink)",
              }}
            >
              <Spinner />
              {UPLOAD_STEPS.find((s) => s.key === status)?.label}…
            </div>
            <div
              style={{
                marginTop: 10,
                fontSize: 12,
                color: "var(--ink-3)",
              }}
            >
              {file?.name} · {formatBytes(file?.size)} ·{" "}
              {categoryLabel(category)}
            </div>
          </div>
          {error && <ErrorBox>{error}</ErrorBox>}
        </div>
      )}

      {/* Success view — uses the real cid / txHash / recordId */}
      {status === "done" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "12px 14px",
              borderRadius: 10,
              background:
                "var(--ok-soft, color-mix(in oklch, var(--ok) 12%, transparent))",
              border:
                "1px solid color-mix(in oklch, var(--ok) 30%, transparent)",
              color: "var(--ok)",
              fontWeight: 600,
              fontSize: 13.5,
            }}
          >
            <Icon name="check" size={16} />
            Record uploaded{recordId ? ` (id #${recordId})` : ""}
          </div>
          {cid && (
            <div
              style={{
                fontSize: 12,
                color: "var(--ink-2)",
                fontFamily: "'Geist Mono Variable', monospace",
                wordBreak: "break-all",
              }}
            >
              CID: {cid}
            </div>
          )}
          {txHash && (
            <div style={{ fontSize: 12 }}>
              Tx:{" "}
              <a
                href={`${SEPOLIA_ETHERSCAN_TX}${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono"
                style={{
                  color: "var(--brand)",
                  textDecoration: "underline",
                  wordBreak: "break-all",
                }}
              >
                {txHash}
              </a>
            </div>
          )}
        </div>
      )}
    </UIModal>
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
    <UICard title="Register as Patient" icon="user">
      <p
        style={{
          fontSize: 13.5,
          color: "var(--ink-2)",
          marginBottom: 14,
        }}
      >
        You're not yet registered. Enter your display name to register on-chain.
      </p>
      <form
        onSubmit={submit}
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "flex-end",
        }}
      >
        <div className="field" style={{ flex: "1 1 240px" }}>
          <span className="label">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={pending}
            placeholder="e.g. Alice Adebayo"
            className="input"
          />
        </div>
        <UIButton
          type="submit"
          disabled={pending}
          loading={pending}
          icon="check"
        >
          {pending ? "Registering…" : "Register as Patient"}
        </UIButton>
      </form>

      {txHash && !pending && (
        <SuccessBox>
          Registered. Tx hash:{" "}
          <span className="font-mono text-xs">{txHash}</span>
        </SuccessBox>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
    </UICard>
  );
}

// ---------------------------------------------------------------------
// Records — table with category icon, real CID, real delete tx
// ---------------------------------------------------------------------

function RecordsTable({
  records,
  loading,
  error,
  contracts,
  onChanged,
  compact,
}) {
  const [deletingId, setDeletingId] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const [copiedCid, setCopiedCid] = useState(null);

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

  async function copyCid(cid) {
    try {
      await navigator.clipboard.writeText(cid);
      setCopiedCid(cid);
      setTimeout(() => setCopiedCid(null), 1200);
    } catch (err) {
      console.error("clipboard write failed:", err);
    }
  }

  if (loading) return <CenteredNotice>Loading records…</CenteredNotice>;

  if (error) {
    return (
      <div style={{ padding: "0 20px 16px" }}>
        <ErrorBox>{error}</ErrorBox>
      </div>
    );
  }

  if (!records || records.length === 0) {
    return (
      <div style={{ padding: 20 }}>
        <Empty
          icon="records"
          title="No records yet"
          body="Upload a record to get started — it will be encrypted client-side before it leaves your device."
        />
      </div>
    );
  }

  return (
    <>
      {deleteError && (
        <div style={{ padding: "0 20px 12px" }}>
          <ErrorBox>{deleteError}</ErrorBox>
        </div>
      )}
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 60 }}>#</th>
            <th>Record</th>
            <th>Category</th>
            <th>Uploaded</th>
            <th>IPFS CID</th>
            <th style={{ width: 60, textAlign: "right" }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.recordId}>
              <td className="num-cell">
                #{(r.recordId || "").toString().padStart(3, "0")}
              </td>
              <td>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      background: "var(--brand-soft)",
                      color: "var(--brand)",
                      display: "grid",
                      placeItems: "center",
                      flex: "none",
                    }}
                  >
                    <Icon name={categoryIcon(r.category)} size={14} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 500,
                        color: "var(--ink)",
                        fontSize: 13,
                      }}
                    >
                      Record #{r.recordId}
                    </div>
                    <div
                      style={{
                        fontSize: 11.5,
                        color: "var(--ink-3)",
                        fontFamily: "'Geist Mono Variable', monospace",
                      }}
                    >
                      {truncateCid(r.ipfsCID)}
                    </div>
                  </div>
                </div>
              </td>
              <td>
                <StatusPill status="brand">
                  {categoryLabel(r.category)}
                </StatusPill>
              </td>
              <td style={{ color: "var(--ink-2)" }}>
                {timestampToRelative(bnToNumber(r.createdAt))}
              </td>
              <td>
                <button
                  type="button"
                  onClick={() => copyCid(r.ipfsCID)}
                  title={r.ipfsCID}
                  className="font-mono"
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    color: "var(--ink-2)",
                    fontSize: 12,
                  }}
                >
                  {truncateCid(r.ipfsCID)}
                  {copiedCid === r.ipfsCID && (
                    <span
                      style={{
                        marginLeft: 6,
                        color: "var(--ok)",
                        fontSize: 10,
                      }}
                    >
                      copied!
                    </span>
                  )}
                </button>
              </td>
              <td style={{ textAlign: "right" }}>
                <button
                  type="button"
                  className="icon-btn"
                  style={{
                    width: 30,
                    height: 30,
                    opacity: deletingId === r.recordId ? 0.4 : 1,
                  }}
                  disabled={deletingId === r.recordId}
                  title={deletingId === r.recordId ? "Deleting…" : "Delete"}
                  onClick={() => deleteRecord(r.recordId)}
                  aria-label="Delete record"
                >
                  <Icon name="trash" size={14} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// ---------------------------------------------------------------------
// Pending requests — uses REAL grant-access flow (ECIES wrap + bundle + tx)
// ---------------------------------------------------------------------

function PendingRequestsList({
  pending,
  doctorInfo,
  contracts,
  account,
  ensurePatientKeypair,
  loading,
  error,
  onDeny,
  onGranted,
  compact,
}) {
  if (loading) return <CenteredNotice>Loading consents…</CenteredNotice>;
  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!pending || pending.length === 0) {
    return (
      <Empty
        icon="shieldcheck"
        title="No pending requests"
        body="Doctors who request access will appear here for review."
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {pending.map((doctor) => (
        <PendingCard
          key={doctor}
          doctor={doctor}
          info={doctorInfo.get(doctor.toLowerCase())}
          contracts={contracts}
          account={account}
          ensurePatientKeypair={ensurePatientKeypair}
          onDeny={() => onDeny(doctor)}
          onGranted={onGranted}
        />
      ))}
    </div>
  );
}

/**
 * Render a pending access request from a doctor + the form to approve it
 * (with category multiselect + expiry).
 *
 * Approve flow — UNCHANGED from the previous implementation. All real:
 *   1. Fetch doctor's encryption pubkey (PatientRegistry.getDoctorEncryptionPubKey).
 *   2. Fetch all the patient's records; filter to those whose category is
 *      in the granted set.
 *   3. Unwrap each record's encryptedKey with the patient's own ECIES
 *      private key, then re-wrap each AES key for the doctor.
 *   4. Per granted category, bundle the wraps via crypto.bundleWrappedKeys.
 *   5. Call consentManager.grantAccess(doctor, categoryArr, expiryDays, bundleArr).
 */
function PendingCard({
  doctor,
  info,
  contracts,
  account,
  ensurePatientKeypair,
  onDeny,
  onGranted,
}) {
  // Default to "all categories" so the patient doesn't have to click each
  // chip — they can untick what they don't want to share.
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

    if (
      !contracts?.consentManager ||
      !contracts?.patientRegistry ||
      !contracts?.healthRecordStorage
    ) {
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
        const rawAESKey = unwrapKeyForSelf(
          patientWrapped,
          patientKp.privateKey
        );
        if (rawAESKey.length !== 32) {
          throw new Error(
            `Grant unwrap produced ${rawAESKey.length} bytes, expected 32`
          );
        }
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
            `Category "${categoryLabel(cat)}" has ${
              entries.length
            } records — max ${BUNDLE_MAX_ENTRIES} per category bundle.`
          );
        }
        categoryArr.push(cat);
        wrappedArr.push(ethers.utils.hexlify(bundleWrappedKeys(entries)));
      }

      if (categoryArr.length === 0) {
        setError("You have no records in the selected categories to share.");
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

  const buttonLabel =
    {
      checking: "Checking key…",
      deriving: "Deriving your key…",
      wrapping: "Wrapping record keys…",
      signing: "Waiting for wallet…",
      confirming: "Confirming transaction…",
    }[status] || "Grant access";

  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: 14,
        padding: 14,
        background: "var(--surface-2)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            background: "var(--brand-soft)",
            color: "var(--brand)",
            display: "grid",
            placeItems: "center",
            flex: "none",
          }}
        >
          <Icon name="doctor" size={18} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontWeight: 600,
              color: "var(--ink)",
              fontSize: 13.5,
            }}
          >
            {shortAddr(doctor)}
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
            {info?.hospital || "Unknown hospital"}
          </div>
        </div>
        <StatusPill status="pending">Pending</StatusPill>
      </div>

      <div style={{ marginTop: 12 }}>
        <div className="label" style={{ marginBottom: 6 }}>
          Grant categories
        </div>
        <div className="chip-row">
          {CATEGORIES.map((c) => (
            <button
              key={c.value}
              type="button"
              className={`chip${selectedCategories.has(c.value) ? " on" : ""}`}
              onClick={() => toggleCategory(c.value)}
              disabled={granting}
            >
              <Icon name={c.icon} size={12} />
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div
        style={{
          marginTop: 12,
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon name="clock" size={14} style={{ color: "var(--ink-3)" }} />
          <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
            Expires in
          </span>
          <input
            type="number"
            min="0"
            value={expiryDays}
            onChange={(e) => setExpiryDays(e.target.value)}
            disabled={granting}
            className="input"
            style={{ width: 70, height: 32, padding: "4px 8px" }}
          />
          <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
            days (0 = permanent)
          </span>
        </div>
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 8,
          }}
        >
          <UIButton
            size="sm"
            variant="ghost"
            onClick={onDeny}
            disabled={granting}
          >
            Decline
          </UIButton>
          <UIButton
            size="sm"
            icon={granting ? undefined : "check"}
            loading={granting}
            onClick={grant}
            disabled={granting || selectedCategories.size === 0}
          >
            {buttonLabel}
          </UIButton>
        </div>
      </div>

      {error && <ErrorBox>{error}</ErrorBox>}
    </div>
  );
}

// ---------------------------------------------------------------------
// Active consents
// ---------------------------------------------------------------------

function ConsentsList({
  consents,
  doctorInfo,
  contracts,
  loading,
  error,
  onRevoked,
}) {
  if (loading) return <CenteredNotice>Loading consents…</CenteredNotice>;
  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!consents || consents.length === 0) {
    return (
      <div style={{ padding: 20 }}>
        <Empty
          icon="shield"
          title="No active consents"
          body="When you grant access, it shows up here."
        />
      </div>
    );
  }
  return (
    <div>
      {consents.map((c) => (
        <ConsentRow
          key={c.doctor}
          consent={c}
          info={doctorInfo.get(c.doctor.toLowerCase())}
          contracts={contracts}
          onRevoked={onRevoked}
        />
      ))}
    </div>
  );
}

function ConsentRow({ consent, info, contracts, onRevoked }) {
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

  const expiresAtSec = bnToNumber(consent.expiresAt);
  const isPermanent = expiresAtSec === 0;
  const daysLeft = isPermanent ? null : daysFromSeconds(consent.expiresAt);

  return (
    <div
      style={{
        padding: "14px 20px",
        borderBottom: "1px solid var(--line)",
        display: "flex",
        alignItems: "center",
        gap: 14,
        flexWrap: "wrap",
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          background:
            "color-mix(in oklch, var(--accent, var(--brand)) 14%, transparent)",
          color: "var(--brand)",
          display: "grid",
          placeItems: "center",
          flex: "none",
        }}
      >
        <Icon name="doctor" size={16} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontWeight: 600,
            color: "var(--ink)",
            fontSize: 13.5,
          }}
        >
          {shortAddr(consent.doctor)}
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--ink-3)",
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            marginTop: 2,
          }}
        >
          <span>{info?.hospital || "Unknown hospital"}</span>
          <span>·</span>
          <span>granted {formatTimestamp(consent.grantedAt)}</span>
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Expires</div>
        <div
          style={{
            fontWeight: 600,
            color: "var(--ink)",
            fontSize: 13,
          }}
        >
          {isPermanent ? "permanent" : `${daysLeft}d`}
        </div>
      </div>
      <UIButton
        size="sm"
        variant="ghost"
        icon="x"
        onClick={revoke}
        disabled={revoking}
      >
        {revoking ? "Revoking…" : "Revoke"}
      </UIButton>
      {error && (
        <div style={{ width: "100%" }}>
          <ErrorBox>{error}</ErrorBox>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Access history — timeline of RecordAccessed + EmergencyRecordAccessed
// ---------------------------------------------------------------------

function AccessTimeline({ entries, loading, error }) {
  if (loading) return <CenteredNotice>Loading access history…</CenteredNotice>;
  if (error) {
    return (
      <div style={{ padding: "0 20px 16px" }}>
        <ErrorBox>{error}</ErrorBox>
      </div>
    );
  }
  if (!entries || entries.length === 0) {
    return (
      <div style={{ padding: 20 }}>
        <Empty
          icon="eye"
          title="No access yet"
          body="When a doctor views one of your records, it appears here. Emergency (break-glass) accesses are also logged with the doctor's justification."
        />
      </div>
    );
  }
  return (
    <div className="timeline">
      {entries.map((e) => {
        const isEmg = e.kind === "emergency";
        const absoluteTime =
          e.timestamp > 0 ? new Date(e.timestamp * 1000).toISOString() : "";
        return (
          <div key={e.key} className={`row ${isEmg ? "emg" : "acc"}`}>
            <div className="marker">
              <Icon name={isEmg ? "emergency" : "eye"} size={14} />
            </div>
            <div className="body">
              <div className="head">
                <span>{isEmg ? "Emergency access" : "Record accessed"}</span>
                <StatusPill status={isEmg ? "emergency" : "access"}>
                  {isEmg ? "Emergency" : "Access"}
                </StatusPill>
                {e.category != null && (
                  <StatusPill status="brand">
                    {categoryLabel(e.category)}
                  </StatusPill>
                )}
              </div>
              <div className="meta">
                <span>by</span>
                <AddressDisplay address={e.doctor} />
                <span>· record #{e.recordId}</span>
              </div>
              {isEmg && (
                <div
                  style={{
                    marginTop: 8,
                    padding: "8px 10px",
                    background: "var(--danger-soft)",
                    borderRadius: 8,
                    fontSize: 12,
                    color: "var(--ink-2)",
                    borderLeft: "3px solid var(--danger)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  <strong style={{ color: "var(--danger)" }}>
                    Justification:{" "}
                  </strong>
                  {e.justification ? (
                    e.justification
                  ) : (
                    <span style={{ fontStyle: "italic", opacity: 0.7 }}>
                      (no matching EmergencyAccessInvoked event found within the
                      audit window)
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="time" title={absoluteTime}>
              {timestampToRelative(e.timestamp)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------
// Local primitives — thin wrappers / utility blocks
// ---------------------------------------------------------------------

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
    <div
      style={{
        marginTop: 12,
        padding: "10px 14px",
        borderRadius: 10,
        background: "var(--danger-soft)",
        color: "var(--danger)",
        fontSize: 13,
        fontWeight: 500,
        border: "1px solid color-mix(in oklch, var(--danger) 28%, transparent)",
      }}
      role="alert"
    >
      {children}
    </div>
  );
}

function SuccessBox({ children }) {
  return (
    <div
      style={{
        marginTop: 12,
        padding: "10px 14px",
        borderRadius: 10,
        background:
          "var(--ok-soft, color-mix(in oklch, var(--ok) 12%, transparent))",
        color: "var(--ok)",
        fontSize: 13,
        fontWeight: 500,
        border: "1px solid color-mix(in oklch, var(--ok) 30%, transparent)",
      }}
    >
      {children}
    </div>
  );
}

function CenteredNotice({ children }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        padding: "32px 0",
        fontSize: 13,
        color: "var(--ink-3)",
      }}
    >
      {children}
    </div>
  );
}
