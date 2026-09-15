const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT || 5050);
const ROOT = __dirname;
const DATA_DIR = process.env.TELEM2_DATA_DIR || path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DELETED_BACKUP_DIR = path.join(DATA_DIR, 'deleted-backups');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DELETED_BACKUP_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'telem2.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_no TEXT NOT NULL,
  date TEXT NOT NULL,
  notes TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pilots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pilot_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tag TEXT NOT NULL CHECK(tag IN ('sd card','regular')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS uavs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uav_id TEXT NOT NULL UNIQUE,
  drone_type TEXT NOT NULL CHECK(drone_type IN ('sd card','regular')),
  status TEXT NOT NULL DEFAULT 'available',
  notes TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  w_group TEXT NOT NULL DEFAULT 'W1',
  position INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'planned',
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE TABLE IF NOT EXISTS scenarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'CALM',
  position INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(round_id) REFERENCES rounds(id)
);
CREATE TABLE IF NOT EXISTS flights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flight_id TEXT NOT NULL UNIQUE,
  session_id INTEGER NOT NULL,
  round_id INTEGER,
  scenario_id INTEGER,
  pilot_id TEXT,
  uav_id TEXT,
  battery_id TEXT,
  fl TEXT,
  mode TEXT DEFAULT 'CALM',
  weather TEXT DEFAULT 'W1',
  rep TEXT DEFAULT 'REP-01',
  status TEXT NOT NULL DEFAULT 'planned',
  result TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  operator TEXT DEFAULT '',
  claimed_by TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id),
  FOREIGN KEY(round_id) REFERENCES rounds(id),
  FOREIGN KEY(scenario_id) REFERENCES scenarios(id)
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flight_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(flight_id) REFERENCES flights(flight_id)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flight_id TEXT,
  event_type TEXT NOT NULL,
  details TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
`);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(ROOT, 'public')));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES || 5 * 1024 * 1024 * 1024) }
});
const now = () => new Date().toISOString();
const broadcast = () => clients.forEach(res => { try { res.write(`data: ${JSON.stringify({ type: 'refresh', at: now() })}\n\n`); } catch (_) {} });
const clients = new Set();
const emitEvent = (flightId, type, details = '') => {
  db.prepare('INSERT INTO events (flight_id,event_type,details,created_at) VALUES (?,?,?,?)').run(flightId || null, type, details, now());
  broadcast();
};
const normalizeTag = value => String(value || '').toLowerCase() === 'sd card' ? 'sd card' : 'regular';
const normalizeMode = value => String(value || '').toUpperCase() === 'DYN' ? 'DYN' : 'CALM';
const normalizeWeather = value => String(value || '').toUpperCase() === 'W2' ? 'W2' : 'W1';
const nextFlightId = () => {
  const row = db.prepare("SELECT flight_id FROM flights WHERE flight_id LIKE 'FL-%' ORDER BY id DESC LIMIT 1").get();
  const n = row ? Number(String(row.flight_id).replace('FL-', '')) + 1 : 1;
  return `FL-${String(n).padStart(6, '0')}`;
};
const autoRepeat = (sessionId, pilotId, scenarioId, mode, weather) => {
  const latest = db.prepare('SELECT * FROM flights WHERE session_id=? AND pilot_id=? AND scenario_id=? AND mode=? AND weather=? ORDER BY id DESC LIMIT 1').get(sessionId, pilotId, scenarioId, mode, weather);
  if (!latest) return 'REP-01';
  const current = Number(String(latest.rep || 'REP-01').replace('REP-', '')) || 1;
  return latest.status === 'completed' || latest.result === 'success' ? `REP-${String(Math.min(current + 1, 4)).padStart(2, '0')}` : `REP-${String(current).padStart(2, '0')}`;
};
const flightName = f => [f.flight_id, f.pilot_id, f.uav_id, f.battery_id, f.scenario_code, f.mode, f.weather, f.rep].filter(Boolean).join('__');

app.get('/api/health', (_, res) => res.json({ ok: true, port: PORT, time: now() }));
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders(); res.write(`data: ${JSON.stringify({ type: 'connected', at: now() })}\n\n`); clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.get('/api/state', (req, res) => {
  const requestedSessionId = Number(req.query.session_id || 0);
  const session = requestedSessionId ? (db.prepare('SELECT * FROM sessions WHERE id=?').get(requestedSessionId) || null) : null;
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY date DESC, id DESC').all();
  const pilots = db.prepare('SELECT * FROM pilots ORDER BY pilot_id').all();
  const uavs = db.prepare('SELECT * FROM uavs ORDER BY uav_id').all();
  const rounds = db.prepare('SELECT * FROM rounds WHERE session_id = ? ORDER BY position, id').all(session?.id || -1);
  const scenarios = db.prepare('SELECT * FROM scenarios WHERE round_id IN (SELECT id FROM rounds WHERE session_id = ?) ORDER BY position, id').all(session?.id || -1);
  const flights = db.prepare(`SELECT f.*, r.name round_name, s.code scenario_code, s.name scenario_name, p.name pilot_name, p.tag pilot_tag
    FROM flights f LEFT JOIN rounds r ON r.id=f.round_id LEFT JOIN scenarios s ON s.id=f.scenario_id LEFT JOIN pilots p ON p.pilot_id=f.pilot_id
    WHERE f.session_id = ? ORDER BY f.id`).all(session?.id || -1);
  const files = db.prepare('SELECT * FROM files ORDER BY id DESC').all();
  res.json({ session, sessions, pilots, uavs, rounds, scenarios, flights: flights.map(f => ({ ...f, display_name: flightName(f) })), files });
});

app.post('/api/session', (req, res) => {
  const body = req.body || {}; if (!body.session_no || !body.date) return res.status(400).json({ error: 'Session number and date are required.' });
  const t = now(); const tx = db.transaction(() => {
    db.prepare("UPDATE sessions SET status='closed', updated_at=? WHERE status='active'").run(t);
    const result = db.prepare('INSERT INTO sessions(session_no,date,notes,status,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(String(body.session_no), body.date, body.notes || '', 'active', t, t);
    return result.lastInsertRowid;
  });
  const id = tx(); emitEvent(null, 'session_created', `Session ${body.session_no}`); res.json({ id });
});
app.patch('/api/session/:id', (req, res) => {
  const body = req.body || {}; const t = now(); db.prepare('UPDATE sessions SET notes=COALESCE(?,notes), status=COALESCE(?,status), updated_at=? WHERE id=?').run(body.notes, body.status, t, req.params.id); emitEvent(null, 'session_updated'); res.json({ ok: true });
});
app.delete('/api/session/:id', (req, res) => {
  const id = Number(req.params.id); const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(id); if (!session) return res.status(404).json({ error: 'Session not found.' });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-'); const backupDir = path.join(DELETED_BACKUP_DIR, `${stamp}-session-${session.session_no.replace(/[^a-zA-Z0-9_-]/g, '_')}`); fs.mkdirSync(path.join(backupDir, 'files'), { recursive: true });
  const rounds = db.prepare('SELECT * FROM rounds WHERE session_id=?').all(id); const scenarios = db.prepare('SELECT * FROM scenarios WHERE round_id IN (SELECT id FROM rounds WHERE session_id=?)').all(id); const flights = db.prepare('SELECT * FROM flights WHERE session_id=?').all(id); const files = db.prepare('SELECT * FROM files WHERE flight_id IN (SELECT flight_id FROM flights WHERE session_id=?)').all(id);
  for (const file of files) if (fs.existsSync(file.stored_path)) fs.copyFileSync(file.stored_path, path.join(backupDir, 'files', file.original_name.replace(/[^a-zA-Z0-9._-]/g, '_')));
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({ session, rounds, scenarios, flights, files, backed_up_at: now() }, null, 2));
  const tx = db.transaction(() => {
    flights.forEach(f => { db.prepare('DELETE FROM files WHERE flight_id=?').run(f.flight_id); db.prepare('DELETE FROM events WHERE flight_id=?').run(f.flight_id); });
    db.prepare('DELETE FROM flights WHERE session_id=?').run(id); db.prepare('DELETE FROM scenarios WHERE round_id IN (SELECT id FROM rounds WHERE session_id=?)').run(id); db.prepare('DELETE FROM rounds WHERE session_id=?').run(id); db.prepare('DELETE FROM sessions WHERE id=?').run(id);
    flights.forEach(f => fs.rmSync(path.join(UPLOAD_DIR, f.flight_id), { recursive: true, force: true }));
  });
  tx(); emitEvent(null, 'session_deleted', `Session ${session.session_no}`); res.json({ ok: true, backup_dir: backupDir });
});

app.post('/api/pilots', (req, res) => {
  const { pilot_id, name, tag } = req.body || {}; if (!pilot_id || !name || !['sd card','regular'].includes(tag)) return res.status(400).json({ error: 'Pilot ID, name, and tag are required.' });
  const existing = db.prepare('SELECT * FROM pilots WHERE pilot_id=?').get(pilot_id);
  if (existing && existing.name !== name) return res.status(409).json({ error: 'Pilot IDs are immutable and already belong to another name.' });
  const t = now();
  if (existing) db.prepare('UPDATE pilots SET tag=?,active=1,updated_at=? WHERE pilot_id=?').run(tag, t, pilot_id);
  else db.prepare('INSERT INTO pilots(pilot_id,name,tag,created_at,updated_at) VALUES (?,?,?,?,?)').run(pilot_id, name, tag, t, t);
  broadcast(); res.json({ ok: true });
});
app.post('/api/uavs', (req, res) => {
  const { uav_id, drone_type, notes } = req.body || {}; if (!uav_id || !['sd card','regular'].includes(drone_type)) return res.status(400).json({ error: 'UAV ID and drone type are required.' });
  db.prepare('INSERT INTO uavs(uav_id,drone_type,notes) VALUES (?,?,?) ON CONFLICT(uav_id) DO UPDATE SET drone_type=excluded.drone_type,notes=excluded.notes').run(uav_id, drone_type, notes || ''); broadcast(); res.json({ ok: true });
});

app.post('/api/rounds', (req, res) => {
  const body = req.body || {}; const session = body.session_id ? db.prepare('SELECT id FROM sessions WHERE id=?').get(body.session_id) : db.prepare("SELECT id FROM sessions WHERE status='active' ORDER BY id DESC LIMIT 1").get(); if (!session) return res.status(400).json({ error: 'Create or select a session first.' });
  const result = db.prepare('INSERT INTO rounds(session_id,name,w_group,position,status) VALUES (?,?,?,?,?)').run(session.id, body.name || 'Round', normalizeWeather(body.w_group), Number(body.position || 0), 'planned'); broadcast(); res.json({ id: result.lastInsertRowid });
});
app.post('/api/scenarios', (req, res) => {
  const body = req.body || {}; if (!body.round_id || !body.name) return res.status(400).json({ error: 'Round and scenario are required.' });
  const codes = {'Linijinis skrydis A–B–A':'SC-01','Kvadratas':'SC-02','Ovalas':'SC-03','Freestyle / trys laiptai':'SC-04','Slalomas':'SC-05','Aštuoniukė':'SC-06'}; const code = body.code || codes[body.name] || 'SC-CUSTOM';
  const result = db.prepare('INSERT INTO scenarios(round_id,code,name,mode,position) VALUES (?,?,?,?,?)').run(body.round_id, code, body.name, 'CALM', Number(body.position || 0)); broadcast(); res.json({ id: result.lastInsertRowid });
});
app.post('/api/flights', (req, res) => {
  const body = req.body || {}; const session = body.session_id ? db.prepare('SELECT id FROM sessions WHERE id=?').get(body.session_id) : db.prepare("SELECT id FROM sessions WHERE status='active' ORDER BY id DESC LIMIT 1").get(); if (!session) return res.status(400).json({ error: 'Create or select a session first.' });
  if (!body.pilot_id || !body.scenario_id) return res.status(400).json({ error: 'Pilot and scenario are required.' });
  const scenario = db.prepare('SELECT s.*, r.w_group FROM scenarios s JOIN rounds r ON r.id=s.round_id WHERE s.id=?').get(body.scenario_id); if (!scenario) return res.status(400).json({ error: 'Scenario not found.' });
  const mode = scenario.mode || 'CALM'; const weather = normalizeWeather(scenario.w_group); const uavId = `UAV-${String(body.pilot_id).replace(/^PILOT-/, '')}`; const rep = autoRepeat(session.id, body.pilot_id, body.scenario_id, mode, weather); const pendingId = `PENDING-${crypto.randomUUID()}`;
  const result = db.prepare(`INSERT INTO flights(flight_id,session_id,round_id,scenario_id,pilot_id,uav_id,battery_id,fl,mode,weather,rep,status,notes,operator,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(pendingId, session.id, scenario.round_id, body.scenario_id, body.pilot_id, uavId, '', body.fl || '', mode, weather, rep, 'planned', body.notes || '', body.operator || '', now(), now());
  emitEvent(result.lastInsertRowid, 'flight_created'); res.json({ id: result.lastInsertRowid });
});
app.patch('/api/flights/:id', (req, res) => {
  const allowed = ['pilot_id','uav_id','battery_id','fl','mode','weather','rep','status','result','notes','operator','claimed_by','round_id','scenario_id'];
  const body = req.body || {}; const flight = db.prepare('SELECT * FROM flights WHERE id=?').get(req.params.id); if (!flight) return res.status(404).json({ error: 'Flight not found.' });
  const updates = []; const values = []; for (const key of allowed) if (body[key] !== undefined) { updates.push(`${key}=?`); values.push(key === 'mode' ? normalizeMode(body[key]) : key === 'weather' ? normalizeWeather(body[key]) : body[key]); }
  if (!updates.length) return res.json({ ok: true }); updates.push('updated_at=?'); values.push(now(), req.params.id);
  db.prepare(`UPDATE flights SET ${updates.join(',')} WHERE id=?`).run(...values); emitEvent(flight.flight_id, 'flight_updated', JSON.stringify(body)); res.json({ ok: true });
});

app.post('/api/flights/:id/files', upload.array('files', 10), (req, res) => {
  const flight = db.prepare('SELECT * FROM flights WHERE id=?').get(req.params.id); if (!flight) return res.status(404).json({ error: 'Flight not found.' });
  const requestedKind = req.body.kind || 'telemetry'; const kind = requestedKind === 'goggles' ? 'goggles' : 'telemetry'; const folderName = kind === 'goggles' ? 'goggles' : 'blackbox'; const destination = path.join(UPLOAD_DIR, flight.flight_id, folderName); fs.mkdirSync(destination, { recursive: true });
  const allowed = kind === 'goggles' ? ['.mp4','.mov','.mkv','.webm'] : ['.bbl','.bfl','.dat','.txt','.csv'];
  for (const file of req.files || []) { const ext = path.extname(file.originalname).toLowerCase(); if (!allowed.includes(ext)) { fs.rmSync(file.path, { force: true }); return res.status(400).json({ error: `Invalid ${kind} file. Allowed: ${allowed.join(', ')}` }); } }
  const saved = [];
  for (const file of req.files || []) {
    const finalPath = path.join(destination, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`); fs.renameSync(file.path, finalPath);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(finalPath)).digest('hex');
    const r = db.prepare('INSERT INTO files(flight_id,kind,original_name,stored_path,size,sha256,created_at) VALUES (?,?,?,?,?,?,?)').run(flight.flight_id, kind, file.originalname, finalPath, file.size, hash, now()); saved.push({ id: r.lastInsertRowid, original_name: file.originalname, size: file.size, sha256: hash });
  }
  let assignedFlightId = flight.flight_id; let assignedFlightDbId = flight.id; const kinds = db.prepare('SELECT DISTINCT kind FROM files WHERE flight_id=?').all(flight.flight_id).map(x => x.kind);
  if (flight.flight_id.startsWith('PENDING-') && kinds.includes('telemetry') && kinds.includes('goggles')) {
    assignedFlightId = nextFlightId(); const oldRoot = path.join(UPLOAD_DIR, flight.flight_id); const newRoot = path.join(UPLOAD_DIR, assignedFlightId);
    const migrate = db.transaction(() => {
      const result = db.prepare(`INSERT INTO flights(flight_id,session_id,round_id,scenario_id,pilot_id,uav_id,battery_id,fl,mode,weather,rep,status,result,notes,operator,claimed_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(assignedFlightId, flight.session_id, flight.round_id, flight.scenario_id, flight.pilot_id, flight.uav_id, flight.battery_id, flight.fl, flight.mode, flight.weather, flight.rep, flight.status, flight.result, flight.notes, flight.operator, flight.claimed_by, flight.created_at, now());
      assignedFlightDbId = result.lastInsertRowid; db.prepare('UPDATE files SET flight_id=?,stored_path=replace(stored_path,?,?) WHERE flight_id=?').run(assignedFlightId, oldRoot, newRoot, flight.flight_id); db.prepare('UPDATE events SET flight_id=? WHERE flight_id=?').run(assignedFlightId, flight.flight_id); db.prepare('DELETE FROM flights WHERE id=?').run(flight.id);
    });
    migrate(); if (fs.existsSync(oldRoot)) fs.renameSync(oldRoot, newRoot);
    const scenario = db.prepare('SELECT code FROM scenarios WHERE id=?').get(flight.scenario_id); const stem = [assignedFlightId, flight.pilot_id, scenario?.code || 'SC', flight.mode, flight.weather, flight.rep].filter(Boolean).join('_').replace(/[^a-zA-Z0-9_-]/g, '_');
    const completedFiles = db.prepare('SELECT * FROM files WHERE flight_id=?').all(assignedFlightId);
    for (const stored of completedFiles) { const folder = stored.kind === 'goggles' ? 'goggles' : 'blackbox'; const ext = path.extname(stored.original_name).toLowerCase(); const finalPath = path.join(newRoot, folder, `${stem}${ext}`); if (fs.existsSync(stored.stored_path)) fs.renameSync(stored.stored_path, finalPath); db.prepare('UPDATE files SET stored_path=? WHERE id=?').run(finalPath, stored.id); }
  }
  emitEvent(assignedFlightId, 'files_uploaded', `${saved.length} ${kind} file(s)`); res.json({ files: saved, flight_id: assignedFlightId, flight_db_id: assignedFlightDbId, assigned: assignedFlightId !== flight.flight_id });
});
app.get('/api/files/:id', (req, res) => { const f = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.id); if (!f || !fs.existsSync(f.stored_path)) return res.status(404).end(); res.download(f.stored_path, f.original_name); });

function csvEscape(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function exportCsv() {
  const rows = db.prepare(`SELECT f.flight_id, f.pilot_id, p.name pilot_name, f.uav_id, f.battery_id, f.scenario_id, s.code scenario_code, f.mode, f.weather, f.rep, f.status, f.result, f.notes, f.created_at, f.updated_at
    FROM flights f LEFT JOIN pilots p ON p.pilot_id=f.pilot_id LEFT JOIN scenarios s ON s.id=f.scenario_id ORDER BY f.id`).all();
  const headers = Object.keys(rows[0] || { flight_id:'', pilot_id:'', pilot_name:'', uav_id:'', battery_id:'', scenario_code:'', mode:'', weather:'', rep:'', status:'', result:'', notes:'', created_at:'', updated_at:'' });
  return [headers.join(','), ...rows.map(r => headers.map(h => csvEscape(r[h])).join(','))].join('\n');
}
app.get('/api/export.csv', (_, res) => { res.set('Content-Type', 'text/csv; charset=utf-8'); res.set('Content-Disposition', 'attachment; filename=telem2-flights.csv'); res.send(exportCsv()); });
app.post('/api/sync', (req, res) => {
  const exportPath = path.join(DATA_DIR, `telem2-flights-${new Date().toISOString().slice(0,10)}.csv`); fs.writeFileSync(exportPath, exportCsv());
  const folder = process.env.GOOGLE_DRIVE_FOLDER_ID || '';
  if (!folder) return res.json({ ok: true, local_export: exportPath, message: 'Local export created. Set GOOGLE_DRIVE_FOLDER_ID to upload snapshots to Drive.' });
  const json = JSON.stringify({ name: path.basename(exportPath), parents: [folder] });
  execFile('gws', ['drive','files','create','--upload',exportPath,'--json',json,'--upload-content-type','text/csv'], { timeout: 60000 }, (error, stdout, stderr) => {
    if (error) return res.status(502).json({ ok: false, local_export: exportPath, error: stderr || error.message });
    res.json({ ok: true, local_export: exportPath, drive: stdout });
  });
});

app.get('*', (_, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`Telem2 listening on http://0.0.0.0:${PORT}`));
