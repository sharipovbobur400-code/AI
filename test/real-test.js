'use strict';
// REAL MODE test: empty production start, super admin / admins, API keys (encrypted), push + pull integration,
// QC without quarantine, AI dispatcher contacting drivers over Telegram (mock API), 08:00 / 22:00 reports.
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TOKEN = 'REAL:TEST';
const SA = { login: 'Test Superadmin', password: 'Test#Pass2026' }; // test-only credentials
// ---- mock Telegram ----
const sent = []; const updates = []; let upd = 1; let msgId = 500;
const tgMock = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const p = body ? JSON.parse(body) : {}; const method = req.url.split('/').pop();
    const ok = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); };
    if (!req.url.startsWith(`/bot${TOKEN}/`)) { res.writeHead(401); return res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' })); }
    if (method === 'getMe') return ok({ id: 1, is_bot: true, first_name: 'Solar WMS', username: 'solar_real_bot' });
    if (method === 'getUpdates') { const t0 = Date.now(); while (Date.now() - t0 < (p.timeout || 0) * 1000 && !updates.some((u) => u.update_id >= (p.offset || 0))) await new Promise((r) => setTimeout(r, 50)); return ok(updates.filter((u) => u.update_id >= (p.offset || 0))); }
    if (method === 'sendMessage') { const m = { ...p, message_id: ++msgId }; sent.push(m); return ok({ message_id: m.message_id }); }
    return ok(true);
  });
});
// ---- mock company API (pull) with its own field names ----
let companyStock = [{ code: 'SP-550W-M', quantity: 620, bin: null }];
const companyApi = http.createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer company-secret-123') { res.writeHead(401); return res.end('{}'); }
  res.writeHead(200, { 'content-type': 'application/json' });
  if (req.url.startsWith('/v2/inventory')) return res.end(JSON.stringify({ data: { items: companyStock } }));
  res.end('[]');
});

const pushText = (chatId, text) => updates.push({ update_id: upd++, message: { message_id: ++msgId, chat: { id: chatId, type: 'private' }, from: { id: chatId, first_name: 'u' }, text } });
const pushCb = (chatId, data, m) => updates.push({ update_id: upd++, callback_query: { id: `cb${upd}`, from: { id: chatId }, data, message: { message_id: m.message_id, chat: { id: chatId, type: 'private' }, text: m.text } } });
const waitMsg = async (pred, ms = 7000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = sent.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 60)); } return null; };
const btns = (m) => (m?.reply_markup?.inline_keyboard || []).flat();
const until = async (fn, ms = 6000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 120)); } return v; };

let BASE; let server;
class Client {
  async login(u, pw) { const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: pw }) }); if (!r.ok) throw new Error(`login ${u}: ${r.status}`); this.cookie = r.headers.get('set-cookie').split(';')[0]; const j = await r.json(); this.csrf = j.csrf; this.user = j.user; return this; }
  async req(method, url, body, raw) { const r = await fetch(BASE + url, { method, headers: { cookie: this.cookie, 'content-type': 'application/json', 'x-csrf-token': this.csrf }, body: body ? JSON.stringify(body) : undefined }); const d = await r.json().catch(() => ({})); if (raw) return { status: r.status, data: d }; if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${d.error}`); return d; }
  get(u) { return this.req('GET', u); } post(u, b) { return this.req('POST', u, b || {}); } put(u, b) { return this.req('PUT', u, b || {}); }
}
const ext = async (key, method, url, body) => { const r = await fetch(BASE + url, { method, headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json() }; };
const results = [];
async function test(n, title, fn) { try { const d = await fn(); results.push(true); console.log(`  ✅ REAL ${n}: ${title} — ${d}`); } catch (e) { results.push(false); console.log(`  ❌ REAL ${n}: ${title} — ${e.message}`); } }
const assert = (c, m) => { if (!c) throw new Error(m); };
const plain = (t) => String(t || '').replace(/<[^>]+>/g, '').replace(/\n/g, ' ⏎ ');

(async () => {
  await new Promise((r) => tgMock.listen(0, '127.0.0.1', r)); await new Promise((r) => companyApi.listen(0, '127.0.0.1', r));
  const PORT = 5300 + Math.floor(Math.random() * 400); BASE = `http://127.0.0.1:${PORT}`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-real-'));
  server = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'server.js')], { env: { ...process.env, WMS_NO_DOTENV: '1', LOGISTICS_MODULE: '1', PORT: String(PORT), DATA_DIR: DATA, SEED: 'real', SUPERADMIN_LOGIN: SA.login, SUPERADMIN_NAME: SA.login, SUPERADMIN_PASSWORD: SA.password,
    TELEGRAM_BOT_TOKEN: '', TELEGRAM_API_BASE: `http://127.0.0.1:${tgMock.address().port}`, BOT_POLL_TIMEOUT: '1', BOT_BATCH_SECONDS: '1', BOT_SUPERVISE_SECONDS: '3600', AI_SCAN_SECONDS: '3600', DISPATCH_CYCLE_SECONDS: '3600', BACKUP_DAILY: '0',
    ANTHROPIC_API_KEY: '', AI_API_KEY: '', GEMINI_API_KEY: '', BOT_MORNING_HOUR: '99', BOT_EVENING_HOUR: '99' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  console.log('\nSolar Factory WMS — REAL MODE TEST\n');
  let sa; let admin; let logist; let apiKey; let order; let prod;

  await test(1, 'Real rejim: demo ma’lumot va demo loginlar yo‘q', async () => {
    const demo = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'direktor', password: 'Solar2026!' }) });
    assert(demo.status === 401, 'demo login ishladi');
    sa = await new Client().login(SA.login, SA.password);
    const [products, orders, whs, users] = await Promise.all([sa.get('/api/products'), sa.get('/api/orders?all=1'), sa.get('/api/warehouses'), sa.get('/api/users')]);
    assert(!products.length && !orders.length, 'demo mahsulot/buyurtma bor');
    assert(whs.length === 6 && !whs.some((w) => w.zones.some((z) => z.zone_type === 'QUARANTINE')), 'karantin zonasi bor');
    assert(users.length === 1 && users[0].role_code === 'SUPERADMIN', `foydalanuvchilar: ${users.map((u) => u.username)}`);
    return `0 mahsulot, 0 buyurtma, ${whs.length} ombor (karantinsiz), yagona foydalanuvchi — super admin`;
  });
  await test(2, 'Super admin login/parol (bo‘sh joyli login)', async () => {
    const lower = await new Client().login('test superadmin', SA.password);
    assert(sa.user.role === 'SUPERADMIN' && sa.user.permissions.includes('admin.apikeys') && sa.user.permissions.includes('admin.admins'), 'ruxsatlar yo‘q');
    const bad = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: SA.login, password: '00000000' }) });
    assert(bad.status === 401 && lower.user.id === sa.user.id, 'login xato');
    const setup = await fetch(`${BASE}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'hacker', password: '12345678' }) });
    assert(setup.status === 403, 'setup qayta ochiq');
    return `kirish ✓ (katta-kichik harf farqsiz), noto‘g‘ri parol → 401, qayta “setup” → 403`;
  });
  await test(3, 'Admin qo‘shish faqat super adminda', async () => {
    await sa.post('/api/users', { username: 'Aziz Admin', full_name: 'Aziz Admin', role_code: 'ADMIN', password: 'Admin#2026' });
    admin = await new Client().login('Aziz Admin', 'Admin#2026');
    assert(admin.user.role === 'ADMIN' && !admin.user.permissions.includes('admin.apikeys'), 'admin ruxsatlari noto‘g‘ri');
    const a2 = await admin.req('POST', '/api/users', { username: 'second admin', full_name: 'X', role_code: 'ADMIN', password: 'Admin#2026' }, true);
    assert(a2.status === 403, 'admin admin qo‘sha oldi');
    await admin.post('/api/users', { username: 'Bobur Logist', full_name: 'Bobur Xolmatov', role_code: 'LOGISTICS', password: 'Logist2026' });
    logist = await new Client().login('bobur logist', 'Logist2026');
    const keys = await admin.req('GET', '/api/keys', null, true); assert(keys.status === 403, 'admin API kalitlarini ko‘rdi');
    const editSa = await admin.req('PUT', `/api/users/${sa.user.id}`, { password: 'hacked123' }, true); assert(editSa.status === 400 || editSa.status === 403, 'admin super adminni o‘zgartirdi');
    return 'super admin → admin qo‘shdi; admin → logist qo‘shdi; admin admin qo‘sha olmaydi (403), API kalitlarini ko‘ra olmaydi (403), super adminni o‘zgartira olmaydi';
  });
  await test(4, 'AI kaliti shifrlangan holda saqlanadi', async () => {
    const fake = 'AQ.TEST-KEY-should-never-be-stored-in-plaintext-1234';
    await sa.put('/api/keys/AI_API_KEY', { value: fake });
    const k = await sa.get('/api/keys'); const s = k.secrets.find((x) => x.name === 'AI_API_KEY');
    assert(s.configured && s.masked === 'AQ.TES…1234' && !JSON.stringify(k).includes(fake), 'kalit to‘liq qaytdi');
    const bytes = ['wms.db', 'wms.db-wal'].map((f) => (fs.existsSync(path.join(DATA, f)) ? fs.readFileSync(path.join(DATA, f)).toString('latin1') : '')).join('');
    assert(!bytes.includes(fake), 'kalit bazada ochiq holda');
    await sa.req('DELETE', '/api/keys/AI_API_KEY');
    return `ko‘rinishi: ${s.masked}; bazada ochiq matn yo‘q (AES-256-GCM); provayder: ${k.ai.provider || 'gemini'}`;
  });
  await test(5, 'Telegram tokeni UI orqali → bot ulanadi, adminlar va haydovchi ulanadi', async () => {
    const r = await sa.put('/api/keys/TELEGRAM_BOT_TOKEN', { value: TOKEN });
    assert(r.bot && r.bot.running && r.bot.bot === 'solar_real_bot', `bot: ${JSON.stringify(r.bot)}`);
    for (const [c, chat] of [[sa, 7001], [admin, 7002], [logist, 7003]]) { const code = await c.post('/api/bot/link-code'); pushText(chat, `/start ${code.code}`); assert(await waitMsg((m) => m.chat_id === String(chat) && /Ulandi/.test(m.text)), `chat ${chat} ulanmadi`); }
    return 'bot @solar_real_bot ishga tushdi; super admin, admin, logist ulandi';
  });
  await test(6, 'Kompaniya tizimi API kaliti bilan ma’lumot yuboradi (push, real vaqt)', async () => {
    apiKey = (await sa.post('/api/api-keys', { name: 'Kompaniya ERP', scopes: ['read', 'write'] })).key;
    assert(/^wms_[0-9a-f]{8}_/.test(apiKey), 'kalit formati');
    const p = await ext(apiKey, 'POST', '/api/ext/v1/products', [{ sku: 'SP-550W-M', name: 'Quyosh paneli 550W', category: 'FINISHED', units_per_pallet: 31, net_weight_kg: 28.6 }]);
    const st = await ext(apiKey, 'POST', '/api/ext/v1/stock', { items: [{ sku: 'SP-550W-M', qty: 500 }] });
    const dr = await ext(apiKey, 'POST', '/api/ext/v1/drivers', [{ name: 'Jasur Abdullayev', phone: '+998901112233', carrier: 'TransLogistic' }, { name: 'Sardor Karimov', phone: '+998912223344', carrier: 'TransLogistic' }]);
    const vh = await ext(apiKey, 'POST', '/api/ext/v1/vehicles', [{ code: 'V-VAN', type: 'Furgon', plate: '01 A 111 AA', length_m: 4.2, width_m: 2, height_m: 2.1, payload_kg: 1500, driver: 'Jasur Abdullayev' },
      { code: 'V-T1', type: 'Tentli yuk mashinasi', plate: '01 B 222 BB', length_m: 7.2, width_m: 2.45, height_m: 2.6, payload_kg: 10000, driver: 'Jasur Abdullayev' }, { code: 'V-T2', type: 'Katta yuk mashinasi', plate: '01 C 333 CC', length_m: 9.6, width_m: 2.45, height_m: 2.7, payload_kg: 20000, driver: 'Sardor Karimov' }]);
    const due = new Date(Date.now() + 5 * 3600000).toISOString();
    const od = await ext(apiKey, 'POST', '/api/ext/v1/orders', [{ order_no: 'ERP-5501', customer: 'Navoiy Quyosh Energiya', due_date: due, destination: 'Navoiy, Karmana FES', items: [{ sku: 'SP-550W-M', qty: 124 }] }]);
    assert([p, st, dr, vh, od].every((x) => x.status === 200), JSON.stringify([p, st, dr, vh, od].map((x) => x.data)));
    const stock = (await sa.get('/api/inventory?q=SP-550W-M'))[0];
    const tx = await sa.get(`/api/inventory/transactions?productId=${stock.product_id}&type=ADJUSTMENT`);
    order = (await sa.get('/api/orders?open=1')).find((o) => o.external_ref === 'ERP-5501'); prod = stock;
    assert(stock.available === 500 && stock.reserved === 124 && tx.length && order, `stock ${stock.available}/${stock.reserved}`);
    const read = await ext(apiKey, 'GET', '/api/ext/v1/stock'); assert(read.status === 200 && read.data[0].available === 500, 'GET stock');
    const bad = await ext('wms_bad_key', 'GET', '/api/ext/v1/stock'); assert(bad.status === 401, 'noto‘g‘ri kalit qabul qilindi');
    return `mahsulot, qoldiq 500 (ADJUSTMENT), 2 haydovchi, 3 transport, buyurtma ${order.order_no} (124 dona, rezerv) qabul qilindi; noto‘g‘ri kalit → 401`;
  });
  await test(7, 'Kompaniya API sidan tortish (pull) — maydonlar moslashuvi bilan', async () => {
    const r = await sa.post('/api/integrations', { name: 'Kompaniya Ombor API', baseUrl: `http://127.0.0.1:${companyApi.address().port}`, authType: 'bearer', apiKey: 'company-secret-123', pollSeconds: 3600,
      endpoints: { stock: '/v2/inventory' }, mapping: JSON.stringify({ root: { stock: 'data.items' }, fields: { stock: { sku: 'code', qty: 'quantity', location: 'bin' } } }) });
    const t = await sa.post('/api/integrations/test', { id: r.id, name: 'x', baseUrl: `http://127.0.0.1:${companyApi.address().port}`, authType: 'bearer', endpoints: { stock: '/v2/inventory' }, mapping: { root: { stock: 'data.items' } } });
    assert(t.stock.ok && t.stock.count === 1, `test: ${JSON.stringify(t)}`);
    const s = await sa.post(`/api/integrations/${r.id}/sync`);
    let st = (await sa.get('/api/inventory?q=SP-550W-M'))[0]; assert(st.available === 620, `available ${st.available}`);
    companyStock = [{ code: 'SP-550W-M', quantity: 600 }]; await sa.post(`/api/integrations/${r.id}/sync`);
    st = (await sa.get('/api/inventory?q=SP-550W-M'))[0]; assert(st.available === 600, `available ${st.available}`);
    const list = (await sa.get('/api/keys')).integrations[0]; assert(list.keyMasked && !JSON.stringify(list).includes('company-secret-123'), 'integratsiya kaliti ochiq');
    return `test ✓ (1 yozuv) → sinxron 620 → kompaniyada 600 bo‘ldi → tizimda 600 (${s.stats.stock.updated} yangilanish); kalit ko‘rinmaydi`;
  });
  await test(8, 'QC FAIL → to‘g‘ridan-to‘g‘ri Brak (karantin yo‘q)', async () => {
    const r = await admin.post('/api/receiving', { source: 'OTHER', productId: prod.product_id, qty: 10 });
    const q = await admin.post(`/api/receiving/${r.id}/qc`, { passed: 8, failed: 2, rework: 0 });
    const st = (await sa.get('/api/inventory?q=SP-550W-M'))[0];
    assert(st.scrap === 2 && st.quarantine === undefined && q.status === 'PARTIAL', `scrap ${st.scrap}, quarantine ${st.quarantine}`);
    return `8 → mavjud, 2 → brak zonasi (SCRAP); javobda karantin maydoni yo‘q`;
  });
  let job;
  await test(9, 'AI dispetcher: transport + haydovchi topadi, Telegram orqali bog‘lanadi, rad etsa boshqasini tanlaydi', async () => {
    for (const [name, chat] of [['Jasur Abdullayev', 8001], ['Sardor Karimov', 8002]]) { const d = (await sa.get('/api/drivers')).find((x) => x.full_name === name); const c = await sa.post(`/api/drivers/${d.id}/telegram-code`); pushText(chat, `/start ${c.code}`); assert(await waitMsg((m) => m.chat_id === String(chat) && /haydovchi/.test(m.text)), `${name} ulanmadi`); }
    const t = await admin.post('/api/picking', { orderId: order.id }); const pd = await admin.get(`/api/picking/${t.id}`); for (const l of pd.lines) await admin.post(`/api/picking/lines/${l.id}/pick`, {});
    await admin.post('/api/pallets', { orderId: order.id });
    const run = await sa.post('/api/dispatch/run'); assert(run.planned === 1, `planned ${JSON.stringify(run)}`);
    job = (await sa.get('/api/dispatch')).jobs[0]; assert(job.status === 'CONTACTING' && job.vehicle === 'V-T1' && job.driver === 'Jasur Abdullayev', `job ${job.status} ${job.vehicle} ${job.driver}`);
    const offer = await waitMsg((m) => m.chat_id === '8001' && /Yangi yuk taklifi/.test(m.text)); assert(offer && btns(offer).some((b) => b.callback_data === `dr:dec:${job.id}`), 'haydovchiga taklif kelmadi');
    const note = await waitMsg((m) => m.chat_id === '7003' && /AI dispetcher: transport tanlandi/.test(m.text)); assert(note, 'logistga xabar kelmadi');
    const adm = await waitMsg((m) => m.chat_id === '7001' && /AI dispetcher: transport tanlandi/.test(m.text)); assert(adm, 'super adminga xabar kelmadi');
    pushCb(8001, `dr:dec:${job.id}`, offer);
    const j2 = await until(async () => { const j = (await sa.get('/api/dispatch')).jobs[0]; return j.driver === 'Sardor Karimov' && j.status === 'CONTACTING' ? j : null; });
    assert(j2 && j2.vehicle === 'V-T2', `qayta rejalashtirish: ${j2?.vehicle}`);
    return `V-VAN rad (1500 kg < yuk); V-T1 + Jasur → Telegram taklif → rad etdi → AI V-T2 + Sardor tanladi (${j2.ship_no})`;
  });
  await test(10, 'Haydovchi qabul qiladi → “yo‘lga chiqdim” → yuk ombordan chiqadi', async () => {
    const offer = await waitMsg((m) => m.chat_id === '8002' && /Yangi yuk taklifi/.test(m.text));
    const before = (await sa.get('/api/inventory?q=SP-550W-M'))[0];
    pushCb(8002, `dr:acc:${job.id}`, offer);
    await until(async () => (await sa.get('/api/dispatch')).jobs[0].status === 'DRIVER_ACCEPTED');
    pushCb(8002, `dr:go:${job.id}`, offer);
    const j = await until(async () => { const x = (await sa.get('/api/dispatch')).jobs[0]; return x.status === 'DISPATCHED' ? x : null; });
    assert(j && j.shipment_status === 'DISPATCHED', `holat ${j?.status}`);
    const after = (await sa.get('/api/inventory?q=SP-550W-M'))[0];
    assert(before.on_hand - after.on_hand === 124, `on_hand ${before.on_hand} → ${after.on_hand}`);
    const done = await waitMsg((m) => m.chat_id === '7001' && /Yuk ombordan chiqdi/.test(m.text)); assert(done, 'adminga chiqish xabari kelmadi');
    return `${j.ship_no} DISPATCHED; ombordagi qoldiq ${before.on_hand} → ${after.on_hand} (−124); adminga: “${plain(done.text).slice(0, 90)}…”`;
  });
  await test(11, '08:00 va 22:00 AI hisobotlari botga adminlarga', async () => {
    // a second order due today, still in the warehouse → must appear in the morning plan
    await ext(apiKey, 'POST', '/api/ext/v1/orders', [{ order_no: 'ERP-5502', customer: 'Samarqand Green Power', due_date: new Date(Date.now() + 3 * 3600000).toISOString(), destination: 'Samarqand', items: [{ sku: 'SP-550W-M', qty: 62 }] }]);
    const n0 = sent.length;
    const m = await sa.post('/api/daily-reports/morning', { send: true });
    assert(/Omborda jami yuk/.test(m.text) && /Bugun chiqib ketishi kerak/.test(m.text) && /ERP|ORD-/.test(m.text), 'ertalabki hisobot mazmuni');
    const e = await sa.post('/api/daily-reports/evening', { send: true });
    assert(/Bugun chiqib ketdi: 124 dona/.test(plain(e.text)) && /Omborda qoldi/.test(e.text), `kechki: ${plain(e.text).slice(0, 200)}`);
    const isReport = (x) => /AI ombor hisoboti|AI kunlik yakun/.test(x.text);
    await until(async () => sent.slice(n0).filter(isReport).length >= 2 * m.sent_to); // Telegram queue is asynchronous
    const got = sent.slice(n0).filter(isReport);
    const chats = new Set(got.map((x) => x.chat_id));
    assert(chats.has('7001') && chats.has('7002') && m.sent_to >= 2, `yuborildi: ${[...chats]}`);
    assert(!got.some((x) => x.chat_id === '8001' || x.chat_id === '8002'), 'haydovchilarga hisobot ketdi');
    return `08:00: “${plain(m.text).slice(0, 160)}…” | 22:00: “${plain(e.text).split('⏎').slice(2, 4).join(' ')}” → super admin + admin`;
  });

  const ok = results.filter(Boolean).length;
  console.log(`\nNATIJA: ${ok}/${results.length} real rejim testi o‘tdi\n`);
  if (ok !== results.length) console.log(log.split('\n').filter((l) => /error|xato|Error/i.test(l)).slice(-20).join('\n'));
  server.kill(); tgMock.close(); companyApi.close(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.error(e); if (server) server.kill(); process.exit(1); });
