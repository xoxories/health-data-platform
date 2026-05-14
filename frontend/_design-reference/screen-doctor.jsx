// Doctor Dashboard

function ScreenDoctor({ route, setRoute, toast }) {
  const [consents] = useState(DOCTOR_CONSENTS);
  const [hasKey, setHasKey] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [reqAddr, setReqAddr] = useState('');

  const stats = (
    <div className="stats-grid">
      <Stat label="Active consents"  icon="shield"  value={consents.length}   delta={`${consents.reduce((a, c) => a + c.records, 0)} records accessible`} tone="ok" />
      <Stat label="Records accessed" icon="eye"     value={DOCTOR_HISTORY.length} delta="last 30 days" />
      <Stat label="Emergency invocations" icon="emergency" value="1" delta="last 30 days" tone="warn" />
      <Stat label="License status"   icon="shieldcheck" value="Active" delta="Riverbend General" tone="cyan" />
    </div>
  );

  if (!hasKey) {
    return (
      <Card tone="warn" title="Publish your encryption key" icon="key" sub="One‑time, non‑rotatable. Required before patients can grant you access.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13.5, color: 'var(--ink-2)' }}>
            We’ll derive an ECIES keypair from a deterministic signature on the canonical message
            <span className="font-mono" style={{ display: 'inline-block', marginLeft: 6, padding: '2px 8px', background: 'var(--surface-inset)', borderRadius: 6, fontSize: 12 }}>"HealthDataPlatform key derivation v1"</span>,
            then publish only the public half to the registry.
          </div>
          <Pipeline current={publishing ? 'signing' : 'encrypting'} steps={[
            { key: 'encrypting', label: 'Deriving keypair' },
            { key: 'signing',    label: 'Waiting for signature' },
            { key: 'confirming', label: 'Confirming transaction' },
            { key: 'done',       label: 'Published' },
          ]} />
          <div>
            <Button icon="key" loading={publishing}
              onClick={() => { setPublishing(true); setTimeout(() => { setPublishing(false); setHasKey(true); toast({ title: 'Encryption key published' }); }, 2200); }}>
              Publish encryption key
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  const Overview = () => (
    <>
      {stats}
      <div className="split-3-2">
        <Card title="Active consents" icon="shield" sub="Patients who have granted you scoped access" flush>
          {consents.map((c, i) => <DoctorConsentCard key={i} consent={c} />)}
        </Card>
        <Card title="Recent access" icon="history" sub="Your compliance trail" flush>
          <AccessTimeline items={DOCTOR_HISTORY.slice(0, 4)} side="doctor" />
        </Card>
      </div>

      <Card title="Request access from a patient" icon="send" sub="Submit a patient address to request consent — emits an on‑chain AccessRequested event">
        <div style={{ display: 'grid', gridTemplateColumns: '1.5fr auto', gap: 12, alignItems: 'end' }}>
          <div className="field">
            <span className="label">Patient wallet address</span>
            <div className="input-with-icon">
              <Icon name="user" className="ico" size={14} />
              <input className="input mono" placeholder="0x…" value={reqAddr} onChange={(e) => setReqAddr(e.target.value)} />
            </div>
            <span className="hint">The patient will see your request in their pending list and decide which categories to grant.</span>
          </div>
          <Button icon="send" disabled={!reqAddr} onClick={() => { setReqAddr(''); toast({ title: 'Request submitted', body: 'The patient will be notified.' }); }}>
            Submit request
          </Button>
        </div>
      </Card>
    </>
  );

  const Request = () => (
    <Card title="Request access from a patient" icon="send">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 }}>
        <div className="field">
          <span className="label">Patient wallet address</span>
          <div className="input-with-icon"><Icon name="user" className="ico" size={14} />
            <input className="input mono" placeholder="0x…" value={reqAddr} onChange={(e) => setReqAddr(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <span className="label">Reason (visible to the patient)</span>
          <textarea className="textarea" rows="3" placeholder="e.g. Follow‑up cardiology consult, scheduled May 22" />
        </div>
        <div>
          <Button icon="send" disabled={!reqAddr}>Submit request</Button>
        </div>
      </div>
    </Card>
  );

  const Consents = () => (
    <Card title="My active consents" icon="shield" sub={`${consents.length} patients`} flush>
      {consents.map((c, i) => <DoctorConsentCard key={i} consent={c} expand />)}
    </Card>
  );

  const History = () => (
    <Card title="Access history" icon="history" sub="Every record you have viewed" flush>
      <AccessTimeline items={DOCTOR_HISTORY} side="doctor" />
    </Card>
  );

  const KeyView = () => (
    <Card title="Encryption key" icon="key" sub="Published on‑chain. Non‑rotatable by contract design.">
      <div className="kv-grid">
        <div className="k">Algorithm</div><div className="v">ECIES over secp256k1</div>
        <div className="k">Derivation</div><div className="v">HKDF on deterministic signature</div>
        <div className="k">On‑chain pubkey</div><div className="v font-mono" style={{ wordBreak: 'break-all' }}>0x04f3a2…b1c89e2…7d40a3f1…</div>
        <div className="k">Published</div><div className="v">Mar 14, 2026 · block 8,219,902</div>
        <div className="k">Status</div><div className="v"><StatusPill status="active">Matched · derives identically</StatusPill></div>
      </div>
      <hr style={{ margin: '14px 0' }} />
      <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
        If you ever connect with a different signer, you’ll see a pubkey‑mismatch warning. Rotation requires the admin to revoke and re‑register you.
      </div>
    </Card>
  );

  return route === 'request'  ? <Request />
       : route === 'consents' ? <Consents />
       : route === 'history'  ? <History />
       : route === 'key'      ? <KeyView />
       : <Overview />;
}

function DoctorConsentCard({ consent, expand = false }) {
  const [open, setOpen] = useState(expand);
  return (
    <div style={{ padding: 18, borderBottom: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--brand-soft)', color: 'var(--brand)', display: 'grid', placeItems: 'center', flex: 'none' }}>
          <Icon name="user" size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, color: 'var(--ink)', fontSize: 14 }}>{consent.patient.name}</div>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 }}>
            <AddressDisplay address={consent.patient.addr} />
            <span>·</span>
            <span>{consent.records} records</span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>Expires</div>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{daysUntil(consent.expiresAt)}d</div>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setOpen(!open)} iconRight={open ? 'arrowDown' : 'arrowRight'}>
            {open ? 'Hide records' : `View ${consent.records} records`}
          </Button>
        </div>
      </div>
      <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {consent.categories.map((k) => {
          const c = CATEGORIES.find((x) => x.key === k);
          return <StatusPill key={k} status="brand"><Icon name={c?.icon} size={11} style={{ marginRight: 2 }} /> {c?.label}</StatusPill>;
        })}
      </div>
      {open && (
        <div style={{ marginTop: 14, background: 'var(--surface-inset)', borderRadius: 10, border: '1px solid var(--line)' }}>
          <table className="table" style={{ background: 'transparent' }}>
            <thead><tr><th style={{ width: 70 }}>ID</th><th>File</th><th>Category</th><th>Uploaded</th><th style={{ width: 100 }} /></tr></thead>
            <tbody>
              {RECORDS.slice(0, consent.records).map((r) => {
                const c = CATEGORIES.find((x) => x.key === r.category);
                return (
                  <tr key={r.id}>
                    <td className="num-cell">#{r.id.toString().padStart(3, '0')}</td>
                    <td>{r.filename}</td>
                    <td><StatusPill status="brand">{c?.label}</StatusPill></td>
                    <td style={{ color: 'var(--ink-2)' }}>{relTime(r.uploaded)}</td>
                    <td><Button size="sm" icon="eye">View</Button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

window.ScreenDoctor = ScreenDoctor;
