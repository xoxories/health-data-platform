import { useCallback, useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";

import * as ContractConfig from "../config/contract.js";
import {
  readEventsChunked,
  shortAddr,
  shortHex,
  timestampToRelative,
  toNumberSafe,
} from "../utils/events.js";

import { Card as UICard } from "./ui/Card.jsx";
import { Button as UIButton } from "./ui/Button.jsx";
import { StatusPill } from "./ui/StatusPill.jsx";
import { AddressDisplay } from "./ui/AddressDisplay.jsx";
import { StatusPipeline } from "./ui/StatusPipeline.jsx";

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

const DEPLOY_BLOCK = ContractConfig.DEPLOY_BLOCK ?? 0;

const MAX_LICENSE_LEN = 100;
const MAX_HOSPITAL_LEN = 100;
const MAX_REASON_LEN = 200;

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function describeError(err) {
  return (
    err?.reason ||
    err?.error?.data?.message ||
    err?.error?.message ||
    err?.data?.message ||
    err?.message ||
    "Unexpected error"
  );
}

function isAddrLike(s) {
  if (typeof s !== "string" || s.length === 0) return false;
  return ethers.utils.isAddress(s);
}

function checksum(addr) {
  try {
    return ethers.utils.getAddress(addr);
  } catch {
    return null;
  }
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.error("[clipboard]", err);
    return false;
  }
}

function formatAbsolute(unixSeconds) {
  const s = toNumberSafe(unixSeconds);
  if (!s) return "";
  return new Date(s * 1000).toLocaleString();
}

// ---------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------

export default function AdminPanel({ account, contracts }) {
  const registryAvailable = Boolean(contracts?.patientRegistry);
  const storageAvailable = Boolean(contracts?.healthRecordStorage);
  const consentAvailable = Boolean(contracts?.consentManager);

  const [refreshCount, setRefreshCount] = useState(0);
  const refreshAll = useCallback(() => setRefreshCount((n) => n + 1), []);

  if (!registryAvailable) {
    return (
      <UICard>
        <h2 className="mb-1 font-display text-2xl font-bold text-slate-900 dark:text-slate-50">
          Admin Panel
        </h2>
        <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
          Connected as <AddressDisplay address={account} />
        </p>
        <ErrorBox>
          PatientRegistry contract is not available. Check that contract
          addresses in{" "}
          <span className="font-mono">frontend/src/config/contract.js</span>{" "}
          are set and that MetaMask is on the correct network.
        </ErrorBox>
      </UICard>
    );
  }

  return (
    <div className="space-y-8">
      {/* 1. Header */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            Admin Panel
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Connected as <AddressDisplay address={account} />
          </p>
          <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Contract Owner
          </span>
        </div>
        <SecondaryButton onClick={refreshAll}>Refresh</SecondaryButton>
      </header>

      {/* 2. System stats */}
      <SystemStats
        contracts={contracts}
        refreshKey={refreshCount}
      />

      {/* 3. Register new doctor */}
      <RegisterDoctorCard
        contracts={contracts}
        adminAccount={account}
        onRegistered={refreshAll}
      />

      {/* 4. Registered doctors table */}
      <RegisteredDoctorsTable
        contracts={contracts}
        refreshKey={refreshCount}
        onRevoked={refreshAll}
      />

      {/* 5. Emergency access audit feed */}
      {consentAvailable && (
        <EmergencyAccessFeed
          contracts={contracts}
          refreshKey={refreshCount}
        />
      )}

      {/* 6. Recent activity feed */}
      {storageAvailable && consentAvailable && (
        <RecentActivityFeed
          contracts={contracts}
          refreshKey={refreshCount}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// 2. System stats
// ---------------------------------------------------------------------

function SystemStats({ contracts, refreshKey }) {
  const [stats, setStats] = useState({
    patients: null,
    activeDoctors: null,
    revokedDoctors: null,
    records: null,
  });
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    setStats({
      patients: null,
      activeDoctors: null,
      revokedDoctors: null,
      records: null,
    });
    try {
      const reg = contracts.patientRegistry;
      const storage = contracts.healthRecordStorage;

      // Read in parallel — three chunked event scans.
      const [patientsRes, doctorsRes, recordsRes] = await Promise.all([
        readEventsChunked(
          reg,
          reg.filters.PatientRegistered(),
          DEPLOY_BLOCK,
          "latest"
        ),
        readEventsChunked(
          reg,
          reg.filters.DoctorRegistered(),
          DEPLOY_BLOCK,
          "latest"
        ),
        storage
          ? readEventsChunked(
              storage,
              storage.filters.RecordStored(),
              DEPLOY_BLOCK,
              "latest"
            )
          : Promise.resolve({ events: [], partial: false }),
      ]);

      // Unique patients = unique `patient` topic.
      const patientAddrs = new Set(
        patientsRes.events.map((e) => e.args.patient.toLowerCase())
      );
      // Unique doctor addresses ever registered.
      const doctorAddrs = [
        ...new Set(doctorsRes.events.map((e) => e.args.doctor.toLowerCase())),
      ];
      // For each, fetch current active state via getDoctorInfo (state may
      // have changed since the registration event — don't trust the event
      // payload alone).
      const infos = await Promise.all(
        doctorAddrs.map((a) => reg.getDoctorInfo(a))
      );
      let active = 0;
      let revoked = 0;
      for (const info of infos) {
        if (info.isActive) active += 1;
        else revoked += 1;
      }

      if (
        patientsRes.partial ||
        doctorsRes.partial ||
        recordsRes.partial
      ) {
        setError(
          "Partial data — chunk limit reached. Click Refresh to retry."
        );
      }

      setStats({
        patients: patientAddrs.size,
        activeDoctors: active,
        revokedDoctors: revoked,
        records: recordsRes.events.length,
      });
    } catch (err) {
      console.error("[admin/stats] load failed:", err);
      setError(describeError(err));
    }
  }, [contracts]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  return (
    <section>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Patients Registered" value={stats.patients} />
        <StatCard label="Active Doctors" value={stats.activeDoctors} />
        <StatCard label="Revoked Doctors" value={stats.revokedDoctors} />
        <StatCard label="Total Records Uploaded" value={stats.records} />
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
    </section>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md dark:border-slate-800 dark:bg-surface-darkAlt">
      <div className="font-display text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
        {value == null ? "—" : value}
      </div>
      <div className="mt-1 text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// 3. Register new doctor
// ---------------------------------------------------------------------

function RegisterDoctorCard({ contracts, adminAccount, onRegistered }) {
  const [doctorAddr, setDoctorAddr] = useState("");
  const [doctorAddrError, setDoctorAddrError] = useState("");
  const [license, setLicense] = useState("");
  const [hospital, setHospital] = useState("");

  // null | "validating" | "signing" | "confirming" | "done"
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const pending = status !== null && status !== "done";

  const licenseHash = useMemo(() => {
    if (!license) return "";
    return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(license));
  }, [license]);

  const valid =
    isAddrLike(doctorAddr) &&
    license.trim().length > 0 &&
    license.trim().length <= MAX_LICENSE_LEN &&
    hospital.trim().length > 0 &&
    hospital.trim().length <= MAX_HOSPITAL_LEN &&
    !doctorAddrError;

  function validateAddrOnBlur() {
    if (!doctorAddr) {
      setDoctorAddrError("");
      return;
    }
    if (!isAddrLike(doctorAddr)) {
      setDoctorAddrError("Not a valid Ethereum address.");
      return;
    }
    if (doctorAddr.toLowerCase() === adminAccount.toLowerCase()) {
      setDoctorAddrError("This is your admin address — pick a different one.");
      return;
    }
    setDoctorAddrError("");
  }

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (!valid) {
      setError("Please fix the form errors above before submitting.");
      return;
    }
    const reg = contracts.patientRegistry;

    let phase = "validating";
    try {
      setStatus("validating");

      const checksummed = checksum(doctorAddr);
      if (!checksummed) throw new Error("Address failed checksum normalization.");

      // Pre-flight: not already a doctor and not already a patient.
      const [alreadyDoctor, alreadyPatient] = await Promise.all([
        reg.isDoctor(checksummed),
        reg.isPatient(checksummed),
      ]);
      if (alreadyDoctor) {
        throw new Error("Address is already registered as a doctor.");
      }
      if (alreadyPatient) {
        throw new Error("Address is already registered as a patient.");
      }

      phase = "signing";
      setStatus("signing");
      const tx = await reg.registerDoctor(
        checksummed,
        licenseHash,
        hospital.trim()
      );

      phase = "confirming";
      setStatus("confirming");
      await tx.wait();

      setSuccess({
        address: checksummed,
        hospital: hospital.trim(),
        txHash: tx.hash,
      });

      // Clear the form.
      setDoctorAddr("");
      setLicense("");
      setHospital("");
      setStatus("done");

      // Refresh the doctor table and stats.
      onRegistered();

      // Reset the "done" sticky state after a brief moment so the button
      // re-enables for the next registration.
      setTimeout(() => setStatus(null), 400);
    } catch (err) {
      console.error(`[admin/registerDoctor] failed (phase: ${phase}):`, err);
      setError(describeError(err));
      setStatus(null);
    }
  }

  const buttonLabel =
    {
      validating: "Validating…",
      signing: "Waiting for wallet…",
      confirming: "Confirming transaction…",
      done: "Registered ✓",
    }[status] || "Register Doctor";

  return (
    <Card title="Register New Doctor">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">
            Doctor address
          </label>
          <input
            type="text"
            value={doctorAddr}
            onChange={(e) => {
              setDoctorAddr(e.target.value);
              if (doctorAddrError) setDoctorAddrError("");
            }}
            onBlur={validateAddrOnBlur}
            disabled={pending}
            placeholder="0x…"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-100"
          />
          {doctorAddrError && (
            <p className="mt-1 text-xs text-red-700">{doctorAddrError}</p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">
            License number
            <span className="ml-1 text-slate-400">
              (hashed client-side; raw value never reaches the chain)
            </span>
          </label>
          <input
            type="text"
            value={license}
            onChange={(e) => setLicense(e.target.value)}
            disabled={pending}
            maxLength={MAX_LICENSE_LEN}
            placeholder="LICENSE-MD-12345"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-100"
          />
          {licenseHash && (
            <p className="mt-1 break-all font-mono text-[10px] text-slate-500">
              keccak256 → {licenseHash}
            </p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">
            Hospital affiliation
          </label>
          <input
            type="text"
            value={hospital}
            onChange={(e) => setHospital(e.target.value)}
            disabled={pending}
            maxLength={MAX_HOSPITAL_LEN}
            placeholder="e.g. Cardiology Specialists"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-100"
          />
        </div>

        <PrimaryButton type="submit" disabled={pending || !valid}>
          {pending ? <Spinner /> : null}
          {buttonLabel}
        </PrimaryButton>
      </form>

      {success && (
        <SuccessBox>
          Registered <span className="font-mono">{shortAddr(success.address)}</span>{" "}
          at {success.hospital}.
          <div className="mt-1 break-all font-mono text-xs">
            tx: {success.txHash}
          </div>
        </SuccessBox>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
    </Card>
  );
}

// ---------------------------------------------------------------------
// 4. Registered doctors table + revoke modal
// ---------------------------------------------------------------------

function RegisteredDoctorsTable({ contracts, refreshKey, onRevoked }) {
  const [rows, setRows] = useState(null); // null = loading, [] = empty
  const [error, setError] = useState(null);
  const [revokeTarget, setRevokeTarget] = useState(null); // row being revoked

  const load = useCallback(async () => {
    setError(null);
    setRows(null);
    try {
      const reg = contracts.patientRegistry;
      const [registeredRes, revokedRes] = await Promise.all([
        readEventsChunked(
          reg,
          reg.filters.DoctorRegistered(),
          DEPLOY_BLOCK,
          "latest"
        ),
        readEventsChunked(
          reg,
          reg.filters.DoctorRevoked(),
          DEPLOY_BLOCK,
          "latest"
        ),
      ]);

      // Latest revocation reason per address.
      const revokedMap = new Map();
      for (const ev of revokedRes.events) {
        revokedMap.set(ev.args.doctor.toLowerCase(), {
          reason: ev.args.reason,
          timestamp: toNumberSafe(ev.args.timestamp),
        });
      }

      // Latest registration per address (in case re-registration is
      // ever allowed — we keep the most recent timestamp).
      const regMap = new Map();
      for (const ev of registeredRes.events) {
        const key = ev.args.doctor.toLowerCase();
        const ts = toNumberSafe(ev.args.timestamp);
        const prev = regMap.get(key);
        if (!prev || ts > prev.timestamp) {
          regMap.set(key, {
            doctor: ev.args.doctor,
            licenseHash: ev.args.licenseHash,
            hospitalAffiliation: ev.args.hospitalAffiliation,
            timestamp: ts,
          });
        }
      }

      const addresses = [...regMap.values()];
      // For each, fetch current state via getDoctorInfo (truth is the
      // mapping, not the event payload).
      const infos = await Promise.all(
        addresses.map((a) => reg.getDoctorInfo(a.doctor))
      );

      const merged = addresses.map((evRow, i) => {
        const info = infos[i];
        const revInfo = revokedMap.get(evRow.doctor.toLowerCase()) || null;
        return {
          address: evRow.doctor,
          hospital: info.hospitalAffiliation || evRow.hospitalAffiliation,
          licenseHash: info.licenseHash || evRow.licenseHash,
          registeredAt: evRow.timestamp,
          isActive: info.isActive,
          revocation: info.isActive ? null : revInfo,
        };
      });

      // Newest registration first.
      merged.sort((a, b) => b.registeredAt - a.registeredAt);

      if (registeredRes.partial || revokedRes.partial) {
        setError(
          "Partial data — chunk limit reached. Click Refresh to retry."
        );
      }

      setRows(merged);
    } catch (err) {
      console.error("[admin/doctors] load failed:", err);
      setError(describeError(err));
      setRows([]);
    }
  }, [contracts]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  return (
    <Card title="Registered Doctors">
      {error && <ErrorBox>{error}</ErrorBox>}

      {rows === null && <CenteredNotice>Loading doctors…</CenteredNotice>}

      {rows && rows.length === 0 && !error && (
        <p className="text-sm text-slate-500">
          No doctors registered yet. Use the form above to register the
          first one.
        </p>
      )}

      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-800">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2">Address</th>
                <th className="px-3 py-2">Hospital</th>
                <th className="px-3 py-2">License hash</th>
                <th className="px-3 py-2">Registered</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white dark:divide-slate-800 dark:bg-surface-darkAlt">
              {rows.map((r) => (
                <DoctorRow
                  key={r.address}
                  row={r}
                  onRevokeClick={() => setRevokeTarget(r)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {revokeTarget && (
        <RevokeDoctorModal
          row={revokeTarget}
          contracts={contracts}
          onClose={() => setRevokeTarget(null)}
          onRevoked={() => {
            setRevokeTarget(null);
            onRevoked();
          }}
        />
      )}
    </Card>
  );
}

function DoctorRow({ row, onRevokeClick }) {
  const [copyMsg, setCopyMsg] = useState(null);

  async function copy(text) {
    const ok = await copyToClipboard(text);
    setCopyMsg(ok ? "Copied!" : "Copy failed");
    setTimeout(() => setCopyMsg(null), 1200);
  }

  return (
    <tr className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
      <td className="px-3 py-3">
        <AddressDisplay address={row.address} />
      </td>
      <td className="px-3 py-3 text-slate-700 dark:text-slate-300">
        {row.hospital || "—"}
      </td>
      <td className="px-3 py-3">
        <button
          type="button"
          onClick={() => copy(row.licenseHash)}
          title={row.licenseHash}
          className="font-mono text-xs text-slate-500 underline-offset-2 hover:underline dark:text-slate-400"
        >
          {shortHex(row.licenseHash)}
        </button>
        {copyMsg && (
          <span className="ml-2 text-[10px] text-emerald-700 dark:text-emerald-400">
            {copyMsg}
          </span>
        )}
      </td>
      <td className="px-3 py-3 text-slate-600 dark:text-slate-400">
        {formatAbsolute(row.registeredAt)}
      </td>
      <td className="px-3 py-3">
        {row.isActive ? (
          <StatusPill status="active" />
        ) : (
          <div>
            <StatusPill status="revoked" />
            {row.revocation?.reason && (
              <div className="mt-1 max-w-xs text-[11px] italic text-slate-500 dark:text-slate-400">
                {row.revocation.reason}
              </div>
            )}
          </div>
        )}
      </td>
      <td className="px-3 py-3 text-right">
        {row.isActive ? (
          <DangerButton size="sm" onClick={onRevokeClick}>
            Revoke
          </DangerButton>
        ) : (
          <DangerButton size="sm" disabled>
            Revoke
          </DangerButton>
        )}
      </td>
    </tr>
  );
}

function RevokeDoctorModal({ row, contracts, onClose, onRevoked }) {
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState(null); // null | "signing" | "confirming"
  const [error, setError] = useState(null);
  const pending = status !== null;

  async function confirm() {
    setError(null);
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      setError("Please provide a revocation reason.");
      return;
    }
    if (trimmed.length > MAX_REASON_LEN) {
      setError(`Reason is too long (max ${MAX_REASON_LEN} characters).`);
      return;
    }

    try {
      setStatus("signing");
      const tx = await contracts.patientRegistry.revokeDoctor(
        row.address,
        trimmed
      );
      setStatus("confirming");
      await tx.wait();
      onRevoked();
    } catch (err) {
      console.error("[admin/revokeDoctor] failed:", err);
      setError(describeError(err));
      setStatus(null);
    }
  }

  const buttonLabel =
    {
      signing: "Waiting for wallet…",
      confirming: "Confirming…",
    }[status] || "Revoke";

  return (
    <ModalOverlay onClose={pending ? undefined : onClose}>
      <h3 className="mb-3 font-display text-lg font-bold text-slate-900 dark:text-slate-50">
        Revoke doctor access
      </h3>
      <p className="mb-4 text-sm text-slate-700">
        Doctor <span className="font-mono">{shortAddr(row.address)}</span> at{" "}
        <strong>{row.hospital || "—"}</strong> will lose the DOCTOR_ROLE.
        All existing patient grants for this doctor become unenforceable.
        This cannot be undone — to re-enable, the doctor must be
        registered again with a new license hash.
      </p>

      <label className="mb-1 block text-xs font-medium text-slate-700">
        Revocation reason{" "}
        <span className="text-slate-400">
          ({MAX_REASON_LEN} chars max — visible in the on-chain event log)
        </span>
      </label>
      <textarea
        rows={3}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={pending}
        maxLength={MAX_REASON_LEN + 1 /* allow visual hint of overflow */}
        className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-100"
      />
      <p className="mt-1 text-[11px] text-slate-400">
        {reason.length}/{MAX_REASON_LEN}
      </p>

      <div className="mt-5 flex justify-end gap-2">
        <SecondaryButton onClick={onClose} disabled={pending}>
          Cancel
        </SecondaryButton>
        <DangerButton onClick={confirm} disabled={pending}>
          {pending ? <Spinner /> : null}
          {buttonLabel}
        </DangerButton>
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
    </ModalOverlay>
  );
}

// ---------------------------------------------------------------------
// 5. Emergency access audit feed
// ---------------------------------------------------------------------

function EmergencyAccessFeed({ contracts, refreshKey }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    setRows(null);
    try {
      const cm = contracts.consentManager;
      const res = await readEventsChunked(
        cm,
        cm.filters.EmergencyAccessInvoked(),
        DEPLOY_BLOCK,
        "latest"
      );
      const mapped = res.events
        .map((e) => ({
          doctor: e.args.doctor,
          patient: e.args.patient,
          reason: e.args.reason,
          timestamp: toNumberSafe(e.args.timestamp),
          blockNumber: e.blockNumber,
        }))
        .sort((a, b) => b.timestamp - a.timestamp);

      if (res.partial) {
        setError(
          "Partial data — chunk limit reached. Click Refresh to retry."
        );
      }
      setRows(mapped);
    } catch (err) {
      console.error("[admin/emergency] load failed:", err);
      setError(describeError(err));
      setRows([]);
    }
  }, [contracts]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  return (
    <Card title="Emergency Access Audit">
      <p className="mb-4 text-sm text-slate-600">
        Emergency access (a.k.a. <em>break-glass</em>) lets a registered
        doctor read a patient's records without explicit consent — for
        cases like an unconscious patient in the ER. Every invocation is
        permanently logged on-chain with the doctor's stated
        justification and surfaces here. This is the audit trail the
        platform's threat model relies on: privacy is not absolute, but
        every override is observable, attributable, and reviewable after
        the fact.
      </p>

      {error && <ErrorBox>{error}</ErrorBox>}
      {rows === null && <CenteredNotice>Loading audit feed…</CenteredNotice>}

      {rows && rows.length === 0 && !error && (
        <p className="text-sm text-slate-500">
          No emergency access has been invoked. This is the break-glass
          audit trail — any time a doctor accesses a record without
          explicit consent (e.g. life-threatening emergency), it will
          appear here with the justification they provided.
        </p>
      )}

      {rows && rows.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {rows.map((r, i) => (
            <li key={`${r.blockNumber}-${i}`} className="py-3">
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-xs">
                <div className="space-x-2">
                  <span className="text-slate-500">Doctor</span>
                  <CopyableAddr addr={r.doctor} />
                  <span className="text-slate-500">→ Patient</span>
                  <CopyableAddr addr={r.patient} />
                </div>
                <span
                  className="text-slate-400"
                  title={formatAbsolute(r.timestamp)}
                >
                  {timestampToRelative(r.timestamp)}
                </span>
              </div>
              <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <span className="text-xs font-semibold uppercase text-amber-700">
                  Justification
                </span>
                <div className="mt-1 whitespace-pre-wrap break-words">
                  {r.reason}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------
// 6. Recent activity feed
// ---------------------------------------------------------------------

function RecentActivityFeed({ contracts, refreshKey }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const MAX_ROWS = 20;

  const load = useCallback(async () => {
    setError(null);
    setRows(null);
    try {
      const cm = contracts.consentManager;
      const storage = contracts.healthRecordStorage;

      const [grantedRes, revokedRes, storedRes] = await Promise.all([
        readEventsChunked(
          cm,
          cm.filters.AccessGranted(),
          DEPLOY_BLOCK,
          "latest"
        ),
        readEventsChunked(
          cm,
          cm.filters.AccessRevoked(),
          DEPLOY_BLOCK,
          "latest"
        ),
        readEventsChunked(
          storage,
          storage.filters.RecordStored(),
          DEPLOY_BLOCK,
          "latest"
        ),
      ]);

      const merged = [
        ...grantedRes.events.map((e) => ({
          kind: "granted",
          timestamp: toNumberSafe(e.args.timestamp),
          patient: e.args.patient,
          doctor: e.args.doctor,
          key: `g-${e.blockNumber}-${e.logIndex}`,
        })),
        ...revokedRes.events.map((e) => ({
          kind: "revoked",
          timestamp: toNumberSafe(e.args.timestamp),
          patient: e.args.patient,
          doctor: e.args.doctor,
          key: `r-${e.blockNumber}-${e.logIndex}`,
        })),
        ...storedRes.events.map((e) => ({
          kind: "stored",
          timestamp: toNumberSafe(e.args.timestamp),
          patient: e.args.patient,
          recordId: e.args.recordId?.toString?.() ?? String(e.args.recordId),
          key: `s-${e.blockNumber}-${e.logIndex}`,
        })),
      ];
      merged.sort((a, b) => b.timestamp - a.timestamp);

      if (grantedRes.partial || revokedRes.partial || storedRes.partial) {
        setError(
          "Partial data — chunk limit reached. Click Refresh to retry."
        );
      }
      setRows(merged.slice(0, MAX_ROWS));
    } catch (err) {
      console.error("[admin/activity] load failed:", err);
      setError(describeError(err));
      setRows([]);
    }
  }, [contracts]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  return (
    <Card title="Recent Activity">
      {error && <ErrorBox>{error}</ErrorBox>}
      {rows === null && <CenteredNotice>Loading activity…</CenteredNotice>}

      {rows && rows.length === 0 && !error && (
        <p className="text-sm text-slate-500">No recent activity.</p>
      )}

      {rows && rows.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {rows.map((r) => (
            <li
              key={r.key}
              className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm"
            >
              <div className="flex items-baseline gap-2">
                {r.kind === "granted" && (
                  <span className="rounded bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-800">
                    Granted
                  </span>
                )}
                {r.kind === "revoked" && (
                  <span className="rounded bg-rose-50 px-2 py-0.5 text-[10px] font-bold uppercase text-rose-800">
                    Revoked
                  </span>
                )}
                {r.kind === "stored" && (
                  <span className="rounded bg-brand-50 px-2 py-0.5 text-[10px] font-bold uppercase text-brand-800 dark:bg-brand-900/30 dark:text-brand-300">
                    Stored
                  </span>
                )}
                {r.kind === "stored" ? (
                  <span className="text-slate-700">
                    record <span className="font-mono">#{r.recordId}</span> by{" "}
                    <CopyableAddr addr={r.patient} />
                  </span>
                ) : (
                  <span className="text-slate-700">
                    <CopyableAddr addr={r.patient} /> ↔{" "}
                    <CopyableAddr addr={r.doctor} />
                  </span>
                )}
              </div>
              <span
                className="text-xs text-slate-400"
                title={formatAbsolute(r.timestamp)}
              >
                {timestampToRelative(r.timestamp)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------
// Shared UI primitives
// ---------------------------------------------------------------------

function CopyableAddr({ addr }) {
  // Forwarding to the shared AddressDisplay so click-to-copy, "Copied!"
  // feedback, and dark-mode styling are uniform with the rest of the app.
  return <AddressDisplay address={addr} />;
}

// ---------------------------------------------------------------------
// Local primitives are now thin wrappers over the shared UI library
// (frontend/src/components/ui/). The original call sites keep working
// without changes because the wrapper names match.
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

function ModalOverlay({ children, onClose }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-surface-darkAlt"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
