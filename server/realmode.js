'use strict';
// Demo → Real: demo (namunaviy) ma’lumotlar bilan to‘ldirilgan bazani toza real bazaga almashtiradi.
// Saqlanadi: demo bo‘lmagan foydalanuvchilar (super admin, adminlar, bo‘lim loginlari), API/AI/Telegram kalitlari, integratsiyalar, Odoo sozlamasi,
// korxona sozlamalari, Telegram ulanishlari. Oldin to‘liq zaxira nusxa olinadi (data/backups/pre-real-*.db).
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const auth = require('./auth');
const { clock, bad } = require('./core');

const DEMO_USERS = ['direktor', 'admin', 'menejer', 'omborchi1', 'omborchi2', 'omborchi3', 'qc', 'logist', 'taminot', 'kuzatuvchi'];
const SYSTEM_USERS = ['ai.dispetcher', 'integratsiya'];
const demoPassword = () => process.env.SEED_PASSWORD || 'Solar2026!';

/** Demo foydalanuvchi: demo ro‘yxatidagi login VA demo paroli (real admin shu nomni tanlagan bo‘lsa ham adashtirmaydi). */
function isDemoUser(u) { return DEMO_USERS.includes(u.username) && String(u.password_hash).startsWith('scrypt$') && auth.verifyPassword(demoPassword(), u.password_hash); }
function status() {
  const demoUsers = db.all(`SELECT username, password_hash FROM users WHERE username IN (${DEMO_USERS.map(() => '?').join(',')})`, ...DEMO_USERS).filter(isDemoUser).map((u) => u.username);
  const counts = {};
  for (const t of ['products', 'orders', 'shipments', 'purchase_requests', 'suppliers', 'vehicles', 'drivers', 'inventory_transactions']) counts[t] = db.val(`SELECT COUNT(*) FROM ${t}`);
  return { demo: demoUsers.length > 0, demoUsers, counts };
}

function switchToReal(user) {
  const st = status();
  if (!st.demo) throw bad('Tizim allaqachon real rejimda (demo foydalanuvchilar topilmadi)');
  const tableExists = (t) => !!db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", t);
  // 1) saqlanadigan ma’lumotlar
  const keepUsers = db.all('SELECT * FROM users').filter((u) => !SYSTEM_USERS.includes(u.username) && !isDemoUser(u) && String(u.password_hash).startsWith('scrypt$'));
  const carry = {
    secrets: db.all('SELECT * FROM secrets'), integrations: db.all('SELECT * FROM integrations'), api_keys: db.all('SELECT * FROM api_keys'), settings: db.all('SELECT * FROM settings'),
    bot_links: tableExists('bot_links') ? db.all('SELECT * FROM bot_links') : [],
  };
  // 2) zaxira nusxa
  const live = db.file(); const bkDir = path.join(path.dirname(live), 'backups'); fs.mkdirSync(bkDir, { recursive: true });
  const backup = path.join(bkDir, `pre-real-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`);
  db.snapshot(backup);
  // 3) yangi toza baza
  const rebuild = () => {
    db.close();
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(live + ext); } catch { /* none */ } }
    db.reopen(live);
    auth.seedRoles();
    require('./documents').seedTemplates();
    require('./bot').init();
  };
  try {
    rebuild();
    const idMap = new Map();
    db.tx(() => {
      for (const u of keepUsers) {
        const { id, employee_id: _e, ...row } = u;
        idMap.set(id, db.insert('users', { ...row, employee_id: null, failed_logins: 0, locked_until: null }));
      }
    });
    require('./seed').run('real'); // omborlar, zonalar, tizim foydalanuvchilari (super admin allaqachon bor — qayta yaratilmaydi)
    db.tx(() => {
      const put = (table, row) => { const cols = Object.keys(row); db.run(`INSERT OR REPLACE INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...cols.map((c) => row[c])); };
      for (const s of carry.settings) put('settings', s);
      for (const s of carry.secrets) put('secrets', { ...s, updated_by: idMap.get(s.updated_by) ?? null });
      for (const i of carry.integrations) put('integrations', { ...i, created_by: idMap.get(i.created_by) ?? null });
      for (const k of carry.api_keys) put('api_keys', { ...k, created_by: idMap.get(k.created_by) ?? null });
      for (const b of carry.bot_links) if (idMap.has(b.user_id)) put('bot_links', { ...b, user_id: idMap.get(b.user_id) });
      // Odoo keshlangan ma’lumotlari qayta sinxronizatsiyada keladi
      db.setSetting('odoo', { ...(db.setting('odoo', null) || {}), lastSyncAt: null });
    });
    auth.loadPerms();
    const actor = keepUsers.find((u) => u.id === user.id);
    db.audit({ id: actor ? idMap.get(actor.id) : null, username: user.username }, 'SWITCH_TO_REAL', 'database', null, { backup: path.basename(backup), keptUsers: keepUsers.map((u) => u.username), removedDemoUsers: st.demoUsers });
  } catch (e) {
    // muvaffaqiyatsiz bo‘lsa — zaxiradan tiklash
    db.close();
    for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(live + ext); } catch { /* none */ } }
    fs.copyFileSync(backup, live); db.reopen(live); auth.loadPerms();
    throw bad(`Real rejimga o‘tib bo‘lmadi, eski ma’lumotlar tiklandi: ${e.message}`);
  }
  // Odoo ulangan bo‘lsa — darhol real ma’lumotni tortish
  let odoo = null;
  if (db.setting('odoo', null)?.apiKeyEnc) odoo = 'boshlandi';
  return { ok: true, backup: path.basename(backup), keptUsers: keepUsers.map((u) => u.username), removedDemoUsers: st.demoUsers, odoo, at: clock.iso() };
}
module.exports = { status, switchToReal, isDemoUser };
