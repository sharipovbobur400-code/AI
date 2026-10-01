'use strict';
// Boshqa kompyuterga ko‘chirish: butun baza + hujjat fayllari + kalitlar bitta .sfwms paketga yig‘iladi,
// paket parol bilan shifrlanadi (scrypt + AES-256-GCM). Import oldidan paket to‘liq tekshiriladi:
// parol/butunlik, SQLite integrity, sxema, begona trigger/view yo‘qligi va har bir faylning virus tekshiruvi.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const db = require('./db');
const { clock, bad } = require('./core');

const MAGIC = Buffer.from('SFWMSTR1', 'latin1');
const FORMAT = 'solar-factory-wms-transfer';
const KDF = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const REQUIRED_TABLES = ['users', 'roles', 'warehouses', 'warehouse_locations', 'products', 'inventory', 'inventory_transactions', 'orders', 'documents', 'document_versions', 'audit_logs', 'settings'];
const COUNT_TABLES = { products: 'Mahsulotlar', inventory_transactions: 'Ombor harakatlari', orders: 'Buyurtmalar', shipments: 'Jo‘natmalar', users: 'Foydalanuvchilar', drivers: 'Haydovchilar', documents: 'Hujjatlar', document_versions: 'Hujjat versiyalari', audit_logs: 'Audit yozuvlari' };

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wms-transfer-'));
function checkPassword(pw) { if (typeof pw !== 'string' || pw.length < 8 || pw.length > 200) throw bad('Ko‘chirish paroli kamida 8 belgi bo‘lsin'); }
function counts(conn) {
  const out = {};
  for (const [t, label] of Object.entries(COUNT_TABLES)) { try { out[t] = { label, n: Number(conn.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c) }; } catch { /* table missing */ } }
  return out;
}

/** Build an encrypted transfer package. Returns { buffer, filename, counts }. */
function exportPackage(password, user) {
  checkPassword(password);
  const secrets = require('./secrets'); const docs = require('./documents');
  const dir = tmpDir(); const tmp = path.join(dir, 'export.db');
  try {
    db.snapshot(tmp);
    const x = db.openDatabase(tmp);
    let payloadMeta;
    try {
      // uploaded files live on disk in normal mode — put them inside the copy so they travel with it
      const missing = [];
      const upd = x.prepare('UPDATE document_versions SET file_data=? WHERE id=?');
      for (const v of x.prepare('SELECT id, file_path FROM document_versions WHERE file_path IS NOT NULL AND file_data IS NULL').all()) {
        const p = docs.fileOf(v.id).path;
        if (fs.existsSync(p)) upd.run(fs.readFileSync(p), v.id); else missing.push(v.file_path);
      }
      // secrets are encrypted with this computer's master key: carry them as plain values inside the (password-encrypted) package
      const secretRows = x.prepare('SELECT name, value_enc, meta FROM secrets').all().map((s) => { try { return { name: s.name, value: secrets.decrypt(s.value_enc), meta: s.meta }; } catch { return null; } }).filter(Boolean);
      const integrationSecrets = x.prepare('SELECT id, secret_enc FROM integrations WHERE secret_enc IS NOT NULL').all().map((i) => { try { return { id: i.id, value: secrets.decrypt(i.secret_enc) }; } catch { return null; } }).filter(Boolean);
      x.exec("UPDATE integrations SET secret_enc=NULL; DELETE FROM secrets; DELETE FROM sessions; DELETE FROM settings WHERE key='bot_webhook';");
      try { x.exec('DELETE FROM bot_state'); } catch { /* bot tables not created */ }
      payloadMeta = { secretRows, integrationSecrets, missing, counts: counts(x) };
      x.exec('VACUUM');
    } finally { x.close(); }
    const dbBuf = fs.readFileSync(tmp);
    const payload = Buffer.from(JSON.stringify({ format: FORMAT, version: 1, exportedAt: clock.iso(), exportedBy: user?.username || null, source: os.hostname(), app: require('../package.json').version,
      counts: payloadMeta.counts, missingFiles: payloadMeta.missing, secrets: payloadMeta.secretRows, integrationSecrets: payloadMeta.integrationSecrets, db: dbBuf.toString('base64') }), 'utf8');
    const gz = zlib.gzipSync(payload, { level: 6 });
    const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(password, salt, 32, KDF);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv); c.setAAD(MAGIC);
    const enc = Buffer.concat([c.update(gz), c.final()]);
    const buffer = Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), enc]);
    db.audit(user, 'DATA_EXPORT', 'database', null, { size: buffer.length, files: payloadMeta.counts.document_versions?.n, missingFiles: payloadMeta.missing.length });
    return { buffer, filename: `solar-wms-${clock.iso().slice(0, 10)}.sfwms`, counts: payloadMeta.counts, missingFiles: payloadMeta.missing };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function openPackage(buf, password) {
  checkPassword(password);
  if (!Buffer.isBuffer(buf) || buf.length < 60 || !buf.subarray(0, 8).equals(MAGIC)) throw bad('Bu fayl ko‘chirish paketi emas (.sfwms kerak)');
  const salt = buf.subarray(8, 24); const iv = buf.subarray(24, 36); const tag = buf.subarray(36, 52); const enc = buf.subarray(52);
  let gz;
  try {
    const key = crypto.scryptSync(password, salt, 32, KDF);
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAAD(MAGIC); d.setAuthTag(tag);
    gz = Buffer.concat([d.update(enc), d.final()]);
  } catch { throw bad('Parol noto‘g‘ri yoki fayl buzilgan / o‘zgartirilgan'); }
  let p;
  try { p = JSON.parse(zlib.gunzipSync(gz, { maxOutputLength: 1536 * 1024 * 1024 }).toString('utf8')); } catch { throw bad('Paket ichi buzilgan'); }
  if (p.format !== FORMAT || p.version !== 1 || typeof p.db !== 'string') throw bad('Paket formati mos emas');
  const dbBuf = Buffer.from(p.db, 'base64');
  if (dbBuf.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') throw bad('Paket ichidagi baza yaroqsiz');
  return { meta: p, dbBuf };
}

/** Everything that must be true before a package may replace the live database. */
function validateDb(file) {
  const x = db.openDatabase(file); const problems = [];
  try {
    const ic = x.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
    if (ic[0] !== 'ok') problems.push(`Baza butunligi buzilgan: ${ic.slice(0, 3).join('; ')}`);
    const tables = new Set(x.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    const lack = REQUIRED_TABLES.filter((t) => !tables.has(t)); if (lack.length) problems.push(`Kerakli jadvallar yo‘q: ${lack.join(', ')}`);
    // no triggers / views other than the ones this application creates itself
    const ours = new Set(db.all("SELECT name FROM sqlite_master WHERE type IN ('trigger','view')").map((r) => r.name));
    const foreign = x.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('trigger','view')").all().filter((r) => !ours.has(r.name));
    if (foreign.length) problems.push(`Begona obyektlar topildi (${foreign.map((f) => `${f.type} ${f.name}`).join(', ')}) — paket rad etildi`);
    if (tables.has('users') && !x.prepare("SELECT id FROM users WHERE role_code='SUPERADMIN' AND active=1").get()) problems.push('Paketda faol super admin yo‘q');
    // every stored file goes through the same check as a normal upload (type, content, antivirus)
    const fc = require('./filecheck'); let scanned = 0; const bad_ = [];
    if (tables.has('document_versions')) {
      for (const v of x.prepare('SELECT id, file_name, file_data FROM document_versions WHERE file_data IS NOT NULL').all()) {
        try { fc.check(Buffer.from(v.file_data), v.file_name); scanned++; } catch (err) { bad_.push(err.message); }
      }
    }
    if (bad_.length) problems.push(`Xavfli yoki ruxsat etilmagan fayllar (${bad_.length}): ${bad_.slice(0, 5).join(' | ')}`);
    return { problems, scanned, counts: counts(x) };
  } finally { x.close(); }
}

/** Validate (dryRun) or import a package, replacing the whole local database. */
async function importPackage(buf, password, user, { dryRun = false } = {}) {
  const { meta, dbBuf } = openPackage(buf, password);
  const dir = tmpDir(); const tmp = path.join(dir, 'import.db');
  try {
    fs.writeFileSync(tmp, dbBuf);
    const v = validateDb(tmp);
    const scanner = require('./filecheck').scannerInfo().scanner;
    const summary = { exportedAt: meta.exportedAt, exportedBy: meta.exportedBy, source: meta.source, counts: v.counts, filesScanned: v.scanned, antivirus: scanner, secrets: (meta.secrets || []).map((s) => s.name), missingFiles: meta.missingFiles || [] };
    if (v.problems.length) {
      db.audit(user, 'DATA_IMPORT_REJECTED', 'database', null, { problems: v.problems, source: meta.source });
      throw bad(`Paket qabul qilinmadi: ${v.problems.join(' · ')}`);
    }
    if (dryRun) return { ok: true, dryRun: true, ...summary };

    // safety copy of the current data, then swap the database file
    const live = db.file(); const bkDir = path.join(path.dirname(live), 'backups'); fs.mkdirSync(bkDir, { recursive: true });
    const safety = path.join(bkDir, `pre-import-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`);
    db.snapshot(safety);
    const swap = (src) => { db.close(); for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(live + ext); } catch { /* none */ } } fs.copyFileSync(src, live); db.reopen(live); };
    try { swap(tmp); } catch (err) { swap(safety); throw bad(`Import bajarilmadi, eski ma’lumotlar tiklandi: ${err.message}`); }

    const secrets = require('./secrets');
    require('./auth').loadPerms();
    db.run('DELETE FROM sessions');
    for (const s of meta.secrets || []) {
      if (!secrets.NAMES[s.name]) continue;
      db.run('INSERT INTO secrets(name,value_enc,last4,meta,updated_by,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET value_enc=excluded.value_enc, last4=excluded.last4, meta=excluded.meta, updated_at=excluded.updated_at',
        s.name, secrets.encrypt(s.value), String(s.value).slice(-4), s.meta || null, null, clock.iso());
    }
    for (const i of meta.integrationSecrets || []) db.run('UPDATE integrations SET secret_enc=? WHERE id=?', secrets.encrypt(i.value), i.id);
    require('./seed').systemUsers();
    db.audit({ id: null, username: user?.username }, 'DATA_IMPORT', 'database', null, { source: meta.source, exportedAt: meta.exportedAt, filesScanned: v.scanned, safetyBackup: path.basename(safety) });
    await require('./bot').reload().catch(() => {});
    return { ok: true, ...summary, safetyBackup: path.basename(safety) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { exportPackage, importPackage, openPackage };
