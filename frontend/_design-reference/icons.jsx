// Lightweight icon library — original line icons drawn as SVG paths.
// Stroke-currentColor, sized via width/height props.

const Icon = ({ name, size = 18, className = '', strokeWidth = 1.7, ...rest }) => {
  const p = ICON_PATHS[name];
  if (!p) return null;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      {p}
    </svg>
  );
};

const ICON_PATHS = {
  // Brand
  pulse: (<>
    <path d="M3 12h4l2-6 4 12 2-6h6" />
  </>),
  cross: (<>
    <path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" />
  </>),
  shield: (<>
    <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />
    <path d="m9 12 2 2 4-4" />
  </>),
  // Wallet / chain
  wallet: (<>
    <path d="M3 7a2 2 0 0 1 2-2h12v4" />
    <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7H6" />
    <circle cx="17" cy="13.5" r="1.2" fill="currentColor" stroke="none" />
  </>),
  link: (<>
    <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 1 0-5.66-5.66l-1.5 1.5" />
    <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 1 0 5.66 5.66l1.5-1.5" />
  </>),
  hash: (<>
    <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
  </>),
  // Nav
  dashboard: (<>
    <rect x="3"  y="3"  width="8" height="10" rx="2" />
    <rect x="13" y="3"  width="8" height="6"  rx="2" />
    <rect x="13" y="11" width="8" height="10" rx="2" />
    <rect x="3"  y="15" width="8" height="6"  rx="2" />
  </>),
  upload: (<>
    <path d="M12 16V4" />
    <path d="m6 10 6-6 6 6" />
    <path d="M4 20h16" />
  </>),
  records: (<>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M8 8h8M8 12h8M8 16h5" />
  </>),
  users: (<>
    <circle cx="9" cy="9" r="3.5" />
    <path d="M2.5 19a6.5 6.5 0 0 1 13 0" />
    <path d="M16 11a3 3 0 1 0 0-6" />
    <path d="M22 19a6 6 0 0 0-5-5.92" />
  </>),
  user: (<>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </>),
  doctor: (<>
    <path d="M8 3v4a4 4 0 0 0 8 0V3" />
    <path d="M6 7a6 6 0 0 0 12 0" />
    <path d="M12 13v4" />
    <circle cx="12" cy="19" r="2" />
  </>),
  audit: (<>
    <rect x="3" y="3" width="14" height="18" rx="2" />
    <path d="M7 8h6M7 12h6M7 16h4" />
    <circle cx="19" cy="17" r="3" />
    <path d="m21 19 1 1" />
  </>),
  shieldcheck: (<>
    <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />
    <path d="m9 12 2 2 4-4" />
  </>),
  bell: (<>
    <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
    <path d="M10 19a2 2 0 0 0 4 0" />
  </>),
  activity: (<>
    <path d="M3 12h4l3-8 4 16 3-8h4" />
  </>),
  history: (<>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
    <path d="M12 7v5l3 2" />
  </>),
  emergency: (<>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v6" />
    <path d="M12 16v.5" />
  </>),
  // Actions
  copy: (<>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </>),
  check: (<path d="m5 12 5 5L20 7" />),
  x: (<><path d="M6 6 18 18M18 6 6 18" /></>),
  plus: (<><path d="M12 5v14M5 12h14" /></>),
  search: (<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>),
  arrowRight: (<><path d="M5 12h14M13 5l7 7-7 7" /></>),
  arrowUpRight: (<><path d="M7 17 17 7M9 7h8v8" /></>),
  arrowDown: (<><path d="M12 5v14M19 12l-7 7-7-7" /></>),
  refresh: (<><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></>),
  download: (<><path d="M12 4v12" /><path d="m6 14 6 6 6-6" /><path d="M4 20h16" /></>),
  trash: (<><path d="M4 7h16" /><path d="M10 4h4a1 1 0 0 1 1 1v2H9V5a1 1 0 0 1 1-1z" /><path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7" /><path d="M10 11v6M14 11v6" /></>),
  eye: (<><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" /><circle cx="12" cy="12" r="3" /></>),
  more: (<><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" /></>),
  // File / data
  file: (<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>),
  image: (<><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 16-5-5L5 21" /></>),
  pill: (<><rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-30 12 12)" /><path d="M8 8 16 16" transform="rotate(-30 12 12)" /></>),
  brain: (<><path d="M9 4a3 3 0 0 0-3 3v1a3 3 0 0 0-2 5 3 3 0 0 0 2 5v1a3 3 0 0 0 3 3" /><path d="M15 4a3 3 0 0 1 3 3v1a3 3 0 0 1 2 5 3 3 0 0 1-2 5v1a3 3 0 0 1-3 3" /><path d="M12 4v18" /></>),
  syringe: (<><path d="m18 2 4 4" /><path d="m15 5 4 4" /><path d="m11 9 7 7" /><path d="m7 13 4 4" /><path d="M3 21l4-1 6-6-3-3-6 6z" /></>),
  scalpel: (<><path d="M3 21 14 10l4 4-11 11z" /><path d="M14 10 21 3 14 3z" /></>),
  // Lock / crypto
  lock: (<><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>),
  key: (<><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9" /><path d="m17 6 3 3" /><path d="m14 9 3 3" /></>),
  // Theme
  sun: (<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></>),
  moon: (<><path d="M21 12.8A9 9 0 0 1 11.2 3a7 7 0 1 0 9.8 9.8z" /></>),
  // Clock & calendar
  clock: (<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  calendar: (<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>),
  // Misc
  warning: (<><path d="M12 3 2 21h20z" /><path d="M12 10v5M12 18v.5" /></>),
  info: (<><circle cx="12" cy="12" r="9" /><path d="M12 8v.5M12 11v6" /></>),
  spark: (<><path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z" /></>),
  ipfs: (<><circle cx="12" cy="12" r="9" /><path d="M12 3v18M3 12h18M5 7c4 3 10 3 14 0M5 17c4-3 10-3 14 0" /></>),
  network: (<><circle cx="12" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="19" r="2" /><path d="M12 7v3M12 13l-5.5 4.5M12 13l5.5 4.5" /></>),
  filter: (<><path d="M4 5h16l-6 8v6l-4-2v-4z" /></>),
  send: (<><path d="m22 2-7 20-4-9-9-4z" /></>),
  building: (<><rect x="4" y="3" width="16" height="18" rx="1" /><path d="M9 7h2M9 11h2M9 15h2M13 7h2M13 11h2M13 15h2" /></>),
  scroll: (<><path d="M19 17V5a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 1-2-2v0a2 2 0 0 1 2-2h2z" /><path d="M9 7h6M9 11h6M9 15h4" /></>),
  qr: (<><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM20 14v3M14 20h7" /></>),
  flame: (<><path d="M12 3s5 5 5 10a5 5 0 0 1-10 0c0-3 2-4 2-7 1 1 3 2 3-3z" /></>),
};

window.Icon = Icon;
