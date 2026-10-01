'use strict';
// Ta'minot: purchase requests (zayavka) workflow, purchase orders, supplier deliveries, supplier performance.
const db = require('./db');
const inv = require('./inventory');
const { clock, bad, notFound, forbidden, V, round } = require('./core');

const FLOW = ['REQUESTED', 'APPROVED', 'ORDERED', 'SUPPLIER_CONFIRMED', 'IN_TRANSIT', 'ARRIVED', 'QC', 'RECEIVED'];
const pr = (id) => { const r = db.get('SELECT * FROM purchase_requests WHERE id=?', id); if (!r) throw notFound('Zayavka'); return r; };

function setStatus(r, to, user, note) {
  db.update('purchase_requests', r.id, { status: to, updated_at: clock.iso() });
  db.history('purchase_request', r.id, r.status, to, user, note);
  db.audit(user, `PR_${to}`, 'purchase_requests', r.pr_no, note ? { note } : null);
  db.emit('PURCHASE_REQUEST_STATUS', { id: r.id, prNo: r.pr_no, from: r.status, to });
}
function expect(r, ...allowed) { if (!allowed.includes(r.status)) throw bad(`Zayavka holati ${r.status}; kutilgan: ${allowed.join(' / ')}`); }

/** Best supplier for a product: on-time rate × quality, then lead time, then price. */
function bestSupplier(productId) {
  const rows = db.all(`SELECT s.id, s.company, sp.price, sp.currency, COALESCE(sp.lead_time_days, p.lead_time_days) lead_time_days FROM supplier_products sp
    JOIN suppliers s ON s.id=sp.supplier_id JOIN products p ON p.id=sp.product_id WHERE sp.product_id=? AND s.active=1`, productId);
  if (!rows.length) { const p = inv.product(productId); if (p.default_supplier_id) return { id: p.default_supplier_id, lead_time_days: p.lead_time_days, score: null }; return null; }
  const perf = Object.fromEntries(performance().map((x) => [x.supplier_id, x]));
  for (const r of rows) { const pf = perf[r.id]; r.score = pf ? (pf.on_time_rate / 100) * (pf.quality_rate / 100) : 0.8; }
  rows.sort((a, b) => b.score - a.score || a.lead_time_days - b.lead_time_days || (a.price || 0) - (b.price || 0));
  return rows[0];
}

function create(input, user) {
  return db.tx(() => {
    const p = inv.product(V.id(input.productId, 'Material'));
    const qty = V.qty(input.qty);
    const shortageId = V.optId(input.shortageId, 'Yetishmovchilik');
    let supplierId = V.optId(input.supplierId, 'Supplier');
    if (!supplierId) { const b = bestSupplier(p.id); if (!b) throw bad('Supplier tanlanmagan va mahsulot uchun supplier topilmadi'); supplierId = b.id; }
    if (!db.get('SELECT id FROM suppliers WHERE id=?', supplierId)) throw notFound('Supplier');
    const no = db.nextNo('PR');
    const id = db.insert('purchase_requests', {
      pr_no: no, supplier_id: supplierId, product_id: p.id, qty, required_date: input.requiredDate ? V.date(input.requiredDate, 'Kerakli sana') : clock.addDays(p.lead_time_days || 7),
      priority: V.oneOf(input.priority || 'NORMAL', 'Muhimlik', ['URGENT', 'HIGH', 'NORMAL', 'LOW']), reason: V.str(input.reason, 'Sabab', { max: 1000 }),
      production_order: V.str(input.productionOrder, 'Ishlab chiqarish buyurtmasi', { required: false, max: 80 }), order_id: V.optId(input.orderId, 'Buyurtma'), shortage_id: shortageId,
      warehouse_id: input.warehouseId || (p.category === 'FINISHED' ? 'WH-03' : 'WH-01'), status: 'REQUESTED', ai_generated: input.aiGenerated ? 1 : 0,
      created_by: user?.id, created_at: clock.iso(), updated_at: clock.iso(),
    });
    if (shortageId) db.run("UPDATE shortages SET status='REQUESTED', purchase_request_id=?, updated_at=? WHERE id=? AND status='OPEN'", id, clock.iso(), shortageId);
    db.history('purchase_request', id, null, 'REQUESTED', user);
    db.audit(user, 'PR_CREATE', 'purchase_requests', no, { sku: p.sku, qty, supplierId, ai: !!input.aiGenerated });
    db.emit('SUPPLIER_REQUEST_CREATED', { id, prNo: no, productId: p.id, sku: p.sku, qty, supplierId });
    return { id, prNo: no, status: 'REQUESTED' };
  });
}

function approve(id, input, user) {
  return db.tx(() => {
    const r = pr(id); expect(r, 'REQUESTED');
    if (r.created_by && r.created_by === user?.id && !['DIRECTOR', 'ADMIN'].includes(user.role)) throw forbidden('Zayavkani yaratgan xodim uni o‘zi tasdiqlay olmaydi (4 ko‘z tamoyili)');
    db.update('purchase_requests', r.id, { approved_by: user?.id, approved_at: clock.iso() });
    setStatus(r, 'APPROVED', user, input.note);
    return { status: 'APPROVED' };
  });
}
function reject(id, input, user) {
  return db.tx(() => {
    const r = pr(id); expect(r, 'REQUESTED', 'APPROVED');
    setStatus(r, 'REJECTED', user, V.str(input.reason, 'Rad etish sababi', { max: 500 }));
    if (r.shortage_id) db.run("UPDATE shortages SET status='OPEN', purchase_request_id=NULL WHERE id=? AND status='REQUESTED'", r.shortage_id);
    return { status: 'REJECTED' };
  });
}
function placeOrder(id, input, user) {
  return db.tx(() => {
    const r = pr(id); expect(r, 'APPROVED');
    const sp = db.get('SELECT * FROM supplier_products WHERE supplier_id=? AND product_id=?', r.supplier_id, r.product_id) || {};
    const poNo = db.nextNo('PO');
    const poId = db.insert('purchase_orders', { po_no: poNo, supplier_id: r.supplier_id, purchase_request_id: r.id, status: 'ORDERED', order_date: clock.iso(),
      expected_date: input.expectedDate ? V.date(input.expectedDate, 'Kutilgan sana') : r.required_date, total: round((sp.price || 0) * r.qty, 2), currency: sp.currency || 'USD', created_by: user?.id, created_at: clock.iso() });
    db.insert('purchase_items', { po_id: poId, product_id: r.product_id, qty: r.qty, price: sp.price || null });
    setStatus(r, 'ORDERED', user, poNo);
    return { poId, poNo, status: 'ORDERED' };
  });
}
function supplierConfirm(id, input, user) {
  return db.tx(() => {
    const r = pr(id); expect(r, 'ORDERED');
    const po = db.get('SELECT * FROM purchase_orders WHERE purchase_request_id=?', r.id);
    const expected = V.date(input.expectedDate || po.expected_date, 'Kutilgan yetkazish sanasi');
    const no = db.nextNo('DLV');
    const did = db.insert('supplier_deliveries', { delivery_no: no, po_id: po.id, purchase_request_id: r.id, supplier_id: r.supplier_id, product_id: r.product_id, qty: r.qty,
      expected_date: expected, original_expected_date: expected, status: 'CONFIRMED', created_at: clock.iso(), updated_at: clock.iso() });
    db.update('purchase_orders', po.id, { status: 'CONFIRMED', expected_date: expected });
    setStatus(r, 'SUPPLIER_CONFIRMED', user, `Kutilmoqda: ${expected.slice(0, 10)}`);
    return { deliveryId: did, deliveryNo: no, status: 'SUPPLIER_CONFIRMED' };
  });
}
function inTransit(id, input, user) {
  return db.tx(() => {
    const r = pr(id); expect(r, 'SUPPLIER_CONFIRMED');
    const d = db.get('SELECT * FROM supplier_deliveries WHERE purchase_request_id=? ORDER BY id DESC', r.id);
    db.update('supplier_deliveries', d.id, { status: 'IN_TRANSIT', vehicle: V.str(input.vehicle, 'Transport', { required: false, max: 80 }), driver: V.str(input.driver, 'Haydovchi', { required: false, max: 120 }),
      expected_date: input.expectedDate ? V.date(input.expectedDate, 'Kutilgan sana') : d.expected_date, updated_at: clock.iso() });
    setStatus(r, 'IN_TRANSIT', user);
    return { status: 'IN_TRANSIT' };
  });
}
/** Arrival at dock: creates a receiving order (stock RECEIVING = incoming, awaiting QC). */
function arrive(id, input, user) {
  return db.tx(() => {
    const r = pr(id); expect(r, 'SUPPLIER_CONFIRMED', 'IN_TRANSIT');
    const d = db.get('SELECT * FROM supplier_deliveries WHERE purchase_request_id=? ORDER BY id DESC', r.id);
    const qty = input.qty != null ? V.qty(input.qty) : r.qty;
    const po = db.get('SELECT * FROM purchase_orders WHERE purchase_request_id=?', r.id);
    const rcv = inv.receive({ source: 'SUPPLIER', productId: r.product_id, qty, supplierId: r.supplier_id, poId: po?.id, deliveryId: d.id, prId: r.id,
      deliveryNumber: input.deliveryNumber || d.delivery_no, vehicle: input.vehicle || d.vehicle, driver: input.driver || d.driver, batchNo: input.batchNo, qtyExpected: r.qty,
      weightKg: input.weightKg, documents: input.documents, serials: input.serials }, user);
    const late = d.expected_date && clock.now() > new Date(new Date(d.expected_date).getTime() + 86400000 - 1);
    db.update('supplier_deliveries', d.id, { status: 'ARRIVED', actual_date: clock.iso(), received_qty: qty, updated_at: clock.iso() });
    db.run("UPDATE ai_events SET status='RESOLVED', resolved_at=? WHERE dedupe_key=? AND status<>'RESOLVED'", clock.iso(), `delay-${d.id}`);
    setStatus(r, 'ARRIVED', user, `${rcv.rcvNo}${late ? ' (kechikib)' : ''}`);
    db.emit('SUPPLIER_DELIVERY_ARRIVED', { prId: r.id, deliveryId: d.id, receivingId: rcv.id, qty });
    return { status: 'ARRIVED', receiving: rcv, late };
  });
}
function startQc(id, user) { return db.tx(() => { const r = pr(id); expect(r, 'ARRIVED'); setStatus(r, 'QC', user); return { status: 'QC' }; }); }

/** Called by inventory.qualityCheck when a receiving linked to a PR is inspected. */
function onQcDone(rcv, res, user) {
  const r = pr(rcv.purchase_request_id);
  if (r.status === 'ARRIVED') { setStatus(r, 'QC', user, 'QC boshlandi'); r.status = 'QC'; }
  db.update('purchase_requests', r.id, { received_qty: round((r.received_qty || 0) + res.passed, 4) });
  setStatus(r, 'RECEIVED', user, `QC: o‘tdi ${res.passed}, rad ${res.failed + res.rework}`);
  if (rcv.delivery_id) db.update('supplier_deliveries', rcv.delivery_id, { status: 'RECEIVED', rejected_qty: res.failed + res.rework, updated_at: clock.iso() });
  if (rcv.po_id) { db.run('UPDATE purchase_items SET received_qty=received_qty+? WHERE po_id=?', res.passed, rcv.po_id); db.run("UPDATE purchase_orders SET status='RECEIVED' WHERE id=?", rcv.po_id); }
}

function cancel(id, input, user) {
  return db.tx(() => {
    const r = pr(id); expect(r, 'REQUESTED', 'APPROVED', 'ORDERED', 'SUPPLIER_CONFIRMED');
    setStatus(r, 'CANCELLED', user, V.str(input.reason, 'Sabab', { max: 500 }));
    db.run("UPDATE supplier_deliveries SET status='CANCELLED' WHERE purchase_request_id=?", r.id);
    if (r.shortage_id) db.run("UPDATE shortages SET status='OPEN', purchase_request_id=NULL WHERE id=? AND status='REQUESTED'", r.shortage_id);
    return { status: 'CANCELLED' };
  });
}

/** Supplier notifies a new ETA (or we record a slip). Delay alerting is done by the AI scan. */
function reschedule(deliveryId, input, user) {
  return db.tx(() => {
    const d = db.get('SELECT * FROM supplier_deliveries WHERE id=?', deliveryId); if (!d) throw notFound('Yetkazib berish');
    if (['ARRIVED', 'RECEIVED', 'CANCELLED'].includes(d.status)) throw bad('Yakunlangan yetkazishni o‘zgartirib bo‘lmaydi');
    const date = V.date(input.expectedDate, 'Yangi sana');
    db.update('supplier_deliveries', d.id, { expected_date: date, notes: [d.notes, input.reason].filter(Boolean).join('; '), updated_at: clock.iso() });
    db.audit(user, 'DELIVERY_RESCHEDULE', 'supplier_deliveries', d.delivery_no, { from: d.expected_date, to: date, reason: input.reason });
    db.emit('DELIVERY_UPDATED', { deliveryId: d.id });
    return { ok: true };
  });
}

/** AI-prepared draft for a shortage — returned to the UI for human confirmation, never auto-sent. */
function draftFromShortage(shortageId) {
  const s = db.get('SELECT * FROM shortages WHERE id=?', shortageId); if (!s) throw notFound('Yetishmovchilik');
  const p = inv.product(s.product_id); const o = s.order_id ? db.get('SELECT o.*, c.name customer FROM orders o LEFT JOIN customers c ON c.id=o.customer_id WHERE o.id=?', s.order_id) : null;
  const st = inv.productStock(p.id); const sup = bestSupplier(p.id);
  const supplier = sup ? db.get('SELECT id, company FROM suppliers WHERE id=?', sup.id) : null;
  const lead = sup?.lead_time_days || p.lead_time_days || 7;
  const due = o?.due_date ? new Date(o.due_date) : null;
  const daysLeft = due ? Math.ceil((due - clock.now()) / 86400000) : null;
  const priority = daysLeft == null ? 'NORMAL' : daysLeft <= lead ? 'URGENT' : daysLeft <= lead + 3 ? 'HIGH' : 'NORMAL';
  const perf = sup ? performance().find((x) => x.supplier_id === sup.id) : null;
  const text = [
    `Omborda ${st.available} ${p.unit} ${p.name} mavjud (erkin: ${Math.max(0, st.free)}, rezerv: ${st.reserved}).`,
    o ? `${o.order_no} (${o.customer || ''}) uchun ${s.required_qty} ${p.unit} talab qilinmoqda.` : '',
    `${s.shortage_qty} ${p.unit} yetishmaydi.`,
    supplier ? `Tavsiya etilgan supplier: ${supplier.company} — yetkazib berish muddati ${lead} kun${perf ? `, vaqtida yetkazish ${perf.on_time_rate}%` : ''}.` : 'Supplier topilmadi — qo‘lda tanlang.',
    `${s.shortage_qty} ${p.unit} uchun ${p.category === 'FINISHED' ? 'ishlab chiqarish/ta\'minot' : 'ta\'minot'} zayavkasi tayyorlandi. Yuborishdan oldin vakolatli xodim tasdiqlashi shart.`,
  ].filter(Boolean).join(' ');
  return { shortageId: s.id, productId: p.id, sku: p.sku, name: p.name, qty: s.shortage_qty, supplierId: supplier?.id || null, supplier: supplier?.company || null,
    requiredDate: (due && due > clock.now() ? due.toISOString() : clock.addDays(lead)).slice(0, 10), priority, orderId: s.order_id, warehouseId: p.category === 'FINISHED' ? 'WH-03' : 'WH-01',
    reason: `Yetishmovchilik ${s.shortage_no}${o ? ` — ${o.order_no}` : ''}`, leadTimeDays: lead, aiText: text };
}

/** Supplier performance computed from delivery + QC history. */
function performance() {
  const today = clock.now();
  return db.all('SELECT id, code, company, country FROM suppliers ORDER BY company').map((s) => {
    const d = db.all("SELECT * FROM supplier_deliveries WHERE supplier_id=? AND status<>'CANCELLED'", s.id);
    const done = d.filter((x) => x.actual_date);
    const delays = done.map((x) => Math.max(0, Math.ceil((new Date(x.actual_date) - new Date(x.expected_date || x.actual_date)) / 86400000 - 0.0001)));
    const late = delays.filter((x) => x > 0).length;
    const openLate = d.filter((x) => !x.actual_date && x.expected_date && new Date(x.expected_date).getTime() + 86400000 < today.getTime()).length;
    const leadDays = done.map((x) => (new Date(x.actual_date) - new Date(x.created_at)) / 86400000);
    const ordered = d.reduce((a, x) => a + (x.qty || 0), 0);
    const received = done.reduce((a, x) => a + (x.received_qty || 0), 0);
    const shortQty = done.reduce((a, x) => a + Math.max(0, (x.qty || 0) - (x.received_qty || 0)), 0);
    const rejected = done.reduce((a, x) => a + (x.rejected_qty || 0), 0);
    return { supplier_id: s.id, code: s.code, company: s.company, country: s.country, orders: d.length, delivered: done.length, on_time: done.length - late, late, open_late: openLate,
      on_time_rate: done.length ? round(((done.length - late) / done.length) * 100, 1) : 100, avg_delay_days: late ? round(delays.reduce((a, b) => a + b, 0) / late, 1) : 0,
      avg_lead_days: leadDays.length ? round(leadDays.reduce((a, b) => a + b, 0) / leadDays.length, 1) : null, ordered_qty: ordered, received_qty: received, short_qty: shortQty,
      rejected_qty: rejected, quality_rate: received ? round(((received - rejected) / received) * 100, 1) : 100 };
  });
}

module.exports = { FLOW, create, approve, reject, placeOrder, supplierConfirm, inTransit, arrive, startQc, onQcDone, cancel, reschedule, draftFromShortage, performance, bestSupplier };
