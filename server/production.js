'use strict';
// Ishlab chiqarish: mahsulot tarkibi (BOM), ishlab chiqarish buyurtmalari (reja → material berish → jarayon → natija),
// reja takliflari (mijoz buyurtmalari − tayyor qoldiq − rejadagi), material ehtiyoji (MRP) va ta’minotga zayavka.
// Ombor bilan bog‘liq barcha harakatlar inventory.move orqali (issue / productionReceipt) — qoldiq va audit bir xil.
const db = require('./db');
const inv = require('./inventory');
const { clock, bad, notFound, V, round } = require('./core');

const STATUSES = ['PLANNED', 'RELEASED', 'IN_PROGRESS', 'DONE', 'CANCELLED'];
const OPEN = ['PLANNED', 'RELEASED', 'IN_PROGRESS'];
const PRODUCIBLE = ['FINISHED', 'WIP'];
const COMPONENTS = ['RAW', 'MATERIAL', 'PACKAGING', 'WIP'];

// ---------------- BOM ----------------
function bomOf(productId) {
  return db.all(`SELECT b.id, b.component_id, b.qty_per_unit, b.scrap_pct, b.note, p.sku, p.name, p.unit, p.category FROM bom_items b JOIN products p ON p.id=b.component_id
    WHERE b.product_id=? ORDER BY p.category, p.sku`, productId);
}
function bomList() {
  return db.all(`SELECT p.id, p.sku, p.name, p.unit, p.category, (SELECT COUNT(*) FROM bom_items b WHERE b.product_id=p.id) components
    FROM products p WHERE p.status='ACTIVE' AND p.category IN ('FINISHED','WIP') ORDER BY components DESC, p.category, p.sku`);
}
function saveBom(productId, items, user) {
  return db.tx(() => {
    const p = inv.product(V.id(productId, 'Mahsulot'));
    if (!PRODUCIBLE.includes(p.category)) throw bad('Tarkib faqat tayyor yoki yarim tayyor mahsulot uchun');
    const rows = (V.arr(items, 'Komponentlar', { required: false }) || []).map((it) => {
      const c = inv.product(V.id(it.componentId, 'Komponent'));
      if (c.id === p.id) throw bad('Mahsulot o‘zining komponenti bo‘la olmaydi');
      return { component_id: c.id, qty_per_unit: V.num(it.qtyPerUnit, `${c.sku}: 1 dona uchun miqdor`, { min: 0.000001 }), scrap_pct: V.num(it.scrapPct || 0, `${c.sku}: chiqindi %`, { min: 0, max: 50 }), note: it.note ? String(it.note).slice(0, 200) : null };
    });
    if (new Set(rows.map((r) => r.component_id)).size !== rows.length) throw bad('Bir komponent ikki marta kiritilgan');
    const old = bomOf(p.id);
    db.run('DELETE FROM bom_items WHERE product_id=?', p.id);
    for (const r of rows) db.insert('bom_items', { product_id: p.id, ...r, updated_at: clock.iso() });
    db.audit(user, 'BOM_UPDATE', 'products', p.sku, { before: old.length, after: rows.length });
    db.emit('PRODUCTION_BOM', { productId: p.id, sku: p.sku });
    return { ok: true, components: rows.length };
  });
}

// ---------------- buyurtmalar ----------------
const order = (id) => { const o = db.get('SELECT * FROM production_orders WHERE id=?', id); if (!o) throw notFound('Ishlab chiqarish buyurtmasi'); return o; };
function materialsOf(id) {
  const stock = Object.fromEntries(inv.stockSummary().map((s) => [s.product_id, s]));
  return db.all(`SELECT m.*, p.sku, p.name, p.unit FROM production_materials m JOIN products p ON p.id=m.component_id WHERE m.production_order_id=? ORDER BY p.sku`, id)
    .map((m) => { const s = stock[m.component_id] || {}; const need = Math.max(0, round(m.required_qty - m.issued_qty, 4)); return { ...m, remaining: need, free: s.free ?? 0, inbound: s.inbound ?? 0, shortfall: Math.max(0, round(need - (s.free ?? 0), 4)) }; });
}
function list({ status, all } = {}) {
  const where = status ? 'WHERE o.status=?' : all ? '' : `WHERE o.status IN (${OPEN.map(() => '?').join(',')}) OR o.updated_at>=?`;
  const params = status ? [status] : all ? [] : [...OPEN, clock.addDays(-7)];
  return db.all(`SELECT o.*, p.sku, p.name, p.unit, so.order_no sales_order, u.full_name creator,
      (SELECT COUNT(*) FROM production_materials m WHERE m.production_order_id=o.id) materials
    FROM production_orders o JOIN products p ON p.id=o.product_id LEFT JOIN orders so ON so.id=o.order_id LEFT JOIN users u ON u.id=o.created_by
    ${where} ORDER BY CASE o.status WHEN 'IN_PROGRESS' THEN 0 WHEN 'RELEASED' THEN 1 WHEN 'PLANNED' THEN 2 WHEN 'DONE' THEN 3 ELSE 4 END, o.planned_end, o.id DESC LIMIT 500`, ...params)
    .map((o) => ({ ...o, late: OPEN.includes(o.status) && o.planned_end && o.planned_end < clock.iso() }));
}
function detail(id) {
  const o = db.get(`SELECT o.*, p.sku, p.name, p.unit, p.category, so.order_no sales_order FROM production_orders o JOIN products p ON p.id=o.product_id LEFT JOIN orders so ON so.id=o.order_id WHERE o.id=?`, id);
  if (!o) throw notFound('Ishlab chiqarish buyurtmasi');
  // yaroqli — ishlab chiqarishdan kirim hujjatlari; rework / brak — shu buyurtma raqami bilan yozilgan harakatlar
  const outputs = [
    ...db.all(`SELECT 'RECEIVE' type, r.qty_received qty, r.created_at, r.rcv_no doc, u.full_name FROM receiving_orders r LEFT JOIN users u ON u.id=r.created_by WHERE r.source='PRODUCTION' AND r.production_order=? AND r.qty_received>0`, o.po_no),
    ...db.all(`SELECT t.type, t.qty, t.created_at, t.txn_no doc, u.full_name FROM inventory_transactions t LEFT JOIN users u ON u.id=t.user_id WHERE t.reference=? AND t.type IN ('REWORK','REJECT')`, o.po_no),
  ].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 50);
  const issues = db.all(`SELECT t.qty, t.created_at, p.sku, p.name, p.unit FROM inventory_transactions t JOIN products p ON p.id=t.product_id WHERE t.reference=? AND t.type='ISSUE' ORDER BY t.id DESC LIMIT 100`, o.po_no);
  return { order: { ...o, late: OPEN.includes(o.status) && o.planned_end && o.planned_end < clock.iso() }, materials: materialsOf(id), outputs, issues, history: db.all("SELECT h.*, u.full_name user FROM status_history h LEFT JOIN users u ON u.id=h.user_id WHERE entity='production_order' AND entity_id=? ORDER BY h.id", id) };
}
function create(input, user) {
  return db.tx(() => {
    const p = inv.product(V.id(input.productId, 'Mahsulot'));
    if (!PRODUCIBLE.includes(p.category)) throw bad('Faqat tayyor yoki yarim tayyor mahsulot ishlab chiqariladi');
    const qty = V.num(input.qty, 'Miqdor', { min: p.track_serial ? 1 : 0.0001, int: !!p.track_serial });
    const start = input.plannedStart ? V.date(input.plannedStart, 'Boshlanish') : clock.iso();
    const end = input.plannedEnd ? V.date(input.plannedEnd, 'Tugash') : clock.addDays(1);
    if (end < start) throw bad('Tugash sanasi boshlanishdan oldin bo‘lishi mumkin emas');
    const no = db.nextNo('PRD');
    const id = db.insert('production_orders', { po_no: no, product_id: p.id, qty, status: 'PLANNED', priority: ['URGENT', 'HIGH', 'NORMAL', 'LOW'].includes(input.priority) ? input.priority : 'NORMAL',
      line: input.line ? String(input.line).slice(0, 80) : null, planned_start: start, planned_end: end, order_id: V.optId(input.orderId, 'Buyurtma'), notes: input.notes ? String(input.notes).slice(0, 1000) : null,
      created_by: user?.id, created_at: clock.iso(), updated_at: clock.iso() });
    const bom = bomOf(p.id);
    for (const b of bom) db.insert('production_materials', { production_order_id: id, component_id: b.component_id, required_qty: round(qty * b.qty_per_unit * (1 + (b.scrap_pct || 0) / 100), 4), issued_qty: 0 });
    db.history('production_order', id, null, 'PLANNED', user);
    db.audit(user, 'PRODUCTION_CREATE', 'production_orders', no, { sku: p.sku, qty, materials: bom.length });
    db.emit('PRODUCTION_CREATED', { id, poNo: no, sku: p.sku, qty });
    return { id, poNo: no, materials: bom.length, warning: bom.length ? null : 'Mahsulot tarkibi (BOM) kiritilmagan — materiallar hisoblanmadi' };
  });
}
function setStatus(o, to, user, extra = {}) {
  db.update('production_orders', o.id, { status: to, updated_at: clock.iso(), ...extra });
  db.history('production_order', o.id, o.status, to, user);
  db.emit('PRODUCTION_STATUS', { id: o.id, poNo: o.po_no, from: o.status, to });
}
/** Materiallarni ombordan ishlab chiqarishga berish (ISSUE). Yetmasa — xato (partial=true bo‘lsa borini beradi). */
function release(id, { partial = false } = {}, user) {
  return db.tx(() => {
    const o = order(id);
    if (!['PLANNED', 'RELEASED', 'IN_PROGRESS'].includes(o.status)) throw bad(`Holat: ${o.status} — material berib bo‘lmaydi`);
    const mats = materialsOf(id);
    const short = mats.filter((m) => m.shortfall > 0);
    if (short.length && !partial) throw bad(`Omborda yetarli emas: ${short.map((m) => `${m.sku} ${round(m.shortfall, 2)} ${m.unit}`).join(', ')}. Material ehtiyoji sahifasidan ta’minotga zayavka yuboring yoki “borini berish” ni tanlang.`);
    let issued = 0;
    for (const m of mats) {
      const q = round(Math.min(m.remaining, m.free), 4);
      if (q <= 0) continue;
      inv.issue({ productId: m.component_id, qty: q, reason: `Ishlab chiqarishga berildi (${o.po_no})`, reference: o.po_no }, user);
      db.run('UPDATE production_materials SET issued_qty=issued_qty+? WHERE id=?', q, m.id);
      issued++;
    }
    if (o.status === 'PLANNED') setStatus(o, 'RELEASED', user, { released_at: clock.iso() });
    db.audit(user, 'PRODUCTION_RELEASE', 'production_orders', o.po_no, { issued, partial });
    return { ok: true, issued, shortfalls: short.map((m) => ({ sku: m.sku, qty: m.shortfall })) };
  });
}
function start(id, user) {
  return db.tx(() => { const o = order(id); if (!['PLANNED', 'RELEASED'].includes(o.status)) throw bad(`Holat: ${o.status}`); setStatus(o, 'IN_PROGRESS', user, { started_at: clock.iso() }); return { ok: true }; });
}
/** Natija: yaroqli / rework / brak — ombor kirimi (PRODUCTION), rework va brak zonalari. */
function report(id, input, user) {
  return db.tx(() => {
    const o = order(id);
    if (!['RELEASED', 'IN_PROGRESS', 'PLANNED'].includes(o.status)) throw bad(`Holat: ${o.status} — natija kiritib bo‘lmaydi`);
    const good = Number(input.good || 0); const rework = Number(input.rework || 0); const reject = Number(input.reject || 0);
    const total = round(good + rework + reject, 4);
    if (!(total > 0)) throw bad('Natija miqdorini kiriting');
    const r = inv.productionReceipt({ productId: o.product_id, total, good, rework, reject, productionOrder: o.po_no, batchNo: input.batchNo || null, notes: input.notes }, user);
    const produced = round(o.produced_qty + total, 4);
    const upd = { produced_qty: produced, good_qty: round(o.good_qty + good, 4), rework_qty: round(o.rework_qty + rework, 4), reject_qty: round(o.reject_qty + reject, 4), updated_at: clock.iso() };
    if (o.status !== 'IN_PROGRESS') { upd.started_at = o.started_at || clock.iso(); db.update('production_orders', o.id, upd); setStatus({ ...o, ...upd }, 'IN_PROGRESS', user); } else db.update('production_orders', o.id, upd);
    const fresh = order(id);
    if (round(fresh.good_qty, 4) >= round(fresh.qty, 4)) setStatus(fresh, 'DONE', user, { completed_at: clock.iso() });
    db.audit(user, 'PRODUCTION_OUTPUT', 'production_orders', o.po_no, { good, rework, reject });
    db.emit('PRODUCTION_OUTPUT', { id: o.id, poNo: o.po_no, good, rework, reject, rcvNo: r.receiving?.rcvNo || null });
    return { ok: true, status: order(id).status, receiving: r.receiving?.rcvNo || null };
  });
}
function complete(id, user) { return db.tx(() => { const o = order(id); if (!OPEN.includes(o.status)) throw bad(`Holat: ${o.status}`); setStatus(o, 'DONE', user, { completed_at: clock.iso() }); db.audit(user, 'PRODUCTION_COMPLETE', 'production_orders', o.po_no); return { ok: true }; }); }
function cancel(id, reason, user) {
  return db.tx(() => {
    const o = order(id); if (!['PLANNED', 'RELEASED'].includes(o.status)) throw bad('Faqat boshlanmagan buyurtmani bekor qilish mumkin');
    if (o.status === 'RELEASED' && db.val('SELECT COALESCE(SUM(issued_qty),0) FROM production_materials WHERE production_order_id=?', o.id) > 0) throw bad('Materiallar berilgan — avval omborga qaytaring (Kirim → Qaytarish) yoki natija kiriting');
    setStatus(o, 'CANCELLED', user, { notes: [o.notes, `Bekor: ${String(reason || '').slice(0, 300)}`].filter(Boolean).join('\n') });
    db.audit(user, 'PRODUCTION_CANCEL', 'production_orders', o.po_no, { reason });
    return { ok: true };
  });
}

// ---------------- reja va MRP ----------------
/** Mijoz buyurtmalari bo‘yicha ishlab chiqarish kerak bo‘lgan miqdor (rejadagilar hisobga olingan). */
function suggestions() {
  const demand = db.all(`SELECT oi.product_id, SUM(oi.qty - oi.shipped_qty) need, MIN(o.due_date) due, GROUP_CONCAT(DISTINCT o.order_no) orders FROM order_items oi JOIN orders o ON o.id=oi.order_id
    WHERE o.status NOT IN ('SHIPPED','DELIVERED','CANCELLED') GROUP BY oi.product_id`);
  const planned = Object.fromEntries(db.all(`SELECT product_id, SUM(qty - good_qty) q FROM production_orders WHERE status IN (${OPEN.map(() => '?').join(',')}) GROUP BY product_id`, ...OPEN).map((r) => [r.product_id, r.q]));
  const stock = Object.fromEntries(inv.stockSummary().map((s) => [s.product_id, s]));
  return demand.map((d) => {
    const s = stock[d.product_id]; if (!s || !PRODUCIBLE.includes(s.category)) return null;
    const have = round(s.available, 4); const inPlan = round(planned[d.product_id] || 0, 4);
    const toMake = round(Math.max(0, d.need - have - inPlan), 4);
    return { productId: d.product_id, sku: s.sku, name: s.name, unit: s.unit, demand: d.need, stock: have, planned: inPlan, toMake, due: d.due, orders: d.orders, hasBom: !!db.val('SELECT COUNT(*) FROM bom_items WHERE product_id=?', d.product_id) };
  }).filter((x) => x && x.toMake > 0).sort((a, b) => String(a.due).localeCompare(String(b.due)));
}
/** Ochiq buyurtmalar uchun hali berilmagan materiallar va ombordagi erkin qoldiq. */
function mrp() {
  const rows = db.all(`SELECT m.component_id, SUM(m.required_qty - m.issued_qty) need, COUNT(DISTINCT m.production_order_id) orders FROM production_materials m JOIN production_orders o ON o.id=m.production_order_id
    WHERE o.status IN (${OPEN.map(() => '?').join(',')}) AND m.required_qty > m.issued_qty GROUP BY m.component_id`, ...OPEN);
  const stock = Object.fromEntries(inv.stockSummary().map((s) => [s.product_id, s]));
  return rows.map((r) => { const s = stock[r.component_id] || {}; const shortfall = round(Math.max(0, r.need - (s.free || 0) - (s.inbound || 0) - (s.requested || 0)), 4);
    return { componentId: r.component_id, sku: s.sku, name: s.name, unit: s.unit, category: s.category, need: round(r.need, 4), free: s.free || 0, inbound: s.inbound || 0, requested: s.requested || 0, shortfall, orders: r.orders, status: shortfall > 0 ? 'SHORT' : (s.free || 0) >= r.need ? 'OK' : 'INBOUND' }; })
    .sort((a, b) => b.shortfall - a.shortfall);
}
/** Yetishmaydigan materiallarga ta’minot zayavkasi (supplier — mahsulotning asosiy supplieri). */
function requestShortfalls(componentIds, user) {
  const list = mrp().filter((m) => m.shortfall > 0 && (!componentIds?.length || componentIds.includes(m.componentId)));
  const proc = require('./procurement'); const created = []; const errors = [];
  for (const m of list) {
    try { const r = proc.create({ productId: m.componentId, qty: Math.ceil(m.shortfall), reason: `Ishlab chiqarish uchun material yetishmaydi (${m.orders} ta buyurtma)`, priority: 'HIGH', requiredDate: clock.addDays(3) }, user); created.push({ sku: m.sku, prNo: r.prNo, qty: Math.ceil(m.shortfall) }); }
    catch (e) { errors.push(`${m.sku}: ${e.message}`); }
  }
  db.audit(user, 'PRODUCTION_MRP_REQUEST', 'production', null, { created: created.length, errors: errors.length });
  return { created, errors };
}

// ---------------- panel ----------------
function overview() {
  const offMin = Number(process.env.BOT_TZ_OFFSET_MIN ?? 300);
  const localDay = new Date(Date.now() + offMin * 60000).toISOString().slice(0, 10);
  const dayStart = new Date(Date.parse(`${localDay}T00:00:00Z`) - offMin * 60000).toISOString();
  const out = (since) => db.get("SELECT COALESCE(SUM(qty_received),0) good, COALESCE(SUM(production_total),0) total, COALESCE(SUM(reject_qty),0) reject, COALESCE(SUM(rework_qty),0) rework, COUNT(*) n FROM receiving_orders WHERE source='PRODUCTION' AND created_at>=?", since);
  const today = out(dayStart); const week = out(clock.addDays(-7));
  const byStatus = Object.fromEntries(db.all('SELECT status, COUNT(*) n FROM production_orders GROUP BY status').map((r) => [r.status, r.n]));
  const daily = db.all("SELECT substr(created_at,1,10) d, SUM(qty_received) good, SUM(COALESCE(reject_qty,0)) reject FROM receiving_orders WHERE source='PRODUCTION' AND created_at>=? GROUP BY d ORDER BY d", clock.addDays(-14));
  const m = mrp();
  return {
    today: { good: today.good, total: today.total || today.good, reject: today.reject, rework: today.rework, receipts: today.n },
    week: { good: week.good, total: week.total || week.good, defectPct: (week.total || week.good) ? round(((week.reject + week.rework) / (week.total || week.good)) * 100, 1) : 0 },
    orders: { open: OPEN.reduce((a, s) => a + (byStatus[s] || 0), 0), byStatus, late: db.val(`SELECT COUNT(*) FROM production_orders WHERE status IN (${OPEN.map(() => '?').join(',')}) AND planned_end<?`, ...OPEN, clock.iso()) },
    materials: { short: m.filter((x) => x.status === 'SHORT').length, inbound: m.filter((x) => x.status === 'INBOUND').length, list: m.slice(0, 8) },
    suggestions: suggestions().slice(0, 10), active: list().filter((o) => OPEN.includes(o.status)).slice(0, 10), daily,
    wip: inv.stockSummary({ category: 'WIP' }).filter((s) => s.available > 0).slice(0, 10).map((s) => ({ sku: s.sku, name: s.name, qty: s.available, unit: s.unit })),
    recent: db.all("SELECT r.rcv_no, r.qty_received, r.reject_qty, r.rework_qty, r.production_order, r.created_at, p.name, p.unit FROM receiving_orders r JOIN products p ON p.id=r.product_id WHERE r.source='PRODUCTION' ORDER BY r.id DESC LIMIT 10"),
    bomCoverage: { products: db.val("SELECT COUNT(*) FROM products WHERE status='ACTIVE' AND category IN ('FINISHED','WIP')"), withBom: db.val('SELECT COUNT(DISTINCT product_id) FROM bom_items') },
  };
}

module.exports = { STATUSES, OPEN, PRODUCIBLE, COMPONENTS, bomOf, bomList, saveBom, list, detail, create, release, start, report, complete, cancel, suggestions, mrp, requestShortfalls, overview };
