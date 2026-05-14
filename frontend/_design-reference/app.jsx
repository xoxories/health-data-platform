// App — main composition

function UploadModal({ open, onClose, onDone }) {
  const [phase, setPhase] = useState(null); // null | encrypting | uploading | ...
  const [category, setCategory] = useState('BloodTest');
  const [filename, setFilename] = useState('chest-xray-2026-05.pdf');

  const start = () => {
    const phases = UPLOAD_STEPS.map((s) => s.key);
    let i = 0;
    setPhase(phases[0]);
    const tick = () => {
      i++;
      if (i >= phases.length) {
        onDone();
        setTimeout(() => { setPhase(null); onClose(); }, 600);
        return;
      }
      setPhase(phases[i]);
      setTimeout(tick, 700);
    };
    setTimeout(tick, 700);
  };

  return (
    <Modal open={open} onClose={() => { if (!phase) onClose(); }} title="Upload health record" subtitle="Encrypted client‑side · stored on IPFS · indexed on‑chain"
      footer={!phase ? <>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button icon="lock" onClick={start}>Encrypt &amp; upload</Button>
      </> : null}
      width={620}
    >
      {!phase ? (
        <>
          <div className="dropzone">
            <div className="dz-ico"><Icon name="file" size={20} /></div>
            <div className="dz-title">{filename}</div>
            <div className="dz-sub">2.4 MB · application/pdf · ready to encrypt</div>
          </div>
          <div className="field">
            <span className="label">Category</span>
            <div className="chip-row">
              {CATEGORIES.map((c) => (
                <button key={c.key} className={`chip${category === c.key ? ' on' : ''}`} onClick={() => setCategory(c.key)}>
                  <Icon name={c.icon} size={12} />{c.label}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Pipeline current={phase} steps={UPLOAD_STEPS} />
            <div style={{ background: 'var(--surface-inset)', borderRadius: 10, padding: 14, border: '1px solid var(--line)' }}>
              <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 6 }}>Status</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="sp" style={{ color: 'var(--brand)' }} />
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{UPLOAD_STEPS.find((s) => s.key === phase)?.label}…</div>
              </div>
              <div className="bar" style={{ marginTop: 12 }}>
                <i style={{ width: `${((UPLOAD_STEPS.findIndex((s) => s.key === phase) + 1) / UPLOAD_STEPS.length) * 100}%` }} />
              </div>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

function App() {
  const [connected, setConnected] = useState(false);
  const [role, setRole] = useState('patient');
  const [route, setRoute] = useState('overview');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [toasts, setToasts] = useState([]);

  const wallet = DEMO_WALLETS[role];

  const pushToast = useCallback((t) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((arr) => [...arr, { id, ...t }]);
    setTimeout(() => setToasts((arr) => arr.filter((x) => x.id !== id)), 3000);
  }, []);

  // Titles for the topbar crumb
  const titles = {
    patient: {
      overview: ['Patient Dashboard', 'Your records, consents and audit trail'],
      upload:   ['Upload health record', 'Encrypt and store on IPFS'],
      records:  ['My records', 'All your encrypted records'],
      consents: ['Active consents', 'Who currently has access'],
      requests: ['Pending requests', 'Doctors awaiting your decision'],
      history:  ['Access history', 'Every record view on the chain'],
    },
    doctor: {
      overview: ['Doctor Dashboard', 'Your active consents and access history'],
      request:  ['Request access', 'Ask a patient for record access'],
      consents: ['My consents', 'Patients who granted you access'],
      history:  ['Access history', 'Your record‑view audit log'],
      key:      ['Encryption key', 'Your published ECIES pubkey'],
    },
    admin: {
      overview: ['Admin Panel', 'Platform health and governance'],
      doctors:  ['Doctors', 'Registered and revoked doctors'],
      register: ['Register doctor', 'Grant DOCTOR_ROLE to a wallet'],
      emergency:['Emergency audit', 'Break‑glass access invocations'],
      activity: ['Activity feed', 'Recent platform events'],
    },
  };
  const [title, sub] = titles[role][route] || ['', ''];

  if (!connected) {
    return (
      <div className="app">
        <div className="mesh-bg"><div className="mesh-c" /></div>
        <ScreenConnect onConnect={() => setConnected(true)} />
        <ToastStack items={toasts} />
      </div>
    );
  }

  return (
    <div className="app">
      <div className="mesh-bg"><div className="mesh-c" /></div>
      <div className="shell">
        <Sidebar role={role} setRole={setRole} route={route} setRoute={setRoute} walletAddr={wallet} />
        <div className="main-col">
          <Topbar title={title} sub={sub} onDisconnect={() => setConnected(false)} />
          <main className="content">
            {role === 'patient' && <ScreenPatient route={route} setRoute={setRoute} openUpload={() => setUploadOpen(true)} toast={pushToast} />}
            {role === 'doctor'  && <ScreenDoctor  route={route} setRoute={setRoute} toast={pushToast} />}
            {role === 'admin'   && <ScreenAdmin   route={route} setRoute={setRoute} toast={pushToast} />}
          </main>
        </div>
      </div>
      <UploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} onDone={() => pushToast({ title: 'Record uploaded', body: 'IPFS CID stored on‑chain.' })} />
      <ToastStack items={toasts} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
