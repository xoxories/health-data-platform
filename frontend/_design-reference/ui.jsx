// UI primitives — Button, Card, Pill, AddressDisplay, etc.

const { useState, useEffect, useRef, useCallback } = React;

// --- Button -----------------------------------------------------------------
function Button({ variant = 'primary', size = 'md', loading, icon, iconRight, children, className = '', ...rest }) {
  const cls = `btn btn-${variant}${size === 'sm' ? ' btn-sm' : size === 'lg' ? ' btn-lg' : ''} ${className}`;
  return (
    <button className={cls} disabled={loading || rest.disabled} {...rest}>
      {loading ? <span className="sp" /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={size === 'sm' ? 14 : 16} /> : null}
    </button>
  );
}

// --- Card -------------------------------------------------------------------
function Card({ title, sub, icon, action, tone, flush, padding, glass, children, className = '' }) {
  const t = tone ? ` tone-${tone}` : '';
  const g = glass ? ' glass' : '';
  return (
    <section className={`card${t}${g} ${className}`}>
      {(title || action) && (
        <header className="card-header">
          {icon ? (
            <div style={{
              width: 32, height: 32, borderRadius: 10, display: 'grid', placeItems: 'center',
              background: 'var(--brand-soft)', color: 'var(--brand)', flex: 'none',
            }}><Icon name={icon} size={16} /></div>
          ) : null}
          <div style={{ minWidth: 0 }}>
            {title && <div className="card-title">{title}</div>}
            {sub && <div className="card-sub">{sub}</div>}
          </div>
          {action && <div className="card-action">{action}</div>}
        </header>
      )}
      <div className={flush ? 'card-body-flush' : 'card-body'} style={padding === 'compact' ? { padding: 14 } : undefined}>
        {children}
      </div>
    </section>
  );
}

// --- StatusPill -------------------------------------------------------------
function StatusPill({ status = 'active', children, icon }) {
  return (
    <span className={`spill ${status}`}>
      <span className="dt" />
      {children}
    </span>
  );
}

// --- AddressDisplay ---------------------------------------------------------
function AddressDisplay({ address, size = 'md', label }) {
  const [copied, setCopied] = useState(false);
  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '';
  const copy = (e) => {
    e?.stopPropagation();
    navigator.clipboard?.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <button className={`addr${size === 'lg' ? ' lg' : ''}`} onClick={copy} title={address}>
      {label && <span style={{ color: 'var(--ink-3)', marginRight: 4 }}>{label}</span>}
      <span>{short}</span>
      <Icon name={copied ? 'check' : 'copy'} className="copy-ico" />
    </button>
  );
}

// --- Stat -------------------------------------------------------------------
function Stat({ label, value, icon, tone, delta, deltaDirection }) {
  return (
    <div className={`stat${tone ? ' tone-' + tone : ''}`} style={{ position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1 }}>
        <div className="stat-label">
          {icon && <Icon name={icon} className="ico" />}
          {label}
        </div>
        <div className="stat-value">{value}</div>
        {delta && (
          <div className={`stat-delta${deltaDirection ? ' ' + deltaDirection : ''}`}>
            {deltaDirection === 'up' && <Icon name="arrowUpRight" size={12} />}
            {delta}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Empty state ------------------------------------------------------------
function Empty({ icon = 'pulse', title, body, action }) {
  return (
    <div className="empty">
      <div className="empty-ico"><Icon name={icon} size={22} /></div>
      <div className="empty-title">{title}</div>
      {body && <div className="empty-body">{body}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

// --- Modal ------------------------------------------------------------------
function Modal({ open, onClose, title, subtitle, children, footer, width }) {
  useEffect(() => {
    if (!open) return;
    const k = (e) => e.key === 'Escape' && onClose?.();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          {subtitle && <div className="modal-sub">{subtitle}</div>}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// --- Toast ------------------------------------------------------------------
function ToastStack({ items }) {
  return (
    <div className="toast-stack">
      {items.map((t) => (
        <div key={t.id} className="toast">
          <div className="t-ico" style={t.tone === 'danger' ? { background: 'var(--danger-soft)', color: 'var(--danger)' } : t.tone === 'warn' ? { background: 'var(--warn-soft)', color: 'var(--warn)' } : undefined}>
            <Icon name={t.tone === 'danger' ? 'warning' : t.tone === 'warn' ? 'info' : 'check'} size={14} />
          </div>
          <div>
            <div className="t-title">{t.title}</div>
            {t.body && <div className="t-body">{t.body}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

// --- Pipeline ---------------------------------------------------------------
function Pipeline({ steps, current }) {
  const idx = steps.findIndex((s) => s.key === current);
  return (
    <div className="pipeline">
      {steps.map((s, i) => {
        const state = i < idx ? 'done' : i === idx ? 'current' : 'pending';
        return (
          <div key={s.key} className={`step ${state}`}>
            <div className="indicator">{state === 'done' ? <Icon name="check" size={12} /> : state === 'current' ? '' : i + 1}</div>
            <div className="step-label">{s.label}</div>
          </div>
        );
      })}
    </div>
  );
}

// --- Theme toggle -----------------------------------------------------------
function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute('data-theme') || 'light');
  const toggle = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('hdp-theme', next); } catch {}
  };
  useEffect(() => {
    try {
      const saved = localStorage.getItem('hdp-theme');
      if (saved) { setTheme(saved); document.documentElement.setAttribute('data-theme', saved); }
    } catch {}
  }, []);
  return (
    <button className="icon-btn" onClick={toggle} aria-label="Toggle theme" title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}>
      <Icon name={theme === 'light' ? 'moon' : 'sun'} size={16} />
    </button>
  );
}

Object.assign(window, { Button, Card, StatusPill, AddressDisplay, Stat, Empty, Modal, ToastStack, Pipeline, ThemeToggle });
