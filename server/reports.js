'use strict';
// Dashboards, KPIs, reports, global search, QR resolution and full traceability.
const db = require('./db');
const inv = require('./inventory');
const ai = require('./ai');
const { clock, bad, notFound, round } = require('./core');

const dayStart = (offset = 0) => { const d = clock.now(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString(); };

function warehouseDashboard() {
  const st = inv.stockSummary();
  const sum = (k, f = () => true) => round(st.filter(f).reduce((a, s) => a + (s[k] || 0), 0), 2);
  const t0 = dayStart(0); const t1 = dayStart(1);
  const cap = ai.capacity();
  const incomingToday = db.all(`SELECT d.delivery_no, s.company, p.name, d.qty, d.expected_date, d.status FROM supplier_deliveries d JOIN suppliers s ON s.id=d.supplier_id LEFT JOIN products p ON p.id=d.product_id
    WHERE d.status IN ('CONFIRMED','IN_TRANSIT') AND d.expected_date>=? AND d.expected_date<?`, t0, t1);
  const lateIncoming = db.all(`SELECT d.delivery_no, s.company, p.name, d.qty, d.expected_date FROM supplier_deliveries d JOIN suppliers s ON s.id=d.supplier_id LEFT JOIN products p ON p.id=d.product_id
    WHERE d.status IN ('CONFIRMED','IN_TRANSIT') AND d.expected_date<?`, clock.addDays(-1));
  const shipToday = db.all(`SELECT s.ship_no, s.status, s.destination, s.planned_departure, s.pallet_count FROM shipments s WHERE s.status IN ('PLANNED','LOADING','LOADED') AND s.planned_departure<?`, t1);
  const needTransport = db.all(`SELECT o.id, o.order_no, o.due_date FROM orders o WHERE o.status IN ('PACKED','PICKED') AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.order_id=o.id AND s.status NOT IN ('CANCELLED'))`);
  const readyToShip = db.get("SELECT COUNT(*) n, COALESCE(SUM(qty),0) q FROM pallets WHERE status='PACKED'");
  const movement = db.all(`SELECT substr(created_at,1,10) d, SUM(CASE WHEN type IN ('RECEIVE','RETURN') THEN qty ELSE 0 END) inq, SUM(CASE WHEN type IN ('SHIP','ISSUE') THEN qty ELSE 0 END) outq
    FROM inventory_transactions WHERE created_at>=? AND product_id IN (SELECT id FROM products WHERE category='FINISHED') GROUP BY d ORDER BY d`, dayStart(-13));
  const alerts = db.all("SELECT * FROM ai_events WHERE status='OPEN' ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, id DESC LIMIT 12");
  return {
    kpi: {
      total: sum('on_hand'), available: sum('available'), reserved: sum('reserved'), free: sum('free'), shortage: sum('shortage'), rework: sum('rework'), scrap: sum('scrap'),
      receiving: sum('receiving'), readyToShip: readyToShip.q, readyPallets: readyToShip.n, incomingToday: incomingToday.length, lateIncoming: lateIncoming.length, shipToday: shipToday.length,
      needTransport: needTransport.length, alerts: alerts.filter((a) => a.severity !== 'INFO').length,
      panels: { available: sum('available', (s) => s.category === 'FINISHED'), reserved: sum('reserved', (s) => s.category === 'FINISHED'), free: sum('free', (s) => s.category === 'FINISHED') },
    },
    finished: st.filter((s) => s.category === 'FINISHED'), low: st.filter((s) => s.low), capacity: cap, incomingToday, lateIncoming, shipToday, needTransport, movement, alerts,
    recent: db.all(`SELECT t.txn_no, t.type, t.qty, t.created_at, p.sku, u.full_name user, t.reference FROM inventory_transactions t JOIN products p ON p.id=t.product_id LEFT JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 12`),
  };
}

function directorDashboard() {
  const cap = ai.capacity();
  const pos = cap.reduce((a, c) => a + c.positions, 0); const used = cap.reduce((a, c) => a + c.usedPallets, 0);
  const pk = db.get(`SELECT COALESCE(SUM(oi.qty),0) required, COALESCE(SUM(oi.picked_qty),0) picked FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.status IN ('NEW','PARTIALLY_RESERVED','RESERVED','PICKING','PICKED','PACKED','LOADING')`);
  const st = inv.stockSummary({ category: 'FINISHED' });
  return {
    warehouse: { pct: round((used / Math.max(1, pos)) * 100, 1), usedPallets: used, positions: pos, capacity: cap },
    stock: { panels: round(st.reduce((a, s) => a + s.available, 0)), reserved: round(st.reduce((a, s) => a + s.reserved, 0)), free: round(st.reduce((a, s) => a + s.free, 0)) },
    supply: { shortages: db.val("SELECT COUNT(*) FROM shortages WHERE status IN ('OPEN','REQUESTED')"), shortageQty: db.val("SELECT COALESCE(SUM(shortage_qty),0) FROM shortages WHERE status IN ('OPEN','REQUESTED')"),
      openRequests: db.val("SELECT COUNT(*) FROM purchase_requests WHERE status NOT IN ('RECEIVED','REJECTED','CANCELLED')"), awaitingApproval: db.val("SELECT COUNT(*) FROM purchase_requests WHERE status='REQUESTED'") },
    supplier: { delays: db.val("SELECT COUNT(*) FROM supplier_deliveries WHERE status IN ('CONFIRMED','IN_TRANSIT') AND expected_date<?", clock.addDays(-1)), inTransit: db.val("SELECT COUNT(*) FROM supplier_deliveries WHERE status='IN_TRANSIT'") },
    picking: { picked: pk.picked, required: pk.required, openTasks: db.val("SELECT COUNT(*) FROM picking_tasks WHERE status IN ('PENDING','IN_PROGRESS')") },
    logistics: { active: db.val("SELECT COUNT(*) FROM shipments WHERE status IN ('PLANNED','LOADING','LOADED','DISPATCHED')"), inTransit: db.val("SELECT COUNT(*) FROM shipments WHERE status='DISPATCHED'"),
      late: db.val("SELECT COUNT(*) FROM shipments WHERE status='DISPATCHED' AND eta<?", clock.iso()), loading: db.val("SELECT COUNT(*) FROM shipments WHERE status='LOADING'") },
    transport: { available: db.val("SELECT COUNT(*) FROM vehicles WHERE status='AVAILABLE'"), total: db.val('SELECT COUNT(*) FROM vehicles'),
      byStatus: db.all('SELECT status, COUNT(*) n FROM vehicles GROUP BY status') },
    xetq: { inReview: db.val("SELECT COUNT(*) FROM xetq_submissions WHERE status IN ('SUBMITTED','UNDER_REVIEW','INTERNAL_REVIEW')"), revision: db.val("SELECT COUNT(*) FROM xetq_submissions WHERE status='REVISION_REQUIRED'"),
      approved: db.val("SELECT COUNT(*) FROM xetq_submissions WHERE status='APPROVED'"), byStatus: db.all('SELECT status, COUNT(*) n FROM xetq_submissions GROUP BY status') },
    ai: { alerts: db.val("SELECT COUNT(*) FROM ai_events WHERE status='OPEN' AND severity<>'INFO'"), critical: db.val("SELECT COUNT(*) FROM ai_events WHERE status='OPEN' AND severity='CRITICAL'"),
      top: db.all("SELECT id, severity, title, message, created_at FROM ai_events WHERE status='OPEN' ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, id DESC LIMIT 8") },
    orders: db.all("SELECT status, COUNT(*) n FROM orders GROUP BY status"),
    updatedAt: clock.iso(),
  };
}

function workerKpi(days = 30) {
  const since = clock.addDays(-days);
  const m = require('./modules');
  return db.all("SELECT id, full_name, role_code, section FROM users WHERE role_code IN ('STOREKEEPER','MANAGER','LOGISTICS') AND active=1").filter((u) => m.logisticsOn() || !m.isLogiUser(u)).map((u) => {
    const pt = db.all("SELECT * FROM picking_tasks WHERE assigned_to=? AND status='COMPLETED' AND completed_at>=?", u.id, since);
    const qty = pt.length ? db.val(`SELECT COALESCE(SUM(picked_qty),0) FROM picking_task_lines WHERE task_id IN (${pt.map(() => '?').join(',')})`, ...pt.map((t) => t.id)) : 0;
    const scans = pt.reduce((a, t) => a + t.scans, 0); const errors = pt.reduce((a, t) => a + t.errors, 0);
    const mins = pt.filter((t) => t.started_at).map((t) => (new Date(t.completed_at) - new Date(t.started_at)) / 60000);
    const lt = db.all("SELECT actual_minutes FROM loading_tasks WHERE assigned_to=? AND status='COMPLETED' AND completed_at>=?", u.id, since);
    const counts = db.all(`SELECT l.system_qty, l.physical_qty FROM inventory_count_lines l JOIN inventory_counts c ON c.id=l.count_id WHERE l.counted_by=? AND c.created_at>=? AND l.physical_qty IS NOT NULL`, u.id, since);
    return { userId: u.id, name: u.full_name, role: u.role_code, pickedOrders: pt.length, pickedQty: qty, errors, scans, errorRate: scans ? round((errors / scans) * 100, 1) : 0,
      avgPickMinutes: mins.length ? round(mins.reduce((a, b) => a + b, 0) / mins.length, 1) : null, loadings: lt.length,
      avgLoadMinutes: lt.length ? round(lt.reduce((a, b) => a + b.actual_minutes, 0) / lt.length, 1) : null,
      inventoryAccuracy: counts.length ? round((counts.filter((c) => c.system_qty === c.physical_qty).length / counts.length) * 100, 1) : null,
      openTasks: db.val("SELECT COUNT(*) FROM picking_tasks WHERE assigned_to=? AND status IN ('PENDING','IN_PROGRESS')", u.id) + db.val("SELECT COUNT(*) FROM loading_tasks WHERE assigned_to=? AND status IN ('PENDING','IN_PROGRESS')", u.id) };
  });
}

function myTasks(user, all) {
  const w = all ? '' : 'AND t.assigned_to=?'; const p = all ? [] : [user.id];
  const pick = db.all(`SELECT 'picking' kind, t.id, t.task_no, t.status, t.deadline, t.assigned_to, u.full_name assignee, o.order_no ref, (SELECT SUM(qty) FROM picking_task_lines WHERE task_id=t.id) qty FROM picking_tasks t JOIN orders o ON o.id=t.order_id LEFT JOIN users u ON u.id=t.assigned_to WHERE t.status IN ('PENDING','IN_PROGRESS') ${w}`, ...p);
  const pack = db.all(`SELECT 'packing' kind, t.id, t.task_no, t.status, t.deadline, t.assigned_to, u.full_name assignee, o.order_no ref, o.id order_id, (SELECT SUM(picked_qty-packed_qty) FROM order_items WHERE order_id=o.id) qty FROM packing_tasks t JOIN orders o ON o.id=t.order_id LEFT JOIN users u ON u.id=t.assigned_to WHERE t.status IN ('PENDING','IN_PROGRESS') ${w}`, ...p);
  const load = db.all(`SELECT 'loading' kind, t.id, t.task_no, t.status, t.deadline, t.assigned_to, u.full_name assignee, s.ship_no ref, s.pallet_count qty FROM loading_tasks t JOIN shipments s ON s.id=t.shipment_id LEFT JOIN users u ON u.id=t.assigned_to WHERE t.status IN ('PENDING','IN_PROGRESS') ${w}`, ...p);
  const rcv = all || ['QC', 'MANAGER'].includes(user.role) ? db.all("SELECT 'qc' kind, r.id, r.rcv_no task_no, 'PENDING' status, r.deadline, NULL assigned_to, NULL assignee, p.sku ref, r.qty_received qty FROM receiving_orders r JOIN products p ON p.id=r.product_id WHERE r.status='RECEIVING'") : [];
  return [...pick, ...pack, ...load, ...rcv].map((t) => ({ ...t, overdue: t.deadline && new Date(t.deadline) < clock.now() })).sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));
}

// ---- Traceability -----------------------------------------------------------------------
function traceSerial(serial) {
  const s = db.get('SELECT * FROM serial_numbers WHERE serial=?', serial); if (!s) throw notFound(`Serial ${serial}`);
  const p = db.get('SELECT id, sku, name, model, power_w FROM products WHERE id=?', s.product_id);
  const batch = s.batch_id ? db.get('SELECT * FROM product_batches WHERE id=?', s.batch_id) : null;
  const rcv = s.receiving_id ? db.get('SELECT r.*, sp.company supplier FROM receiving_orders r LEFT JOIN suppliers sp ON sp.id=r.supplier_id WHERE r.id=?', s.receiving_id) : null;
  const qc = rcv ? db.all('SELECT q.*, u.full_name inspector FROM quality_checks q LEFT JOIN users u ON u.id=q.inspector_id WHERE receiving_id=?', rcv.id) : [];
  const pallet = s.pallet_id ? db.get('SELECT * FROM pallets WHERE id=?', s.pallet_id) : null;
  const order = s.order_id ? db.get('SELECT o.*, c.name customer, pj.code project_code, pj.name project_name FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN projects pj ON pj.id=o.project_id WHERE o.id=?', s.order_id) : null;
  const shipment = s.shipment_id ? db.get('SELECT sh.*, v.code vehicle_code, v.plate, v.type vehicle_type, d.full_name driver, d.phone driver_phone FROM shipments sh LEFT JOIN vehicles v ON v.id=sh.vehicle_id LEFT JOIN drivers d ON d.id=sh.driver_id WHERE sh.id=?', s.shipment_id) : null;
  const txns = db.all(`SELECT t.txn_no, t.type, t.created_at, t.reference, t.reason, t.from_status, t.to_status, lf.code from_loc, lt.code to_loc, u.full_name user FROM inventory_transactions t
    LEFT JOIN warehouse_locations lf ON lf.id=t.from_location_id LEFT JOIN warehouse_locations lt ON lt.id=t.to_location_id LEFT JOIN users u ON u.id=t.user_id
    WHERE t.product_id=? AND t.serials LIKE ? ORDER BY t.id`, s.product_id, `%"${serial}"%`);
  return { serial: s.serial, status: s.status, location: s.location_id ? inv.location(s.location_id).code : null, product: p, batch, receiving: rcv, qc, pallet, order, shipment, history: txns,
    chain: [
      rcv && { step: rcv.source === 'PRODUCTION' ? 'Ishlab chiqarish' : 'Kirim', ref: rcv.rcv_no, at: rcv.created_at, detail: rcv.source === 'PRODUCTION' ? `PO ${rcv.production_order}` : rcv.supplier },
      ...qc.map((q) => ({ step: 'QC', ref: q.qc_no, at: q.created_at, detail: `${q.result} — ${q.inspector || ''}` })),
      order && { step: 'Buyurtma', ref: order.order_no, at: order.created_at, detail: `${order.customer || ''}${order.project_code ? ` / ${order.project_code}` : ''}` },
      pallet && { step: 'Pallet', ref: pallet.pallet_no, at: pallet.created_at, detail: `${pallet.qty} dona, ${pallet.gross_weight_kg} kg` },
      shipment && { step: 'Jo‘natma', ref: shipment.ship_no, at: shipment.departure || shipment.created_at, detail: `${shipment.vehicle_type} ${shipment.plate} / ${shipment.driver} → ${shipment.destination}` },
      shipment?.actual_arrival && { step: 'Yetkazildi', ref: shipment.ship_no, at: shipment.actual_arrival, detail: shipment.destination },
    ].filter(Boolean) };
}
function tracePallet(no) {
  const pl = db.get('SELECT * FROM pallets WHERE pallet_no=?', no); if (!pl) throw notFound(`Pallet ${no}`);
  return { pallet: pl, product: db.get('SELECT sku, name FROM products WHERE id=?', pl.product_id), order: db.get('SELECT order_no, status FROM orders WHERE id=?', pl.order_id),
    location: pl.location_id ? inv.location(pl.location_id).code : null, shipment: pl.shipment_id ? db.get('SELECT ship_no, status, destination FROM shipments WHERE id=?', pl.shipment_id) : null,
    serials: db.all('SELECT serial, status FROM serial_numbers WHERE pallet_id=? ORDER BY serial', pl.id), history: db.all("SELECT * FROM status_history WHERE entity='pallet' AND entity_id=? ORDER BY id", pl.id) };
}
function traceShipment(no) {
  const s = db.get('SELECT * FROM shipments WHERE ship_no=?', no); if (!s) throw notFound(`Jo‘natma ${no}`);
  const o = db.get('SELECT o.order_no, o.status, c.name customer, pj.code project FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN projects pj ON pj.id=o.project_id WHERE o.id=?', s.order_id);
  return { shipment: s, order: o, vehicle: db.get('SELECT * FROM vehicles WHERE id=?', s.vehicle_id), driver: db.get('SELECT * FROM drivers WHERE id=?', s.driver_id),
    pallets: db.all('SELECT pl.pallet_no, pl.qty, pl.gross_weight_kg, pl.status, p.sku, (SELECT COUNT(*) FROM serial_numbers WHERE pallet_id=pl.id) serials FROM shipment_items si JOIN pallets pl ON pl.id=si.pallet_id JOIN products p ON p.id=pl.product_id WHERE si.shipment_id=? ORDER BY si.load_seq', s.id),
    serials: db.all('SELECT serial FROM serial_numbers WHERE shipment_id=? ORDER BY serial LIMIT 5000', s.id).map((x) => x.serial),
    documents: db.all("SELECT id, doc_no, doc_type, title, current_version, status FROM documents WHERE ref_type='shipment' AND ref_id=?", s.id),
    history: db.all("SELECT h.*, u.full_name user FROM status_history h LEFT JOIN users u ON u.id=h.user_id WHERE entity='shipment' AND entity_id=? ORDER BY h.id", s.id) };
}

/** QR / barcode resolution to any entity. */
function resolveCode(code) {
  const c = String(code || '').trim(); if (!c) throw bad('Kod bo‘sh');
  if (db.get('SELECT id FROM serial_numbers WHERE serial=?', c)) return { kind: 'serial', data: traceSerial(c) };
  if (db.get('SELECT id FROM pallets WHERE pallet_no=?', c)) return { kind: 'pallet', data: tracePallet(c) };
  if (db.get('SELECT id FROM shipments WHERE ship_no=?', c)) return { kind: 'shipment', data: traceShipment(c) };
  const o = db.get('SELECT * FROM orders WHERE order_no=?', c);
  if (o) return { kind: 'order', data: { order: o, items: db.all('SELECT oi.*, p.sku, p.name FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE order_id=?', o.id) } };
  const l = db.get('SELECT id FROM warehouse_locations WHERE code=?', c);
  if (l) return { kind: 'location', data: { location: inv.location(l.id), stock: inv.inventoryRows({ locationId: l.id }) } };
  const b = db.get('SELECT * FROM product_batches WHERE batch_no=?', c);
  if (b) return { kind: 'batch', data: { batch: b, product: inv.product(b.product_id), stock: db.all('SELECT i.status, i.qty, l.code FROM inventory i JOIN warehouse_locations l ON l.id=i.location_id WHERE batch_id=?', b.id), serials: db.val('SELECT COUNT(*) FROM serial_numbers WHERE batch_id=?', b.id) } };
  const p = db.get('SELECT * FROM products WHERE sku=? OR barcode=?', c, c);
  if (p) return { kind: 'product', data: { product: p, stock: inv.productStock(p.id), locations: inv.inventoryRows({ productId: p.id }) } };
  const pr = db.get('SELECT * FROM purchase_requests WHERE pr_no=?', c);
  if (pr) return { kind: 'purchase_request', data: pr };
  throw notFound(`Kod ${c}`);
}

function search(q) {
  const s = `%${String(q || '').trim()}%`; if (s.length < 4) return [];
  const out = [];
  const add = (kind, rows, label, sub) => rows.forEach((r) => out.push({ kind, id: r.id, label: label(r), sub: sub(r), code: r.code }));
  add('product', db.all('SELECT id, sku code, sku, name FROM products WHERE sku LIKE ? OR name LIKE ? OR barcode LIKE ? LIMIT 6', s, s, s), (r) => r.sku, (r) => r.name);
  add('order', db.all('SELECT o.id, o.order_no code, o.status, c.name FROM orders o LEFT JOIN customers c ON c.id=o.customer_id WHERE o.order_no LIKE ? OR c.name LIKE ? LIMIT 6', s, s), (r) => r.code, (r) => `${r.name || ''} · ${r.status}`);
  add('serial', db.all('SELECT id, serial code, status FROM serial_numbers WHERE serial LIKE ? LIMIT 6', s), (r) => r.code, (r) => r.status);
  add('pallet', db.all('SELECT id, pallet_no code, status, qty FROM pallets WHERE pallet_no LIKE ? LIMIT 5', s), (r) => r.code, (r) => `${r.qty} dona · ${r.status}`);
  add('shipment', db.all('SELECT id, ship_no code, status, destination FROM shipments WHERE ship_no LIKE ? OR destination LIKE ? LIMIT 5', s, s), (r) => r.code, (r) => `${r.status} → ${r.destination || ''}`);
  add('purchase_request', db.all('SELECT id, pr_no code, status FROM purchase_requests WHERE pr_no LIKE ? LIMIT 5', s), (r) => r.code, (r) => r.status);
  add('supplier', db.all('SELECT id, code, company FROM suppliers WHERE company LIKE ? OR code LIKE ? LIMIT 5', s, s), (r) => r.company, (r) => r.code);
  add('location', db.all('SELECT id, code FROM warehouse_locations WHERE code LIKE ? LIMIT 5', s), (r) => r.code, () => 'Lokatsiya');
  add('document', db.all('SELECT id, doc_no code, title FROM documents WHERE doc_no LIKE ? OR title LIKE ? LIMIT 5', s, s), (r) => r.code, (r) => r.title);
  add('xetq', db.all('SELECT id, sub_no code, title, status FROM xetq_submissions WHERE sub_no LIKE ? OR title LIKE ? LIMIT 5', s, s), (r) => r.code, (r) => `${r.title} · ${r.status}`);
  add('vehicle', db.all('SELECT id, code, plate, type FROM vehicles WHERE code LIKE ? OR plate LIKE ? LIMIT 5', s, s), (r) => r.code, (r) => `${r.type} ${r.plate || ''}`);
  return out;
}

// ---- Reports ----------------------------------------------------------------------------------
const REPORTS = {
  daily: 'Kunlik ombor hisoboti', weekly: 'Haftalik ombor hisoboti', monthly: 'Oylik ombor hisoboti', stock: 'Qoldiq hisoboti', shortage: 'Yetishmovchilik hisoboti',
  supplier: 'Supplier hisoboti', delivery: 'Yetkazib berish hisoboti', logistics: 'Logistika hisoboti', picking: 'Picking hisoboti', loading: 'Yuklash hisoboti',
  accuracy: 'Inventarizatsiya aniqligi', capacity: 'Ombor sig‘imi', purchase: 'Ta’minot zayavkalari', finished: 'Tayyor mahsulot', traceability: 'Traceability (serial)', xetq: 'XETQ hujjatlar holati',
};
function report(type, q = {}) {
  const T = REPORTS[type]; if (!T) throw notFound('Hisobot');
  const range = { daily: 1, weekly: 7, monthly: 30 }[type];
  const from = q.from ? new Date(q.from).toISOString() : range ? dayStart(-(range - 1)) : dayStart(-30);
  const to = q.to ? new Date(new Date(q.to).getTime() + 86400000).toISOString() : dayStart(1);
  let columns; let rows; let summary = {};
  switch (type) {
    case 'daily': case 'weekly': case 'monthly': {
      rows = db.all(`SELECT p.sku, p.name, p.unit, ${['RECEIVE', 'ISSUE', 'TRANSFER', 'RESERVE', 'RELEASE', 'ADJUSTMENT', 'RETURN', 'REJECT', 'SCRAP', 'REWORK', 'PACK', 'SHIP'].map((t) => `COALESCE(SUM(CASE WHEN t.type='${t}' THEN t.qty END),0) ${t.toLowerCase()}`).join(',')}, COUNT(*) txns
        FROM inventory_transactions t JOIN products p ON p.id=t.product_id WHERE t.created_at>=? AND t.created_at<? GROUP BY p.id ORDER BY p.category, p.sku`, from, to);
      columns = ['sku', 'name', 'receive', 'issue', 'ship', 'transfer', 'reserve', 'release', 'adjustment', 'return', 'reject', 'scrap', 'rework', 'pack', 'txns'];
      summary = { tranzaksiyalar: rows.reduce((a, r) => a + r.txns, 0), kirim: rows.reduce((a, r) => a + r.receive, 0), jo_natildi: rows.reduce((a, r) => a + r.ship, 0) };
      break;
    }
    case 'stock': case 'finished': rows = inv.stockSummary(type === 'finished' ? { category: 'FINISHED' } : {}); columns = ['sku', 'name', 'category', 'on_hand', 'available', 'reserved', 'free', 'receiving', 'rework', 'scrap', 'picked', 'packed', 'inbound', 'shortage', 'unit']; break;
    case 'shortage': rows = db.all(`SELECT s.shortage_no, p.sku, p.name, o.order_no, s.required_qty, s.shortage_qty, s.status, pr.pr_no, pr.status pr_status, s.created_at FROM shortages s JOIN products p ON p.id=s.product_id LEFT JOIN orders o ON o.id=s.order_id LEFT JOIN purchase_requests pr ON pr.id=s.purchase_request_id WHERE s.created_at>=? AND s.created_at<? ORDER BY s.id DESC`, from, to); columns = Object.keys(rows[0] || { shortage_no: 0, sku: 0, name: 0, order_no: 0, required_qty: 0, shortage_qty: 0, status: 0, pr_no: 0, pr_status: 0, created_at: 0 }); break;
    case 'supplier': rows = require('./procurement').performance(); columns = ['company', 'country', 'orders', 'delivered', 'on_time', 'late', 'open_late', 'on_time_rate', 'avg_delay_days', 'avg_lead_days', 'ordered_qty', 'received_qty', 'short_qty', 'rejected_qty', 'quality_rate']; break;
    case 'delivery': rows = db.all(`SELECT d.delivery_no, s.company, p.sku, d.qty, d.received_qty, d.rejected_qty, substr(d.expected_date,1,10) expected, substr(d.actual_date,1,10) actual, d.status FROM supplier_deliveries d JOIN suppliers s ON s.id=d.supplier_id LEFT JOIN products p ON p.id=d.product_id WHERE d.created_at>=? AND d.created_at<? ORDER BY d.id DESC`, from, to); columns = ['delivery_no', 'company', 'sku', 'qty', 'received_qty', 'rejected_qty', 'expected', 'actual', 'status']; break;
    case 'logistics': rows = db.all(`SELECT s.ship_no, o.order_no, s.status, v.code vehicle, d.full_name driver, s.pallet_count, s.total_qty, s.total_weight_kg, s.total_volume_m3, s.destination, s.departure, s.eta, s.actual_arrival FROM shipments s LEFT JOIN orders o ON o.id=s.order_id LEFT JOIN vehicles v ON v.id=s.vehicle_id LEFT JOIN drivers d ON d.id=s.driver_id WHERE s.created_at>=? AND s.created_at<? ORDER BY s.id DESC`, from, to); columns = ['ship_no', 'order_no', 'status', 'vehicle', 'driver', 'pallet_count', 'total_qty', 'total_weight_kg', 'total_volume_m3', 'destination', 'departure', 'eta', 'actual_arrival']; break;
    case 'picking': rows = db.all(`SELECT t.task_no, o.order_no, u.full_name worker, t.status, (SELECT SUM(picked_qty) FROM picking_task_lines WHERE task_id=t.id) qty, t.scans, t.errors, t.started_at, t.completed_at, ROUND((julianday(t.completed_at)-julianday(t.started_at))*1440,1) minutes FROM picking_tasks t JOIN orders o ON o.id=t.order_id LEFT JOIN users u ON u.id=t.assigned_to WHERE t.created_at>=? AND t.created_at<? ORDER BY t.id DESC`, from, to); columns = ['task_no', 'order_no', 'worker', 'status', 'qty', 'scans', 'errors', 'minutes', 'completed_at']; break;
    case 'loading': rows = db.all(`SELECT t.task_no, s.ship_no, u.full_name worker, t.status, s.pallet_count, t.estimated_minutes, t.actual_minutes, t.started_at, t.completed_at FROM loading_tasks t JOIN shipments s ON s.id=t.shipment_id LEFT JOIN users u ON u.id=t.assigned_to WHERE t.created_at>=? AND t.created_at<? ORDER BY t.id DESC`, from, to); columns = ['task_no', 'ship_no', 'worker', 'status', 'pallet_count', 'estimated_minutes', 'actual_minutes', 'completed_at']; break;
    case 'accuracy': rows = db.all(`SELECT c.count_no, c.warehouse_id, c.zone_id, c.status, COUNT(l.id) lines, SUM(CASE WHEN l.physical_qty=l.system_qty THEN 1 ELSE 0 END) matched, ROUND(100.0*SUM(CASE WHEN l.physical_qty=l.system_qty THEN 1 ELSE 0 END)/COUNT(l.id),1) accuracy, SUM(l.physical_qty-l.system_qty) diff, c.reason, c.posted_at FROM inventory_counts c JOIN inventory_count_lines l ON l.count_id=c.id GROUP BY c.id ORDER BY c.id DESC`); columns = ['count_no', 'warehouse_id', 'zone_id', 'status', 'lines', 'matched', 'accuracy', 'diff', 'reason', 'posted_at']; break;
    case 'capacity': rows = ai.capacity(); columns = ['id', 'name', 'positions', 'usedPallets', 'freePallets', 'pct', 'weightKg', 'maxLoadKg', 'weightPct', 'volumeM3', 'usableVolumeM3', 'volumePct']; break;
    case 'purchase': rows = db.all(`SELECT pr.pr_no, s.company, p.sku, pr.qty, pr.received_qty, pr.priority, pr.status, substr(pr.required_date,1,10) required_date, pr.ai_generated, u.full_name created_by, a.full_name approved_by, pr.created_at FROM purchase_requests pr LEFT JOIN suppliers s ON s.id=pr.supplier_id JOIN products p ON p.id=pr.product_id LEFT JOIN users u ON u.id=pr.created_by LEFT JOIN users a ON a.id=pr.approved_by WHERE pr.created_at>=? AND pr.created_at<? ORDER BY pr.id DESC`, from, to); columns = ['pr_no', 'company', 'sku', 'qty', 'received_qty', 'priority', 'status', 'required_date', 'ai_generated', 'created_by', 'approved_by']; break;
    case 'traceability': rows = db.all(`SELECT s.serial, p.sku, b.batch_no, s.status, l.code location, o.order_no, pl.pallet_no, sh.ship_no FROM serial_numbers s JOIN products p ON p.id=s.product_id LEFT JOIN product_batches b ON b.id=s.batch_id LEFT JOIN warehouse_locations l ON l.id=s.location_id LEFT JOIN orders o ON o.id=s.order_id LEFT JOIN pallets pl ON pl.id=s.pallet_id LEFT JOIN shipments sh ON sh.id=s.shipment_id ${q.q ? 'WHERE s.serial LIKE ? OR b.batch_no LIKE ?' : ''} ORDER BY s.id DESC LIMIT 1000`, ...(q.q ? [`%${q.q}%`, `%${q.q}%`] : [])); columns = ['serial', 'sku', 'batch_no', 'status', 'location', 'order_no', 'pallet_no', 'ship_no']; break;
    case 'xetq': rows = db.all(`SELECT x.sub_no, x.title, pj.code project, x.status, x.version, t.ts_no || ' v' || t.version ts, u.full_name responsible, x.submitted_at, x.approved_at, x.updated_at FROM xetq_submissions x LEFT JOIN projects pj ON pj.id=x.project_id LEFT JOIN technical_specifications t ON t.id=x.ts_id LEFT JOIN users u ON u.id=x.responsible_id ORDER BY x.id DESC`); columns = ['sub_no', 'title', 'project', 'status', 'version', 'ts', 'responsible', 'submitted_at', 'approved_at']; break;
    default: throw notFound('Hisobot');
  }
  return { type, title: T, from, to, columns, rows, summary, generatedAt: clock.iso() };
}
function toCsv(r) {
  const e = (v) => { const s = v == null ? '' : String(v); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + [r.columns.join(';'), ...r.rows.map((row) => r.columns.map((c) => e(row[c])).join(';'))].join('\n');
}

module.exports = { warehouseDashboard, directorDashboard, workerKpi, myTasks, traceSerial, tracePallet, traceShipment, resolveCode, search, REPORTS, report, toCsv };
