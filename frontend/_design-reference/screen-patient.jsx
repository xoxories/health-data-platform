// Patient Dashboard

function CatChip({ catKey, on, onClick, size = 'md' }) {
  const c = CATEGORIES.find((x) => x.key === catKey);
  if (!c) return null;
  return (
    <button className={`chip${on ? ' on' : ''}`} onClick={onClick}>
      <Icon name={c.icon} size={12} />
      {c.label}
    </button>
  );
}

function ScreenPatient({ route, setRoute, openUpload, toast }) {
  const [pendings, setPendings] = useState(PENDING_REQUESTS);
  const [consents, setConsents] = useState(ACTIVE_CONSENTS);
  const [records, setRecords] = useState(RECORDS);

  const stats = (
    <div className="stats-grid">
      <Stat label="Total records"    icon="records"    value={records.length}      delta="+2 this month" deltaDirection="up" />
      <Stat label="Active consents"  icon="shield"     value={consents.length}     delta={`expires in ${daysUntil(consents[0]?.expiresAt || new Date().toISOString())}d`} tone="ok" />
      <Stat label="Pending requests" icon="bell"       value={pendings.length}     delta="awaiting your action" tone="warn" />
      <Stat label="Records accessed" icon="eye"        value={PATIENT_ACCESS_HISTORY.length} delta="last 30 days" tone="cyan" />
    </div>
  );

  // --- Sub-views ----------------------------------------------------------
  const Overview = () => (
    <>
      {stats}

      <div className="split-3-2">
        <Card
          title="Your records"
          sub="Encrypted, stored on IPFS, indexed on‑chain"
          icon="records"
          action={<>
            <Button size="sm" variant="ghost" icon="filter">Filter</Button>
            <Button size="sm" icon="upload" onClick={() => openUpload()}>Upload</Button>
          </>}
          flush
        >
          <RecordsTable records={records.slice(0, 5)} onDelete={(id) => setRecords(records.filter((r) => r.id !== id))} />
          <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end' }}>
            <button className="linkbtn" onClick={() => setRoute('records')}>View all {records.length} records <Icon name="arrowRight" size={12} /></button>
          </div>
        </Card>

        <Card title="Pending access requests" icon="bell" sub={`${pendings.length} doctors awaiting consent`}>
          {pendings.length === 0 ? (
            <Empty icon="shieldcheck" title="No pending requests" body="Doctors who request access will appear here for review." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {pendings.map((p) => (
                <PendingCard
                  key={p.id}
                  pending={p}
                  onGrant={() => { setPendings(pendings.filter((x) => x.id !== p.id)); toast({ title: 'Consent granted', body: `${p.doctor.name} now has scoped access.` }); }}
                  onDecline={() => { setPendings(pendings.filter((x) => x.id !== p.id)); toast({ title: 'Request declined', body: p.doctor.name, tone: 'warn' }); }}
                />
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="split-3-2">
        <Card title="Access history" icon="history" sub="Every record view — normal and emergency" flush>
          <AccessTimeline items={PATIENT_ACCESS_HISTORY} side="patient" />
        </Card>

        <Card title="Active consents" icon="shield" sub="Currently granted access" flush>
          {consents.length === 0 ? (
            <Empty icon="shield" title="No active consents" body="When you grant access, it shows up here." />
          ) : (
            <div>
              {consents.map((c) => (
                <ConsentRow key={c.id} consent={c}
                  onRevoke={() => { setConsents(consents.filter((x) => x.id !== c.id)); toast({ title: 'Consent revoked', body: c.doctor.name, tone: 'warn' }); }}
                />
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );

  const Upload = () => <UploadFull openUpload={openUpload} />;
  const Records = () => (
    <Card title="My records" icon="records" sub={`${records.length} encrypted records on IPFS`} flush
      action={<Button size="sm" icon="upload" onClick={() => openUpload()}>Upload</Button>}>
      <RecordsTable records={records} onDelete={(id) => setRecords(records.filter((r) => r.id !== id))} />
    </Card>
  );
  const Consents = () => (
    <Card title="Active consents" icon="shield" sub={`${consents.length} doctors currently authorized`} flush>
      {consents.length === 0
        ? <Empty icon="shield" title="No active consents" />
        : consents.map((c) => <ConsentRow key={c.id} consent={c} onRevoke={() => setConsents(consents.filter((x) => x.id !== c.id))} />)}
    </Card>
  );
  const Requests = () => (
    <Card title="Pending access requests" icon="bell" sub={`${pendings.length} awaiting your action`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {pendings.map((p) => (
          <PendingCard key={p.id} pending={p}
            onGrant={() => setPendings(pendings.filter((x) => x.id !== p.id))}
            onDecline={() => setPendings(pendings.filter((x) => x.id !== p.id))} />
        ))}
        {pendings.length === 0 && <Empty icon="shieldcheck" title="All caught up" body="No pending requests." />}
      </div>
    </Card>
  );
  const History = () => (
    <Card title="Access history" icon="history" sub="Complete audit log" flush>
      <AccessTimeline items={PATIENT_ACCESS_HISTORY} side="patient" />
    </Card>
  );

  return route === 'upload'   ? <Upload />
       : route === 'records'  ? <Records />
       : route === 'consents' ? <Consents />
       : route === 'requests' ? <Requests />
       : route === 'history'  ? <History />
       : <Overview />;
}

// --- Sub components ---------------------------------------------------------

function RecordsTable({ records, onDelete }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th style={{ width: 50 }}>#</th>
          <th>File</th>
          <th>Category</th>
          <th>Uploaded</th>
          <th>IPFS CID</th>
          <th style={{ width: 40 }} />
        </tr>
      </thead>
      <tbody>
        {records.map((r) => {
          const c = CATEGORIES.find((x) => x.key === r.category);
          return (
            <tr key={r.id}>
              <td className="num-cell">#{r.id.toString().padStart(3, '0')}</td>
              <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--brand-soft)', color: 'var(--brand)', display: 'grid', placeItems: 'center', flex: 'none' }}>
                    <Icon name={c?.icon || 'file'} size={14} />
                  </div>
                  <div>
                    <div style={{ fontWeight: 500, color: 'var(--ink)' }}>{r.filename}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>{r.size}</div>
                  </div>
                </div>
              </td>
              <td><StatusPill status="brand">{c?.label}</StatusPill></td>
              <td style={{ color: 'var(--ink-2)' }}>{relTime(r.uploaded)}</td>
              <td>
                <span className="font-mono" title={r.cid} style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                  {r.cid.slice(0, 8)}…{r.cid.slice(-6)}
                </span>
              </td>
              <td>
                <button className="icon-btn" style={{ width: 30, height: 30 }} title="Delete" onClick={() => onDelete(r.id)}>
                  <Icon name="trash" size={14} />
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PendingCard({ pending, onGrant, onDecline }) {
  const [cats, setCats] = useState(['BloodTest']);
  const [days, setDays] = useState(30);
  const toggle = (k) => setCats(cats.includes(k) ? cats.filter((x) => x !== k) : [...cats, k]);
  return (
    <div style={{
      border: '1px solid var(--line)', borderRadius: 14, padding: 14,
      background: 'var(--surface-2)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--brand-soft)', color: 'var(--brand)', display: 'grid', placeItems: 'center' }}>
          <Icon name="doctor" size={18} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, color: 'var(--ink)', fontSize: 13.5 }}>{pending.doctor.name}</div>
          <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{pending.doctor.hospital} · {relTime(pending.requested)}</div>
        </div>
        <StatusPill status="pending">Pending</StatusPill>
      </div>
      {pending.message && (
        <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--ink-2)', fontStyle: 'italic' }}>
          “{pending.message}”
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <div className="label" style={{ marginBottom: 6 }}>Grant categories</div>
        <div className="chip-row">
          {CATEGORIES.map((c) => (
            <CatChip key={c.key} catKey={c.key} on={cats.includes(c.key)} onClick={() => toggle(c.key)} />
          ))}
        </div>
      </div>
      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="clock" size={14} style={{ color: 'var(--ink-3)' }} />
          <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>Expires in</span>
          <input type="number" min="1" max="365" value={days} onChange={(e) => setDays(Number(e.target.value))}
                 className="input" style={{ width: 70, height: 32, padding: '4px 8px' }} />
          <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>days</span>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Button size="sm" variant="ghost" onClick={onDecline}>Decline</Button>
          <Button size="sm" icon="check" onClick={onGrant} disabled={cats.length === 0}>Grant access</Button>
        </div>
      </div>
    </div>
  );
}

function ConsentRow({ consent, onRevoke }) {
  return (
    <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 14 }}>
      <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--accent-soft)', color: 'oklch(0.4 0.12 200)', display: 'grid', placeItems: 'center', flex: 'none' }}>
        <Icon name="doctor" size={16} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: 'var(--ink)', fontSize: 13.5 }}>{consent.doctor.name}</div>
        <div style={{ fontSize: 12, color: 'var(--ink-3)', display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
          <span>{consent.doctor.hospital}</span>
          <span>·</span>
          <span>{consent.records} records</span>
          <span>·</span>
          <span style={{ color: 'var(--ink-2)' }}>{consent.categories.join(' · ')}</span>
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>Expires</div>
        <div style={{ fontWeight: 600, color: 'var(--ink)', fontSize: 13 }}>{daysUntil(consent.expiresAt)}d</div>
      </div>
      <Button size="sm" variant="ghost" onClick={onRevoke} icon="x">Revoke</Button>
    </div>
  );
}

function AccessTimeline({ items, side = 'patient' }) {
  return (
    <div className="timeline">
      {items.map((it, i) => {
        const isEmg = it.type === 'emergency';
        const c = CATEGORIES.find((x) => x.key === it.category);
        const other = side === 'patient' ? it.actor : it.patient;
        return (
          <div key={i} className={`row ${isEmg ? 'emg' : 'acc'}`}>
            <div className="marker">
              <Icon name={isEmg ? 'emergency' : 'eye'} size={14} />
            </div>
            <div className="body">
              <div className="head">
                <span>{isEmg ? 'Emergency access' : 'Record accessed'}</span>
                <StatusPill status={isEmg ? 'emergency' : 'access'}>{isEmg ? 'Emergency' : 'Access'}</StatusPill>
                <StatusPill status="brand">{c?.label}</StatusPill>
              </div>
              <div className="meta">
                <span>by <strong style={{ color: 'var(--ink-2)' }}>{other?.name || 'Unknown'}</strong></span>
                <AddressDisplay address={other?.addr} />
                <span>· record #{(it.recordId || '').toString().padStart(3, '0')}</span>
              </div>
              {isEmg && it.reason && (
                <div style={{ marginTop: 8, padding: '8px 10px', background: 'var(--danger-soft)', borderRadius: 8, fontSize: 12, color: 'var(--ink-2)', borderLeft: '3px solid var(--danger)' }}>
                  <strong style={{ color: 'var(--danger)' }}>Justification: </strong>{it.reason}
                </div>
              )}
            </div>
            <div className="time">{relTime(it.ts)}</div>
          </div>
        );
      })}
    </div>
  );
}

function UploadFull({ openUpload }) {
  return (
    <Card title="Upload health record" icon="upload" sub="Encrypted in‑browser before it leaves your device">
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 18 }}>
        <div>
          <div className="dropzone" onClick={openUpload}>
            <div className="dz-ico"><Icon name="upload" size={20} /></div>
            <div className="dz-title">Drop a file here or click to browse</div>
            <div className="dz-sub">PDF, JPG, PNG, DICOM up to 5 MB · AES‑256‑GCM encrypted client‑side</div>
          </div>
          <div style={{ marginTop: 16 }}>
            <div className="label" style={{ marginBottom: 6 }}>Category</div>
            <div className="chip-row">
              {CATEGORIES.map((c) => (
                <button key={c.key} className="chip"><Icon name={c.icon} size={12} />{c.label}</button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ background: 'var(--surface-inset)', borderRadius: 12, padding: 16, border: '1px solid var(--line)' }}>
          <div style={{ fontFamily: 'Sora', fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>Encryption pipeline</div>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 4, marginBottom: 14 }}>
            Your file is encrypted before upload. Only wallets you grant consent to can decrypt.
          </div>
          <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[
              { i: 1, t: 'Generate AES‑256 key',    s: 'Random per file · 96‑bit IV' },
              { i: 2, t: 'AES‑GCM encrypt the file', s: 'Tag verifies on decrypt' },
              { i: 3, t: 'Upload ciphertext to IPFS', s: 'Pinata gateway · returns CID' },
              { i: 4, t: 'Wrap AES key with your pubkey', s: '93‑byte ECIES envelope' },
              { i: 5, t: 'storeRecord(CID, category, wrappedKey)', s: 'On‑chain transaction' },
            ].map((s) => (
              <li key={s.i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <span style={{ width: 22, height: 22, borderRadius: 6, background: 'var(--surface)', border: '1px solid var(--line)', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700, color: 'var(--brand)', flex: 'none' }}>{s.i}</span>
                <div>
                  <div style={{ fontSize: 12.5, color: 'var(--ink)', fontWeight: 500 }}>{s.t}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>{s.s}</div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </Card>
  );
}

Object.assign(window, { ScreenPatient, CatChip, AccessTimeline });
