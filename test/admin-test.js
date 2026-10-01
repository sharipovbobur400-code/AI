'use strict';
// MAIN ADMIN test: .env dagi SUPERADMIN_LOGIN / SUPERADMIN_PASSWORD mavjud bazada ham asosiy admin bo‘ladi va hamma narsani ko‘radi.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAIN = { login: 'Main Admin Test', password: 'Main#Pass2026' }; // test-only credentials
const OTHER = { login: 'Other Boss', password: 'Other#Pass2026' };
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-mainadmin-'));
const PORT = 7700 + Math.floor(Math.random() * 200); const BASE = `http://127.0.0.1:${PORT}`;
let proc = null; let log = '';
async function start(withEnv) {
  proc = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'server.js')], { env: { ...process.env, WMS_NO_DOTENV: '1', PORT: String(PORT), DATA_DIR: DATA, SEED: 'real',
    SUPERADMIN_LOGIN: withEnv ? MAIN.login : '', SUPERADMIN_NAME: MAIN.login, SUPERADMIN_PASSWORD: withEnv ? MAIN.password : '', TELEGRAM_BOT_TOKEN: '', AI_API_KEY: '', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '',
    BOT_MORNING_HOUR: '99', BOT_EVENING_HOUR: '99', BACKUP_DAILY: '0', AI_SCAN_SECONDS: '3600', DISPATCH_CYCLE_SECONDS: '3600', ANTIVIRUS: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 150)); }
}
async function stop() { if (!proc) return; const p = proc; proc = null; await new Promise((r) => { p.once('exit', r); p.kill(); }); }
const login = (u, pw) => fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: pw }) });
async function client(u, pw) { const r = await login(u, pw); if (!r.ok) throw new Error(`login ${u}: ${r.status}`); const j = await r.json(); const c = { cookie: r.headers.get('set-cookie').split(';')[0], csrf: j.csrf, user: j.user };
  c.req = async (m, url, body) => { const x = await fetch(BASE + url, { method: m, headers: { cookie: c.cookie, 'content-type': 'application/json', 'x-csrf-token': c.csrf }, body: body ? JSON.stringify(body) : undefined }); return { status: x.status, data: await x.json().catch(() => ({})) }; };
  return c; }
const results = [];
async function test(n, title, fn) { try { const d = await fn(); results.push(true); console.log(`  ✅ ADMIN ${n}: ${title} — ${d}`); } catch (e) { results.push(false); console.log(`  ❌ ADMIN ${n}: ${title} — ${e.message}`); } }
const assert = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  console.log('\nSolar Factory WMS — ASOSIY ADMIN TESTI\n');
  await start(false);
  // boshqa super admin (birinchi sozlash), va asosiy admin logini oddiy ADMIN, boshqa parol bilan, bloklangan
  await fetch(`${BASE}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fullName: OTHER.login, login: OTHER.login, password: OTHER.password }) });
  const other = await client(OTHER.login, OTHER.password);
  await other.req('POST', '/api/users', { username: MAIN.login, full_name: MAIN.login, role_code: 'ADMIN', password: 'Wrong#Pass2026' });
  for (let i = 0; i < 5; i++) await login(MAIN.login, 'bad-password-1');
  await stop();

  await start(true);
  await test(1, 'Asosiy admin .env paroli bilan kiradi (bloklangan bo‘lsa ham)', async () => {
    const m = await client(MAIN.login, MAIN.password);
    assert(m.user.role === 'SUPERADMIN' && !m.user.section, `rol: ${m.user.role}`);
    const low = await client(MAIN.login.toLowerCase(), MAIN.password); assert(low.user.id === m.user.id, 'katta-kichik harf');
    return `rol: ${m.user.role}, bo‘lim cheklovi yo‘q`;
  });
  await test(2, 'Asosiy admin hamma narsani ko‘radi', async () => {
    const m = await client(MAIN.login, MAIN.password);
    for (const p of ['admin.admins', 'admin.apikeys', 'admin.users', 'admin.settings', 'audit.view', 'products.manage', 'procurement.approve', 'shipments.manage', 'xetq.manage']) assert(m.user.permissions.includes(p), `ruxsat yo‘q: ${p}`);
    const urls = ['/api/keys', '/api/odoo', '/api/users', '/api/diagnostics', '/api/audit', '/api/admin/mode', '/api/receiving', '/api/purchase-requests', '/api/shipments', '/api/xetq', '/api/dashboard/director', '/api/ai/pulse', '/api/bot/status', '/api/settings'];
    for (const u of urls) { const r = await m.req('GET', u); assert(r.status === 200, `${u}: ${r.status}`); }
    return `${m.user.permissions.length} ta ruxsat; ${urls.length} ta bo‘lim (API kalitlar, Odoo, adminlar, audit, diagnostika, ombor, ta’minot, logistika, XETQ…) — 200`;
  });
  await test(3, 'Oldingi super admin ADMIN ga o‘tdi — asosiy admin bitta', async () => {
    const o = await client(OTHER.login, OTHER.password);
    assert(o.user.role === 'ADMIN', `rol: ${o.user.role}`);
    const r = await o.req('GET', '/api/keys'); assert(r.status === 403, `API kalitlar: ${r.status}`);
    const m = await client(MAIN.login, MAIN.password);
    const users = (await m.req('GET', '/api/users')).data; assert(users.filter((u) => u.role_code === 'SUPERADMIN').length === 1, 'super admin soni');
    return 'Other Boss → ADMIN (API kalitlar 403); tizimda 1 ta super admin';
  });
  await test(4, 'Qayta ishga tushirish: ortiqcha o‘zgarish yo‘q, sessiya saqlanadi', async () => {
    const m = await client(MAIN.login, MAIN.password);
    await stop(); await start(true);
    const again = await m.req('GET', '/api/auth/me'); assert(again.status === 200, `sessiya: ${again.status}`);
    const audit = (await m.req('GET', '/api/audit?q=MAIN_ADMIN_SYNC')).data; assert(audit.length === 1, `audit: ${audit.length}`);
    return 'sessiya ochiq qoldi, MAIN_ADMIN_SYNC faqat 1 marta';
  });

  await stop();
  const ok = results.filter(Boolean).length;
  console.log(`\nNATIJA: ${ok}/${results.length} asosiy admin testi o‘tdi\n`);
  if (ok !== results.length) console.log(log.slice(-3000));
  process.exit(ok === results.length ? 0 : 1);
})().catch(async (e) => { console.error(e); await stop(); process.exit(1); });
