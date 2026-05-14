// Connect Wallet — landing screen

function ScreenConnect({ onConnect }) {
  const [connecting, setConnecting] = useState(false);
  const handle = () => {
    setConnecting(true);
    setTimeout(() => { setConnecting(false); onConnect(); }, 900);
  };

  return (
    <div className="hero-wrap">
      <div style={{ position: 'absolute', top: 24, left: 24, zIndex: 2, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="brand-mark" style={{ width: 36, height: 36, borderRadius: 11 }}><Icon name="cross" size={18} /></div>
        <div>
          <div style={{ fontFamily: 'Sora', fontWeight: 700, fontSize: 14, color: 'var(--ink)' }}>Health Data Platform</div>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '.04em' }}>Decentralized · Patient‑Owned</div>
        </div>
      </div>
      <div style={{ position: 'absolute', top: 24, right: 24, zIndex: 2 }}>
        <ThemeToggle />
      </div>

      <div className="hero-card">
        <div className="hero-left">
          <span className="eyebrow"><span className="dt" /> Web3 · Healthcare</span>
          <h1 className="hero-title">Your medical records, <em>on‑chain</em> &amp; under your consent.</h1>
          <p className="hero-body">
            End‑to‑end encrypted records stored on IPFS, with patient‑mediated consent enforced cryptographically.
            Every access is auditable and revocable. No middleman holds a key you didn’t give them.
          </p>

          <div className="feature-row">
            <div className="feature">
              <div className="ico"><Icon name="lock" size={14} /></div>
              <div>
                <div className="ft-title">Client‑side AES‑GCM</div>
                <div className="ft-sub">Files encrypted before they leave you.</div>
              </div>
            </div>
            <div className="feature">
              <div className="ico"><Icon name="key" size={14} /></div>
              <div>
                <div className="ft-title">ECIES key wrap</div>
                <div className="ft-sub">No wrapped key — no plaintext path.</div>
              </div>
            </div>
            <div className="feature">
              <div className="ico"><Icon name="audit" size={14} /></div>
              <div>
                <div className="ft-title">On‑chain audit</div>
                <div className="ft-sub">Every view is an immutable event.</div>
              </div>
            </div>
            <div className="feature">
              <div className="ico"><Icon name="shieldcheck" size={14} /></div>
              <div>
                <div className="ft-title">Granular consent</div>
                <div className="ft-sub">Per‑category, time‑limited grants.</div>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
            <Button size="lg" icon="wallet" loading={connecting} onClick={handle}>
              {connecting ? 'Connecting…' : 'Connect Wallet'}
            </Button>
            <Button variant="secondary" size="lg" icon="info">How it works</Button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6, fontSize: 12, color: 'var(--ink-3)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className="pill" style={{ padding: '3px 8px', fontSize: 11 }}>Sepolia</span>
            </span>
            <span>·</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className="pill" style={{ padding: '3px 8px', fontSize: 11 }}>Hardhat Local</span>
            </span>
            <span>·</span>
            <span>Make sure your wallet is on a supported network.</span>
          </div>
        </div>

        <div className="hero-right">
          <div className="grid-overlay" />
          <div className="ring r1" />
          <div className="ring r2" />
          <div className="hero-mark"><Icon name="cross" size={28} /></div>

          {/* Mock chain receipt */}
          <div style={{ position: 'absolute', top: 130, right: 36, left: 36, zIndex: 2 }}>
            <div style={{
              background: 'color-mix(in oklch, var(--surface) 78%, transparent)',
              backdropFilter: 'blur(14px)',
              border: '1px solid var(--line)',
              borderRadius: 14,
              padding: 14,
              boxShadow: 'var(--shadow-md)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color: 'var(--brand)' }}>
                  <Icon name="link" size={12} /> CONSENT GRANT
                </div>
                <StatusPill status="active">Confirmed</StatusPill>
              </div>
              <div style={{ marginTop: 10, fontFamily: 'Sora', fontWeight: 600, fontSize: 13.5, color: 'var(--ink)' }}>
                grantAccess(doctor, BloodTest|Imaging, +30d)
              </div>
              <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8, fontFamily: 'JetBrains Mono', fontSize: 11, color: 'var(--ink-3)' }}>
                <span>tx: 0xf18a…9d4c</span>
                <span>·</span>
                <span>block 8,402,113</span>
                <span>·</span>
                <span>gas 84,231</span>
              </div>
            </div>
          </div>

          <div className="floating-stat" style={{ alignSelf: 'flex-start', marginTop: 'auto' }}>
            <div className="fs-ico"><Icon name="shieldcheck" size={16} /></div>
            <div>
              <div className="fs-title">Cryptographically enforced</div>
              <div className="fs-sub">93‑byte ECIES envelope per record</div>
            </div>
          </div>
          <div className="floating-stat fs-cyan">
            <div className="fs-ico"><Icon name="ipfs" size={16} /></div>
            <div>
              <div className="fs-title">IPFS via Pinata</div>
              <div className="fs-sub">Ciphertext only · tag‑verified on decrypt</div>
            </div>
          </div>
        </div>
      </div>

      <div style={{ position: 'absolute', bottom: 18, left: 0, right: 0, textAlign: 'center', fontSize: 11.5, color: 'var(--ink-3)', zIndex: 2 }}>
        Health Data Platform · Patient‑owned health‑record sharing on Ethereum
      </div>
    </div>
  );
}

window.ScreenConnect = ScreenConnect;
