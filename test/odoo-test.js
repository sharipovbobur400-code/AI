'use strict';
// ODOO + REAL MODE test: mock Odoo JSON-RPC → Ombor / Ta’minot / Logistika sync, section access, AI pulse, demo → real switch.
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SA = { login: 'Test Superadmin', password: 'Test#Pass2026' }; // test-only credentials
const ODOO_KEY = 'odoo-test-key-0001';
const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
const odoo = {
  down: false, qty: 40,
  'product.product': () => [
    { id: 1, default_code: 'OD-GLASS', name: 'Test oyna', categ_id: [1, 'Xomashyo'], uom_id: [1, 'dona'], qty_available: odoo.qty, is_storable: true },
    { id: 2, default_code: false, name: 'Test ramka', categ_id: [2, 'Materiallar'], uom_id: [1, 'dona'], qty_available: 12, is_storable: true }],
  'stock.warehouse.orderpoint': () => [{ id: 1, product_id: [1, 'Test oyna'], product_min_qty: 100 }],
  'res.partner': () => [{ id: 7, name: 'Test Supplier A' }, { id: 8, name: 'Test Supplier B' }],
  'purchase.order': () => [
    { id: 11, name: 'PO-T-1', partner_id: [7, 'Test Supplier A'], state: 'purchase', date_order: past, date_planned: past, currency_id: [1, 'UZS'], amount_total: 1000, receipt_status: 'pending', order_line: [101] },
    { id: 12, name: 'PO-T-2', partner_id: [8, 'Test Supplier B'], state: 'draft', date_order: past, date_planned: future, currency_id: [1, 'UZS'], amount_total: 500, receipt_status: false, order_line: [] }],
  'purchase.order.line': () => [{ id: 101, order_id: [11, 'PO-T-1'], product_id: [1, 'Test oyna'], product_qty: 200, qty_received: 0, price_unit: 5, product_uom: [1, 'dona'] }],
  'stock.picking': () => [
    { id: 21, name: 'WH/OUT/0001', partner_id: [9, 'Test mijoz'], state: 'assigned', scheduled_date: past, origin: 'S0001', picking_type_id: [2, 'Delivery'], move_ids: [201] },
    { id: 22, name: 'WH/OUT/0002', partner_id: [9, 'Test mijoz'], state: 'confirmed', scheduled_date: future, origin: 'S0002', picking_type_id: [2, 'Delivery'], move_ids: [] }],
  'stock.move': () => [{ id: 201, picking_id: [21, 'WH/OUT/0001'], product_id: [1, 'Test oyna'], product_uom_qty: 10, quantity: 0, product_uom: [1, 'dona'] }],
};
const FIELDS = { 'product.product': ['id', 'default_code', 'name', 'categ_id', 'uom_id', 'qty_available', 'is_storable', 'active', 'barcode', 'weight'], 'res.partner': ['id', 'name', 'supplier_rank', 'active'],
  'stock.picking': ['id', 'name', 'partner_id', 'state', 'scheduled_date', 'date_done', 'origin', 'picking_type_id', 'move_ids', 'picking_type_code'] };
const mock = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const reply = (result, error) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(error ? { jsonrpc: '2.0', error: { message: error, data: { message: error } } } : { jsonrpc: '2.0', result })); };
    if (odoo.down) { res.writeHead(502); return res.end('bad gateway'); }
    const { service, method, args } = JSON.parse(body).params;
    if (service === 'common' && method === 'version') return reply({ server_version: '17.0' });
    if (service === 'common' && method === 'authenticate') return reply(args[2] === ODOO_KEY ? 2 : false);
    if (args[2] !== ODOO_KEY) return reply(null, 'Access denied');
    const [model, m, a] = [args[3], args[4], args[5]];
    if (m === 'search_count') return reply(1);
    if (m === 'fields_get') return reply(Object.fromEntries((FIELDS[model] || []).map((f) => [f, { type: 'char' }])));
    if (m === 'search_read') return reply(odoo[model] ? odoo[model]() : []);
    return reply(null, `unsupported ${model}.${m}`);
  });
});

const procs = [];
function start(seed, tag) {
  const port = 7300 + Math.floor(Math.random() * 300) + (tag === 'demo' ? 300 : 0);
  const p = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'server.js')], { env: { ...process.env, WMS_NO_DOTENV: '1', PORT: String(port), DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), `wms-odoo-${tag}-`)), SEED: seed,
    SUPERADMIN_LOGIN: SA.login, SUPERADMIN_NAME: SA.login, SUPERADMIN_PASSWORD: SA.password, TELEGRAM_BOT_TOKEN: '', ANTHROPIC_API_KEY: '', AI_API_KEY: '', GEMINI_API_KEY: '',
    BOT_MORNING_HOUR: '99', BOT_EVENING_HOUR: '99', BACKUP_DAILY: '0', AI_SCAN_SECONDS: '3600', DISPATCH_CYCLE_SECONDS: '3600', ANTIVIRUS: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout.on('data', (d) => { log += d; }); p.stderr.on('data', (d) => { log += d; });
  procs.push(p); return { base: `http://127.0.0.1:${port}`, log: () => log };
}
class Client {
  constructor(base) { this.base = base; }
  async login(u, pw) { const r = await fetch(`${this.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: pw }) }); if (!r.ok) throw new Error(`login ${u}: ${r.status}`); this.cookie = r.headers.get('set-cookie').split(';')[0]; const j = await r.json(); this.csrf = j.csrf; this.user = j.user; return this; }
  async req(method, url, body) { const r = await fetch(this.base + url, { method, headers: { cookie: this.cookie, 'content-type': 'application/json', 'x-csrf-token': this.csrf }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
  async ok(method, url, body) { const r = await this.req(method, url, body); if (r.status >= 400) throw new Error(`${method} ${url}: ${r.status} ${r.data.error}`); return r.data; }
}
const waitUp = async (base) => { for (let i = 0; i < 300; i++) { try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 150)); } };
const results = [];
async function test(n, title, fn) { try { const d = await fn(); results.push(true); console.log(`  ✅ ODOO ${n}: ${title} — ${d}`); } catch (e) { results.push(false); console.log(`  ❌ ODOO ${n}: ${title} — ${e.message}`); } }
const assert = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const ODOO_URL = `http://127.0.0.1:${mock.address().port}`;
  const R = start('real', 'real'); const D = start('demo', 'demo');
  await waitUp(R.base); await waitUp(D.base);
  console.log('\nSolar Factory WMS — ODOO VA REAL REJIM TESTI\n');
  const sa = await new Client(R.base).login(SA.login, SA.password);
  const cfg = { url: ODOO_URL, db: 'testdb', login: 'api@test', apiKey: ODOO_KEY, intervalMin: 15, modules: { stock: true, purchase: true, delivery: true } };

  await test(1, 'Ulanishni tekshirish: to‘g‘ri va noto‘g‘ri kalit', async () => {
    const ok = await sa.ok('POST', '/api/odoo/test', cfg);
    const bad = await sa.ok('POST', '/api/odoo/test', { ...cfg, apiKey: 'wrong-key-000000' });
    assert(ok.ok && ok.version === '17.0' && ok.models.stock && ok.models.purchase && ok.models.delivery, JSON.stringify(ok));
    assert(bad.ok === false && /noto‘g‘ri/.test(bad.error), `yomon kalit: ${JSON.stringify(bad)}`);
    return `Odoo ${ok.version} ✓; noto‘g‘ri kalit → “${bad.error}”`;
  });
  await test(2, 'Saqlash: kalit shifrlanadi va brauzerga qaytmaydi', async () => {
    await sa.ok('PUT', '/api/odoo', cfg);
    const d = await sa.ok('GET', '/api/odoo');
    assert(d.config.configured && !JSON.stringify(d).includes(ODOO_KEY) && d.config.apiKeyMasked, 'kalit ochiq qaytdi');
    return `ko‘rinishi: ${d.config.apiKeyMasked}`;
  });
  await test(3, 'Sinxronizatsiya: Ombor + Ta’minot + Logistika', async () => {
    const r = await sa.ok('POST', '/api/odoo/sync');
    assert(r.ok, `xatolar: ${r.errors}`);
    const prods = await sa.ok('GET', '/api/products');
    const glass = prods.find((p) => p.sku === 'OD-GLASS'); const frame = prods.find((p) => p.sku === 'ODOO-2');
    assert(glass && frame, `mahsulotlar: ${prods.map((p) => p.sku)}`);
    assert(glass.category === 'RAW' && Number(glass.min_stock) === 100, `kategoriya/min: ${glass.category}/${glass.min_stock}`);
    const inv = await sa.ok('GET', '/api/inventory/rows');
    const qty = inv.filter((x) => x.sku === 'OD-GLASS').reduce((a, x) => a + Number(x.qty || 0), 0);
    assert(qty === 40, `qoldiq: ${qty}`);
    const pos = await sa.ok('GET', '/api/odoo/purchases'); const dels = await sa.ok('GET', '/api/odoo/deliveries');
    assert(pos.length === 2 && pos.find((p) => p.name === 'PO-T-1').is_late === 1 && pos.find((p) => p.name === 'PO-T-1').lines.length === 1, 'PO');
    assert(dels.length === 2 && dels.find((d) => d.name === 'WH/OUT/0001').is_late === 1, 'jo‘natma');
    const sups = await sa.ok('GET', '/api/suppliers'); assert(sups.filter((s) => s.code.startsWith('ODOO-')).length === 2, 'supplier');
    return `2 mahsulot (qoldiq 40), 2 supplier, 2 PO (1 kechikkan), 2 jo‘natma (1 kechikkan)`;
  });
  await test(4, 'Qayta sinxronizatsiya: qoldiq o‘zgarishi va kechikish ogohlantirishi', async () => {
    odoo.qty = 65;
    await sa.ok('POST', '/api/odoo/sync');
    const inv = await sa.ok('GET', '/api/inventory/rows');
    const qty = inv.filter((x) => x.sku === 'OD-GLASS').reduce((a, x) => a + Number(x.qty || 0), 0);
    assert(qty === 65, `qoldiq: ${qty}`);
    const alerts = await sa.ok('GET', '/api/ai/alerts');
    assert(alerts.some((a) => /PO-T-1/.test(a.title)), 'kechikish ogohlantirishi yo‘q');
    return 'qoldiq 40 → 65 (tuzatish tranzaksiyasi), “PO-T-1 kechikmoqda” AI ogohlantirishi';
  });
  await test(5, 'Odoo ishlamasa — xato va ogohlantirish, keyin tiklanish', async () => {
    odoo.down = true;
    const r = await sa.req('POST', '/api/odoo/sync');
    assert(r.status === 400, `status ${r.status}`);
    const alerts = await sa.ok('GET', '/api/ai/alerts'); assert(alerts.some((a) => /Odoo bilan aloqa/.test(a.title)), 'ODOO_DOWN yo‘q');
    odoo.down = false;
    const ok = await sa.ok('POST', '/api/odoo/sync'); assert(ok.ok, 'tiklanmadi');
    return `xato: “${r.data.error.slice(0, 60)}…”; tiklangach sinxronizatsiya ✓`;
  });
  await test(6, 'Bo‘limlar: Ta’minot — Odoo xaridlari, Logistika — Odoo jo‘natmalari', async () => {
    const mk = async (section) => { const a = await sa.ok('POST', '/api/users/section-account', { section, full_name: `Test ${section}` }); return new Client(R.base).login(a.login, a.password); };
    const t = await mk('TAMINOT'); const l = await mk('ISHLAB'); const o = await mk('OMBOR');
    assert((await t.req('GET', '/api/odoo/purchases')).status === 200 && (await t.req('GET', '/api/odoo/deliveries')).status === 403, 'ta’minot');
    assert((await sa.req('GET', '/api/odoo/deliveries')).status === 200 && (await l.req('GET', '/api/odoo/purchases')).status === 403 && (await l.req('GET', '/api/odoo/deliveries')).status === 403, 'ishlab chiqarish');
    assert((await o.req('GET', '/api/odoo/purchases')).status === 403 && (await o.req('GET', '/api/odoo')).status === 403, 'ombor');
    const pt = await t.ok('GET', '/api/ai/pulse'); const pa = await sa.ok('GET', '/api/ai/pulse');
    assert(pt.metrics.map((m) => m.key).join() === 'shortages,approvals,supplierLate' && pt.metrics[2].value >= 1, `ta’minot pulse: ${JSON.stringify(pt.metrics)}`);
    assert(pa.headline && pa.odoo && pa.odoo.status === 'OK', 'admin pulse');
    return `bo‘lim cheklovi ✓; AI panel (Ta’minot): ${pt.headline}`;
  });
  await test(7, 'Real bazada “real rejimga o‘tish” kerak emas', async () => {
    const m = await sa.ok('GET', '/api/admin/mode'); const r = await sa.req('POST', '/api/admin/go-real', { confirm: 'REAL' });
    assert(!m.demo && r.status === 400, `${m.demo} ${r.status}`);
    return 'mode.demo = false, go-real → 400';
  });
  await test(8, 'Demo → Real: namunaviy ma’lumot o‘chadi, super admin va kalitlar qoladi', async () => {
    const d = await new Client(D.base).login(SA.login, SA.password);
    await d.ok('PUT', '/api/odoo', cfg);
    await d.ok('PUT', '/api/keys/AI_API_KEY', { value: 'AQ.TEST-KEY-FOR-REAL-SWITCH-0000-1111' });
    const before = await d.ok('GET', '/api/admin/mode');
    assert(before.demo && before.counts.products > 0, 'demo emas');
    assert((await d.req('POST', '/api/admin/go-real', { confirm: 'yo‘q' })).status === 400, 'tasdiqsiz o‘tdi');
    const r = await d.ok('POST', '/api/admin/go-real', { confirm: 'REAL' });
    assert(r.ok && r.keptUsers.includes(SA.login.toLowerCase()) && r.removedDemoUsers.includes('direktor'), JSON.stringify(r));
    const d2 = await new Client(D.base).login(SA.login, SA.password);
    const after = await d2.ok('GET', '/api/admin/mode');
    const demoLogin = await fetch(`${D.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'direktor', password: 'Solar2026!' }) });
    const keys = await d2.ok('GET', '/api/keys'); const od = await d2.ok('GET', '/api/odoo');
    assert(!after.demo && after.counts.orders === 0 && after.counts.shipments === 0 && demoLogin.status === 401, JSON.stringify(after));
    assert(keys.secrets.find((s) => s.name === 'AI_API_KEY').configured && od.config.configured, 'kalitlar yo‘qoldi');
    await new Promise((res) => setTimeout(res, 1500)); // Odoo'dan avtomatik tortish
    const prods = await d2.ok('GET', '/api/products');
    return `demo ${before.counts.products} mahsulot/${before.counts.orders} buyurtma → 0; demo login → 401; AI va Odoo kalitlari saqlandi; zaxira ${r.backup}; Odoo'dan ${prods.length} mahsulot tortildi`;
  });

  procs.forEach((p) => p.kill()); mock.close();
  const ok = results.filter(Boolean).length;
  console.log(`\nNATIJA: ${ok}/${results.length} Odoo/real rejim testi o‘tdi\n`);
  if (ok !== results.length) console.log(`--- real ---\n${R.log().slice(-2500)}\n--- demo ---\n${D.log().slice(-2500)}`);
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.error(e); procs.forEach((p) => p.kill()); process.exit(1); });
