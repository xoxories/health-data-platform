// Admin Panel

function ScreenAdmin({ route, setRoute, toast }) {
  const [doctors, setDoctors] = useState(DOCTORS);
  const [showRevoke, setShowRevoke] = useState(null);
  const [reason, setReason] = useState('');
  const [newDoctor, setNewDoctor] = useState({ addr: '', license: '', hospital: '' });

  const stats = (
    <div className="stats-grid">
      <Stat label="Patients"          icon="user"   value="248" delta="+12 this week" deltaDirection="up" />
      <Stat label="Active doctors"    icon="doctor" value={doctors.filter((d) => d.status === 'active').length} delta="across 8 hospitals" tone="ok" />
      <Stat label="Revoked doctors"   icon="x"      value={doctors.filter((d) => d.status === 'revoked').length} delta="compliance actions" tone="warn" />
      <Stat label="Records on chain"  icon="records" value="1,742" delta="all categories" tone="cyan" />
    </div>
  );

  const handleRevoke = () => {
    setDoctors(doctors.map((d) => d.addr === showRevoke.addr ? { ...d, status: 'revoked', reason } : d));
    setShowRevoke(null); setReason('');
    toast({ title: 'Doctor revoked', body: 'DOCTOR_ROLE removed and reason logged.', tone: 'warn' });
  };

  const handleRegister = () => {
    if (!newDoctor.addr || !newDoctor.license || !newDoctor.hospital) return;
    setDoctors([{ addr: newDoctor.addr, name: 'Pending verification', hospital: newDoctor.hospital, license: '0x' + newDoctor.license.slice(0, 4) + '…' + newDoctor.license.slice(-4), registered: new Date().toISOString().slice(0, 10), status: 'active' }, ...doctors]);
    setNewDoctor({ addr: '', license: '', hospital: '' });
    toast({ title: 'Doctor registered', body: 'DOCTOR_ROLE granted on‑chain.' });
  };

  const Overview = () => (
    <>
      {stats}
      <div className="split-3-2">
        <Card title="Registered doctors" icon="doctor" sub={`${doctors.length} total`} flush
          action={<Button size="sm" icon="plus" onClick={() => setRoute('register')}>Register doctor</Button>}>
          <DoctorsTable doctors={doctors} onRevoke={(d) => setShowRevoke(d)} />
        </Card>

        <Card title="Emergency access audit" icon="emergency" sub="Read‑only chain of break‑glass events" flush>
          <EmergencyAudit items={EMERGENCY_AUDIT} />
        </Card>
      </div>

      <Card title="Recent activity" icon="activity" sub="Combined timeline of grants, revokes, registrations, uploads" flush>
        <ActivityFeed items={RECENT_ACTIVITY} />
      </Card>

      <Modal
        open={!!showRevoke}
        onClose={() => setShowRevoke(null)}
        title={`Revoke ${showRevoke?.name}?`}
        subtitle="This removes DOCTOR_ROLE and is logged on‑chain. The reason will be visible to the doctor and patients."
        footer={<>
          <Button variant="ghost" onClick={() => setShowRevoke(null)}>Cancel</Button>
          <Button variant="danger" disabled={!reason} icon="warning" onClick={handleRevoke}>Confirm revocation</Button>
        </>}
      >
        <div className="field">
          <span className="label">Reason</span>
          <textarea className="textarea" rows="3" placeholder="e.g. Compliance violation — unauthorized data sharing" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </Modal>
    </>
  );

  const Doctors = () => (
    <Card title="Registered doctors" icon="doctor" sub={`${doctors.length} total · across the network`} flush
      action={<Button size="sm" icon="plus" onClick={() => setRoute('register')}>Register doctor</Button>}>
      <DoctorsTable doctors={doctors} onRevoke={(d) => setShowRevoke(d)} expanded />
      <Modal
        open={!!showRevoke}
        onClose={() => setShowRevoke(null)}
        title={`Revoke ${showRevoke?.name}?`}
        subtitle="This removes DOCTOR_ROLE and is logged on‑chain."
        footer={<>
          <Button variant="ghost" onClick={() => setShowRevoke(null)}>Cancel</Button>
          <Button variant="danger" disabled={!reason} icon="warning" onClick={handleRevoke}>Confirm revocation</Button>
        </>}
      >
        <div className="field"><span className="label">Reason</span>
          <textarea className="textarea" rows="3" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </Modal>
    </Card>
  );

  const Register = () => (
    <Card title="Register new doctor" icon="plus" sub="Grants DOCTOR_ROLE so the wallet can publish a pubkey and request access">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div className="field">
          <span className="label">Wallet address</span>
          <div className="input-with-icon"><Icon name="wallet" className="ico" size={14} />
            <input className="input mono" placeholder="0x…" value={newDoctor.addr}
                   onChange={(e) => setNewDoctor({ ...newDoctor, addr: e.target.value })} />
          </div>
        </div>
        <div className="field">
          <span className="label">Hospital affiliation</span>
          <div className="input-with-icon"><Icon name="building" className="ico" size={14} />
            <input className="input" placeholder="e.g. Riverbend General" value={newDoctor.hospital}
                   onChange={(e) => setNewDoctor({ ...newDoctor, hospital: e.target.value })} />
          </div>
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <span className="label">License number</span>
          <div className="input-with-icon"><Icon name="scroll" className="ico" size={14} />
            <input className="input" placeholder="e.g. MD‑BRD‑492018" value={newDoctor.license}
                   onChange={(e) => setNewDoctor({ ...newDoctor, license: e.target.value })} />
          </div>
          <span className="hint">Hashed client‑side to a bytes32 before going on‑chain. Original is never stored.</span>
        </div>
      </div>
      <hr style={{ margin: '18px 0' }} />
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <Button variant="ghost">Cancel</Button>
        <Button icon="check" disabled={!newDoctor.addr || !newDoctor.license || !newDoctor.hospital} onClick={handleRegister}>Register doctor</Button>
      </div>
    </Card>
  );

  const Emergency = () => (
    <Card title="Emergency access audit" icon="emergency" sub="Every break‑glass invocation, on‑chain, immutable" flush>
      <EmergencyAudit items={EMERGENCY_AUDIT} full />
    </Card>
  );

  const Activity = () => (
    <Card title="Activity feed" icon="activity" sub="Recent platform events" flush>
      <ActivityFeed items={RECENT_ACTIVITY} />
    </Card>
  );

  return route === 'doctors'   ? <Doctors />
       : route === 'register'  ? <Register />
       : route === 'emergency' ? <Emergency />
       : route === 'activity'  ? <Activity />
       : <Overview />;
}

function DoctorsTable({ doctors, onRevoke, expanded }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Doctor</th>
          <th>Address</th>
          <th>Hospital</th>
          {expanded && <th>License hash</th>}
          <th>Registered</th>
          <th>Status</th>
          <th style={{ width: 60 }} />
        </tr>
      </thead>
      <tbody>
        {doctors.map((d) => (
          <tr key={d.addr}>
            <td>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--brand-soft)', color: 'var(--brand)', display: 'grid', placeItems: 'center' }}>
                  <Icon name="doctor" size={14} />
                </div>
                <div style={{ fontWeight: 500 }}>{d.name}</div>
              </div>
            </td>
            <td><AddressDisplay address={d.addr} /></td>
            <td style={{ color: 'var(--ink-2)' }}>{d.hospital}</td>
            {expanded && <td className="num-cell">{d.license}</td>}
            <td style={{ color: 'var(--ink-2)' }}>{d.registered}</td>
            <td>
              {d.status === 'active'
                ? <StatusPill status="active">Active</StatusPill>
                : <StatusPill status="revoked">Revoked</StatusPill>}
              {d.status === 'revoked' && d.reason && (
                <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4, maxWidth: 280 }}>{d.reason}</div>
              )}
            </td>
            <td>
              {d.status === 'active' && (
                <button className="icon-btn" style={{ width: 30, height: 30 }} title="Revoke" onClick={() => onRevoke(d)}>
                  <Icon name="x" size={14} />
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EmergencyAudit({ items, full }) {
  return (
    <div className="timeline">
      {items.map((e, i) => (
        <div key={i} className="row emg">
          <div className="marker"><Icon name="emergency" size={14} /></div>
          <div className="body">
            <div className="head">
              <span><strong>{e.doctor.name}</strong> accessed record of <strong>{e.patient.name}</strong></span>
              <StatusPill status="emergency">Emergency</StatusPill>
            </div>
            <div className="meta">
              <AddressDisplay address={e.doctor.addr} label="doctor" />
              <AddressDisplay address={e.patient.addr} label="patient" />
              <span>· record #{e.recordId.toString().padStart(3, '0')}</span>
            </div>
            <div style={{ marginTop: 8, padding: '8px 10px', background: 'var(--danger-soft)', borderRadius: 8, fontSize: 12, color: 'var(--ink-2)', borderLeft: '3px solid var(--danger)' }}>
              <strong style={{ color: 'var(--danger)' }}>Justification: </strong>{e.reason}
            </div>
            {full && (
              <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--ink-3)', fontFamily: 'JetBrains Mono' }}>
                tx {e.txHash}
              </div>
            )}
          </div>
          <div className="time">{relTime(e.ts)}</div>
        </div>
      ))}
    </div>
  );
}

function ActivityFeed({ items }) {
  const iconMap = { grant: { i: 'shieldcheck', t: 'ok' }, upload: { i: 'upload', t: 'acc' }, revoke: { i: 'x', t: 'warn' }, register: { i: 'plus', t: 'acc' }, emergency: { i: 'emergency', t: 'emg' } };
  return (
    <div className="timeline">
      {items.map((it, i) => {
        const m = iconMap[it.type] || { i: 'activity', t: 'acc' };
        return (
          <div key={i} className={`row ${m.t}`}>
            <div className="marker"><Icon name={m.i} size={14} /></div>
            <div className="body">
              <div className="head">{it.text}</div>
            </div>
            <div className="time">{relTime(it.ts)}</div>
          </div>
        );
      })}
    </div>
  );
}

window.ScreenAdmin = ScreenAdmin;
