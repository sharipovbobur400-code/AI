'use strict';
// PRODUCTION test: BOM → ishlab chiqarish buyurtmasi → material berish (ombordan chiqim) → natija (ombor kirimi) → reja va MRP.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SA = { login: 'Test Superadmin', password: 'Test#Pass2026' }; // test-only credentials
const PORT = 8200 + Math.floor(Math.random() * 300); const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'server.js')], { env: { ...process.env, WMS_NO_DOTENV: '1', PORT: String(PORT), DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'wms-production-')), SEED: 'demo',
  SUPERADMIN_LOGIN: SA.login, SUPERADMIN_NAME: SA.login, SUPERADMIN_PASSWORD: SA.password, TELEGRAM_BOT_TOKEN: '', ANTHROPIC_API_KEY: '', AI_API_KEY: '', GEMINI_API_KEY: '',
  BOT_MORNING_HOUR: '99', BOT_EVENING_HOUR: '99', BACKUP_DAILY: '0', AI_SCAN_SECONDS: '3600', DISPATCH_CYCLE_SECONDS: '3600', ANTIVIRUS: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
class Client {
  async login(u, pw) { const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: pw }) }); if (!r.ok) throw new Error(`login ${u}: ${r.status}`); this.cookie = r.headers.get('set-cookie').split(';')[0]; const j = await r.json(); this.csrf = j.csrf; this.user = j.user; return this; }
  async req(method, url, body) { const r = await fetch(BASE + url, { method, headers: { cookie: this.cookie, 'content-type': 'application/json', 'x-csrf-token': this.csrf }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
  async ok(method, url, body) { const r = await this.req(method, url, body); if (r.status >= 400) throw new Error(`${method} ${url}: ${r.status} ${r.data.error}`); return r.data; }
}
const results = [];
async function test(n, title, fn) { try { const d = await fn(); results.push(true); console.log(`  ✅ PROD ${n}: ${title} — ${d}`); } catch (e) { results.push(false); console.log(`  ❌ PROD ${n}: ${title} — ${e.message}`); } }
const assert = (c, m) => { if (!c) throw new Error(m); };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;

(async () => {
  for (let i = 0; i < 300; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  console.log('\nSolar Factory WMS — ISHLAB CHIQARISH TESTI\n');
  const sa = await new Client().login(SA.login, SA.password);
  const stock = await sa.ok('GET', '/api/inventory');
  const fin = stock.find((s) => s.category === 'FINISHED');
  const comps = stock.filter((s) => ['RAW', 'MATERIAL', 'PACKAGING'].includes(s.category) && s.free >= 50).slice(0, 2);
  const freeOf = async (pid) => (await sa.ok('GET', '/api/inventory')).find((s) => s.product_id === pid);
  let po; let big; const before = {};

  await test(1, 'Mahsulot tarkibi (BOM) saqlanadi va tekshiriladi', async () => {
    assert(fin && comps.length === 2, 'demo ma’lumot yetarli emas');
    const bad = await sa.req('PUT', `/api/production/bom/${fin.product_id}`, { items: [{ componentId: fin.product_id, qtyPerUnit: 1 }] });
    assert(bad.status === 400, 'o‘zini komponent qildi');
    const r = await sa.ok('PUT', `/api/production/bom/${fin.product_id}`, { items: [{ componentId: comps[0].product_id, qtyPerUnit: 2, scrapPct: 10 }, { componentId: comps[1].product_id, qtyPerUnit: 0.5 }] });
    const b = await sa.ok('GET', `/api/production/bom/${fin.product_id}`);
    assert(r.components === 2 && b.items.length === 2, 'saqlanmadi');
    return `${fin.sku} = 2 × ${comps[0].sku} (+10% chiqindi) + 0.5 × ${comps[1].sku}`;
  });
  await test(2, 'Buyurtma yaratiladi — materiallar BOM bo‘yicha hisoblanadi', async () => {
    const r = await sa.ok('POST', '/api/production/orders', { productId: fin.product_id, qty: 10, line: '1-liniya', priority: 'HIGH' });
    po = r; const d = await sa.ok('GET', `/api/production/orders/${r.id}`);
    const m0 = d.materials.find((m) => m.component_id === comps[0].product_id); const m1 = d.materials.find((m) => m.component_id === comps[1].product_id);
    assert(/^PRD-\d{4}-\d{4}$/.test(r.poNo) && d.order.status === 'PLANNED' && near(m0.required_qty, 22) && near(m1.required_qty, 5), JSON.stringify(d.materials.map((m) => [m.sku, m.required_qty])));
    return `${r.poNo}: ${comps[0].sku} 22 (2×10+10%), ${comps[1].sku} 5`;
  });
  await test(3, 'Materiallarni berish — ombordan chiqim, holat RELEASED', async () => {
    for (const c of comps) before[c.product_id] = (await freeOf(c.product_id)).free;
    const r = await sa.ok('POST', `/api/production/orders/${po.id}/release`, {});
    const a0 = (await freeOf(comps[0].product_id)).free; const a1 = (await freeOf(comps[1].product_id)).free;
    const d = await sa.ok('GET', `/api/production/orders/${po.id}`);
    assert(r.issued === 2 && near(before[comps[0].product_id] - a0, 22) && near(before[comps[1].product_id] - a1, 5) && d.order.status === 'RELEASED' && d.issues.length >= 2, `berildi ${r.issued}, qoldiq ${a0}/${a1}`);
    const tx = await sa.ok('GET', '/api/inventory/transactions?limit=20'); assert(tx.some((t) => t.reference === po.poNo && t.type === 'ISSUE'), 'chiqim tranzaksiyasi yo‘q');
    return `${comps[0].sku} −22, ${comps[1].sku} −5 (hujjat ${po.poNo})`;
  });
  await test(4, 'Natija: yaroqli omborga kirim, brak — brak zonasiga; to‘lsa DONE', async () => {
    const f0 = await freeOf(fin.product_id);
    const r1 = await sa.ok('POST', `/api/production/orders/${po.id}/report`, { good: 6, reject: 1 });
    const d1 = await sa.ok('GET', `/api/production/orders/${po.id}`);
    assert(r1.status === 'IN_PROGRESS' && near(d1.order.good_qty, 6) && near(d1.order.reject_qty, 1) && r1.receiving, JSON.stringify(r1));
    const r2 = await sa.ok('POST', `/api/production/orders/${po.id}/report`, { good: 4 });
    const f1 = await freeOf(fin.product_id);
    assert(r2.status === 'DONE' && near(f1.on_hand - f0.on_hand, 10), `holat ${r2.status}, qoldiq farqi ${f1.on_hand - f0.on_hand}`);
    const rc = await sa.ok('GET', '/api/receiving?source=PRODUCTION&limit=10'); assert(rc.some((x) => x.production_order === po.poNo), 'kirim yo‘q');
    const d2 = await sa.ok('GET', `/api/production/orders/${po.id}`); const goodRows = d2.outputs.filter((x) => x.type === 'RECEIVE');
    assert(goodRows.length === 2 && near(goodRows.reduce((t, x) => t + x.qty, 0), 10) && d2.outputs.some((x) => x.type === 'REJECT'), `natijalar: ${JSON.stringify(d2.outputs.map((x) => [x.type, x.qty]))}`);
    return `6 + 4 yaroqli → ${fin.sku} omborda +10 (QC ga), 1 brak; holat DONE`;
  });
  await test(5, 'Material yetmasa — aniq xato; “borini berish” mumkin', async () => {
    big = await sa.ok('POST', '/api/production/orders', { productId: fin.product_id, qty: 1000000 });
    const r = await sa.req('POST', `/api/production/orders/${big.id}/release`, {});
    assert(r.status === 400 && /yetarli emas/.test(r.data.error), r.data.error);
    const p = await sa.ok('POST', `/api/production/orders/${big.id}/release`, { partial: true });
    assert(p.shortfalls.length >= 1, 'yetishmovchilik qaytmadi');
    const c = await sa.req('POST', `/api/production/orders/${big.id}/cancel`, { reason: 'test' }); assert(c.status === 400, 'material berilgan buyurtma bekor qilindi');
    return `xato: “${r.data.error.slice(0, 70)}…”; qisman berildi, yetishmaydi: ${p.shortfalls.length}`;
  });
  await test(6, 'MRP: yetishmaydigan materiallar va Ta’minotga zayavka', async () => {
    const mrp = await sa.ok('GET', '/api/production/mrp');
    const short = mrp.filter((m) => m.status === 'SHORT');
    assert(short.length >= 1 && short[0].shortfall > 0, 'MRP bo‘sh');
    const r = await sa.ok('POST', '/api/production/mrp/request', { componentIds: [short[0].componentId] });
    assert(r.created.length + r.errors.length === 1, JSON.stringify(r));
    return r.created.length ? `${short.length} ta yetishmaydi → zayavka ${r.created[0].prNo} (${r.created[0].sku} ${r.created[0].qty})` : `${short.length} ta yetishmaydi; zayavka: ${r.errors[0]}`;
  });
  await test(7, 'Reja: mijoz buyurtmasi qoldiqdan oshsa — ishlab chiqarish taklifi', async () => {
    await sa.ok('POST', `/api/production/orders/${big.id}/complete`); // katta test buyurtmasi rejani to‘ldirib qo‘ymasin
    const f = await freeOf(fin.product_id);
    await sa.ok('POST', '/api/orders', { customerName: 'Reja test', items: [{ productId: fin.product_id, qty: Math.ceil(f.available) + 50 }], destination: 'Toshkent' });
    const s = await sa.ok('GET', '/api/production/suggestions');
    const it = s.find((x) => x.productId === fin.product_id);
    assert(it && it.toMake > 0 && it.hasBom, JSON.stringify(s.slice(0, 3)));
    return `${it.sku}: talab ${it.demand}, omborda ${it.stock}, rejada ${it.planned} → ishlab chiqarish ${it.toMake}`;
  });
  await test(9, 'Logistika standart holatda yashirin', async () => {
    const meta = await sa.ok('GET', '/api/meta'); assert(meta.modules && meta.modules.logistics === false, `modules: ${JSON.stringify(meta.modules)}`);
    const d = await sa.ok('POST', '/api/dispatch/run', {}); assert(d.mode === 'off', `dispetcher: ${JSON.stringify(d).slice(0, 120)}`);
    await sa.ok('PUT', '/api/settings', { module_logistics: true }); const on = await sa.ok('GET', '/api/meta'); assert(on.modules.logistics === true, 'yoqilmadi');
    await sa.ok('PUT', '/api/settings', { module_logistics: false }); const off = await sa.ok('GET', '/api/meta'); assert(off.modules.logistics === false, 'o‘chmadi');
    return 'meta.modules.logistics=false, AI dispetcher ishlamaydi; super admin yoqib-o‘chira oladi';
  });
  await test(8, 'Panel va ruxsatlar', async () => {
    const o = await sa.ok('GET', '/api/production/overview');
    assert(o.today.good >= 10 && o.suggestions.length >= 1 && o.orders.byStatus.DONE >= 2, JSON.stringify({ today: o.today, orders: o.orders.open }));
    const v = await new Client().login('kuzatuvchi', 'Solar2026!');
    const r = await v.req('POST', '/api/production/orders', { productId: fin.product_id, qty: 1 }); assert(r.status === 403, `kuzatuvchi yaratdi: ${r.status}`);
    const acc = await sa.ok('POST', '/api/users/section-account', { section: 'ISHLAB', full_name: 'Texnolog' });
    const t = await new Client().login(acc.login, acc.password);
    const pulse = await t.ok('GET', '/api/ai/pulse'); assert(pulse.metrics.map((m) => m.key).join() === 'prodToday,prodOpen,prodShort', JSON.stringify(pulse.metrics));
    const mine = await t.ok('POST', '/api/production/orders', { productId: fin.product_id, qty: 2 }); assert(mine.poNo, 'texnolog yarata olmadi');
    return `bugun ${o.today.good} yaroqli, ochiq ${o.orders.open}, material yetishmaydi ${o.materials.short}; kuzatuvchi → 403; texnolog (${acc.login}) buyurtma yaratdi; AI panel: ${pulse.headline}`;
  });

  server.kill();
  const ok = results.filter(Boolean).length;
  console.log(`\nNATIJA: ${ok}/${results.length} ishlab chiqarish testi o‘tdi\n`);
  if (ok !== results.length) console.log(log.slice(-3000));
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.error(e); server.kill(); process.exit(1); });
