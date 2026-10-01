'use strict';
// VERCEL MODE test: two independent "function instances" (separate processes, separate /tmp DB copies)
// share one snapshot store — the same way two Vercel instances share Neon Postgres.
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SA = { login: 'Test Superadmin', password: 'Test#Pass2026' }; // test-only credentials
const CRON = 'cron-test-secret-0123456789';
const ROOT = path.join(__dirname, '..');
const SHARED = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-vercel-store-'));
// a tiny host that mimics Vercel: every request goes to api/index.js
const HOST = `const http=require('node:http');const h=require(${JSON.stringify(path.join(ROOT, 'api', 'index.js'))});http.createServer((q,s)=>h(q,s)).listen(Number(process.env.TEST_PORT),'127.0.0.1');`;

const procs = []; const logs = [];
function instance(i) {
  const port = 5800 + Math.floor(Math.random() * 300) + i * 300;
  const p = spawn(process.execPath, ['--no-warnings', '-e', HOST], { env: { ...process.env, WMS_NO_DOTENV: '1', VERCEL: '1', TEST_PORT: String(port), WMS_SNAPSHOT_STORE: `dir:${SHARED}`, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), `wms-vercel-i${i}-`)),
    WMS_MASTER_KEY: 'test-master-key', CRON_SECRET: CRON, SEED: 'real', SUPERADMIN_LOGIN: SA.login, SUPERADMIN_NAME: SA.login, SUPERADMIN_PASSWORD: SA.password,
    TELEGRAM_BOT_TOKEN: '', ANTHROPIC_API_KEY: '', AI_API_KEY: '', GEMINI_API_KEY: '', BOT_MORNING_HOUR: '99', BOT_EVENING_HOUR: '99', BACKUP_DAILY: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  logs[i] = ''; p.stdout.on('data', (d) => { logs[i] += d; }); p.stderr.on('data', (d) => { logs[i] += d; });
  procs.push(p); return `http://127.0.0.1:${port}`;
}
class Client {
  constructor(base) { this.base = base; }
  async login(u, pw) { const r = await fetch(`${this.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: pw }) }); if (!r.ok) throw new Error(`login ${u}: ${r.status} ${await r.text()}`); this.cookie = r.headers.get('set-cookie').split(';')[0]; const j = await r.json(); this.csrf = j.csrf; this.user = j.user; return this; }
  on(base) { const c = Object.assign(new Client(base), { cookie: this.cookie, csrf: this.csrf, user: this.user }); return c; }
  async req(method, url, body, raw) { const r = await fetch(this.base + url, { method, headers: { cookie: this.cookie, 'content-type': 'application/json', 'x-csrf-token': this.csrf }, body: body ? JSON.stringify(body) : undefined }); const d = await r.json().catch(() => ({})); if (raw) return { status: r.status, data: d }; if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${d.error}`); return d; }
  get(u) { return this.req('GET', u); } post(u, b) { return this.req('POST', u, b || {}); }
}
const product = (sku) => ({ sku, name: `Vercel test ${sku}`, category: 'FINISHED', model: sku, power_w: 550, length_mm: 2278, width_mm: 1134, height_mm: 35, net_weight_kg: 28, gross_weight_kg: 29, units_per_pallet: 31, pallet_weight_kg: 25, pallet_length_mm: 2300, pallet_width_mm: 1150, pallet_height_mm: 1300, packaging_weight_kg: 15, max_stack: 2, orientation: 'VERTICAL', track_serial: false, min_stock: 0, lead_time_days: 3 });
const results = [];
async function test(n, title, fn) { try { const d = await fn(); results.push(true); console.log(`  ✅ VERCEL ${n}: ${title} — ${d}`); } catch (e) { results.push(false); console.log(`  ❌ VERCEL ${n}: ${title} — ${e.message}`); } }
const assert = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  const A = instance(0); const B = instance(1);
  for (const base of [A, B]) for (let i = 0; i < 200; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  console.log('\nSolar Factory WMS — VERCEL (serverless) TEST\n');
  let a; let b;

  await test(1, 'Ikkala instansiya ishga tushdi, super admin env dan yaratildi', async () => {
    a = await new Client(A).login(SA.login, SA.password);
    b = a.on(B);
    const users = await b.get('/api/users');
    assert(users.length === 1 && users[0].role_code === 'SUPERADMIN', `users: ${users.length}`);
    assert(fs.existsSync(path.join(SHARED, 'version')), 'snapshot saqlanmadi');
    return 'A da login → sessiya B da ham ishlaydi (umumiy baza)';
  });
  await test(2, 'A dagi yozuv darhol B da ko‘rinadi (va aksincha)', async () => {
    await a.post('/api/products', product('VC-A-1'));
    const onB = await b.get('/api/products'); assert(onB.some((p) => p.sku === 'VC-A-1'), 'B ko‘rmadi');
    await b.post('/api/products', product('VC-B-1'));
    const onA = await a.get('/api/products'); assert(onA.some((p) => p.sku === 'VC-B-1'), 'A ko‘rmadi');
    return `mahsulotlar: ${onA.map((p) => p.sku).join(', ')}`;
  });
  await test(3, 'Parallel yozuvlar (A+B, 16 ta) yo‘qolmaydi', async () => {
    const jobs = []; for (let i = 0; i < 8; i++) { jobs.push(a.post('/api/products', product(`VC-PA-${i}`))); jobs.push(b.post('/api/products', product(`VC-PB-${i}`))); }
    const r = await Promise.allSettled(jobs); const failed = r.filter((x) => x.status === 'rejected');
    assert(!failed.length, `${failed.length} ta xato: ${failed[0]?.reason?.message}`);
    const [pa, pb] = await Promise.all([a.get('/api/products'), b.get('/api/products')]);
    assert(pa.length === 18 && pb.length === 18, `A=${pa.length} B=${pb.length}`);
    return 'global lock: 18/18 mahsulot ikkala instansiyada';
  });
  await test(4, 'Cron tick faqat CRON_SECRET bilan', async () => {
    const no = await fetch(`${A}/api/cron/tick`); assert(no.status === 401, `kalitsiz: ${no.status}`);
    const wrong = await fetch(`${A}/api/cron/tick?key=wrong`); assert(wrong.status === 401, 'noto‘g‘ri kalit o‘tdi');
    const ok = await fetch(`${B}/api/cron/tick`, { headers: { authorization: `Bearer ${CRON}` } }); assert(ok.ok, `bearer: ${ok.status} ${await ok.text()}`);
    const ok2 = await fetch(`${A}/api/cron/tick?key=${CRON}`); assert(ok2.ok, `?key: ${ok2.status}`);
    return 'kalitsiz/noto‘g‘ri → 401; Bearer va ?key= → 200';
  });
  await test(5, 'Telegram webhook maxfiy tokensiz rad etiladi', async () => {
    const r = await fetch(`${A}/api/telegram/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"update_id":1}' });
    assert(r.status === 401 || r.status === 403, `status ${r.status}`);
    return `status ${r.status}`;
  });
  await test(6, 'SSE oqimi serverless rejimida tez yopiladi (5 s qayta ulanish)', async () => {
    const t0 = Date.now(); const r = await fetch(`${B}/api/events/stream`, { headers: { cookie: a.cookie } }); const txt = await r.text();
    assert(r.ok && /retry: 5000/.test(txt) && Date.now() - t0 < 5000, `status ${r.status}`);
    return `${Date.now() - t0} ms, ${txt.split('\n').length} qator`;
  });
  await test(7, 'Sovuq start: yangi instansiya bazani saqlovdan tiklaydi', async () => {
    const C = instance(2); for (let i = 0; i < 200; i++) { try { if ((await fetch(`${C}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }
    const c = await new Client(C).login(SA.login, SA.password);
    const p = await c.get('/api/products'); assert(p.length === 18, `C=${p.length}`);
    const logout = await b.req('POST', '/api/auth/logout', {}, true); assert(logout.status < 400, `logout ${logout.status}`);
    const after = await a.req('GET', '/api/products', null, true); assert(after.status === 401, `chiqilgandan keyin: ${after.status}`);
    return 'C: 18 mahsulot, B da chiqish → A da sessiya bekor (401)';
  });
  await test(8, 'Xavfsizlik: .env va baza fayllari tashqariga chiqmaydi', async () => {
    for (const u of ['/.env', '/data/wms.db', '/server/server.js', '/api/../.env']) { const r = await fetch(A + u); const t = await r.text(); assert(!/SUPERADMIN_PASSWORD|SQLite format/.test(t), `${u} ochiq`); }
    return '/.env, /data/wms.db, /server/*.js — yopiq';
  });

  procs.forEach((p) => p.kill());
  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} VERCEL testlari o‘tdi\n`);
  if (ok !== results.length) console.log(logs.map((l, i) => `--- instance ${i} ---\n${l.slice(-3000)}`).join('\n'));
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.error(e); procs.forEach((p) => p.kill()); process.exit(1); });
