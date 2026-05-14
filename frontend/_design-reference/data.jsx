// Mock data — simulated state for the prototype.

const CATEGORIES = [
  { key: 'General',      label: 'General',      icon: 'file' },
  { key: 'BloodTest',    label: 'Blood Test',   icon: 'activity' },
  { key: 'Imaging',      label: 'Imaging',      icon: 'image' },
  { key: 'Prescription', label: 'Prescription', icon: 'pill' },
  { key: 'MentalHealth', label: 'Mental Health',icon: 'brain' },
  { key: 'Surgery',      label: 'Surgery',      icon: 'scalpel' },
  { key: 'Vaccination',  label: 'Vaccination',  icon: 'syringe' },
];

const DEMO_WALLETS = {
  admin:   '0xA1cE3F4d7B2E9c5e8A40c8F1d9D7E0b6cC4b1234',
  patient: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  doctor:  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
};

const PATIENTS = [
  { addr: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', name: 'Aria Chen',     joined: '2026-02-08', records: 12 },
  { addr: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', name: 'Marcus Vega',   joined: '2026-03-14', records: 6  },
  { addr: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', name: 'Lina Karimi',   joined: '2026-04-02', records: 21 },
];

const DOCTORS = [
  { addr: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', name: 'Dr. Sina Park',     hospital: 'Riverbend General',    license: '0x7c2a…9f10', registered: '2026-01-22', status: 'active'  },
  { addr: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', name: 'Dr. Joon Albright', hospital: 'Cedar Heights Medical', license: '0x4b8c…2e0a', registered: '2026-02-09', status: 'active'  },
  { addr: '0x976EA74026E726554dB657fA54763abd0C3a0aa9', name: 'Dr. Ines Romero',   hospital: 'Northgate Hospital',    license: '0x9d12…77af', registered: '2026-03-01', status: 'active'  },
  { addr: '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955', name: 'Dr. Olafur Brandt', hospital: 'Belmar Clinic Group',   license: '0x2e90…b1c3', registered: '2026-03-18', status: 'revoked', reason: 'Compliance violation — unauthorized data sharing' },
  { addr: '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f', name: 'Dr. Priya Devarajan',hospital: 'Aurora Health Network', license: '0x6f33…4ad2', registered: '2026-04-05', status: 'active'  },
];

const RECORDS = [
  { id: 1, category: 'BloodTest',    filename: 'cbc-panel-2026-04-18.pdf', uploaded: '2026-04-18T09:23:00Z', cid: 'bafybeicfqyzg7y2xq4hjrgkc3w5vw5sd4hvqx7lkbpbb6gj2u3rrnnzqcm', size: '142 KB' },
  { id: 2, category: 'Imaging',      filename: 'chest-xray.jpg',           uploaded: '2026-04-12T14:08:00Z', cid: 'bafkreiabcdef1234567890qwxyzabcdefghijklmnopqrstuvwxy12345',     size: '2.4 MB' },
  { id: 3, category: 'Prescription', filename: 'atorvastatin-10mg.pdf',    uploaded: '2026-03-30T11:50:00Z', cid: 'bafybeigh4eyq8l2tpvy7zxs6m9axuc8n0eg5wfb2mrkdq3whnpvc6lf7yi',     size:  '88 KB' },
  { id: 4, category: 'General',      filename: 'annual-physical.pdf',      uploaded: '2026-03-15T16:32:00Z', cid: 'bafybeih7gh5xv2kjadqkn3jt5yvqlpz8rfn7sx2c1qab9w3pn6vfdh4uta',     size: '310 KB' },
  { id: 5, category: 'Vaccination',  filename: 'influenza-record.pdf',     uploaded: '2026-02-22T08:14:00Z', cid: 'bafkrei8xahg5kc7zndqp1jvqzh9ercrn2j6rsxbnap0lthdv8cy3y1m4ne',     size:  '54 KB' },
  { id: 6, category: 'BloodTest',    filename: 'lipid-panel-q1.pdf',       uploaded: '2026-02-04T10:45:00Z', cid: 'bafybeibwfh4nqr8sxq2dyk3mng2hpj1tv6c7xfeznabmlqg9rhxpdoq3eu',     size: '128 KB' },
];

const PENDING_REQUESTS = [
  { id: 'r1', doctor: DOCTORS[0], requested: '2026-05-11T13:00:00Z', message: 'Follow-up cardiology consult' },
  { id: 'r2', doctor: DOCTORS[2], requested: '2026-05-10T09:22:00Z', message: 'Imaging review for upcoming surgery' },
];

const ACTIVE_CONSENTS = [
  { id: 'c1', doctor: DOCTORS[1], categories: ['BloodTest', 'Prescription'], records: 3, expiresAt: '2026-06-12', granted: '2026-04-12' },
  { id: 'c2', doctor: DOCTORS[4], categories: ['Imaging'],                    records: 1, expiresAt: '2026-05-21', granted: '2026-04-21' },
];

const PATIENT_ACCESS_HISTORY = [
  { type: 'access',    actor: DOCTORS[1], recordId: 1, category: 'BloodTest',    ts: '2026-05-13T08:42:00Z' },
  { type: 'access',    actor: DOCTORS[1], recordId: 3, category: 'Prescription', ts: '2026-05-12T17:11:00Z' },
  { type: 'emergency', actor: DOCTORS[2], recordId: 2, category: 'Imaging',      ts: '2026-05-11T03:09:00Z', reason: 'Patient unconscious — trauma intake (ER‑A09421)' },
  { type: 'access',    actor: DOCTORS[1], recordId: 6, category: 'BloodTest',    ts: '2026-05-09T11:25:00Z' },
  { type: 'access',    actor: DOCTORS[4], recordId: 2, category: 'Imaging',      ts: '2026-05-04T15:50:00Z' },
];

const DOCTOR_CONSENTS = [
  { patient: PATIENTS[0], categories: ['BloodTest', 'Prescription'], records: 3, expiresAt: '2026-06-12' },
  { patient: PATIENTS[1], categories: ['General','Vaccination'],     records: 2, expiresAt: '2026-05-30' },
  { patient: PATIENTS[2], categories: ['Imaging'],                   records: 4, expiresAt: '2026-07-04' },
];

const DOCTOR_HISTORY = [
  { type: 'access',    patient: PATIENTS[0], recordId: 1, category: 'BloodTest',    ts: '2026-05-13T08:42:00Z' },
  { type: 'access',    patient: PATIENTS[2], recordId: 14, category: 'Imaging',     ts: '2026-05-12T13:08:00Z' },
  { type: 'access',    patient: PATIENTS[0], recordId: 3, category: 'Prescription', ts: '2026-05-12T17:11:00Z' },
  { type: 'emergency', patient: PATIENTS[1], recordId: 9, category: 'General',      ts: '2026-05-11T03:09:00Z', reason: 'Trauma intake — patient unable to consent' },
  { type: 'access',    patient: PATIENTS[2], recordId: 13, category: 'Imaging',     ts: '2026-05-08T10:18:00Z' },
];

const EMERGENCY_AUDIT = [
  { doctor: DOCTORS[2], patient: PATIENTS[1], recordId: 9, ts: '2026-05-11T03:09:00Z', reason: 'Trauma intake (ER-A09421) — patient unable to consent', txHash: '0xf18a…9d4c' },
  { doctor: DOCTORS[1], patient: PATIENTS[0], recordId: 4, ts: '2026-04-28T22:11:00Z', reason: 'Cardiac arrest — required prior surgery records', txHash: '0xb320…7f10' },
  { doctor: DOCTORS[0], patient: PATIENTS[2], recordId: 17, ts: '2026-04-15T01:42:00Z', reason: 'Anaphylaxis — pulled vaccination history', txHash: '0xd80e…2a8c' },
];

const RECENT_ACTIVITY = [
  { type: 'grant',    text: 'Aria Chen granted Blood Test + Prescription access to Dr. Joon Albright', ts: '2026-05-13T08:42:00Z' },
  { type: 'upload',   text: 'Marcus Vega uploaded a new General record',                                ts: '2026-05-13T07:11:00Z' },
  { type: 'revoke',   text: 'Lina Karimi revoked Imaging consent from Dr. Olafur Brandt',              ts: '2026-05-12T19:30:00Z' },
  { type: 'register', text: 'Dr. Priya Devarajan registered (Aurora Health Network)',                  ts: '2026-05-12T16:02:00Z' },
  { type: 'upload',   text: 'Aria Chen uploaded a new Imaging record',                                  ts: '2026-05-12T11:25:00Z' },
  { type: 'emergency',text: 'Dr. Ines Romero invoked emergency access on Marcus Vega (rec #9)',         ts: '2026-05-11T03:09:00Z' },
];

const UPLOAD_STEPS = [
  { key: 'encrypting', label: 'Encrypting' },
  { key: 'uploading',  label: 'Uploading to IPFS' },
  { key: 'wrapping',   label: 'Wrapping AES key' },
  { key: 'signing',    label: 'Awaiting signature' },
  { key: 'confirming', label: 'Confirming tx' },
  { key: 'done',       label: 'Complete' },
];

// Time helpers
function relTime(iso) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function absTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function daysUntil(iso) {
  const d = new Date(iso);
  const diff = (d.getTime() - Date.now()) / (1000 * 86400);
  return Math.max(0, Math.ceil(diff));
}

Object.assign(window, {
  CATEGORIES, DEMO_WALLETS,
  PATIENTS, DOCTORS, RECORDS,
  PENDING_REQUESTS, ACTIVE_CONSENTS, PATIENT_ACCESS_HISTORY,
  DOCTOR_CONSENTS, DOCTOR_HISTORY,
  EMERGENCY_AUDIT, RECENT_ACTIVITY,
  UPLOAD_STEPS,
  relTime, absTime, daysUntil,
});
