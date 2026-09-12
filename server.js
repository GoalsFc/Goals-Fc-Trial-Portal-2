// Goals FC Trial Portal — persistent PostgreSQL backend
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'goalsfc2026';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-session-secret';
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'players.json');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. PostgreSQL is required in production.');
}

const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
}) : null;

async function initDb() {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id BIGSERIAL PRIMARY KEY,
      reference TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      dob TEXT,
      age TEXT,
      phone TEXT NOT NULL,
      email TEXT,
      area TEXT,
      position TEXT NOT NULL,
      secondary TEXT,
      foot TEXT,
      height TEXT,
      weight TEXT,
      previous_club TEXT,
      competition TEXT,
      experience TEXT,
      emergency_name TEXT,
      emergency_phone TEXT,
      status TEXT NOT NULL DEFAULT 'Pending',
      scores JSONB NOT NULL DEFAULT '{}'::jsonb,
      notes TEXT NOT NULL DEFAULT '',
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_players_submitted_at ON players(submitted_at DESC)`);
  await migrateJsonIfNeeded();
}

async function migrateJsonIfNeeded() {
  if (!fs.existsSync(DATA_FILE)) return;
  let old;
  try { old = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return; }
  if (!Array.isArray(old) || old.length === 0) return;
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM players');
  if (rows[0].count > 0) return;
  for (const p of old) {
    await insertPlayer(p);
  }
  console.log(`Migrated ${old.length} player(s) from data/players.json to PostgreSQL.`);
}

async function insertPlayer(p) {
  await pool.query(`
    INSERT INTO players (
      reference, full_name, dob, age, phone, email, area, position, secondary, foot,
      height, weight, previous_club, competition, experience, emergency_name,
      emergency_phone, status, scores, notes, submitted_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
    ON CONFLICT (reference) DO NOTHING
  `, [
    p.reference, p.fullName, p.dob || null, p.age || null, p.phone, p.email || null,
    p.area || null, p.position, p.secondary || null, p.foot || null, p.height || null,
    p.weight || null, p.previousClub || null, p.competition || null, p.experience || null,
    p.emergencyName || null, p.emergencyPhone || null, p.status || 'Pending',
    JSON.stringify(p.scores || {}), p.notes || '', p.submittedAt || new Date().toISOString()
  ]);
}

function makeReference() {
  const year = new Date().getFullYear();
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `GFC-${year}-${rand}`;
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return false;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Date.now();
  } catch { return false; }
}
function requireAdmin(req, res, next) {
  const token = req.query.token || (req.body && req.body.token) || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!verifyToken(token)) return res.status(401).json({ error: 'Session expired. Please log in again.' });
  next();
}

function rowToPlayer(r) {
  return {
    reference: r.reference, fullName: r.full_name, dob: r.dob, age: r.age,
    phone: r.phone, email: r.email, area: r.area, position: r.position,
    secondary: r.secondary, foot: r.foot, height: r.height, weight: r.weight,
    previousClub: r.previous_club, competition: r.competition, experience: r.experience,
    emergencyName: r.emergency_name, emergencyPhone: r.emergency_phone,
    status: r.status, scores: r.scores || {}, notes: r.notes || '',
    submittedAt: r.submitted_at,
  };
}

function toCSV(players) {
  const cols = ['reference','fullName','dob','age','phone','email','area','position','secondary','foot','height','weight','previousClub','competition','experience','emergencyName','emergencyPhone','status','notes','submittedAt'];
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(','), ...players.map(p => cols.map(c => esc(p[c])).join(','))].join('\n');
}

app.get('/api/health', async (req, res) => {
  if (!pool) return res.status(503).json({ ok: false, database: 'not configured' });
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: 'connected' });
  } catch (e) {
    res.status(503).json({ ok: false, database: 'error', message: e.message });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const d = req.body || {};
    if (!d.fullName || !d.phone || !d.position) return res.status(400).json({ error: 'Missing required fields.' });
    let reference;
    for (let i = 0; i < 5; i++) {
      reference = makeReference();
      const exists = await pool.query('SELECT 1 FROM players WHERE reference=$1', [reference]);
      if (!exists.rowCount) break;
    }
    await insertPlayer({
      reference, fullName: d.fullName, dob: d.dob, age: d.age, phone: d.phone, email: d.email,
      area: d.area, position: d.position, secondary: d.secondary, foot: d.foot, height: d.height,
      weight: d.weight, previousClub: d.previousClub, competition: d.competition,
      experience: d.experience, emergencyName: d.emergencyName, emergencyPhone: d.emergencyPhone,
      status: 'Pending', scores: {}, notes: '', submittedAt: new Date().toISOString()
    });
    res.json({ reference });
  } catch (e) {
    console.error('Registration error:', e);
    res.status(500).json({ error: 'Unable to save registration. Please try again.' });
  }
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Incorrect password.' });
  res.json({ token: signToken({ role: 'admin', exp: Date.now() + 12 * 60 * 60 * 1000 }) });
});

app.get('/api/admin/players', requireAdmin, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const params = [];
    let where = '';
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where = `WHERE LOWER(reference) LIKE $1 OR LOWER(full_name) LIKE $1 OR LOWER(position) LIKE $1 OR LOWER(phone) LIKE $1`;
    }
    const result = await pool.query(`SELECT * FROM players ${where} ORDER BY submitted_at DESC`, params);
    const all = await pool.query(`SELECT status, COUNT(*)::int AS count FROM players GROUP BY status`);
    const stats = { total: 0, pending: 0, shortlisted: 0, selected: 0 };
    all.rows.forEach(r => {
      stats.total += r.count;
      if (r.status === 'Pending') stats.pending = r.count;
      if (r.status === 'Shortlisted') stats.shortlisted = r.count;
      if (r.status === 'Selected') stats.selected = r.count;
    });
    res.json({ players: result.rows.map(rowToPlayer), stats });
  } catch (e) {
    console.error('Player list error:', e);
    res.status(500).json({ error: 'Unable to load players.' });
  }
});

app.get('/api/admin/players/:ref', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM players WHERE reference=$1', [req.params.ref]);
    if (!rows.length) return res.status(404).json({ error: 'Player not found.' });
    res.json(rowToPlayer(rows[0]));
  } catch (e) { res.status(500).json({ error: 'Unable to load player.' }); }
});

app.put('/api/admin/players/:ref', requireAdmin, async (req, res) => {
  try {
    const { status, scores, notes } = req.body || {};
    const fields = [], values = [];
    if (status !== undefined) { values.push(status); fields.push(`status=$${values.length}`); }
    if (scores !== undefined) { values.push(JSON.stringify(scores)); fields.push(`scores=$${values.length}::jsonb`); }
    if (notes !== undefined) { values.push(notes); fields.push(`notes=$${values.length}`); }
    if (!fields.length) return res.json({ ok: true });
    values.push(req.params.ref);
    const result = await pool.query(`UPDATE players SET ${fields.join(', ')} WHERE reference=$${values.length}`, values);
    if (!result.rowCount) return res.status(404).json({ error: 'Player not found.' });
    res.json({ ok: true });
  } catch (e) {
    console.error('Update error:', e);
    res.status(500).json({ error: 'Unable to update player.' });
  }
});

app.get('/api/admin/export', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM players ORDER BY submitted_at DESC');
    const csv = toCSV(rows.map(rowToPlayer));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="goals-fc-players.csv"');
    res.send(csv);
  } catch (e) { res.status(500).json({ error: 'Unable to export players.' }); }
});

async function start() {
  try {
    await initDb();
    app.listen(PORT, () => console.log(`Goals FC server running on port ${PORT}`));
  } catch (e) {
    console.error('Database initialization failed:', e.message);
    process.exit(1);
  }
}
start();
