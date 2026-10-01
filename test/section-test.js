'use strict';
// SECTION ACCESS test: admin creates Ombor / Ta’minot / Logistika logins; each login only reaches its own section.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SA = { login: 'Test Superadmin', password: 'Test#Pass2026' }; // test-only credentials
const PORT = 6900 + Math.floor(Math.random() * 300); const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-sections-'));
const server = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'server.js')], { env: { ...process.env, WMS_NO_DOTENV: '1', PORT: String(PORT), DATA_DIR: DATA, SEED: 'real',
  SUPERADMIN_LOGIN: SA.login, SUPERADMIN_NAME: SA.login, SUPERADMIN_PASSWORD: SA.password, TELEGRAM_BOT_TOKEN: '', ANTHROPIC_API_KEY: '', AI_API_KEY: '', GEMINI_API_KEY: '',
  BOT_MORNING_HOUR: '99', BOT_EVENING_HOUR: '99', BACKUP_DAILY: '0', AI_SCAN_SECONDS: '3600', DISPATCH_CYCLE_SECONDS: '3600', ANTIVIRUS: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });

class Client {
  async login(u, pw) { const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: pw }) }); if (!r.ok) throw new Error(`login ${u}: ${r.status}`); this.cookie = r.headers.get('set-cookie').split(';')[0]; const j = await r.json(); this.csrf = j.csrf; this.user = j.user; return this; }
  async req(method, url, body) { const r = await fetch(BASE + url, { method, headers: { cookie: this.cookie, 'content-type': 'application/json', 'x-csrf-token': this.csrf }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
  async ok(method, url, body) { const r = await this.req(method, url, body); if (r.status >= 400) throw new Error(`${method} ${url}: ${r.status} ${r.data.error}`); return r.data; }
}
const results = [];
async function test(n, title, fn) { try { const d = await fn(); results.push(true); console.log(`  ✅ SECTION ${n}: ${title} — ${d}`); } catch (e) { results.push(false); console.log(`  ❌ SECTION ${n}: ${title} — ${e.message}`); } }
const assert = (c, m) => { if (!c) throw new Error(m); };
const expect = async (c, method, url, status, body) => { const r = await c.req(method, url, body); assert(r.status === status, `${method} ${url}: kutilgan ${status}, keldi ${r.status} (${r.data.error || ''})`); };

(async () => {
  for (let i = 0; i < 200; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  console.log('\nSolar Factory WMS — BO‘LIMLAR BO‘YICHA KIRISH TESTI\n');
  const sa = await new Client().login(SA.login, SA.password);
  const acc = {}; const who = {};

  await test(1, 'Admin har bir bo‘lim uchun login/parol yaratadi', async () => {
    for (const [section, level, name] of [['OMBOR', 'STAFF', 'Omborchi Ali'], ['TAMINOT', 'HEAD', 'Ta’minotchi Vali'], ['ISHLAB', 'STAFF', 'Texnolog Sardor']]) {
      const r = await sa.ok('POST', '/api/users/section-account', { section, level, full_name: name });
      assert(new RegExp(`^${{ OMBOR: 'omb', TAMINOT: 'tam', ISHLAB: 'ish' }[section]}-[0-9a-f]{4,6}$`).test(r.login), `login: ${r.login}`);
      assert(r.password.length === 12 && /[A-Z]/.test(r.password) && /\d/.test(r.password), 'parol kuchsiz');
      acc[section] = r;
    }
    const users = await sa.ok('GET', '/api/users');
    assert(users.filter((u) => u.section).length === 3, 'bo‘lim hisoblari ro‘yxatda yo‘q');
    return Object.values(acc).map((r) => `${r.sectionLabel}: ${r.login}`).join(', ');
  });
  await test(2, 'Bo‘lim logini bilan kirish — sessiyada bo‘lim bor', async () => {
    for (const k of Object.keys(acc)) { who[k] = await new Client().login(acc[k].login, acc[k].password); assert(who[k].user.section === k, `${k}: ${who[k].user.section}`); }
    const me = await who.OMBOR.ok('GET', '/api/auth/me'); assert(me.user.section === 'OMBOR', 'me.section');
    const secs = await who.OMBOR.ok('GET', '/api/sections'); assert(secs.sections.OMBOR.pages.includes('/receiving'), 'sahifalar');
    return 'uchala login ishladi; /api/auth/me va /api/sections bo‘limni qaytaradi';
  });
  await test(3, 'Ombor logini: faqat ombor API lari', async () => {
    const o = who.OMBOR;
    for (const u of ['/api/inventory/rows', '/api/receiving', '/api/products', '/api/warehouses', '/api/picking', '/api/dashboard/warehouse', '/api/meta', '/api/tasks']) await expect(o, 'GET', u, 200);
    for (const u of ['/api/purchase-requests', '/api/suppliers', '/api/shipments', '/api/vehicles', '/api/users', '/api/audit', '/api/search?q=ab', '/api/dashboard/director', '/api/ai/alerts', '/api/documents', '/api/xetq', '/api/settings']) await expect(o, 'GET', u, 403);
    await expect(o, 'POST', '/api/purchase-requests', 403, { productId: 1, qty: 1 });
    return 'ombor ✓; ta’minot, logistika, foydalanuvchilar, audit, qidiruv, direktor paneli, XETQ → 403';
  });
  await test(4, 'Ta’minot logini: faqat ta’minot API lari', async () => {
    const t = who.TAMINOT;
    for (const u of ['/api/purchase-requests', '/api/suppliers', '/api/supplier-deliveries', '/api/shortages', '/api/products']) await expect(t, 'GET', u, 200);
    for (const u of ['/api/receiving', '/api/shipments', '/api/vehicles', '/api/drivers', '/api/picking', '/api/users', '/api/dispatch', '/api/production/orders']) await expect(t, 'GET', u, 403);
    await expect(t, 'POST', '/api/inventory/issue', 403, { productId: 1, qty: 1 });
    await expect(t, 'POST', '/api/products', 403, { sku: 'X' });
    const tg = await t.ok('GET', '/api/bot/status'); // Telegram sahifasi: bo‘lim boshlig‘i ham boshqalarning chatlarini ko‘rmaydi
    assert(tg.all === undefined && Array.isArray(tg.mine), 'bot/status: barcha chatlar ro‘yxati bo‘lim xodimiga berildi');
    return 'ta’minot ✓; ombor kirim/chiqim, logistika, mahsulot yaratish → 403 (bo‘lim boshlig‘i bo‘lsa ham)';
  });
  await test(5, 'Ishlab chiqarish logini: faqat ishlab chiqarish API lari', async () => {
    const l = who.ISHLAB;
    assert(l.user.role === 'PRODUCTION' && l.user.permissions.includes('production.manage'), `rol: ${l.user.role}`);
    for (const u of ['/api/production/overview', '/api/production/orders', '/api/production/bom', '/api/production/mrp', '/api/production/suggestions', '/api/products', '/api/inventory/rows', '/api/receiving', '/api/orders']) await expect(l, 'GET', u, 200);
    for (const u of ['/api/purchase-requests', '/api/suppliers', '/api/shipments', '/api/vehicles', '/api/users', '/api/keys', '/api/picking']) await expect(l, 'GET', u, 403);
    await expect(l, 'POST', '/api/inventory/issue', 403, { productId: 1, qty: 1 });
    const create = await sa.ok('GET', '/api/sections'); assert(!create.sections.ISHLAB.hidden && create.sections.LOGISTIKA.hidden, 'bo‘limlar ro‘yxati');
    const old = await sa.req('POST', '/api/users/section-account', { section: 'LOGISTIKA', full_name: 'X' }); assert(old.status === 400, `logistika logini yaratildi: ${old.status}`);
    return 'ishlab chiqarish ✓ (panel, buyurtmalar, BOM, MRP); ta’minot, logistika, admin → 403; yangi Logistika logini yaratilmaydi';
  });
  await test(6, 'Bo‘lim xodimi login yarata olmaydi, admin/direktorga bo‘lim berilmaydi', async () => {
    await expect(who.TAMINOT, 'POST', '/api/users/section-account', 403, { section: 'OMBOR', full_name: 'X' });
    await expect(who.OMBOR, 'POST', '/api/users', 403, { username: 'hack', full_name: 'X', role_code: 'ADMIN', password: 'Hack#2026x' });
    const adm = await sa.ok('POST', '/api/users', { username: 'Admin Two', full_name: 'Admin Two', role_code: 'ADMIN', password: 'Admin#2026' });
    const r = await sa.req('PUT', `/api/users/${adm.id}`, { section: 'OMBOR' }); assert(r.status === 400, `admin bo‘limga cheklandi: ${r.status}`);
    return 'bo‘lim xodimi → 403; admin bo‘limga cheklanmaydi (400)';
  });
  await test(7, 'Yangi parol: eski parol va sessiya bekor bo‘ladi; bo‘limni o‘zgartirish', async () => {
    const id = who.OMBOR.user.id;
    const r = await sa.ok('POST', `/api/users/${id}/reset-password`);
    await expect(who.OMBOR, 'GET', '/api/products', 401);
    const old = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: acc.OMBOR.login, password: acc.OMBOR.password }) });
    assert(old.status === 401, `eski parol: ${old.status}`);
    const fresh = await new Client().login(r.login, r.password);
    await sa.ok('PUT', `/api/users/${id}`, { section: 'ISHLAB' });
    await expect(fresh, 'GET', '/api/products', 401);
    const moved = await new Client().login(r.login, r.password);
    assert(moved.user.section === 'ISHLAB', 'bo‘lim o‘zgarmadi');
    await expect(moved, 'GET', '/api/production/orders', 200); await expect(moved, 'GET', '/api/picking', 403);
    return 'yangi parol ishlaydi, eski → 401; bo‘lim ISHLAB ga o‘tkazildi — endi faqat ishlab chiqarish';
  });
  await test(8, 'Super admin barcha bo‘limlarni ko‘radi; audit yozuvi bor', async () => {
    for (const u of ['/api/receiving', '/api/purchase-requests', '/api/shipments', '/api/users']) await expect(sa, 'GET', u, 200);
    const audit = await sa.ok('GET', '/api/audit?q=SECTION');
    assert(audit.some((a) => a.action === 'SECTION_ACCOUNT_CREATE') && audit.some((a) => a.action === 'SECTION_PASSWORD_RESET'), 'audit yo‘q');
    return `cheklov faqat bo‘lim hisoblariga; audit: ${audit.length} yozuv`;
  });

  server.kill();
  const ok = results.filter(Boolean).length;
  console.log(`\nNATIJA: ${ok}/${results.length} bo‘lim testi o‘tdi\n`);
  if (ok !== results.length) console.log(log.slice(-3000));
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.error(e); server.kill(); process.exit(1); });
