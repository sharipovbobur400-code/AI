'use strict';
// FINAL ACCEPTANCE TEST — starts a fresh server (own DB), drives the real HTTP API as different users
// (RBAC + CSRF + sessions), listens to the SSE stream, and checks all 15 scenarios from the spec.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3999 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-acceptance-'));
const PW = 'Solar2026!';
const results = [];
let server;

class Client {
  constructor(name) { this.name = name; this.cookie = ''; this.csrf = ''; }
  async login(username) {
    const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PW }) });
    if (!r.ok) throw new Error(`login ${username}: ${r.status}`);
    this.cookie = r.headers.get('set-cookie').split(';')[0]; this.csrf = (await r.json()).csrf; return this;
  }
  async req(method, url, body, { raw, noCsrf } = {}) {
    const r = await fetch(BASE + url, { method, headers: { cookie: this.cookie, ...(body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' && !noCsrf ? { 'x-csrf-token': this.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text();
    if (raw) return { status: r.status, data };
    if (!r.ok) throw new Error(`${method} ${url} → ${r.status}: ${data.error || data}`);
    return data;
  }
  get(u) { return this.req('GET', u); } post(u, b) { return this.req('POST', u, b || {}); } put(u, b) { return this.req('PUT', u, b || {}); }
}

function sse(client) { // collect server-sent events
  const events = []; const ctrl = new AbortController();
  const ready = (async () => {
    const r = await fetch(`${BASE}/api/events/stream`, { headers: { cookie: client.cookie }, signal: ctrl.signal });
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /event: (.+)/.exec(block); const data = /data: (.+)/.exec(block); if (ev) events.push({ type: ev[1], data: data ? JSON.parse(data[1]) : {}, at: Date.now() }); } } } catch {} })();
  })();
  return { events, ready, close: () => ctrl.abort(), waitFor: async (type, pred = () => true, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const e = events.find((x) => x.type === type && pred(x.data)); if (e) return e; await new Promise((r) => setTimeout(r, 50)); } return null; } };
}

async function test(n, title, expected, fn) {
  const t0 = Date.now();
  try { const detail = await fn(); results.push({ n, title, expected, ok: true, detail, ms: Date.now() - t0 }); console.log(`  ✅ TEST ${n}: ${title} — ${detail}`); }
  catch (e) { results.push({ n, title, expected, ok: false, detail: e.message, ms: Date.now() - t0 }); console.log(`  ❌ TEST ${n}: ${title} — ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const stockOf = async (c, pid) => (await c.get(`/api/inventory?q=${encodeURIComponent('SP-700W-AT')}`)).find((s) => s.product_id === pid);

async function main() {
  console.log(`\nSolar Factory WMS — FINAL ACCEPTANCE TEST\nServer: ${BASE}  DB: ${DATA}\n`);
  server = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'server.js')], { env: { ...process.env, WMS_NO_DOTENV: '1', LOGISTICS_MODULE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, AI_SCAN_SECONDS: '3600', BACKUP_DAILY: '0', ANTHROPIC_API_KEY: '', AI_API_KEY: '', GEMINI_API_KEY: '', SEED: 'demo', TELEGRAM_BOT_TOKEN: '', SUPERADMIN_LOGIN: '', SUPERADMIN_PASSWORD: '', DISPATCH_CYCLE_SECONDS: '3600' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }

  const mgr = await new Client('menejer').login('menejer');
  const sk = await new Client('omborchi1').login('omborchi1');
  const qc = await new Client('qc').login('qc');
  const lg = await new Client('logist').login('logist');
  const pr = await new Client('taminot').login('taminot');
  const dir = await new Client('direktor').login('direktor');
  const viewer = await new Client('kuzatuvchi').login('kuzatuvchi');
  const stream = sse(dir); await stream.ready; await new Promise((r) => setTimeout(r, 300));

  // test fixture: a brand-new panel SKU (starts at zero stock) + a project
  const prod = await mgr.post('/api/products', { sku: 'SP-700W-AT', name: 'Acceptance test panel 700W', category: 'FINISHED', model: 'AT-700', power_w: 700, length_mm: 2384, width_mm: 1303, height_mm: 33, net_weight_kg: 38.3, gross_weight_kg: 39.5, units_per_pallet: 31, pallet_weight_kg: 25, pallet_length_mm: 2400, pallet_width_mm: 1330, pallet_height_mm: 1300, packaging_weight_kg: 20, max_stack: 2, orientation: 'VERTICAL', track_serial: true, min_stock: 0, lead_time_days: 3, default_supplier_id: 1 });
  const PID = prod.id;
  const project = await mgr.post('/api/projects', { code: 'PRJ-AT', name: 'Acceptance test project', customerName: 'AT Energy LLC' });
  let o1; let o2; let shortage; let prq; let shipment; let pallets;

  await test(1, '100 dona mahsulot qabul qil', 'Inventory +100', async () => {
    const r = await sk.post('/api/receiving/production', { productId: PID, productionOrder: 'PRD-AT-001', total: 100, good: 100, rework: 0, reject: 0 });
    let s = await stockOf(mgr, PID); assert(s.receiving === 100, `qabul zonasida 100 kutilgan, bor ${s.receiving}`);
    const q = await qc.post(`/api/receiving/${r.receiving.id}/qc`, { passed: 100, failed: 0, rework: 0 });
    s = await stockOf(mgr, PID);
    assert(s.on_hand === 100 && s.available === 100, `on_hand=${s.on_hand}, available=${s.available}`);
    const tx = await mgr.get(`/api/inventory/transactions?productId=${PID}&type=RECEIVE`); assert(tx.length === 1 && tx[0].qty === 100 && tx[0].serial_count === 100, 'RECEIVE tranzaksiya / 100 serial');
    return `RECEIVING → QC ${q.result} → Available 100 (${q.placements.map((p) => `${p.code}:${p.qty}`).join(', ')}), 100 serial`;
  });

  await test(2, '20 dona picking qil', 'Available 80', async () => {
    o1 = await mgr.post('/api/orders', { customerName: 'AT Mijoz 1', items: [{ productId: PID, qty: 20 }], destination: 'Toshkent' });
    assert(o1.status === 'RESERVED', `buyurtma holati ${o1.status}`);
    const t = await mgr.post('/api/picking', { orderId: o1.id });
    const d = await sk.get(`/api/picking/${t.id}`);
    const bad = await sk.post(`/api/picking/${t.id}/scan`, { code: 'SP-450W-M', lineId: d.lines[0].id }); assert(!bad.ok && bad.message.startsWith('❌'), 'noto‘g‘ri mahsulot aniqlanmadi');
    const good = await sk.post(`/api/picking/${t.id}/scan`, { code: 'SP-700W-AT', lineId: d.lines[0].id }); assert(good.ok, 'to‘g‘ri mahsulot tasdiqlanmadi');
    for (const l of d.lines) await sk.post(`/api/picking/lines/${l.id}/pick`, {});
    const s = await stockOf(mgr, PID); assert(s.available === 80, `available=${s.available}`);
    return `scan: "${bad.message}" / "${good.message}"; Available ${s.available}, Picked ${s.picked}`;
  });

  await test(3, '50 dona rezerv qil', 'Available (free) 30', async () => {
    const r = await mgr.post('/api/inventory/reservations', { productId: PID, qty: 50, projectId: project.id, note: 'Loyiha uchun oldindan rezerv' });
    const s = await stockOf(mgr, PID); assert(s.free === 30 && s.reserved === 50 && s.available === 80, `available=${s.available}, reserved=${s.reserved}, free=${s.free}`);
    const over = await mgr.req('POST', '/api/inventory/reservations', { productId: PID, qty: 31, projectId: project.id }, { raw: true }); assert(over.status === 400, 'free dan ortiq rezervga ruxsat berildi');
    return `${r.resNo}: Stock 80 · Reserved 50 · Free 30 (31 dona rezerv urinish → 400 "${over.data.error.slice(0, 60)}…")`;
  });

  await test(4, '100 dona order yarat', 'Shortage 20', async () => {
    o2 = await mgr.post('/api/orders', { customerName: 'AT Energy LLC', projectId: project.id, items: [{ productId: PID, qty: 100 }], priority: 'URGENT', dueDate: new Date(Date.now() + 36 * 3600000).toISOString(), destination: 'Navoiy, AT FES' });
    const a = o2.analysis[0]; assert(a.shortage === 20 && a.reserved === 80, `reserved=${a.reserved}, shortage=${a.shortage}`);
    const sh = (await mgr.get('/api/shortages')).find((x) => x.order_id === o2.id); assert(sh && sh.shortage_qty === 20, 'shortage yozuvi yo‘q');
    shortage = sh;
    const ev = await stream.waitFor('SHORTAGE_DETECTED', (d) => d.orderId === o2.id); assert(ev, 'SHORTAGE_DETECTED event kelmadi');
    return `${o2.orderNo}: loyiha rezervi 50 + erkin 30 = 80 rezerv; 🔴 ${sh.shortage_qty} dona yetishmaydi ("${a.message}")`;
  });

  await test(5, '20 dona purchase request yarat', 'Supplier request', async () => {
    const draft = await mgr.get(`/api/shortages/${shortage.id}/draft`); assert(draft.qty === 20 && draft.supplierId, 'AI draft noto‘g‘ri');
    prq = await mgr.post('/api/purchase-requests', { productId: PID, qty: draft.qty, supplierId: draft.supplierId, requiredDate: draft.requiredDate, priority: draft.priority, reason: draft.reason, shortageId: shortage.id, orderId: o2.id, aiGenerated: true });
    assert(prq.status === 'REQUESTED', prq.status);
    const ev = await stream.waitFor('SUPPLIER_REQUEST_CREATED', (d) => d.id === prq.id); assert(ev, 'SUPPLIER_REQUEST_CREATED event kelmadi');
    const self = await mgr.req('POST', `/api/purchase-requests/${prq.id}/approve`, {}, { raw: true }); assert(self.status === 403, '4 ko‘z tamoyili buzildi');
    const noPerm = await sk.req('POST', `/api/purchase-requests/${prq.id}/approve`, {}, { raw: true }); assert(noPerm.status === 403, 'omborchi tasdiqlay oldi (RBAC)');
    await pr.post(`/api/purchase-requests/${prq.id}/approve`, { note: 'OK' });
    const po = await pr.post(`/api/purchase-requests/${prq.id}/order`, {});
    await pr.post(`/api/purchase-requests/${prq.id}/confirm`, { expectedDate: new Date(Date.now() + 86400000).toISOString() });
    await pr.post(`/api/purchase-requests/${prq.id}/transit`, { vehicle: '01 X 000 XX' });
    const sh = (await mgr.get('/api/shortages')).find((x) => x.id === shortage.id); assert(sh.status === 'REQUESTED', 'shortage REQUESTED emas');
    return `${prq.prNo} (AI draft: "${draft.aiText.slice(0, 70)}…") → REQUESTED → APPROVED → ${po.poNo} ORDERED → SUPPLIER_CONFIRMED → IN_TRANSIT`;
  });

  await test(6, '20 dona kelgan deb belgila', 'Incoming +20', async () => {
    const before = await stockOf(mgr, PID);
    const a = await sk.post(`/api/purchase-requests/${prq.id}/arrive`, { qty: 20, deliveryNumber: 'DN-AT-1' });
    const after = await stockOf(mgr, PID); assert(after.receiving - before.receiving === 20, `receiving ${before.receiving} → ${after.receiving}`);
    assert(await stream.waitFor('MATERIAL_RECEIVED', (d) => d.receivingId === a.receiving.id), 'MATERIAL_RECEIVED event yo‘q');
    await qc.post(`/api/receiving/${a.receiving.id}/qc`, { passed: 20 });
    const s2 = await stockOf(mgr, PID); const o = await mgr.get(`/api/orders/${o2.id}`);
    const prd = await mgr.get(`/api/purchase-requests/${prq.id}`);
    assert(o.items[0].need === 0 && o.items[0].reserved === 100, `buyurtma rezervi ${o.items[0].reserved}`);
    assert(prd.request.status === 'RECEIVED', prd.request.status);
    return `Incoming (qabul zonasi) ${before.receiving} → ${after.receiving}; QC → Available ${s2.available}; shortage avtomatik yopildi, ${o.order.order_no} rezerv 100/100, zayavka RECEIVED`;
  });

  await test(7, '100 dona yig‘', 'Picking completed', async () => {
    const t = await mgr.post('/api/picking', { orderId: o2.id });
    const d = await sk.get(`/api/picking/${t.id}`);
    await sk.post(`/api/picking/${t.id}/start`);
    let last; for (const l of d.lines) last = await sk.post(`/api/picking/lines/${l.id}/pick`, {});
    const t2 = await sk.get(`/api/picking/${t.id}`);
    assert(t2.task.status === 'COMPLETED' && last.completed, `holat ${t2.task.status}`);
    assert(await stream.waitFor('PICKING_COMPLETED', (x) => x.taskId === t.id), 'PICKING_COMPLETED event yo‘q');
    const o = await mgr.get(`/api/orders/${o2.id}`); assert(o.order.status === 'PICKED', o.order.status);
    return `${t.taskNo}: marshrut ${t.route.join(' → ')}; ${d.lines.length} qator, 100 dona → COMPLETED, buyurtma PICKED`;
  });

  await test(8, 'Pallet yarat', 'Pallet traceability', async () => {
    const r = await sk.post('/api/pallets', { orderId: o2.id });
    pallets = r.pallets;
    assert(pallets.length === 4 && pallets.map((p) => p.qty).join(',') === '31,31,31,7', `palletlar: ${pallets.map((p) => p.qty)}`);
    const p0 = pallets[0]; const expected = +(31 * 38.3 + 25 + 20).toFixed(2);
    assert(Math.abs(p0.gross_weight_kg - expected) < 0.01, `gross ${p0.gross_weight_kg} ≠ ${expected}`);
    const tr = await mgr.get(`/api/trace/pallet/${p0.palletNo}`); assert(tr.serials.length === 31 && tr.order.order_no === o2.orderNo, 'pallet → serial bog‘lanmagan');
    for (const p of pallets) await sk.post(`/api/pallets/${p.id}/dispatch-zone`);
    return `4 pallet (31/31/31/7); ${p0.palletNo}: 31 × 38.3 + 25 + 20 = ${p0.gross_weight_kg} kg; pallet → 31 serial → ${tr.order.order_no}`;
  });

  let calc;
  await test(9, 'Transport tanla', 'weight/volume/capacity validation', async () => {
    calc = await lg.post('/api/transport/calculate', { orderId: o2.id });
    assert(calc.totals.palletCount === 4 && calc.totals.grossWeight > 3900, `jami ${calc.totals.grossWeight} kg`);
    const van = calc.vehicles.find((v) => v.code === 'V-01');
    assert(!van.fits && van.reasons.length, 'furgon noto‘g‘ri mos deb topildi');
    const rej = await lg.req('POST', '/api/shipments', { orderId: o2.id, vehicleId: van.vehicleId, destination: 'Navoiy' }, { raw: true });
    assert(rej.status === 400 && /sig‘imi yetarli emas/.test(rej.data.error), `kichik transport rad etilmadi: ${rej.status}`);
    assert(calc.recommended && calc.recommended.fits && calc.recommended.checks.weight.ok && calc.recommended.checks.volume.ok && calc.recommended.checks.pallets.ok, 'tavsiya yo‘q');
    return `Og‘irlik ${calc.totals.grossWeight} kg, hajm ${calc.totals.volume} m³, 4 pallet → V-01 rad: "${van.reasons.join('; ')}"; tavsiya ${calc.recommended.code} ${calc.recommended.type} (og‘irlik ${calc.recommended.checks.weight.util}%, hajm ${calc.recommended.checks.volume.util}%)`;
  });

  await test(10, 'Shipment yarat', 'Loading task', async () => {
    shipment = await lg.post('/api/shipments', { orderId: o2.id, vehicleId: calc.recommended.vehicleId, destination: 'Navoiy, AT FES', distanceKm: 450, plannedDeparture: new Date(Date.now() + 3 * 3600000).toISOString() });
    const d = await lg.get(`/api/shipments/${shipment.id}`);
    assert(d.loading && d.loading.status === 'PENDING' && d.loading.sequence.length === 4, 'loading task yo‘q');
    const heavyFirst = d.loading.sequence[0].weight >= d.loading.sequence[d.loading.sequence.length - 1].weight;
    assert(heavyFirst, 'og‘ir yuk birinchi (pastda) emas');
    return `${shipment.shipNo} → ${shipment.loadingTask.taskNo} (PENDING, ~${shipment.loadingTask.estimatedMinutes} daq, yuklovchi ${shipment.loadingTask.assignedTo?.full_name}); ketma-ketlik: ${d.loading.sequence.map((s) => `${s.palletNo}@${s.position}`).join(' | ')}`;
  });

  await test(11, 'Shipment dispatch', 'Inventory decrement', async () => {
    const before = await stockOf(mgr, PID);
    const d = await lg.get(`/api/shipments/${shipment.id}`);
    await sk.post(`/api/loading/${d.loading.id}/start`);
    const wrong = await sk.post(`/api/loading/${d.loading.id}/scan`, { code: 'PAL-9999-9999' }); assert(!wrong.ok, 'noto‘g‘ri pallet qabul qilindi');
    for (const p of pallets) { const r = await sk.post(`/api/loading/${d.loading.id}/scan`, { code: p.palletNo }); assert(r.ok, r.message); }
    const done = await sk.post(`/api/loading/${d.loading.id}/complete`, {}); assert(done.documents.length === 6, 'hujjatlar generatsiya qilinmadi');
    const early = await lg.req('POST', `/api/shipments/${shipment.id}/dispatch`, {}, { raw: true }); // documents exist → should pass
    assert(early.status === 200, `dispatch: ${early.data.error}`);
    const after = await stockOf(mgr, PID);
    assert(before.on_hand - after.on_hand === 100 && after.loaded === 0, `on_hand ${before.on_hand} → ${after.on_hand}`);
    const ship = await mgr.get(`/api/inventory/transactions?productId=${PID}&type=SHIP`); assert(ship.reduce((a, t) => a + t.qty, 0) === 100, 'SHIP tranzaksiyalar 100 emas');
    assert(await stream.waitFor('SHIPMENT_DISPATCHED', (x) => x.shipmentId === shipment.id), 'SHIPMENT_DISPATCHED event yo‘q');
    return `Yuklash → 6 hujjat (Packing List, Delivery Note, Loading Sheet, Issue, Shipment Record, Transport Assignment) → DISPATCHED; on-hand ${before.on_hand} → ${after.on_hand} (SHIP −100)`;
  });

  await test(12, 'Panel serialini search qil', 'To‘liq traceability', async () => {
    const d = await mgr.get(`/api/shipments/${shipment.id}`);
    const serial = d.serials[17];
    const found = await mgr.get(`/api/search?q=${encodeURIComponent(serial)}`); assert(found.some((x) => x.kind === 'serial' && x.label === serial), 'global qidiruvda topilmadi');
    const t = await mgr.get(`/api/trace/serial/${encodeURIComponent(serial)}`);
    const steps = t.chain.map((c) => c.step);
    assert(t.status === 'SHIPPED' && t.shipment && t.shipment.vehicle_code && t.shipment.driver && t.pallet && t.order.customer === 'AT Energy LLC' && t.order.project_code === 'PRJ-AT', 'zanjir to‘liq emas');
    assert(['QC', 'Buyurtma', 'Pallet', 'Jo‘natma'].every((s) => steps.includes(s)), `qadamlar: ${steps}`);
    return `${serial}: ${steps.join(' → ')} | ${t.batch.batch_no} · ${t.pallet.pallet_no} · ${t.shipment.ship_no} · ${t.shipment.vehicle_code} ${t.shipment.plate} · ${t.shipment.driver} · ${t.order.customer}/${t.order.project_code} · ${t.history.length} harakat`;
  });

  await test(13, 'Stock o‘zgartir', 'Director dashboard real-time update', async () => {
    const glass = (await dir.get('/api/inventory?q=RM-GLASS-32'))[0];
    const n0 = stream.events.length;
    const t0 = Date.now();
    await sk.post('/api/inventory/issue', { productId: glass.product_id, qty: 20, reason: 'Ishlab chiqarishga berildi', reference: 'AT-ISSUE' });
    const ev = await stream.waitFor('STOCK_CHANGED', (d) => d.productId === glass.product_id && d.type === 'ISSUE', 3000);
    assert(ev && stream.events.indexOf(ev) >= n0, 'Direktor SSE oqimida STOCK_CHANGED kelmadi');
    const after = (await dir.get('/api/inventory?q=RM-GLASS-32'))[0];
    assert(glass.available - after.available === 20, `${glass.available} → ${after.available}`);
    const neg = await sk.req('POST', '/api/inventory/issue', { productId: glass.product_id, qty: after.free + 5, reason: 'test' }, { raw: true });
    assert(neg.status === 400 && /yetarli mahsulot mavjud emas/.test(neg.data.error), 'manfiy qoldiqqa ruxsat berildi');
    const csrf = await sk.req('POST', '/api/inventory/issue', { productId: glass.product_id, qty: 1, reason: 'x' }, { raw: true, noCsrf: true }); assert(csrf.status === 403, 'CSRF himoyasi ishlamadi');
    const rbac = await viewer.req('POST', '/api/receiving', { productId: glass.product_id, qty: 1, source: 'OTHER' }, { raw: true }); assert(rbac.status === 403, 'Viewer kirim qila oldi');
    return `Omborchi 20 dona chiqardi → direktor SSE ${ev.at - t0} ms da oldi: ${glass.available} → ${after.available}. Qo‘shimcha: manfiy stock → 400, CSRFsiz → 403, Viewer → 403`;
  });

  await test(14, 'Supplier deliveryni kechiktir', 'AI alert', async () => {
    const eva = (await mgr.get('/api/inventory?q=RM-BS-TPT'))[0];
    const p2 = await mgr.post('/api/purchase-requests', { productId: eva.product_id, qty: 500, supplierId: 3, reason: 'AT delay test' });
    await pr.post(`/api/purchase-requests/${p2.id}/approve`); await pr.post(`/api/purchase-requests/${p2.id}/order`);
    const c = await pr.post(`/api/purchase-requests/${p2.id}/confirm`, { expectedDate: new Date(Date.now() + 2 * 86400000).toISOString() });
    const past = new Date(); past.setUTCDate(past.getUTCDate() - 2);
    await pr.post(`/api/supplier-deliveries/${c.deliveryId}/reschedule`, { expectedDate: past.toISOString(), reason: 'Supplier yuklashni kechiktirdi' });
    await mgr.post('/api/ai/scan');
    const alerts = await mgr.get('/api/ai/alerts');
    const a = alerts.find((x) => x.type === 'DELIVERY_DELAY' && x.ref_id === c.deliveryId);
    assert(a && a.severity === 'CRITICAL', 'DELIVERY_DELAY alert yaratilmadi');
    assert(await stream.waitFor('DELIVERY_DELAYED', (d) => d.deliveryId === c.deliveryId), 'DELIVERY_DELAYED event yo‘q');
    return `🔴 ${a.title}: "${a.message}"`;
  });

  await test(15, 'XETQ hujjatini submit qil', 'status SUBMITTED', async () => {
    const ts = await qc.post('/api/technical-specifications', { projectId: project.id, productId: PID, title: 'AT-700 texnik shartlari', model: 'AT-700', power: '700 W', dimensions: '2384×1303×33', weight: '38.3 kg', standards: 'IEC 61215; IEC 61730' });
    await qc.post(`/api/technical-specifications/${ts.id}/status`, { status: 'IN_REVIEW' });
    await mgr.post(`/api/technical-specifications/${ts.id}/status`, { status: 'APPROVED' });
    const ds = await qc.post('/api/documents', { docType: 'DATASHEET', title: 'AT-700 datasheet', projectId: project.id, content: '<p>Pmax 700W</p>' });
    const sub = await qc.post('/api/xetq', { title: 'AT-700 texnik paketi', projectId: project.id, productId: PID, qty: 1000, tsId: ts.id, documentIds: [ds.id], responsibleId: 7 });
    for (const s of ['INTERNAL_REVIEW', 'READY_FOR_SUBMISSION', 'SUBMITTED']) await qc.post(`/api/xetq/${sub.id}/transition`, { status: s });
    const d = await mgr.get(`/api/xetq/${sub.id}`);
    assert(d.submission.status === 'SUBMITTED', d.submission.status);
    assert(d.documents.some((x) => x.doc_type === 'TECHNICAL_PACKAGE' && x.sha256), 'Technical Document Package yaratilmadi');
    assert(await stream.waitFor('DOCUMENT_SUBMITTED', (x) => x.id === sub.id), 'DOCUMENT_SUBMITTED event yo‘q');
    const skipBad = await qc.req('POST', `/api/xetq/${sub.id}/transition`, { status: 'APPROVED' }, { raw: true }); assert(skipBad.status === 400 || skipBad.status === 403, 'bosqichni sakrab o‘tish mumkin bo‘ldi');
    return `${sub.subNo}: DRAFT → INTERNAL_REVIEW → READY_FOR_SUBMISSION → SUBMITTED; TS ${ts.tsNo} v1.0 APPROVED; paket SHA-256 bilan; SUBMITTED → APPROVED sakrash rad etildi`;
  });

  // extra integrity checks
  const audit = await dir.get('/api/audit?limit=1000');
  const actions = new Set(audit.map((a) => a.action));
  const need = ['RECEIVE', 'QC', 'PICK', 'RESERVE', 'PR_CREATE', 'TRANSPORT_ASSIGN', 'SHIPMENT_DISPATCH', 'DOC_VERSION'];
  const missing = need.filter((a) => !actions.has(a));
  console.log(`\n  Audit: ${audit.length} yozuv; ${missing.length ? `YO‘Q: ${missing.join(', ')}` : `barcha kerakli amallar qayd etilgan (${need.join(', ')})`}`);
  stream.close();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nNATIJA: ${passed}/${results.length} test o‘tdi${missing.length ? ' (audit tekshiruvi: xato)' : ''}\n`);
  fs.writeFileSync(path.join(__dirname, 'acceptance-report.json'), JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, auditEntries: audit.length, auditMissing: missing, results }, null, 2));
  return passed === results.length && !missing.length;
}

main().then((ok) => { server.kill(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {} process.exit(ok ? 0 : 1); })
  .catch((e) => { console.error(e); if (server) server.kill(); process.exit(1); });
