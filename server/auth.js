'use strict';
// Authentication (scrypt), sessions (hashed tokens), CSRF, RBAC, rate limiting.
const crypto = require('node:crypto');
const db = require('./db');
const { clock, AppError, bad, forbidden } = require('./core');

const ROLES = {
  SUPERADMIN: ['Super admin', 'Tizim egasi: adminlar, API kalitlari, to‘liq nazorat'],
  DIRECTOR: ['Direktor', 'To‘liq nazorat'], ADMIN: ['Administrator', 'Tizim sozlamalari va foydalanuvchilar'], MANAGER: ['Ombor menejeri', 'Ombor jarayonlarini to‘liq boshqaradi'],
  STOREKEEPER: ['Omborchi', 'Kirim / chiqim / picking / packing'], QC: ['Sifat nazorati', 'QC, brak, rework'], LOGISTICS: ['Logist', 'Transport, yuklash, jo‘natma'],
  PROCUREMENT: ['Ta’minotchi', 'Supplier va zayavkalar'], PRODUCTION: ['Ishlab chiqarish', 'Reja, material berish, natija kiritish'], VIEWER: ['Kuzatuvchi', 'Faqat ko‘rish'],
};
const PERMISSIONS = {
  'stock.receive': ['MANAGER', 'STOREKEEPER'], 'stock.issue': ['MANAGER', 'STOREKEEPER'], 'stock.transfer': ['MANAGER', 'STOREKEEPER'],
  'stock.qc': ['QC', 'MANAGER'], 'stock.disposition': ['QC', 'MANAGER'], 'dispatch.manage': ['MANAGER', 'LOGISTICS'], 'stock.reserve': ['MANAGER', 'STOREKEEPER', 'LOGISTICS'],
  'stock.count': ['MANAGER', 'STOREKEEPER'], 'stock.count.post': ['MANAGER'], 'products.manage': ['MANAGER'], 'warehouse.manage': ['MANAGER'],
  'orders.manage': ['MANAGER', 'LOGISTICS'], picking: ['MANAGER', 'STOREKEEPER'], packing: ['MANAGER', 'STOREKEEPER'],
  'procurement.request': ['MANAGER', 'PROCUREMENT', 'STOREKEEPER'], 'procurement.approve': ['MANAGER', 'PROCUREMENT'], 'procurement.manage': ['MANAGER', 'PROCUREMENT'],
  'suppliers.manage': ['MANAGER', 'PROCUREMENT'], 'transport.manage': ['MANAGER', 'LOGISTICS'], loading: ['MANAGER', 'LOGISTICS', 'STOREKEEPER'],
  'shipments.manage': ['MANAGER', 'LOGISTICS'], 'documents.manage': ['MANAGER', 'LOGISTICS', 'QC', 'PROCUREMENT'], 'documents.approve': ['MANAGER', 'QC'],
  'xetq.manage': ['MANAGER', 'QC'], 'xetq.review': ['MANAGER'], 'projects.manage': ['MANAGER'], 'tasks.assign': ['MANAGER'],
  'ai.use': ['MANAGER', 'STOREKEEPER', 'QC', 'LOGISTICS', 'PROCUREMENT', 'PRODUCTION', 'VIEWER'], 'ai.scan': ['MANAGER'], 'audit.view': ['MANAGER'],
  'production.manage': ['MANAGER', 'PRODUCTION'], 'production.report': ['MANAGER', 'PRODUCTION', 'STOREKEEPER'],
  'admin.templates': ['MANAGER'], 'admin.users': [], 'admin.settings': [], 'admin.backup': [], 'admin.apikeys': [], 'admin.admins': [],
};
const FULL = ['SUPERADMIN', 'DIRECTOR', 'ADMIN'];
// permissions that only the SUPERADMIN has (not even other full-access roles)
const SUPER_ONLY = ['admin.admins', 'admin.apikeys'];

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [, s, h] = String(stored).split('$');
  if (!s || !h) return false;
  const calc = crypto.scryptSync(pw, Buffer.from(s, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const exp = Buffer.from(h, 'base64');
  return exp.length === calc.length && crypto.timingSafeEqual(exp, calc);
}
function validatePasswordPolicy(pw) {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 128) throw bad('Parol kamida 8 belgidan iborat bo‘lishi kerak');
}

function seedRoles() {
  for (const [code, [name, description]] of Object.entries(ROLES)) db.run('INSERT OR IGNORE INTO roles(code,name,description) VALUES(?,?,?)', code, name, description);
  if (!db.val('SELECT COUNT(*) FROM permissions')) for (const [perm, roles] of Object.entries(PERMISSIONS)) for (const r of roles) db.run('INSERT OR IGNORE INTO permissions(role_code,permission) VALUES(?,?)', r, perm);
  // yangi qo‘shilgan ruxsatlar mavjud bazaga bir marta qo‘shiladi (admin keyin o‘zgartirsa — saqlanadi)
  const done = new Set(db.setting('perm_migrations', []));
  for (const perm of ['production.manage', 'production.report']) {
    if (done.has(perm)) continue;
    for (const r of PERMISSIONS[perm]) db.run('INSERT OR IGNORE INTO permissions(role_code,permission) VALUES(?,?)', r, perm);
    if (!done.has('ai.use:PRODUCTION')) { db.run('INSERT OR IGNORE INTO permissions(role_code,permission) VALUES(?,?)', 'PRODUCTION', 'ai.use'); done.add('ai.use:PRODUCTION'); }
    done.add(perm);
  }
  db.setSetting('perm_migrations', [...done]);
  loadPerms();
}
let permCache = {};
function loadPerms() { permCache = {}; for (const r of db.all('SELECT * FROM permissions')) (permCache[r.role_code] ||= new Set()).add(r.permission); }
function can(user, perm) { if (!user) return false; if (SUPER_ONLY.includes(perm)) return user.role === 'SUPERADMIN'; if (FULL.includes(user.role)) return true; if (perm === 'view') return true; return !!permCache[user.role]?.has(perm); }
function permsOf(role) { return FULL.includes(role) ? Object.keys(PERMISSIONS).filter((p) => role === 'SUPERADMIN' || !SUPER_ONLY.includes(p)) : [...(permCache[role] || [])]; }
function require_(user, perm) { if (!user) throw new AppError(401, 'Tizimga kiring'); if (perm && !can(user, perm)) throw forbidden(`Ruxsat yo‘q: ${perm}`); }
function setPermission(role, perm, enabled, actor) {
  if (!ROLES[role] || FULL.includes(role)) throw bad('Bu rol uchun ruxsatlar o‘zgartirilmaydi');
  if (!PERMISSIONS[perm]) throw bad('Noma’lum ruxsat');
  if (enabled) db.run('INSERT OR IGNORE INTO permissions(role_code,permission) VALUES(?,?)', role, perm); else db.run('DELETE FROM permissions WHERE role_code=? AND permission=?', role, perm);
  db.audit(actor, 'PERMISSION_CHANGE', 'roles', role, { perm, enabled }); loadPerms();
}

const SESSION_HOURS = 12;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function login(username, password, meta) {
  const u = db.get('SELECT * FROM users WHERE username=?', String(username || '').trim().replace(/\s+/g, ' ').toLowerCase());
  if (u && !String(u.password_hash).startsWith('scrypt$')) throw new AppError(401, 'Login yoki parol noto‘g‘ri'); // system accounts cannot log in
  const fail = () => new AppError(401, 'Login yoki parol noto‘g‘ri');
  if (!u || !u.active) { if (!u) verifyPassword('x', 'scrypt$AAAA$AAAA'); throw fail(); }
  if (u.locked_until && new Date(u.locked_until) > new Date()) throw new AppError(423, 'Hisob vaqtincha bloklangan. 15 daqiqadan so‘ng urinib ko‘ring.');
  if (!verifyPassword(String(password || ''), u.password_hash)) {
    const n = u.failed_logins + 1;
    db.run('UPDATE users SET failed_logins=?, locked_until=? WHERE id=?', n >= 5 ? 0 : n, n >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : null, u.id);
    db.audit({ id: u.id, username: u.username }, 'LOGIN_FAILED', 'users', u.id, null, meta.ip);
    throw fail();
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  db.run('DELETE FROM sessions WHERE expires_at<?', new Date().toISOString());
  db.insert('sessions', { token_hash: sha(token), user_id: u.id, csrf, ip: meta.ip, user_agent: String(meta.ua || '').slice(0, 200), created_at: new Date().toISOString(), expires_at: new Date(Date.now() + SESSION_HOURS * 3600000).toISOString() });
  db.run('UPDATE users SET failed_logins=0, locked_until=NULL, last_login=? WHERE id=?', clock.iso(), u.id);
  db.audit({ id: u.id, username: u.username }, 'LOGIN', 'users', u.id, null, meta.ip);
  return { token, csrf, user: publicUser(u) };
}
function publicUser(u) { return { id: u.id, username: u.username, fullName: u.full_name, role: u.role_code, roleName: ROLES[u.role_code]?.[0], permissions: permsOf(u.role_code), section: u.section || null }; }
function sessionUser(token) {
  if (!token) return null;
  const s = db.get('SELECT s.*, u.username, u.full_name, u.role_code, u.active, u.section FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?', sha(token));
  if (!s || !s.active || new Date(s.expires_at) < new Date()) return null;
  return { id: s.user_id, username: s.username, fullName: s.full_name, role: s.role_code, section: s.section || null, csrf: s.csrf, tokenHash: s.token_hash };
}
function logout(token) { if (token) db.run('DELETE FROM sessions WHERE token_hash=?', sha(token)); }

// Fixed-window rate limiter (in memory).
const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now(); let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  if (b.n > limit) throw new AppError(429, 'Juda ko‘p so‘rov. Birozdan so‘ng urinib ko‘ring.');
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60000).unref();

module.exports = { ROLES, PERMISSIONS, FULL, SUPER_ONLY, hashPassword, verifyPassword, validatePasswordPolicy, seedRoles, loadPerms, can, permsOf, require: require_, setPermission, login, logout, sessionUser, publicUser, rateLimit };
