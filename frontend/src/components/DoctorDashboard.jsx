import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";

import { fetchEncrypted } from "../utils/ipfs.js";
import {
  decryptFile,
  deriveECIESKeypairFromSigner,
  findWrappedKeyForRecord,
  importRawKey,
  uncompressPubKey,
  unwrapKeyForSelf,
} from "../utils/crypto.js";
import * as ContractConfig from "../config/contract.js";
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
import { Empty } from "./ui/Empty.jsx";
import { Pipeline } from "./ui/StatusPipeline.jsx";

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

const CATEGORIES = [
  { value: 0, label: "General",       icon: "file" },
  { value: 1, label: "Blood Test",    icon: "activity" },
  { value: 2, label: "Imaging",       icon: "image" },
  { value: 3, label: "Prescription",  icon: "pill" },
  { value: 4, label: "Mental Health", icon: "brain" },
  { value: 5, label: "Genetic",       icon: "hash" },
  { value: 6, label: "Other",         icon: "file" },
];

const DEPLOY_BLOCK = ContractConfig.DEPLOY_BLOCK;
const QUERY_FILTER_LOOKBACK_BLOCKS = 49000;

const SIGNATURE_PROMPT_MESSAGE =
  "Your wallet will be asked to sign a fixed message. This derives a deterministic " +
  "encryption keypair from your wallet — MetaMask never exposes the underlying " +
  "private key. The derived public key is then published on-chain so patients " +
  "can wrap symmetric keys for you.";

const PUBLISH_STEPS = [
  { key: "deriving",   label: "Deriving keypair" },
  { key: "signing",    label: "Waiting for signature" },
  { key: "confirming", label: "Confirming transaction" },
  { key: "verifying",  label: "Verifying on-chain" },
];

const ROUTE_TITLES = {
  overview: "Doctor Dashboard",
  request: "Request access",
  consents: "My active consents",
  history: "Access history",
  key: "Encryption key",
};

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

function categoryLabel(value) {
  if (value == null) return "";
  return CATEGORIES.find((c) => c.value === Number(value))?.label || String(value);
}

function categoryIcon(value) {
  if (value == null) return "file";
  return CATEGORIES.find((c) => c.value === Number(value))?.icon || "file";
}

function bnToNumber(bn) {
  if (bn == null) return 0;
  if (typeof bn === "number") return bn;
  if (typeof bn.toNumber === "function") return bn.toNumber();
  return Number(bn);
}

function formatTimestamp(bn) {
  const sec = bnToNumber(bn);
  if (!sec) return "";
  return new Date(sec * 1000).toLocaleString();
}

function daysFromSeconds(unixSeconds) {
  const sec = bnToNumber(unixSeconds);
  if (!sec) return null;
  const diffMs = sec * 1000 - Date.now();
  return Math.max(0, Math.round(diffMs / 86400000));
}

/**
 * Robust "is the doctor's encryption pubkey published?" check.
 *
 * Solidity `bytes` reads come back from ethers v5 as 0x-prefixed hex
 * strings. The empty-bytes case is the literal string `"0x"` (length 2),
 * NOT the empty string `""` (length 0) and NOT null/undefined. Two
 * brittle predicates I want to avoid here:
 *   - `stored === ""`               — never true for ethers v5 bytes
 *   - `stored.length === 0`         — "0x" has length 2, never 0
 *   - `Boolean(stored)`             — "0x" is a truthy string
 *
 * Use `arrayify` to convert to bytes and check the byte length. Handles
 * every shape (null, undefined, "0x", "0xab…", mixed-case hex) uniformly.
 */
function isPubKeyPublished(stored) {
  if (!stored || typeof stored !== "string") return false;
  try {
    return ethers.utils.arrayify(stored).length > 0;
  } catch {
    return false;
  }
}

/**
 * Convert the on-chain 64-byte uncompressed pubkey (x || y, no prefix
 * byte) to the 33-byte compressed form expected by @noble curves.
 *   compressed[0] = 0x02 if y is even, 0x03 if y is odd
 *   compressed[1..33] = x
 */
function compressedFromOnChainPubKey(uncompressed64) {
  if (uncompressed64.length !== 64) {
    throw new Error("Expected 64-byte uncompressed pubkey");
  }
  const out = new Uint8Array(33);
  out[0] = (uncompressed64[63] & 1) === 0 ? 0x02 : 0x03;
  out.set(uncompressed64.slice(0, 32), 1);
  return out;
}

/**
 * Inverse of the patient-side filename header wrap: split decrypted
 * bytes at the first 0x00 0x00 separator, parse the leading JSON, treat
 * the rest as the file content. Falls back to a generic filename if the
 * payload has no header (e.g. records uploaded before Phase 2C).
 */
function parseFilenameHeader(decryptedBytes, fallbackName) {
  let sep = -1;
  for (let i = 0; i + 1 < decryptedBytes.length; i++) {
    if (decryptedBytes[i] === 0x00 && decryptedBytes[i + 1] === 0x00) {
      sep = i;
      break;
    }
  }
  if (sep === -1) {
    return {
      header: { filename: fallbackName, mimetype: "application/octet-stream" },
      bytes: decryptedBytes,
    };
  }
  let header;
  try {
    const headerJson = new TextDecoder().decode(decryptedBytes.slice(0, sep));
    header = JSON.parse(headerJson);
  } catch {
    return {
      header: { filename: fallbackName, mimetype: "application/octet-stream" },
      bytes: decryptedBytes,
    };
  }
  return { header, bytes: decryptedBytes.slice(sep + 2) };
}

function triggerDownload(bytes, filename, mimetype) {
  const blob = new Blob([bytes], { type: mimetype || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "record";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the browser has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

function categoriesFromBitmap(bitmap) {
  const n = Number(bitmap || 0);
  const out = [];
  for (const c of CATEGORIES) {
    if ((n & (1 << c.value)) !== 0) out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------

export default function DoctorDashboard({
  contracts,
  account,
  route = "overview",
  setRoute = () => {},
}) {
  const [isDoctor, setIsDoctor] = useState(null); // null = checking
  const [statusError, setStatusError] = useState(null);

  // Pubkey state — null = loading, "0x" = unpublished, otherwise hex string
  const [onChainPubKey, setOnChainPubKey] = useState(null);

  // Doctor's own profile info (for the License Status stat + key view).
  // null = not yet loaded.
  const [doctorProfile, setDoctorProfile] = useState(null);

  // Derived keypair (kept in memory ONLY — never persisted). Used for
  // every unwrap.
  const [doctorKeypair, setDoctorKeypair] = useState(null);
  const [keypairMismatch, setKeypairMismatch] = useState(false);

  // Lifted from MyActiveConsentsSection so Overview + Consents view share
  // a single fetch. Each entry: { patient, patientName, consent, records }.
  const [grants, setGrants] = useState([]);
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [grantsError, setGrantsError] = useState(null);

  // Lifted from MyAccessHistorySection. `null` = loading.
  const [historyEntries, setHistoryEntries] = useState(null);
  const [historyError, setHistoryError] = useState(null);
  const [historyRefreshing, setHistoryRefreshing] = useState(false);

  // Bumped after every successful `View` tx so the access-history feed
  // re-fetches without requiring a manual Refresh click.
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const bumpHistory = useCallback(
    () => setHistoryRefreshKey((n) => n + 1),
    []
  );

  // ---- Initial fetch: role + pubkey + own profile ----

  const refreshStatus = useCallback(async () => {
    if (!account) {
      setIsDoctor(false);
      setStatusError("No wallet account connected.");
      return;
    }
    if (!contracts?.patientRegistry) {
      setIsDoctor(false);
      setStatusError(
        "PatientRegistry contract is not available. Check contract addresses and network."
      );
      return;
    }
    setStatusError(null);
    try {
      const result = await contracts.patientRegistry.isDoctor(account);
      setIsDoctor(result);
      if (result) {
        const [pk, doc] = await Promise.all([
          contracts.patientRegistry.getDoctorEncryptionPubKey(account),
          contracts.patientRegistry.getDoctor(account),
        ]);
        setOnChainPubKey(pk);
        setDoctorProfile({
          hospital: doc?.hospitalAffiliation || "",
          isActive: !!doc?.isActive,
          registeredAt: doc?.registeredAt,
        });
      }
    } catch (err) {
      console.error("[doctor] status fetch failed:", err);
      setIsDoctor(false);
      setStatusError(describeError(err));
    }
  }, [contracts, account]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // ---- Derive (or reuse cached) the doctor's keypair ----
  //
  // Used by view-record flows to unwrap the AES key. Also runs the
  // matched-vs-mismatch check against the on-chain pubkey on first call.

  const ensureDoctorKeypair = useCallback(async () => {
    if (doctorKeypair) return doctorKeypair;
    const signer = contracts?.patientRegistry?.signer;
    if (!signer || typeof signer.signMessage !== "function") {
      throw new Error("No signer available — reconnect your wallet.");
    }
    const kp = await deriveECIESKeypairFromSigner(signer);
    setDoctorKeypair(kp);

    // If a pubkey is on-chain, sanity-check that our derived pubkey
    // matches it. A mismatch means the doctor signed in with a wallet
    // that has a published pubkey but isn't the one that registered it
    // (e.g. wallet was recreated from a different seed).
    if (isPubKeyPublished(onChainPubKey)) {
      try {
        const onChainBytes = ethers.utils.arrayify(onChainPubKey);
        const onChainCompressed = compressedFromOnChainPubKey(onChainBytes);
        const match =
          kp.publicKey.length === onChainCompressed.length &&
          kp.publicKey.every((b, i) => b === onChainCompressed[i]);
        if (!match) setKeypairMismatch(true);
      } catch (err) {
        console.error("[doctor] pubkey compare failed:", err);
      }
    }
    return kp;
  }, [doctorKeypair, contracts, onChainPubKey]);

  // ---------------------------------------------------------------
  // Active consents loader (REAL chain reads — UNTOUCHED logic)
  // ---------------------------------------------------------------

  const reloadGrants = useCallback(async () => {
    if (
      !contracts?.consentManager ||
      !contracts?.healthRecordStorage ||
      !contracts?.patientRegistry ||
      !account
    ) {
      return;
    }
    setGrantsLoading(true);
    setGrantsError(null);
    try {
      // Find all patients who ever granted me access (indexed event filter
      // by `doctor`). Bound the lookback so Alchemy's eth_getLogs window
      // never gets blown.
      const provider = contracts.consentManager.provider;
      const latest = await provider.getBlockNumber();
      const fromBlock =
        DEPLOY_BLOCK ?? Math.max(0, latest - QUERY_FILTER_LOOKBACK_BLOCKS);

      const filter = contracts.consentManager.filters.AccessGranted(
        null,
        account
      );
      const events = await contracts.consentManager.queryFilter(
        filter,
        fromBlock,
        "latest"
      );
      const uniquePatients = [...new Set(events.map((e) => e.args.patient))];

      const out = [];
      for (const patient of uniquePatients) {
        const consent = await contracts.consentManager.getConsent(
          patient,
          account
        );
        if (!consent.isActive) continue;
        const expiresAt = bnToNumber(consent.expiresAt);
        if (expiresAt !== 0 && Date.now() / 1000 >= expiresAt) continue;

        const bitmap = Number(consent.categoryBitmap);
        // List records in granted categories.
        const ids = await contracts.healthRecordStorage.getRecordIdsForPatient(
          patient
        );
        const records = [];
        for (const idBN of ids) {
          const rec = await contracts.healthRecordStorage.getRecord(
            BigInt(idBN.toString())
          );
          if (!rec.isActive) continue;
          const cat = Number(rec.category);
          if ((bitmap & (1 << cat)) === 0) continue;
          records.push({
            recordId: BigInt(idBN.toString()),
            category: cat,
            createdAt: rec.createdAt,
            ipfsCID: rec.ipfsCID,
          });
        }

        // Enrich with patient name (real PatientRegistry read). Falls
        // back silently if the read fails — we still have the address.
        let patientName = "";
        try {
          const p = await contracts.patientRegistry.getPatient(patient);
          patientName = p?.name || "";
        } catch (err) {
          console.warn("[doctor] getPatient failed:", err);
        }

        out.push({
          patient,
          patientName,
          consent: {
            isActive: true,
            expiresAt,
            categoryBitmap: bitmap,
          },
          records,
        });
      }

      setGrants(out);
    } catch (err) {
      console.error("[doctor] loadGrants failed:", err);
      setGrantsError(describeError(err));
    } finally {
      setGrantsLoading(false);
    }
  }, [contracts, account]);

  // ---------------------------------------------------------------
  // History loader (REAL chain reads — UNTOUCHED logic)
  // ---------------------------------------------------------------

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

      // Three reads in parallel.
      //
      // RecordAccessed         (patient, doctor, recordId)  ← filter by doctor
      // EmergencyRecordAccessed(patient, doctor, recordId)  ← filter by doctor
      // EmergencyAccessInvoked (doctor,  patient)           ← filter by doctor
      const [normalRes, emergencyRes, invokedRes] = await Promise.all([
        readEventsChunked(
          hrs,
          hrs.filters.RecordAccessed(null, account, null),
          fromBlock,
          "latest"
        ),
        readEventsChunked(
          hrs,
          hrs.filters.EmergencyRecordAccessed(null, account, null),
          fromBlock,
          "latest"
        ),
        readEventsChunked(
          cm,
          cm.filters.EmergencyAccessInvoked(account, null),
          fromBlock,
          "latest"
        ),
      ]);

      // ---- Category enrichment (Option A) ----
      const recordIdSet = new Set();
      for (const ev of normalRes.events) {
        recordIdSet.add(ev.args.recordId.toString());
      }
      for (const ev of emergencyRes.events) {
        recordIdSet.add(ev.args.recordId.toString());
      }
      const categoryMap = new Map();
      await Promise.all(
        [...recordIdSet].map(async (idStr) => {
          try {
            const rec = await hrs.getRecord(idStr);
            categoryMap.set(idStr, Number(rec.category));
          } catch (err) {
            // Record fetch may fail if the doctor's consent has since
            // been revoked. Leave the map entry unset.
            console.error(
              `[history/doctor] getRecord(${idStr}) failed:`,
              err?.message || err
            );
          }
        })
      );

      // ---- Justification lookup for emergency rows ----
      function findJustification(patient, atTime) {
        let best = null;
        let bestTs = -1;
        for (const ev of invokedRes.events) {
          if (ev.args.patient.toLowerCase() !== patient.toLowerCase()) {
            continue;
          }
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
        patient: e.args.patient,
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
          patient: e.args.patient,
          timestamp: ts,
          category: categoryMap.get(e.args.recordId.toString()) ?? null,
          justification: findJustification(e.args.patient, ts),
          key: `e-${e.blockNumber}-${e.logIndex}`,
        };
      });

      const merged = [...normalEntries, ...emergencyEntries].sort(
        (a, b) => b.timestamp - a.timestamp
      );

      if (normalRes.partial || emergencyRes.partial || invokedRes.partial) {
        setHistoryError(
          "Partial history — some older events may be missing. Click Refresh to retry."
        );
      }

      setHistoryEntries(merged);
    } catch (err) {
      console.error("[history/doctor] load failed:", err);
      setHistoryError(describeError(err));
      setHistoryEntries([]);
    } finally {
      setHistoryRefreshing(false);
    }
  }, [contracts, account]);

  useEffect(() => {
    if (isDoctor && isPubKeyPublished(onChainPubKey)) {
      reloadGrants();
    }
    // We deliberately depend only on the gating flags, not reloadGrants
    // itself, to avoid an infinite refetch loop when its closures change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDoctor, onChainPubKey]);

  useEffect(() => {
    if (isDoctor && isPubKeyPublished(onChainPubKey)) {
      loadHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDoctor, onChainPubKey, historyRefreshKey]);

  // ---- Render gating ----

  if (isDoctor === null) {
    return <CenteredNotice>Checking registration…</CenteredNotice>;
  }

  // Non-doctor: short-circuit with a friendly card.
  if (!isDoctor) {
    return (
      <div className="space-y-8">
        <DashboardHeader account={account} title="Doctor Dashboard" />
        {statusError && <ErrorBox>{statusError}</ErrorBox>}
        <UICard title="Registration status" icon="warning" tone="warning">
          <p
            style={{
              fontSize: 13.5,
              color: "var(--ink-2)",
              lineHeight: 1.55,
            }}
          >
            Your address is not registered as a doctor. Please contact the
            admin to be registered.
          </p>
        </UICard>
      </div>
    );
  }

  // Doctor present but pubkey not yet published — full-screen CTA.
  // The check on `onChainPubKey !== null` rules out the loading state so
  // the CTA never flashes while the read is in flight.
  if (
    onChainPubKey !== null &&
    !isPubKeyPublished(onChainPubKey)
  ) {
    return (
      <div className="space-y-8">
        <DashboardHeader account={account} title="Doctor Dashboard" />
        {statusError && <ErrorBox>{statusError}</ErrorBox>}
        <PublishPubKeyCTA
          contracts={contracts}
          account={account}
          onPublished={(publishedHex) => {
            // Immediate state transition: hide the CTA and reveal the
            // main UI without waiting for the parent's refreshStatus to
            // re-fetch. We trust the value we just wrote on-chain.
            if (publishedHex) setOnChainPubKey(publishedHex);
            // Still re-sync from the chain in the background.
            refreshStatus();
          }}
        />
      </div>
    );
  }

  // Pubkey is published — render the route-based dashboard.
  const emergencyCount =
    historyEntries?.filter((e) => e.kind === "emergency").length ?? 0;

  let body;
  if (route === "request") {
    body = <RequestAccessSection contracts={contracts} account={account} full />;
  } else if (route === "consents") {
    body = (
      <ConsentsCard
        grants={grants}
        loading={grantsLoading}
        error={grantsError}
        onRefresh={reloadGrants}
        contracts={contracts}
        account={account}
        ensureDoctorKeypair={ensureDoctorKeypair}
        onAccessLogged={bumpHistory}
        expanded
      />
    );
  } else if (route === "history") {
    body = (
      <UICard
        title="Access history"
        icon="history"
        sub="Every record you have viewed"
        flush
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
      >
        <AccessTimeline
          entries={historyEntries}
          loading={historyEntries === null && historyRefreshing}
          error={historyError}
        />
      </UICard>
    );
  } else if (route === "key") {
    body = (
      <KeyView
        onChainPubKey={onChainPubKey}
        keypairMismatch={keypairMismatch}
        ensureDoctorKeypair={ensureDoctorKeypair}
        haveDerivedKeypair={!!doctorKeypair}
        doctorProfile={doctorProfile}
      />
    );
  } else {
    // overview
    body = (
      <Overview
        grants={grants}
        grantsLoading={grantsLoading}
        grantsError={grantsError}
        onGrantsRefresh={reloadGrants}
        historyEntries={historyEntries}
        historyError={historyError}
        emergencyCount={emergencyCount}
        doctorProfile={doctorProfile}
        contracts={contracts}
        account={account}
        ensureDoctorKeypair={ensureDoctorKeypair}
        onAccessLogged={bumpHistory}
        setRoute={setRoute}
      />
    );
  }

  return (
    <div className="space-y-8">
      <DashboardHeader
        account={account}
        title={ROUTE_TITLES[route] || ROUTE_TITLES.overview}
      />
      {statusError && <ErrorBox>{statusError}</ErrorBox>}
      {keypairMismatch && <PubKeyMismatchBanner />}
      {body}
    </div>
  );
}

function DashboardHeader({ account, title }) {
  return (
    <header>
      <h2 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
        {title}
      </h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Connected as <AddressDisplay address={account} />
      </p>
    </header>
  );
}

function PubKeyMismatchBanner() {
  return (
    <div
      role="alert"
      style={{
        padding: "12px 14px",
        borderRadius: 12,
        background: "var(--danger-soft)",
        color: "var(--danger)",
        border:
          "1px solid color-mix(in oklch, var(--danger) 30%, transparent)",
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
      }}
    >
      <Icon name="warning" size={18} />
      <div>
        <div
          style={{
            fontFamily: "'Sora Variable', Sora, sans-serif",
            fontWeight: 700,
            fontSize: 13.5,
          }}
        >
          Your wallet signature no longer matches your published encryption key.
        </div>
        <div
          style={{
            marginTop: 4,
            fontSize: 12.5,
            color: "color-mix(in oklch, var(--danger) 80%, var(--ink-2))",
          }}
        >
          Decryption will fail. Switch back to the original account or contact
          the admin to re-register you.
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Overview composition
// ---------------------------------------------------------------------

function Overview({
  grants,
  grantsLoading,
  grantsError,
  onGrantsRefresh,
  historyEntries,
  historyError,
  emergencyCount,
  doctorProfile,
  contracts,
  account,
  ensureDoctorKeypair,
  onAccessLogged,
  setRoute,
}) {
  const totalRecords = grants.reduce((acc, g) => acc + g.records.length, 0);

  return (
    <>
      <div className="stats-grid">
        <UIStat
          label="Active consents"
          icon="shield"
          value={grants.length}
          tone="ok"
          delta={`${totalRecords} record${totalRecords === 1 ? "" : "s"} accessible`}
        />
        <UIStat
          label="Records accessed"
          icon="eye"
          value={historyEntries?.length ?? 0}
        />
        <UIStat
          label="Emergency invocations"
          icon="emergency"
          value={emergencyCount}
          tone="warn"
        />
        <UIStat
          label="License status"
          icon="shieldcheck"
          value={doctorProfile?.isActive ? "Active" : "Inactive"}
          tone="cyan"
          delta={doctorProfile?.hospital || ""}
        />
      </div>

      <div className="split-3-2">
        <ConsentsCard
          title="Active consents"
          sub="Patients who have granted you scoped access"
          grants={grants}
          loading={grantsLoading}
          error={grantsError}
          onRefresh={onGrantsRefresh}
          contracts={contracts}
          account={account}
          ensureDoctorKeypair={ensureDoctorKeypair}
          onAccessLogged={onAccessLogged}
          previewLimit={4}
          onViewAll={() => setRoute("consents")}
        />
        <UICard
          title="Recent access"
          icon="history"
          sub="Your compliance trail"
          flush
        >
          <AccessTimeline
            entries={historyEntries ? historyEntries.slice(0, 4) : null}
            loading={historyEntries === null}
            error={historyError}
          />
          {historyEntries && historyEntries.length > 4 && (
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
      </div>

      <RequestAccessSection contracts={contracts} account={account} />
    </>
  );
}

// ---------------------------------------------------------------------
// "Publish your encryption key" — REAL flow, restyled with Pipeline
// ---------------------------------------------------------------------

function PublishPubKeyCTA({ contracts, account, onPublished }) {
  // null | "deriving" | "signing" | "confirming" | "verifying"
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [txHash, setTxHash] = useState(null);

  const pending = status !== null;

  async function publish() {
    setError(null);
    setTxHash(null);

    const signer = contracts?.patientRegistry?.signer;
    if (!signer || typeof signer.signMessage !== "function") {
      setError("No signer available — reconnect your wallet.");
      return;
    }

    try {
      // 1. Derive the keypair from a MetaMask signature.
      setStatus("deriving");
      const kp = await deriveECIESKeypairFromSigner(signer);

      // 2. Convert the 33-byte compressed pubkey to the 64-byte
      // uncompressed (no-prefix) form the contract expects.
      //
      // Note: we deliberately do NOT check that the derived pubkey
      // hashes to msg.sender's address. The keypair is an HKDF
      // derivation off a MetaMask signature — independent of the
      // wallet's signing keypair — and by construction does not satisfy
      // that invariant. The contract no longer enforces it either
      // (Phase 2C bug-fix removed that require).
      const uncompressedNoPrefix = uncompressPubKey(kp.publicKey);

      // 3. Send the tx.
      setStatus("signing");
      const tx = await contracts.patientRegistry.setDoctorEncryptionPubKey(
        ethers.utils.hexlify(uncompressedNoPrefix)
      );
      setTxHash(tx.hash);

      // 4. Wait for mining.
      setStatus("confirming");
      await tx.wait();

      // 5. Verify on-chain. Use the robust `isPubKeyPublished` predicate
      // (arrayify-based) — `=== "0x"` alone is brittle because ethers v5
      // can return mixed-case hex / leading-padded values in some edge
      // cases.
      setStatus("verifying");
      const fetched = await contracts.patientRegistry.getDoctorEncryptionPubKey(
        account
      );
      if (!isPubKeyPublished(fetched)) {
        throw new Error("Pubkey was not stored on-chain after tx confirmed.");
      }

      setStatus(null);
      // Hand the verified hex up to the parent so it can transition state
      // immediately (no need to wait for a refresh-and-re-read round-trip).
      onPublished(fetched);
    } catch (err) {
      console.error("[publishPubKey] failed:", err);
      setError(describeError(err));
      setStatus(null);
    }
  }

  return (
    <UICard
      tone="warn"
      title="Publish your encryption key"
      icon="key"
      sub="One‑time, non‑rotatable. Required before patients can grant you access."
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div
          style={{
            fontSize: 13.5,
            color: "var(--ink-2)",
            lineHeight: 1.55,
          }}
        >
          {SIGNATURE_PROMPT_MESSAGE}
        </div>

        <div
          style={{
            fontSize: 12.5,
            color: "var(--ink-3)",
            background: "var(--surface-inset)",
            border: "1px solid var(--line)",
            borderRadius: 10,
            padding: "10px 12px",
          }}
        >
          We'll derive an ECIES keypair from a deterministic signature on the
          canonical message{" "}
          <span
            className="font-mono"
            style={{
              display: "inline-block",
              padding: "2px 8px",
              background: "var(--surface)",
              borderRadius: 6,
              fontSize: 12,
              color: "var(--ink-2)",
            }}
          >
            "HealthDataPlatform key derivation v1"
          </span>
          , then publish only the public half to the registry.
        </div>

        <Pipeline current={status || ""} steps={PUBLISH_STEPS} />

        <div
          style={{
            fontSize: 12,
            color: "color-mix(in oklch, var(--warn) 75%, var(--ink-3))",
            background: "var(--warn-soft)",
            border:
              "1px solid color-mix(in oklch, var(--warn) 30%, transparent)",
            borderRadius: 10,
            padding: "10px 12px",
          }}
        >
          <strong>One‑time, non‑rotatable.</strong> The contract rejects later
          attempts to overwrite your published key. If you ever need to rotate,
          the admin must revoke and re‑register you.
        </div>

        <div>
          <UIButton
            icon="key"
            onClick={publish}
            loading={pending}
            disabled={pending}
          >
            {pending
              ? PUBLISH_STEPS.find((s) => s.key === status)?.label + "…" ||
                "Working…"
              : "Publish encryption key"}
          </UIButton>
        </div>

        {txHash && (
          <div
            style={{
              fontSize: 12,
              color: "var(--ink-3)",
              fontFamily: "'Geist Mono Variable', monospace",
              wordBreak: "break-all",
            }}
          >
            Tx: {txHash}
          </div>
        )}
        {error && <ErrorBox>{error}</ErrorBox>}
      </div>
    </UICard>
  );
}

// ---------------------------------------------------------------------
// Request access — REAL `consentManager.requestAccess(patient)` tx
// ---------------------------------------------------------------------

function RequestAccessSection({ contracts, account, full }) {
  const [patient, setPatient] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [txHash, setTxHash] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setTxHash(null);

    if (!ethers.utils.isAddress(patient)) {
      setError("Please enter a valid Ethereum address.");
      return;
    }
    if (!contracts?.consentManager) {
      setError("Consent manager contract is not available.");
      return;
    }

    setPending(true);
    try {
      const tx = await contracts.consentManager.requestAccess(
        ethers.utils.getAddress(patient)
      );
      setTxHash(tx.hash);
      await tx.wait();
      setPatient("");
    } catch (err) {
      console.error("requestAccess failed:", err);
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <UICard
      title="Request access from a patient"
      icon="send"
      sub="Submit a patient address to request consent — emits an on‑chain AccessRequested event"
    >
      <form
        onSubmit={submit}
        style={{
          display: "grid",
          gridTemplateColumns: full ? "1fr" : "1.5fr auto",
          gap: 12,
          alignItems: "end",
          maxWidth: full ? 560 : undefined,
        }}
      >
        <div className="field">
          <span className="label">Patient wallet address</span>
          <div className="input-with-icon">
            <Icon name="user" className="ico" size={14} />
            <input
              type="text"
              className="input mono"
              placeholder="0x…"
              value={patient}
              onChange={(e) => setPatient(e.target.value)}
              disabled={pending}
            />
          </div>
          <span className="hint">
            The patient will see your request in their pending list and decide
            which categories to grant.
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <UIButton
            type="submit"
            icon="send"
            disabled={!patient || pending}
            loading={pending}
          >
            {pending ? "Submitting…" : "Submit request"}
          </UIButton>
        </div>
      </form>

      {txHash && (
        <SuccessBox>
          Request submitted. Tx:{" "}
          <span
            style={{
              fontFamily: "'Geist Mono Variable', monospace",
              wordBreak: "break-all",
              fontSize: 12,
            }}
          >
            {txHash}
          </span>
        </SuccessBox>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
    </UICard>
  );
}

// ---------------------------------------------------------------------
// Active consents — expandable per-patient card with REAL view-record flow
// ---------------------------------------------------------------------

function ConsentsCard({
  title = "My active consents",
  sub,
  grants,
  loading,
  error,
  onRefresh,
  contracts,
  account,
  ensureDoctorKeypair,
  onAccessLogged,
  expanded,
  previewLimit,
  onViewAll,
}) {
  const visible =
    previewLimit && grants.length > previewLimit
      ? grants.slice(0, previewLimit)
      : grants;
  const subText =
    sub || `${grants.length} patient${grants.length === 1 ? "" : "s"}`;

  return (
    <UICard
      title={title}
      icon="shield"
      sub={subText}
      flush
      action={
        <UIButton
          size="sm"
          variant="ghost"
          icon="refresh"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </UIButton>
      }
    >
      {loading && <CenteredNotice>Loading consents…</CenteredNotice>}
      {error && (
        <div style={{ padding: "0 20px 12px" }}>
          <ErrorBox>{error}</ErrorBox>
        </div>
      )}

      {!loading && !error && visible.length === 0 && (
        <div style={{ padding: 20 }}>
          <Empty
            icon="shield"
            title="No active consents"
            body="When a patient grants you access, their record list appears here."
          />
        </div>
      )}

      {visible.map((g) => (
        <DoctorConsentCard
          key={g.patient}
          grant={g}
          contracts={contracts}
          account={account}
          ensureDoctorKeypair={ensureDoctorKeypair}
          onAccessLogged={onAccessLogged}
          defaultOpen={!!expanded}
        />
      ))}

      {previewLimit && grants.length > previewLimit && (
        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid var(--line)",
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <button type="button" className="linkbtn" onClick={onViewAll}>
            View all {grants.length} consents{" "}
            <Icon name="arrowRight" size={12} />
          </button>
        </div>
      )}
    </UICard>
  );
}

function DoctorConsentCard({
  grant,
  contracts,
  account,
  ensureDoctorKeypair,
  onAccessLogged,
  defaultOpen,
}) {
  const [open, setOpen] = useState(!!defaultOpen);

  const grantedCategories = categoriesFromBitmap(grant.consent.categoryBitmap);
  const expiresAt = grant.consent.expiresAt;
  const isPermanent = expiresAt === 0;
  const daysLeft = isPermanent ? null : daysFromSeconds(expiresAt);

  return (
    <div style={{ padding: 18, borderBottom: "1px solid var(--line)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            background: "var(--brand-soft)",
            color: "var(--brand)",
            display: "grid",
            placeItems: "center",
            flex: "none",
          }}
        >
          <Icon name="user" size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 600,
              color: "var(--ink)",
              fontSize: 14,
            }}
          >
            {grant.patientName || shortAddr(grant.patient)}
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--ink-3)",
              display: "flex",
              gap: 8,
              alignItems: "center",
              marginTop: 2,
              flexWrap: "wrap",
            }}
          >
            <AddressDisplay address={grant.patient} />
            <span>·</span>
            <span>
              {grant.records.length} record
              {grant.records.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 11, color: "var(--ink-3)" }}>Expires</div>
            <div style={{ fontWeight: 600, fontSize: 13 }}>
              {isPermanent ? "permanent" : `${daysLeft}d`}
            </div>
          </div>
          <UIButton
            size="sm"
            variant="secondary"
            onClick={() => setOpen(!open)}
            iconRight={open ? "arrowDown" : "arrowRight"}
          >
            {open
              ? "Hide records"
              : `View ${grant.records.length} record${grant.records.length === 1 ? "" : "s"}`}
          </UIButton>
        </div>
      </div>
      <div
        style={{
          marginTop: 10,
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        {grantedCategories.map((c) => (
          <StatusPill key={c.value} status="brand">
            <Icon name={c.icon} size={11} style={{ marginRight: 2 }} />{" "}
            {c.label}
          </StatusPill>
        ))}
      </div>
      {open && (
        <div
          style={{
            marginTop: 14,
            background: "var(--surface-inset)",
            borderRadius: 10,
            border: "1px solid var(--line)",
          }}
        >
          {grant.records.length === 0 ? (
            <div style={{ padding: 16 }}>
              <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
                No records in the granted categories yet.
              </span>
            </div>
          ) : (
            <table className="table" style={{ background: "transparent" }}>
              <thead>
                <tr>
                  <th style={{ width: 70 }}>ID</th>
                  <th>Category</th>
                  <th>Uploaded</th>
                  <th style={{ width: 140, textAlign: "right" }} />
                </tr>
              </thead>
              <tbody>
                {grant.records.map((r) => (
                  <ViewRecordRow
                    key={r.recordId.toString()}
                    patient={grant.patient}
                    record={r}
                    contracts={contracts}
                    account={account}
                    ensureDoctorKeypair={ensureDoctorKeypair}
                    onAccessLogged={onAccessLogged}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * View-record row — REAL view+decrypt flow. UNCHANGED logic:
 *   1. healthRecordStorage.getRecordForDoctor(recordId, account) → tx (emits
 *      RecordAccessed / EmergencyRecordAccessed). Re-decode the return via
 *      callStatic to get the actual (cid, wrappedKeyBundle) tuple.
 *   2. ensureDoctorKeypair() → derived ECIES keypair (cached for session).
 *   3. findWrappedKeyForRecord(bundle, recordId) → my 93-byte wrap.
 *   4. unwrapKeyForSelf(wrap, kp.privateKey) → raw AES key.
 *   5. fetchEncrypted(cid) → encrypted payload from IPFS (multi-gateway fallback).
 *   6. decryptFile(ciphertext, aesKey, iv) → plaintext (AES-GCM, tag verifies).
 *   7. parseFilenameHeader → header + bytes; triggerDownload as file.
 */
function ViewRecordRow({
  onAccessLogged,
  patient,
  record,
  contracts,
  account,
  ensureDoctorKeypair,
}) {
  // null | "signing" | "fetching" | "unwrapping" | "decrypting" | "done"
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  const pending = status !== null && status !== "done";

  async function view() {
    setError(null);
    setStatus("signing");
    try {
      // ---- 1. getRecordForDoctor — non-view, emits RecordAccessed ----
      const tx = await contracts.healthRecordStorage.getRecordForDoctor(
        record.recordId,
        account
      );
      await tx.wait();

      // Pull the (cid, wrappedKey) return values out of the receipt.
      // getRecordForDoctor is non-view, so ethers v5 doesn't give us a
      // direct return value — but the RecordAccessed event confirms the
      // call landed, and we re-decode the call result via callStatic for
      // the actual return shape.
      const [cid, wrappedKeyHex] =
        await contracts.healthRecordStorage.callStatic.getRecordForDoctor(
          record.recordId,
          account
        );
      const bundle = ethers.utils.arrayify(wrappedKeyHex);

      // ---- 2. Find my entry in the bundle and unwrap it ----
      setStatus("unwrapping");
      const kp = await ensureDoctorKeypair();
      let myWrap;
      try {
        myWrap = findWrappedKeyForRecord(bundle, record.recordId);
      } catch (err) {
        throw new Error(
          `No access — wrapped key not found in bundle for record #${record.recordId}. ${err.message}`
        );
      }
      let rawAESKey;
      try {
        rawAESKey = unwrapKeyForSelf(myWrap, kp.privateKey);
      } catch {
        throw new Error(
          "Decrypt failed — likely wrong account or pubkey mismatch."
        );
      }

      // ---- 3. Fetch the encrypted blob from IPFS ----
      setStatus("fetching");
      let payload;
      try {
        payload = await fetchEncrypted(cid);
      } catch (err) {
        throw new Error(`IPFS fetch failed: ${err.message}`);
      }

      // Payload format: [iv (12) || ciphertext+tag (variable)]
      if (payload.length <= 12) {
        throw new Error("Encrypted payload is shorter than 12-byte IV header.");
      }
      const iv = payload.slice(0, 12);
      const ciphertextWithTag = payload.slice(12);

      // ---- 4. Decrypt ----
      setStatus("decrypting");
      const aesKey = await importRawKey(rawAESKey);
      let plaintext;
      try {
        plaintext = await decryptFile(ciphertextWithTag, aesKey, iv);
      } catch {
        throw new Error(
          "Decrypt failed — tag mismatch. The payload was tampered with, or the wrong key was used."
        );
      }

      // ---- 5. Recover filename header, trigger download ----
      const { header, bytes } = parseFilenameHeader(
        plaintext,
        `record-${record.recordId.toString()}`
      );
      triggerDownload(bytes, header.filename, header.mimetype);

      setStatus("done");
      // The getRecordForDoctor tx has already emitted RecordAccessed
      // (or EmergencyRecordAccessed) by the time we got here, so the
      // history feed is stale. Bump the parent's refresh key so it
      // re-fetches without the user having to click Refresh.
      onAccessLogged?.();
    } catch (err) {
      console.error("[viewRecord] failed:", err);
      const msg = describeError(err);
      // Categorise per spec.
      if (msg.includes("no consent") || msg.includes("no emergency access")) {
        setError(
          "No access — consent revoked, expired, or category mismatch."
        );
      } else if (msg.includes("Decrypt failed")) {
        setError(msg);
      } else if (msg.includes("IPFS fetch failed")) {
        setError(msg);
      } else if (msg.includes("rejected") || msg.includes("4001")) {
        setError("Transaction rejected by wallet.");
      } else {
        setError(msg);
      }
      setStatus(null);
    }
  }

  const buttonLabel = {
    signing: "Confirming access…",
    fetching: "Fetching from IPFS…",
    unwrapping: "Unwrapping key…",
    decrypting: "Decrypting…",
    done: "Downloaded ✓",
  }[status] || "View";

  return (
    <tr>
      <td className="num-cell">#{record.recordId.toString()}</td>
      <td>
        <StatusPill status="brand">
          <Icon
            name={categoryIcon(record.category)}
            size={11}
            style={{ marginRight: 2 }}
          />
          {categoryLabel(record.category)}
        </StatusPill>
      </td>
      <td style={{ color: "var(--ink-2)" }}>
        {timestampToRelative(bnToNumber(record.createdAt))}
      </td>
      <td style={{ textAlign: "right" }}>
        <UIButton
          size="sm"
          icon={status === "done" ? "check" : "eye"}
          onClick={view}
          disabled={pending}
          loading={pending}
        >
          {buttonLabel}
        </UIButton>
        {error && (
          <div
            style={{
              marginTop: 6,
              fontSize: 11.5,
              color: "var(--danger)",
              textAlign: "right",
              maxWidth: 280,
              marginLeft: "auto",
            }}
          >
            {error}
          </div>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------
// Access history timeline
// ---------------------------------------------------------------------

function AccessTimeline({ entries, loading, error }) {
  if (loading)
    return <CenteredNotice>Loading access history…</CenteredNotice>;
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
          body="When you view a patient's record, it appears here as your audit trail."
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
                <span>
                  {isEmg ? "Emergency access" : "Record accessed"}
                </span>
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
                <span>patient</span>
                <AddressDisplay address={e.patient} />
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
                      (no matching EmergencyAccessInvoked event found within
                      the audit window)
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
// Encryption-key view — REAL on-chain pubkey + matched/mismatch status
// ---------------------------------------------------------------------

function KeyView({
  onChainPubKey,
  keypairMismatch,
  ensureDoctorKeypair,
  haveDerivedKeypair,
  doctorProfile,
}) {
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState(null);

  async function verifyMatch() {
    setVerifyError(null);
    setVerifying(true);
    try {
      await ensureDoctorKeypair();
    } catch (err) {
      setVerifyError(describeError(err));
    } finally {
      setVerifying(false);
    }
  }

  // Status display: three states.
  //   1. We haven't derived the keypair yet → "Not verified" (action: derive)
  //   2. Derived and matches              → "Matched · derives identically"
  //   3. Derived and mismatches           → red emergency pill
  let statusPill;
  if (!haveDerivedKeypair) {
    statusPill = (
      <StatusPill status="pending">Not verified this session</StatusPill>
    );
  } else if (keypairMismatch) {
    statusPill = (
      <StatusPill status="emergency">Mismatch · re-register needed</StatusPill>
    );
  } else {
    statusPill = (
      <StatusPill status="active">Matched · derives identically</StatusPill>
    );
  }

  return (
    <UICard
      title="Encryption key"
      icon="key"
      sub="Published on‑chain. Non‑rotatable by contract design."
    >
      <div className="kv-grid">
        <div className="k">Algorithm</div>
        <div className="v">ECIES over secp256k1</div>

        <div className="k">Derivation</div>
        <div className="v">HKDF on deterministic signature</div>

        <div className="k">On‑chain pubkey</div>
        <div
          className="v font-mono"
          style={{
            wordBreak: "break-all",
            fontSize: 12,
            color: "var(--ink-2)",
          }}
        >
          {onChainPubKey || "—"}
        </div>

        <div className="k">Registered</div>
        <div className="v">
          {doctorProfile?.registeredAt
            ? formatTimestamp(doctorProfile.registeredAt)
            : "—"}
        </div>

        <div className="k">Hospital</div>
        <div className="v">{doctorProfile?.hospital || "—"}</div>

        <div className="k">Status</div>
        <div className="v">{statusPill}</div>
      </div>

      <hr
        style={{
          margin: "16px 0",
          border: "none",
          borderTop: "1px solid var(--line)",
        }}
      />

      <div style={{ fontSize: 12.5, color: "var(--ink-3)", lineHeight: 1.55 }}>
        If you ever connect with a different signer, you'll see a
        pubkey‑mismatch warning. Rotation requires the admin to revoke and
        re‑register you.
      </div>

      {!haveDerivedKeypair && (
        <div style={{ marginTop: 14 }}>
          <UIButton
            size="sm"
            icon="key"
            onClick={verifyMatch}
            loading={verifying}
            disabled={verifying}
          >
            {verifying
              ? "Deriving keypair…"
              : "Derive keypair to verify match"}
          </UIButton>
          <div
            style={{
              marginTop: 6,
              fontSize: 11.5,
              color: "var(--ink-3)",
            }}
          >
            Triggers a MetaMask signature on the canonical derivation
            message. Required once per session.
          </div>
        </div>
      )}

      {verifyError && <ErrorBox>{verifyError}</ErrorBox>}
    </UICard>
  );
}

// ---------------------------------------------------------------------
// Local primitives
// ---------------------------------------------------------------------

function ErrorBox({ children }) {
  return (
    <div
      role="alert"
      style={{
        marginTop: 12,
        padding: "10px 14px",
        borderRadius: 10,
        background: "var(--danger-soft)",
        color: "var(--danger)",
        fontSize: 13,
        fontWeight: 500,
        border:
          "1px solid color-mix(in oklch, var(--danger) 28%, transparent)",
      }}
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
