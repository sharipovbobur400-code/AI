'use strict';
// Encrypted secret store (AES-256-GCM). Secrets entered in the UI (AI key, Telegram token, integration keys)
// are encrypted with a master key that lives outside the database (env WMS_MASTER_KEY or data/.master.key).
// Values are never returned to the browser — only a masked preview.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const { clock, bad } = require('./core');

const NAMES = {
  AI_API_KEY: { label: 'AI API kaliti', envs: ['ANTHROPIC_API_KEY', 'AI_API_KEY', 'GEMINI_API_KEY'] }, // Claude (Anthropic) kaliti berilsa — u ustun
  TELEGRAM_BOT_TOKEN: { label: 'Telegram bot tokeni', envs: ['TELEGRAM_BOT_TOKEN'] },
  TAMINOT_BOT_TOKEN: { label: 'Ta’minot bot tokeni', envs: ['TAMINOT_BOT_TOKEN'] },
  OMBOR_BOT_TOKEN: { label: 'Ombor bot tokeni', envs: ['OMBOR_BOT_TOKEN'] },
  ISHLAB_BOT_TOKEN: { label: 'Ishlab chiqarish bot tokeni', envs: ['ISHLAB_BOT_TOKEN', 'ISHLAB_CHIQARISH_BOT_TOKEN'] },
  XULOSA_BOT_TOKEN: { label: 'Xulosa bot tokeni', envs: ['XULOSA_BOT_TOKEN'] },
  STT_API_KEY: { label: 'Ovoz → matn (Gemini) kaliti', envs: ['STT_API_KEY', 'GEMINI_API_KEY'] },
};
let master = null;
function init(dataDir) {
  if (process.env.WMS_MASTER_KEY) { master = crypto.createHash('sha256').update(process.env.WMS_MASTER_KEY).digest(); return; }
  if (process.env.VERCEL || process.env.WMS_SERVERLESS === '1') {
    // serverless disks are temporary: a key file would be lost on the next cold start
    const fallback = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!fallback) throw new Error('Vercel: WMS_MASTER_KEY muhit o‘zgaruvchisini kiriting (kalitlarni shifrlash uchun)');
    console.warn('WMS_MASTER_KEY berilmagan — shifrlash kaliti DATABASE_URL dan olinmoqda. Vercel sozlamalarida WMS_MASTER_KEY ni alohida kiriting.');
    master = crypto.createHash('sha256').update(`wms-master:${fallback}`).digest(); return;
  }
  const f = path.join(dataDir, '.master.key');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  master = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64');
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', master, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
function decrypt(blob) {
  if (!blob) return null;
  const [, iv, tag, data] = String(blob).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', master, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
const mask = (v) => (!v ? null : v.length <= 10 ? '••••' : `${v.slice(0, 6)}…${v.slice(-4)}`);

/** Resolve a secret: value saved in the UI wins over .env. */
function get(name) {
  const row = db.get('SELECT value_enc FROM secrets WHERE name=?', name);
  if (row) { try { return decrypt(row.value_enc); } catch { return null; } }
  for (const env of NAMES[name]?.envs || [name]) if (process.env[env]) return process.env[env];
  return null;
}
function source(name) {
  if (db.get('SELECT 1 FROM secrets WHERE name=?', name)) return 'ui';
  return (NAMES[name]?.envs || [name]).find((e) => process.env[e]) ? 'env' : null;
}
function set(name, value, user, meta) {
  if (!NAMES[name]) throw bad('Noma’lum kalit');
  const v = String(value || '').trim();
  if (v.length < 8 || v.length > 4000) throw bad('Kalit noto‘g‘ri ko‘rinishda');
  db.run('INSERT INTO secrets(name,value_enc,last4,meta,updated_by,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET value_enc=excluded.value_enc, last4=excluded.last4, meta=excluded.meta, updated_by=excluded.updated_by, updated_at=excluded.updated_at',
    name, encrypt(v), v.slice(-4), meta ? JSON.stringify(meta) : null, user?.id, clock.iso());
  db.audit(user, 'SECRET_SET', 'secrets', name, { masked: mask(v) });
}
function remove(name, user) { db.run('DELETE FROM secrets WHERE name=?', name); db.audit(user, 'SECRET_REMOVE', 'secrets', name); }
function list() {
  return Object.entries(NAMES).filter(([name]) => ['AI_API_KEY', 'TELEGRAM_BOT_TOKEN'].includes(name)).map(([name, d]) => {
    const v = get(name); const row = db.get('SELECT updated_at, updated_by, meta FROM secrets WHERE name=?', name);
    return { name, label: d.label, configured: !!v, source: source(name), masked: mask(v), updatedAt: row?.updated_at || null, meta: row?.meta ? JSON.parse(row.meta) : null };
  });
}
module.exports = { init, encrypt, decrypt, mask, get, set, remove, list, NAMES, source };
