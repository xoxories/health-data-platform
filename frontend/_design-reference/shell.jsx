// App shell — sidebar + topbar.

function Sidebar({ role, setRole, route, setRoute, walletAddr }) {
  const navByRole = {
    patient: [
      { key: 'overview',  label: 'Overview',         icon: 'dashboard' },
      { key: 'upload',    label: 'Upload Record',    icon: 'upload' },
      { key: 'records',   label: 'My Records',       icon: 'records',  count: 12 },
      { key: 'consents',  label: 'Consents',         icon: 'shield',   count: 2 },
      { key: 'requests',  label: 'Pending Requests', icon: 'bell',     count: 2 },
      { key: 'history',   label: 'Access History',   icon: 'history' },
    ],
    doctor: [
      { key: 'overview',  label: 'Overview',         icon: 'dashboard' },
      { key: 'request',   label: 'Request Access',   icon: 'send' },
      { key: 'consents',  label: 'My Consents',      icon: 'shield',   count: 3 },
      { key: 'history',   label: 'Access History',   icon: 'history' },
      { key: 'key',       label: 'Encryption Key',   icon: 'key' },
    ],
    admin: [
      { key: 'overview',  label: 'Overview',         icon: 'dashboard' },
      { key: 'doctors',   label: 'Doctors',          icon: 'doctor',   count: 5 },
      { key: 'register',  label: 'Register Doctor',  icon: 'plus' },
      { key: 'emergency', label: 'Emergency Audit',  icon: 'emergency' },
      { key: 'activity',  label: 'Activity Feed',    icon: 'activity' },
    ],
  };
  const items = navByRole[role];

  return (
    <aside className="sidebar">
      <div className="brand-row">
        <div className="brand-mark"><Icon name="cross" size={20} /></div>
        <div style={{ minWidth: 0 }}>
          <div className="brand-name">Health Data Platform</div>
          <div className="brand-sub">Decentralized · v1.0</div>
        </div>
      </div>

      <div className="nav-group">
        <div className="nav-label">{role === 'patient' ? 'Patient' : role === 'doctor' ? 'Doctor' : 'Administrator'}</div>
        {items.map((it) => (
          <button
            key={it.key}
            className={`nav-item${route === it.key ? ' active' : ''}`}
            onClick={() => setRoute(it.key)}
          >
            <Icon name={it.icon} className="ico" />
            <span>{it.label}</span>
            {it.count !== undefined && <span className="count">{it.count}</span>}
          </button>
        ))}
      </div>

      <div className="role-panel">
        <div className="role-title">Demo · View as</div>
        <div className="role-switch">
          <button className={role === 'patient' ? 'on' : ''} onClick={() => { setRole('patient'); setRoute('overview'); }}>Patient</button>
          <button className={role === 'doctor'  ? 'on' : ''} onClick={() => { setRole('doctor');  setRoute('overview'); }}>Doctor</button>
          <button className={role === 'admin'   ? 'on' : ''} onClick={() => { setRole('admin');   setRoute('overview'); }}>Admin</button>
        </div>
        <div className="role-meta">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="wallet" size={13} style={{ color: 'var(--ink-3)' }} />
            <AddressDisplay address={walletAddr} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="network" size={13} style={{ color: 'var(--ink-3)' }} />
            <span style={{ fontSize: 12, color: 'var(--ink-2)' }}>Sepolia testnet</span>
          </div>
        </div>
      </div>
    </aside>
  );
}

function Topbar({ title, sub, onDisconnect }) {
  return (
    <header className="topbar">
      <div className="crumb">
        <div style={{ minWidth: 0 }}>
          <div className="crumb-title">{title}</div>
          {sub && <div className="crumb-sub">{sub}</div>}
        </div>
      </div>

      <div className="topbar-actions">
        <div className="input-with-icon" style={{ width: 280 }}>
          <Icon name="search" className="ico" size={14} />
          <input className="input" placeholder="Search records, addresses…" />
        </div>

        <span className="pill"><span className="dot" /> Sepolia · 11155111</span>

        <button className="icon-btn" aria-label="Notifications">
          <Icon name="bell" size={16} />
        </button>

        <ThemeToggle />

        <button className="icon-btn" aria-label="Disconnect" onClick={onDisconnect} title="Disconnect wallet">
          <Icon name="x" size={16} />
        </button>
      </div>
    </header>
  );
}

Object.assign(window, { Sidebar, Topbar });
