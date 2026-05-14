import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";

import { fetchEncrypted, getIPFSUrl } from "../utils/ipfs.js";
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

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

const CATEGORIES = [
  { value: 0, label: "General" },
  { value: 1, label: "Blood Test" },
  { value: 2, label: "Imaging" },
  { value: 3, label: "Prescription" },
  { value: 4, label: "Mental Health" },
  { value: 5, label: "Genetic" },
  { value: 6, label: "Other" },
];

const DEPLOY_BLOCK = ContractConfig.DEPLOY_BLOCK;
const QUERY_FILTER_LOOKBACK_BLOCKS = 49000;

const SIGNATURE_PROMPT_MESSAGE =
  "Your wallet will be asked to sign a fixed message. This derives a deterministic " +
  "encryption keypair from your wallet — MetaMask never exposes the underlying " +
  "private key. The derived public key is then published on-chain so patients " +
  "can wrap symmetric keys for you.";

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

function truncateAddress(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function categoryLabel(value) {
  if (value == null) return "";
  return CATEGORIES.find((c) => c.value === Number(value))?.label || String(value);
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

/**
 * Convert the on-chain 64-byte uncompressed pubkey (x || y, no prefix
 * byte) to the 33-byte compressed form expected by @noble curves.
 *   compressed[0] = 0x02 if y is even, 0x03 if y is odd
 *   compressed[1..33] = x
 */
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
// Component
// ---------------------------------------------------------------------

export default function DoctorDashboard({ contracts, account }) {
  const [isDoctor, setIsDoctor] = useState(null); // null = checking
  const [statusError, setStatusError] = useState(null);

  // Pubkey state — null = loading, "0x" = unpublished, otherwise hex string
  const [onChainPubKey, setOnChainPubKey] = useState(null);

  // Derived keypair (kept in memory ONLY — never persisted). Used for
  // every unwrap.
  const [doctorKeypair, setDoctorKeypair] = useState(null);
  const [keypairMismatch, setKeypairMismatch] = useState(false);

  // Bumped after every successful `View` tx so the "My Access History"
  // section re-fetches without requiring a manual Refresh click.
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const bumpHistory = useCallback(
    () => setHistoryRefreshKey((n) => n + 1),
    []
  );

  // ---- Initial fetch: role + pubkey ----

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
        const pk = await contracts.patientRegistry.getDoctorEncryptionPubKey(
          account
        );
        setOnChainPubKey(pk);
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

  // ---- Silent re-derive when pubkey is already published ----
  //
  // If a pubkey is already on-chain, we derive the keypair from the
  // signer once at mount and compare. MetaMask still pops a signature
  // prompt unless the user has explicitly cached it, but it only happens
  // once per session.

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

  // ---- Render gating ----

  if (isDoctor === null) {
    return <CenteredNotice>Checking registration…</CenteredNotice>;
  }

  return (
    <div className="space-y-8">
      <header>
        <h2 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
          Doctor Dashboard
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Connected as <AddressDisplay address={account} />
        </p>
      </header>

      {statusError && <ErrorBox>{statusError}</ErrorBox>}

      {!isDoctor && (
        <UICard title="Registration Status" tone="warning">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-900/20 dark:text-amber-200">
            Your address is not registered as a doctor. Please contact the
            admin to be registered.
          </div>
        </UICard>
      )}

      {/* Only render the CTA AFTER we've confirmed the pubkey is empty.
          `onChainPubKey !== null` rules out the loading state (initial
          null) so the CTA never flashes while the read is in flight. */}
      {isDoctor &&
        onChainPubKey !== null &&
        !isPubKeyPublished(onChainPubKey) && (
          <PublishPubKeyCTA
            contracts={contracts}
            account={account}
            onPublished={(publishedHex) => {
              // Immediate state transition: hide the CTA and reveal the
              // main UI without waiting for the parent's refreshStatus
              // to re-fetch. We trust the value we just wrote on-chain.
              if (publishedHex) setOnChainPubKey(publishedHex);
              // Still re-sync from the chain in the background so any
              // other state stays consistent.
              refreshStatus();
            }}
          />
        )}

      {isDoctor && isPubKeyPublished(onChainPubKey) && (
        <>
          {keypairMismatch && (
            <UICard tone="danger" padding="default">
              <p className="font-display font-semibold text-red-800 dark:text-red-300">
                Your wallet signature no longer matches your published
                encryption key.
              </p>
              <p className="mt-1 text-sm text-red-700 dark:text-red-300/90">
                Decryption will fail. Switch back to the original account or
                contact the admin to re-register you.
              </p>
            </UICard>
          )}

          <RequestAccessSection
            contracts={contracts}
            account={account}
          />

          <MyActiveConsentsSection
            contracts={contracts}
            account={account}
            ensureDoctorKeypair={ensureDoctorKeypair}
            onAccessLogged={bumpHistory}
          />

          <MyAccessHistorySection
            contracts={contracts}
            account={account}
            refreshKey={historyRefreshKey}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// "Publish your encryption key" CTA
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
      // (Phase 2C bug-fix removed that require). See crypto.js
      // deriveECIESKeypairFromSigner for the derivation rationale.
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
      // cases. Arrayify converts to bytes and checks the byte length.
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

  const buttonLabel = {
    deriving: "Deriving keypair (MetaMask sign)…",
    signing: "Waiting for wallet…",
    confirming: "Confirming transaction…",
    verifying: "Verifying on-chain…",
  }[status] || "Publish My Encryption Key";

  return (
    <UICard title="Publish Your Encryption Key (one-time)" tone="warning">
      <p className="mb-2 text-sm text-slate-700 dark:text-slate-300">
        Before any patient can grant you access, you need to publish a
        public encryption key on-chain.
      </p>
      <p className="mb-4 text-xs text-slate-500 dark:text-slate-400">
        {SIGNATURE_PROMPT_MESSAGE}
      </p>
      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-900/20 dark:text-amber-200">
        <strong>One-time, non-rotatable.</strong> The contract rejects later
        attempts to overwrite your published key. If you ever need to rotate,
        the admin must revoke and re-register you.
      </div>

      <PrimaryButton onClick={publish} disabled={pending}>
        {pending ? <Spinner /> : null}
        {buttonLabel}
      </PrimaryButton>

      {txHash && (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          Tx: <span className="font-mono">{txHash}</span>
        </p>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
    </UICard>
  );
}

// ---------------------------------------------------------------------
// Request access from a patient
// ---------------------------------------------------------------------

function RequestAccessSection({ contracts, account }) {
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
    } catch (err) {
      console.error("requestAccess failed:", err);
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card title="Request Access from a Patient">
      <form
        onSubmit={submit}
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
      >
        <div className="flex-1">
          <label className="mb-1 block text-xs font-medium text-slate-700">
            Patient wallet address
          </label>
          <input
            type="text"
            value={patient}
            onChange={(e) => setPatient(e.target.value)}
            disabled={pending}
            placeholder="0x…"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-100"
          />
        </div>
        <PrimaryButton type="submit" disabled={pending}>
          {pending ? <Spinner /> : null}
          {pending ? "Requesting…" : "Request Access"}
        </PrimaryButton>
      </form>
      {txHash && (
        <SuccessBox>
          Request submitted. Tx:{" "}
          <span className="font-mono text-xs">{txHash}</span>
        </SuccessBox>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
    </Card>
  );
}

// ---------------------------------------------------------------------
// "My active consents" — patients who granted me access
// ---------------------------------------------------------------------

function MyActiveConsentsSection({
  contracts,
  account,
  ensureDoctorKeypair,
  onAccessLogged,
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Array of { patient, consent: { isActive, expiresAt, categoryBitmap }, records: [{recordId, category}] }
  const [grants, setGrants] = useState([]);

  const reload = useCallback(async () => {
    if (
      !contracts?.consentManager ||
      !contracts?.healthRecordStorage ||
      !account
    ) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Find all patients who ever granted me access (indexed event filter
      // by `doctor`). Bound the lookback so Alchemy's eth_getLogs window
      // never gets blown.
      const provider = contracts.consentManager.provider;
      const latest = await provider.getBlockNumber();
      const fromBlock =
        DEPLOY_BLOCK ??
        Math.max(0, latest - QUERY_FILTER_LOOKBACK_BLOCKS);

      const filter = contracts.consentManager.filters.AccessGranted(
        null,
        account
      );
      const events = await contracts.consentManager.queryFilter(
        filter,
        fromBlock,
        "latest"
      );
      const uniquePatients = [
        ...new Set(events.map((e) => e.args.patient)),
      ];

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
          });
        }
        out.push({
          patient,
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
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [contracts, account]);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <Card title="My Active Consents">
      <div className="mb-3 flex justify-end">
        <SecondaryButton size="sm" onClick={reload} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </SecondaryButton>
      </div>

      {loading && <CenteredNotice>Loading consents…</CenteredNotice>}
      {error && <ErrorBox>{error}</ErrorBox>}

      {!loading && grants.length === 0 && !error && (
        <p className="text-sm text-slate-500">
          No patients have granted you access yet.
        </p>
      )}

      <ul className="divide-y divide-slate-100">
        {grants.map((g) => (
          <GrantBlock
            key={g.patient}
            grant={g}
            contracts={contracts}
            account={account}
            ensureDoctorKeypair={ensureDoctorKeypair}
            onAccessLogged={onAccessLogged}
          />
        ))}
      </ul>
    </Card>
  );
}

function GrantBlock({
  grant,
  contracts,
  account,
  ensureDoctorKeypair,
  onAccessLogged,
}) {
  const grantedCategories = categoriesFromBitmap(grant.consent.categoryBitmap);
  const expiresAt = grant.consent.expiresAt;

  return (
    <li className="py-4">
      <div className="mb-2 flex flex-wrap items-baseline gap-3">
        <span className="font-mono text-sm text-slate-700">
          {truncateAddress(grant.patient)}
        </span>
        <span className="text-xs text-slate-500">
          {expiresAt === 0
            ? "permanent"
            : `expires ${formatTimestamp(expiresAt)}`}
        </span>
        <div className="flex flex-wrap gap-1">
          {grantedCategories.map((c) => (
            <span
              key={c.value}
              className="rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-700 dark:bg-brand-900/30 dark:text-brand-300"
            >
              {c.label}
            </span>
          ))}
        </div>
      </div>

      {grant.records.length === 0 ? (
        <p className="text-xs text-slate-400">
          No records in the granted categories yet.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2">ID</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
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
        </div>
      )}
    </li>
  );
}

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
      const receipt = await tx.wait();

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
    signing: "Confirming access (logged)…",
    fetching: "Fetching from IPFS…",
    unwrapping: "Unwrapping key…",
    decrypting: "Decrypting…",
    done: "Downloaded ✓",
  }[status] || "View";

  return (
    <tr>
      <td className="px-3 py-2 font-mono text-xs text-slate-700">
        #{record.recordId.toString()}
      </td>
      <td className="px-3 py-2">{categoryLabel(record.category)}</td>
      <td className="px-3 py-2 text-right">
        <PrimaryButton size="sm" onClick={view} disabled={pending}>
          {pending ? <Spinner /> : null}
          {buttonLabel}
        </PrimaryButton>
        {error && (
          <div className="mt-1 text-right text-xs text-red-700">{error}</div>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------
// Shared UI primitives
// ---------------------------------------------------------------------

function Card({ title, children, ...rest }) {
  return (
    <UICard title={title} {...rest}>
      {children}
    </UICard>
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
// My Access History (Phase 5)
// ---------------------------------------------------------------------

/**
 * Doctor's own audit trail — every record this doctor has read,
 * normal or emergency. Mirror of Phase 4's PatientDashboard
 * AccessHistorySection but filtered by `doctor=account` instead of
 * `patient=account`. Same three event streams, same correlation
 * between EmergencyRecordAccessed and EmergencyAccessInvoked for the
 * justification text.
 *
 * Category enrichment uses Option A: for each unique recordId in the
 * combined access list, call HealthRecordStorage.getRecord(id) once
 * and pluck `.category`. With Hardhat test data this is a handful of
 * extra calls; for larger chains, switch to Option B (read RecordStored
 * events unfiltered, build a global map).
 *
 * The parent passes `refreshKey` — bumped after every successful View
 * tx — so the feed auto-refreshes without the user clicking Refresh.
 */
function MyAccessHistorySection({ contracts, account, refreshKey }) {
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

      // Three reads in parallel.
      //
      // RecordAccessed         (patient, doctor, recordId)  ← filter by doctor
      // EmergencyRecordAccessed(patient, doctor, recordId)  ← filter by doctor
      // EmergencyAccessInvoked (doctor,  patient)           ← filter by doctor
      //
      // Phase 4 documented the actual contract signatures (patient
      // first on HRS events, doctor first on CM events) — reusing
      // that resolution here.
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
      // Unique recordIds across both access streams. Then fetch each
      // record's category in parallel via getRecord(recordId).
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
            // been revoked. Leave the map entry unset; the row will
            // render "Unknown".
            console.error(
              `[history/doctor] getRecord(${idStr}) failed:`,
              err?.message || err
            );
          }
        })
      );

      // ---- Justification lookup for emergency rows ----
      // Same correlation as Phase 4: for an EmergencyRecordAccessed at
      // time T, the justification is the most recent
      // EmergencyAccessInvoked from this doctor against the same
      // patient with timestamp <= T.
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
        setError(
          "Partial history — some older events may be missing. Click Refresh to retry."
        );
      }

      setEntries(merged);
    } catch (err) {
      console.error("[history/doctor] load failed:", err);
      setError(describeError(err));
      setEntries([]);
    } finally {
      setRefreshing(false);
    }
  }, [contracts, account]);

  // Refresh on mount, on account change, and on every bump from the
  // parent (triggered by successful View clicks).
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  return (
    <Card title="My Access History">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-3xl text-sm text-slate-600">
          Every record you've read is logged on-chain — both normal
          (consent-backed) and emergency (break-glass). This is your own
          activity log; patients see the mirror of it on their side.
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
          No access history yet. When you view a patient's record, it
          will appear here as an audit trail of your activity.
        </p>
      )}

      {entries && entries.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {entries.map((e) => (
            <MyAccessHistoryRow key={e.key} entry={e} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function MyAccessHistoryRow({ entry }) {
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
          <AddressDisplay address={entry.patient} />
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
              (no matching EmergencyAccessInvoked event found in the
              audit window)
            </span>
          )}
        </div>
      )}
    </li>
  );
}
