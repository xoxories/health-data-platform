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
import { Icon } from "./ui/Icon.jsx";
import { Stat as UIStat } from "./ui/Stat.jsx";
import { Modal as UIModal } from "./ui/Modal.jsx";

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

// Per-route page heading shown in the dashboard's own header (above the
// route body). Distinct from the topbar breadcrumb in App.jsx → Topbar.
const ROUTE_TITLES = {
  overview: "Admin Panel",
  doctors: "Registered doctors",
  register: "Register new doctor",
  emergency: "Emergency access audit",
  activity: "Activity feed",
};

export default function AdminPanel({
  account,
  contracts,
  route = "overview",
  setRoute = () => {},
}) {
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

  const currentTitle = ROUTE_TITLES[route] || ROUTE_TITLES.overview;

  // --- Body per route. Data still flows from the same per-sub-component
  // useEffect's that have always loaded it — this is purely a JSX swap. ---
  let body;
  if (route === "doctors") {
    body = (
      <RegisteredDoctorsTable
        contracts={contracts}
        refreshKey={refreshCount}
        onRevoked={refreshAll}
        setRoute={setRoute}
        expanded
      />
    );
  } else if (route === "register") {
    body = (
      <RegisterDoctorCard
        contracts={contracts}
        adminAccount={account}
        onRegistered={refreshAll}
        setRoute={setRoute}
      />
    );
  } else if (route === "emergency") {
    body = consentAvailable ? (
      <EmergencyAccessFeed
        contracts={contracts}
        refreshKey={refreshCount}
        full
      />
    ) : null;
  } else if (route === "activity") {
    body =
      storageAvailable && consentAvailable ? (
        <RecentActivityFeed
          contracts={contracts}
          refreshKey={refreshCount}
        />
      ) : null;
  } else {
    // overview — stats + doctors table (with action button) + audit + activity
    body = (
      <>
        <SystemStats contracts={contracts} refreshKey={refreshCount} />
        <RegisteredDoctorsTable
          contracts={contracts}
          refreshKey={refreshCount}
          onRevoked={refreshAll}
          setRoute={setRoute}
        />
        {consentAvailable && (
          <EmergencyAccessFeed
            contracts={contracts}
            refreshKey={refreshCount}
          />
        )}
        {storageAvailable && consentAvailable && (
          <RecentActivityFeed
            contracts={contracts}
            refreshKey={refreshCount}
          />
        )}
      </>
    );
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            {currentTitle}
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

      {body}
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

  // Render values: while loading, show the design-system "—" dash so the
  // Stat primitive doesn't try to format a null.
  const v = (n) => (n == null ? "—" : n);

  return (
    <section>
      <div className="stats-grid">
        <UIStat
          label="Patients"
          icon="user"
          value={v(stats.patients)}
        />
        <UIStat
          label="Active doctors"
          icon="doctor"
          value={v(stats.activeDoctors)}
          tone="ok"
        />
        <UIStat
          label="Revoked doctors"
          icon="x"
          value={v(stats.revokedDoctors)}
          tone="warn"
        />
        <UIStat
          label="Records on chain"
          icon="records"
          value={v(stats.records)}
          tone="cyan"
        />
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
    </section>
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

function RegisteredDoctorsTable({
  contracts,
  refreshKey,
  onRevoked,
  setRoute,
  expanded,
}) {
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

  const totalText =
    rows == null
      ? "loading…"
      : rows.length === 1
        ? "1 total"
        : `${rows.length} total`;

  // Header action: jump to the Register view. Hidden if no setRoute was
  // provided (defensive — shouldn't happen, but keeps the component
  // standalone if reused elsewhere later).
  const action = setRoute ? (
    <PrimaryButton size="sm" onClick={() => setRoute("register")}>
      <Icon name="plus" size={14} />
      Register doctor
    </PrimaryButton>
  ) : null;

  return (
    <UICard
      title="Registered doctors"
      icon="doctor"
      sub={totalText}
      action={action}
      flush
    >
      {error && (
        <div style={{ padding: "0 16px 12px" }}>
          <ErrorBox>{error}</ErrorBox>
        </div>
      )}

      {rows === null && <CenteredNotice>Loading doctors…</CenteredNotice>}

      {rows && rows.length === 0 && !error && (
        <div style={{ padding: 24 }}>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No doctors registered yet.{" "}
            {setRoute ? (
              <button
                type="button"
                onClick={() => setRoute("register")}
                className="font-medium text-brand-600 underline-offset-2 hover:underline dark:text-brand-400"
              >
                Register the first one
              </button>
            ) : (
              "Use the Register Doctor view to register the first one."
            )}
            .
          </p>
        </div>
      )}

      {rows && rows.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Address</th>
              <th>Hospital</th>
              {expanded && <th>License hash</th>}
              <th>Registered</th>
              <th>Status</th>
              <th style={{ width: 60, textAlign: "right" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <DoctorRow
                key={r.address}
                row={r}
                expanded={expanded}
                onRevokeClick={() => setRevokeTarget(r)}
              />
            ))}
          </tbody>
        </table>
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
    </UICard>
  );
}

function DoctorRow({ row, onRevokeClick, expanded }) {
  const [copyMsg, setCopyMsg] = useState(null);

  async function copy(text) {
    const ok = await copyToClipboard(text);
    setCopyMsg(ok ? "Copied!" : "Copy failed");
    setTimeout(() => setCopyMsg(null), 1200);
  }

  return (
    <tr>
      <td>
        <AddressDisplay address={row.address} />
      </td>
      <td style={{ color: "var(--ink-2)" }}>{row.hospital || "—"}</td>
      {expanded && (
        <td className="num-cell">
          <button
            type="button"
            onClick={() => copy(row.licenseHash)}
            title={row.licenseHash}
            className="font-mono text-xs underline-offset-2 hover:underline"
            style={{
              color: "var(--ink-3)",
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
            }}
          >
            {shortHex(row.licenseHash)}
          </button>
          {copyMsg && (
            <span
              style={{
                marginLeft: 6,
                fontSize: 10,
                color: "var(--ok)",
              }}
            >
              {copyMsg}
            </span>
          )}
        </td>
      )}
      <td style={{ color: "var(--ink-2)" }}>
        {formatAbsolute(row.registeredAt)}
      </td>
      <td>
        {row.isActive ? (
          <StatusPill status="active">Active</StatusPill>
        ) : (
          <div>
            <StatusPill status="revoked">Revoked</StatusPill>
            {row.revocation?.reason && (
              <div
                style={{
                  fontSize: 11,
                  color: "var(--ink-3)",
                  marginTop: 4,
                  maxWidth: 280,
                }}
              >
                {row.revocation.reason}
              </div>
            )}
          </div>
        )}
      </td>
      <td style={{ textAlign: "right" }}>
        {row.isActive ? (
          <button
            type="button"
            className="icon-btn"
            style={{ width: 30, height: 30 }}
            title="Revoke"
            onClick={onRevokeClick}
            aria-label="Revoke doctor"
          >
            <Icon name="x" size={14} />
          </button>
        ) : (
          <button
            type="button"
            className="icon-btn"
            style={{ width: 30, height: 30, opacity: 0.4 }}
            disabled
            title="Already revoked"
            aria-label="Already revoked"
          >
            <Icon name="x" size={14} />
          </button>
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
    <UIModal
      open={true}
      onClose={pending ? undefined : onClose}
      title="Revoke doctor access"
      subtitle={`Doctor ${shortAddr(row.address)} at ${row.hospital || "—"} will lose DOCTOR_ROLE. Existing patient grants become unenforceable.`}
      width={560}
      footer={
        <>
          <SecondaryButton onClick={onClose} disabled={pending}>
            Cancel
          </SecondaryButton>
          <DangerButton onClick={confirm} disabled={pending}>
            {pending ? <Spinner /> : null}
            {buttonLabel}
          </DangerButton>
        </>
      }
    >
      <div className="field">
        <span className="label">
          Reason{" "}
          <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>
            ({MAX_REASON_LEN} chars max — visible in the on-chain event log)
          </span>
        </span>
        <textarea
          className="textarea"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={pending}
          maxLength={MAX_REASON_LEN + 1}
          placeholder="e.g. Compliance violation — unauthorized data sharing"
        />
        <span className="hint">
          {reason.length}/{MAX_REASON_LEN}
        </span>
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
    </UIModal>
  );
}

// ---------------------------------------------------------------------
// 5. Emergency access audit feed
// ---------------------------------------------------------------------

function EmergencyAccessFeed({ contracts, refreshKey, full }) {
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
    <UICard
      title="Emergency access audit"
      icon="emergency"
      sub="Read-only chain of break-glass events"
      flush
    >
      {/* Explainer paragraph preserved — it's the section's security
          context for the report. Padded inset so flush card body still
          reads cleanly. */}
      <div
        style={{
          padding: "0 18px",
          marginTop: 14,
          marginBottom: 14,
          fontSize: 13,
          lineHeight: 1.5,
          color: "var(--ink-2)",
        }}
      >
        Emergency access (a.k.a. <em>break-glass</em>) lets a registered
        doctor read a patient's records without explicit consent — for
        cases like an unconscious patient in the ER. Every invocation is
        permanently logged on-chain with the doctor's stated
        justification and surfaces here. This is the audit trail the
        platform's threat model relies on: privacy is not absolute, but
        every override is observable, attributable, and reviewable after
        the fact.
      </div>

      {error && (
        <div style={{ padding: "0 18px 12px" }}>
          <ErrorBox>{error}</ErrorBox>
        </div>
      )}
      {rows === null && <CenteredNotice>Loading audit feed…</CenteredNotice>}

      {rows && rows.length === 0 && !error && (
        <div style={{ padding: "0 18px 18px" }}>
          <p
            style={{
              fontSize: 13,
              color: "var(--ink-3)",
              lineHeight: 1.5,
            }}
          >
            No emergency access has been invoked. Any time a doctor
            accesses a record without explicit consent (e.g.
            life-threatening emergency), it will appear here with the
            justification they provided.
          </p>
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="timeline">
          {rows.map((r, i) => (
            <div key={`${r.blockNumber}-${i}`} className="row emg">
              <div className="marker">
                <Icon name="emergency" size={14} />
              </div>
              <div className="body">
                <div className="head">
                  <span>
                    <strong>{shortAddr(r.doctor)}</strong> accessed records of{" "}
                    <strong>{shortAddr(r.patient)}</strong>
                  </span>
                  <StatusPill status="emergency">Emergency</StatusPill>
                </div>
                <div className="meta">
                  <AddressDisplay address={r.doctor} label="doctor" />
                  <AddressDisplay address={r.patient} label="patient" />
                </div>
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
                  {r.reason}
                </div>
                {full && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 11.5,
                      color: "var(--ink-3)",
                      fontFamily: "'Geist Mono Variable', monospace",
                    }}
                  >
                    block {r.blockNumber}
                  </div>
                )}
              </div>
              <div
                className="time"
                title={formatAbsolute(r.timestamp)}
              >
                {timestampToRelative(r.timestamp)}
              </div>
            </div>
          ))}
        </div>
      )}
    </UICard>
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

  // kind → { icon, timeline tone class, label }. Mirrors the prototype's
  // iconMap in screen-admin.jsx ActivityFeed: grants are positive (ok),
  // revokes warn, uploads are neutral access events (acc).
  const KIND_META = {
    granted: { icon: "shieldcheck", tone: "ok", label: "Granted" },
    revoked: { icon: "x", tone: "warn", label: "Revoked" },
    stored: { icon: "upload", tone: "acc", label: "Stored" },
  };

  return (
    <UICard
      title="Recent activity"
      icon="activity"
      sub="Combined timeline of grants, revokes, and uploads"
      flush
    >
      {error && (
        <div style={{ padding: "0 18px 12px" }}>
          <ErrorBox>{error}</ErrorBox>
        </div>
      )}
      {rows === null && <CenteredNotice>Loading activity…</CenteredNotice>}

      {rows && rows.length === 0 && !error && (
        <div style={{ padding: "0 18px 18px" }}>
          <p style={{ fontSize: 13, color: "var(--ink-3)", lineHeight: 1.5 }}>
            No recent activity.
          </p>
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="timeline">
          {rows.map((r) => {
            const m = KIND_META[r.kind] || {
              icon: "activity",
              tone: "acc",
              label: r.kind,
            };
            return (
              <div key={r.key} className={`row ${m.tone}`}>
                <div className="marker">
                  <Icon name={m.icon} size={14} />
                </div>
                <div className="body">
                  <div className="head">
                    <span>
                      <strong>{m.label}</strong>
                      {r.kind === "stored" ? (
                        <>
                          {" — record "}
                          <span
                            style={{
                              fontFamily: "'Geist Mono Variable', monospace",
                              color: "var(--ink-2)",
                            }}
                          >
                            #{r.recordId}
                          </span>
                          {" by "}
                          <strong>{shortAddr(r.patient)}</strong>
                        </>
                      ) : (
                        <>
                          {" — "}
                          <strong>{shortAddr(r.patient)}</strong>
                          {" ↔ "}
                          <strong>{shortAddr(r.doctor)}</strong>
                        </>
                      )}
                    </span>
                  </div>
                  <div className="meta">
                    {r.kind === "stored" ? (
                      <AddressDisplay address={r.patient} label="patient" />
                    ) : (
                      <>
                        <AddressDisplay address={r.patient} label="patient" />
                        <AddressDisplay address={r.doctor} label="doctor" />
                      </>
                    )}
                  </div>
                </div>
                <div className="time" title={formatAbsolute(r.timestamp)}>
                  {timestampToRelative(r.timestamp)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </UICard>
  );
}

// ---------------------------------------------------------------------
// Local primitives are thin wrappers over the shared UI library
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

