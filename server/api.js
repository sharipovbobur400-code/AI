'use strict';
// REST API route table. Every mutating route: auth → RBAC → validation → service (DB transaction) → audit → event.
const db = require('./db');
const auth = require('./auth');
const inv = require('./inventory');
const orders = require('./orders');
const proc = require('./procurement');
const logi = require('./logistics');
const docs = require('./documents');
const xetq = require('./xetq');
const ai = require('./ai');
const rep = require('./reports');
const { clock, bad, notFound, V } = require('./core');

const routes = [];
function r(method, path, perm, handler) {
  const keys = []; const re = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, perm, handler });
}
function match(method, pathname) {
  for (const rt of routes) {
    if (rt.method !== method) continue;
    const m = rt.re.exec(pathname); if (!m) continue;
    const params = {}; rt.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return { route: rt, params };
  }
  return null;
}
const id = (p) => V.id(p.id, 'ID');
const lim = (q, d = 200) => Math.min(1000, Math.max(1, Number(q.limit) || d));
const like = (q) => `%${q}%`;

// ---------------- Meta / auth ----------------
r('GET', '/api/health', null, () => ({ ok: true, time: clock.iso() }));
r('GET', '/api/meta', 'view', ({ user }) => ({
  user, now: clock.iso(), modules: require('./modules').modules(), company: db.setting('company_name', 'Solar Factory'), llm: ai.llmInfo().configured,
  warehouses: db.all('SELECT * FROM warehouses ORDER BY id'), zones: db.all('SELECT * FROM warehouse_zones ORDER BY warehouse_id, sort'),
  products: db.all("SELECT id, sku, name, category, unit, track_serial, units_per_pallet FROM products WHERE status='ACTIVE' ORDER BY category, sku"),
  suppliers: db.all('SELECT id, code, company FROM suppliers WHERE active=1 ORDER BY company'), customers: db.all('SELECT id, name FROM customers ORDER BY name'),
  projects: db.all('SELECT id, code, name, requires_xetq FROM projects ORDER BY code'), users: db.all("SELECT id, full_name, role_code FROM users WHERE active=1 AND password_hash LIKE 'scrypt$%' ORDER BY full_name"),
  drivers: db.all('SELECT id, full_name, status FROM drivers ORDER BY full_name'), vehicles: db.all('SELECT id, code, type, status FROM vehicles ORDER BY code'),
  roles: Object.fromEntries(Object.entries(auth.ROLES).filter(([k]) => (k !== 'SUPERADMIN' || user.role === 'SUPERADMIN') && (k !== 'LOGISTICS' || require('./modules').logisticsOn()))), docTypes: require('./modules').without(docs.DOC_TYPES, require('./modules').LOGI_DOCS), txnTypes: inv.TXN_TYPES, vehicleStatuses: logi.VEHICLE_STATUSES, xetqFlow: xetq.XETQ_FLOW, reports: require('./modules').without(rep.REPORTS, require('./modules').LOGI_REPORTS),
}));

// ---------------- Warehouses / zones / locations ----------------
r('GET', '/api/warehouses', 'view', () => { const cap = Object.fromEntries(ai.capacity().map((c) => [c.id, c])); return db.all('SELECT * FROM warehouses ORDER BY id').map((w) => ({ ...w, capacity: cap[w.id], zones: db.all('SELECT z.*, (SELECT COUNT(*) FROM warehouse_locations l WHERE l.zone_id=z.id) locations FROM warehouse_zones z WHERE warehouse_id=? ORDER BY sort', w.id) })); });
r('POST', '/api/warehouses', 'warehouse.manage', ({ body, user }) => db.tx(() => {
  const wid = V.str(body.id, 'Ombor kodi', { max: 10 }); if (db.get('SELECT id FROM warehouses WHERE id=?', wid)) throw bad('Bunday ombor mavjud');
  const L = V.num(body.length_m, 'Uzunlik', { positive: true }); const W = V.num(body.width_m, 'Kenglik', { positive: true }); const H = V.num(body.height_m, 'Balandlik', { positive: true });
  db.insert('warehouses', { id: wid, name: V.str(body.name, 'Nomi', { max: 200 }), type: body.type || 'GENERAL', address: body.address || null, length_m: L, width_m: W, height_m: H,
    usable_volume_m3: V.num(body.usable_volume_m3, 'Foydali hajm', { required: false, min: 0 }) ?? Math.round(L * W * H * 0.6), pallet_positions: V.num(body.pallet_positions, 'Pallet pozitsiyalari', { int: true, min: 1 }), max_load_kg: V.num(body.max_load_kg, 'Maks. yuk', { required: false, min: 0 }) });
  db.audit(user, 'WAREHOUSE_CREATE', 'warehouses', wid); return { id: wid };
}));
r('PUT', '/api/warehouses/:id', 'warehouse.manage', ({ params, body, user }) => db.tx(() => {
  const w = db.get('SELECT * FROM warehouses WHERE id=?', params.id); if (!w) throw notFound('Ombor');
  const patch = {}; for (const k of ['name', 'type', 'address']) if (body[k] !== undefined) patch[k] = V.str(body[k], k, { required: false, max: 200 });
  for (const k of ['length_m', 'width_m', 'height_m', 'usable_volume_m3', 'pallet_positions', 'max_load_kg']) if (body[k] !== undefined) patch[k] = V.num(body[k], k, { min: 0 });
  db.update('warehouses', w.id, patch); db.audit(user, 'WAREHOUSE_UPDATE', 'warehouses', w.id, patch); return { ok: true };
}));
r('GET', '/api/zones', 'view', ({ query }) => db.all(`SELECT * FROM warehouse_zones ${query.warehouseId ? 'WHERE warehouse_id=?' : ''} ORDER BY warehouse_id, sort`, ...(query.warehouseId ? [query.warehouseId] : [])));
r('POST', '/api/zones', 'warehouse.manage', ({ body, user }) => db.tx(() => {
  const wh = V.str(body.warehouseId, 'Ombor'); const code = V.str(body.code, 'Kod', { max: 10 }).toUpperCase();
  const zid = `${wh}-${code}`; if (db.get('SELECT id FROM warehouse_zones WHERE id=?', zid)) throw bad('Zona mavjud');
  db.insert('warehouse_zones', { id: zid, warehouse_id: wh, code, name: V.str(body.name, 'Nomi', { max: 100 }), zone_type: V.oneOf(body.zoneType, 'Zona turi', ['RECEIVING', 'QC', 'RAW', 'WIP', 'FINISHED', 'PACKING', 'DISPATCH', 'RETURN', 'SCRAP', 'REWORK']), sort: db.val('SELECT COUNT(*) FROM warehouse_zones WHERE warehouse_id=?', wh) + 1 });
  db.audit(user, 'ZONE_CREATE', 'warehouse_zones', zid); return { id: zid };
}));
r('GET', '/api/locations', 'view', ({ query }) => db.all(`SELECT l.*, z.name zone_name, z.zone_type,
    (SELECT COALESCE(SUM(i.qty),0) FROM inventory i WHERE i.location_id=l.id) qty,
    (SELECT COALESCE(SUM(CAST((i.qty + p.units_per_pallet - 1) / p.units_per_pallet AS INTEGER)),0) FROM inventory i JOIN products p ON p.id=i.product_id WHERE i.location_id=l.id) pallets,
    (SELECT GROUP_CONCAT(DISTINCT p.sku) FROM inventory i JOIN products p ON p.id=i.product_id WHERE i.location_id=l.id) skus
  FROM warehouse_locations l JOIN warehouse_zones z ON z.id=l.zone_id WHERE 1=1 ${query.warehouseId ? 'AND l.warehouse_id=?' : ''} ${query.zoneId ? 'AND l.zone_id=?' : ''} ${query.q ? 'AND l.code LIKE ?' : ''} ORDER BY l.code LIMIT 3000`,
...[query.warehouseId, query.zoneId, query.q && like(query.q)].filter(Boolean)));
r('POST', '/api/locations', 'warehouse.manage', ({ body, user }) => db.tx(() => {
  const z = db.get('SELECT * FROM warehouse_zones WHERE id=?', V.str(body.zoneId, 'Zona')); if (!z) throw notFound('Zona');
  const racks = V.num(body.racks, 'Rack soni', { int: true, min: 1, max: 99 }); const shelves = V.num(body.shelves, 'Qavat soni', { int: true, min: 1, max: 20 }); const positions = V.num(body.positions, 'Pozitsiya soni', { int: true, min: 1, max: 50 });
  const start = V.num(body.rackStart || 1, 'Boshlang‘ich rack', { int: true, min: 1 }); let n = 0;
  for (let rk = start; rk < start + racks; rk++) for (let s = 1; s <= shelves; s++) for (let p = 1; p <= positions; p++) {
    const code = `${z.warehouse_id.replace('-', '')}-${z.code}-R${String(rk).padStart(2, '0')}-S${String(s).padStart(2, '0')}-P${String(p).padStart(2, '0')}`;
    if (db.get('SELECT id FROM warehouse_locations WHERE code=?', code)) continue;
    db.insert('warehouse_locations', { code, warehouse_id: z.warehouse_id, zone_id: z.id, rack: `R${String(rk).padStart(2, '0')}`, shelf: `S${String(s).padStart(2, '0')}`, position: `P${String(p).padStart(2, '0')}`, max_pallets: V.num(body.maxPallets || 1, 'Maks. pallet', { int: true, min: 1 }), max_weight_kg: V.num(body.maxWeightKg || 1500, 'Maks. og‘irlik', { min: 1 }), x: rk * 3, y: z.sort * 12 + p });
    n++;
  }
  db.audit(user, 'LOCATIONS_CREATE', 'warehouse_zones', z.id, { created: n }); return { created: n };
}));

// ---------------- Products ----------------
const PRODUCT_FIELDS = { sku: 's', name: 's', model: 's', category: 's', manufacturer: 's', power_w: 'n', length_mm: 'n', width_mm: 'n', height_mm: 'n', net_weight_kg: 'n', gross_weight_kg: 'n', unit: 's', units_per_pallet: 'n', pallet_weight_kg: 'n', pallet_length_mm: 'n', pallet_width_mm: 'n', pallet_height_mm: 'n', packaging_type: 's', packaging_weight_kg: 'n', barcode: 's', track_serial: 'b', min_stock: 'n', fragile: 'b', max_stack: 'n', orientation: 's', packing_standard: 's', electrical_spec: 's', default_supplier_id: 'n', lead_time_days: 'n', default_location_id: 'n', status: 's' };
function productPatch(body, create) {
  const o = {};
  for (const [k, t] of Object.entries(PRODUCT_FIELDS)) {
    if (body[k] === undefined) continue;
    o[k] = t === 'n' ? V.num(body[k], k, { required: false, min: 0 }) : t === 'b' ? (body[k] ? 1 : 0) : V.str(body[k], k, { required: false, max: 2000 });
  }
  if (create) { V.str(o.sku, 'SKU', { max: 60 }); V.str(o.name, 'Nomi', { max: 200 }); V.oneOf(o.category, 'Kategoriya', ['FINISHED', 'RAW', 'WIP', 'MATERIAL', 'PACKAGING']); }
  else if (o.category) V.oneOf(o.category, 'Kategoriya', ['FINISHED', 'RAW', 'WIP', 'MATERIAL', 'PACKAGING']);
  if (o.orientation) V.oneOf(o.orientation, 'Joylashuv', ['VERTICAL', 'HORIZONTAL']);
  if (o.length_mm && o.width_mm && o.height_mm) o.volume_m3 = +(o.length_mm * o.width_mm * o.height_mm / 1e9).toFixed(4);
  if (o.units_per_pallet != null && o.units_per_pallet < 1) throw bad('Palletdagi soni kamida 1');
  return o;
}
r('GET', '/api/products', 'view', ({ query }) => {
  const st = Object.fromEntries(inv.stockSummary().map((s) => [s.product_id, s]));
  return db.all(`SELECT p.*, s.company supplier FROM products p LEFT JOIN suppliers s ON s.id=p.default_supplier_id WHERE 1=1 ${query.category ? 'AND p.category=?' : ''} ${query.q ? 'AND (p.sku LIKE ? OR p.name LIKE ? OR p.model LIKE ? OR p.barcode LIKE ?)' : ''} ORDER BY p.category, p.sku`,
    ...(query.category ? [query.category] : []), ...(query.q ? [like(query.q), like(query.q), like(query.q), like(query.q)] : [])).map((p) => ({ ...p, stock: st[p.id] || null }));
});
r('GET', '/api/products/:id', 'view', ({ params }) => {
  const p = inv.product(id(params));
  return { product: p, stock: inv.productStock(p.id), locations: inv.inventoryRows({ productId: p.id }), batches: db.all('SELECT * FROM product_batches WHERE product_id=? ORDER BY id DESC LIMIT 50', p.id),
    suppliers: db.all('SELECT sp.*, s.company FROM supplier_products sp JOIN suppliers s ON s.id=sp.supplier_id WHERE sp.product_id=?', p.id),
    transactions: db.all(`SELECT t.*, lf.code from_loc, lt.code to_loc, u.full_name user FROM inventory_transactions t LEFT JOIN warehouse_locations lf ON lf.id=t.from_location_id LEFT JOIN warehouse_locations lt ON lt.id=t.to_location_id LEFT JOIN users u ON u.id=t.user_id WHERE t.product_id=? ORDER BY t.id DESC LIMIT 50`, p.id),
    serials: p.track_serial ? db.all("SELECT status, COUNT(*) n FROM serial_numbers WHERE product_id=? GROUP BY status", p.id) : [] };
});
r('POST', '/api/products', 'products.manage', ({ body, user }) => db.tx(() => {
  const o = productPatch(body, true);
  if (db.get('SELECT id FROM products WHERE sku=?', o.sku)) throw bad('Bunday SKU mavjud');
  if (o.barcode && db.get('SELECT id FROM products WHERE barcode=?', o.barcode)) throw bad('Bunday barcode mavjud');
  const pid = db.insert('products', { ...o, barcode: o.barcode || null, created_at: clock.iso(), updated_at: clock.iso() });
  db.audit(user, 'PRODUCT_CREATE', 'products', o.sku); db.emit('PRODUCT_CHANGED', { productId: pid }); return { id: pid };
}));
r('PUT', '/api/products/:id', 'products.manage', ({ params, body, user }) => db.tx(() => {
  const p = inv.product(id(params)); const o = productPatch(body, false);
  if ('track_serial' in o && o.track_serial !== p.track_serial && db.val('SELECT COALESCE(SUM(qty),0) FROM inventory WHERE product_id=?', p.id) > 0) throw bad('Qoldiq mavjud bo‘lganda serial kuzatuvini o‘zgartirib bo‘lmaydi');
  if (o.sku && o.sku !== p.sku && db.get('SELECT id FROM products WHERE sku=?', o.sku)) throw bad('Bunday SKU mavjud');
  if (!o.volume_m3 && (o.length_mm || o.width_mm || o.height_mm)) { const L = o.length_mm ?? p.length_mm; const W = o.width_mm ?? p.width_mm; const H = o.height_mm ?? p.height_mm; if (L && W && H) o.volume_m3 = +(L * W * H / 1e9).toFixed(4); }
  db.update('products', p.id, { ...o, updated_at: clock.iso() }); db.audit(user, 'PRODUCT_UPDATE', 'products', p.sku, o); db.emit('PRODUCT_CHANGED', { productId: p.id }); return { ok: true };
}));

// ---------------- Inventory ----------------
r('GET', '/api/inventory', 'view', ({ query }) => inv.stockSummary({ category: query.category, q: query.q }));
r('GET', '/api/inventory/rows', 'view', ({ query }) => inv.inventoryRows({ productId: query.productId, warehouseId: query.warehouseId, zoneId: query.zoneId, status: query.status, q: query.q, locationId: query.locationId }));
r('GET', '/api/inventory/putaway', 'view', ({ query }) => inv.putawayPlan(inv.product(V.id(query.productId, 'Mahsulot')), V.qty(query.qty)));
r('GET', '/api/inventory/transactions', 'view', ({ query }) => {
  const w = []; const p = [];
  if (query.productId) { w.push('t.product_id=?'); p.push(query.productId); }
  if (query.type) { w.push('t.type=?'); p.push(query.type); }
  if (query.q) { w.push('(t.txn_no LIKE ? OR t.reference LIKE ? OR pr.sku LIKE ? OR t.serials LIKE ?)'); p.push(like(query.q), like(query.q), like(query.q), like(query.q)); }
  if (query.from) { w.push('t.created_at>=?'); p.push(new Date(query.from).toISOString()); }
  return db.all(`SELECT t.id, t.txn_no, t.type, t.qty, t.created_at, t.reference, t.reason, t.from_status, t.to_status, pr.sku, pr.name, pr.unit, lf.code from_loc, lt.code to_loc, u.full_name user, b.batch_no,
      CASE WHEN t.serials IS NULL THEN 0 ELSE json_array_length(t.serials) END serial_count
    FROM inventory_transactions t JOIN products pr ON pr.id=t.product_id LEFT JOIN warehouse_locations lf ON lf.id=t.from_location_id LEFT JOIN warehouse_locations lt ON lt.id=t.to_location_id
    LEFT JOIN users u ON u.id=t.user_id LEFT JOIN product_batches b ON b.id=t.batch_id ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY t.id DESC LIMIT ? OFFSET ?`, ...p, lim(query), Number(query.offset) || 0);
});
r('POST', '/api/inventory/issue', 'stock.issue', ({ body, user }) => inv.issue(body, user));
r('POST', '/api/inventory/transfer', 'stock.transfer', ({ body, user }) => inv.transfer(body, user));
r('POST', '/api/inventory/disposition', 'stock.disposition', ({ body, user }) => inv.disposition(body, user));
r('GET', '/api/inventory/reservations', 'view', ({ query }) => db.all(`SELECT r.*, p.sku, p.name, p.unit, o.order_no, pj.code project_code, u.full_name created_by_name, (r.qty - r.picked_qty) remaining FROM inventory_reservations r JOIN products p ON p.id=r.product_id
  LEFT JOIN orders o ON o.id=r.order_id LEFT JOIN projects pj ON pj.id=r.project_id LEFT JOIN users u ON u.id=r.created_by WHERE 1=1 ${query.status ? 'AND r.status=?' : ''} ORDER BY r.id DESC LIMIT 500`, ...(query.status ? [query.status] : [])));
r('POST', '/api/inventory/reservations', 'stock.reserve', ({ body, user }) => {
  if (body.orderId) { const it = db.get('SELECT * FROM order_items WHERE order_id=? AND product_id=?', V.id(body.orderId, 'Buyurtma'), V.id(body.productId, 'Mahsulot')); if (!it) throw bad('Buyurtmada bu mahsulot yo‘q'); const c = orders.itemCoverage(it.id); if (V.qty(body.qty) > c.need) throw bad(`Buyurtma uchun faqat ${c.need} rezerv qilish mumkin`); return db.tx(() => { const res = inv.reserve({ ...body, orderItemId: it.id }, user); orders.refreshItem(it.id, user); return res; }); }
  return inv.reserve({ productId: body.productId, qty: body.qty, projectId: V.optId(body.projectId, 'Loyiha'), note: body.note }, user);
});
r('POST', '/api/inventory/reservations/:id/release', 'stock.reserve', ({ params, body, user }) => inv.release(id(params), body, user));
r('GET', '/api/inventory/counts', 'view', () => db.all(`SELECT c.*, u.full_name created_by_name, (SELECT COUNT(*) FROM inventory_count_lines WHERE count_id=c.id) lines,
  (SELECT COUNT(*) FROM inventory_count_lines WHERE count_id=c.id AND physical_qty IS NOT NULL AND physical_qty<>system_qty) diffs FROM inventory_counts c LEFT JOIN users u ON u.id=c.created_by ORDER BY c.id DESC`));
r('GET', '/api/inventory/counts/:id', 'view', ({ params }) => ({ count: db.get('SELECT * FROM inventory_counts WHERE id=?', id(params)),
  lines: db.all('SELECT l.*, p.sku, p.name, p.unit, loc.code location, b.batch_no FROM inventory_count_lines l JOIN products p ON p.id=l.product_id JOIN warehouse_locations loc ON loc.id=l.location_id LEFT JOIN product_batches b ON b.id=l.batch_id WHERE l.count_id=? ORDER BY loc.code', id(params)) }));
r('POST', '/api/inventory/counts', 'stock.count', ({ body, user }) => inv.createCount(body, user));
r('POST', '/api/inventory/counts/:id/lines', 'stock.count', ({ params, body, user }) => inv.recordCount(id(params), body.lines, user));
r('POST', '/api/inventory/counts/:id/post', 'stock.count.post', ({ params, body, user }) => inv.postCount(id(params), body, user));

// ---------------- Receiving / QC ----------------
r('GET', '/api/receiving', 'view', ({ query }) => db.all(`SELECT r.*, p.sku, p.name, p.unit, s.company supplier, b.batch_no, l.code location, u.full_name created_by_name, po.po_no
  FROM receiving_orders r JOIN products p ON p.id=r.product_id LEFT JOIN suppliers s ON s.id=r.supplier_id LEFT JOIN product_batches b ON b.id=r.batch_id LEFT JOIN warehouse_locations l ON l.id=r.location_id
  LEFT JOIN users u ON u.id=r.created_by LEFT JOIN purchase_orders po ON po.id=r.po_id WHERE 1=1 ${query.status ? 'AND r.status=?' : ''} ${query.source ? 'AND r.source=?' : ''} ORDER BY r.id DESC LIMIT ?`, ...[query.status, query.source].filter(Boolean), lim(query)));
r('GET', '/api/receiving/:id', 'view', ({ params }) => { const rc = db.get('SELECT r.*, p.sku, p.name, p.unit, p.track_serial, s.company supplier, b.batch_no FROM receiving_orders r JOIN products p ON p.id=r.product_id LEFT JOIN suppliers s ON s.id=r.supplier_id LEFT JOIN product_batches b ON b.id=r.batch_id WHERE r.id=?', id(params)); if (!rc) throw notFound('Kirim'); return { receiving: rc, qc: db.all('SELECT * FROM quality_checks WHERE receiving_id=?', rc.id), serials: db.all('SELECT serial, status FROM serial_numbers WHERE receiving_id=? ORDER BY id LIMIT 500', rc.id), putaway: rc.status === 'RECEIVING' ? inv.putawayPlan(inv.product(rc.product_id), rc.qty_received) : [], history: db.all("SELECT * FROM status_history WHERE entity='receiving' AND entity_id=?", rc.id), documents: db.all("SELECT id, doc_no, doc_type, current_version FROM documents WHERE ref_type='receiving' AND ref_id=?", rc.id) }; });
r('POST', '/api/receiving', 'stock.receive', ({ body, user }) => inv.receive(body, user));
r('POST', '/api/receiving/production', 'stock.receive', ({ body, user }) => inv.productionReceipt(body, user));
r('POST', '/api/receiving/:id/qc', 'stock.qc', ({ params, body, user }) => inv.qualityCheck(id(params), body, user));

// ---------------- Orders / shortages ----------------
r('GET', '/api/orders', 'view', ({ query }) => db.all(`SELECT o.*, c.name customer, pj.code project_code, (SELECT SUM(qty) FROM order_items WHERE order_id=o.id) qty,
  (SELECT SUM(picked_qty) FROM order_items WHERE order_id=o.id) picked, (SELECT SUM(packed_qty) FROM order_items WHERE order_id=o.id) packed, (SELECT SUM(shipped_qty) FROM order_items WHERE order_id=o.id) shipped,
  (SELECT COALESCE(SUM(qty-picked_qty),0) FROM inventory_reservations WHERE order_id=o.id AND status='ACTIVE') reserved, (SELECT COALESCE(SUM(shortage_qty),0) FROM shortages WHERE order_id=o.id AND status IN ('OPEN','REQUESTED')) shortage
  FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN projects pj ON pj.id=o.project_id WHERE 1=1 ${query.status ? 'AND o.status=?' : ''} ${query.open ? "AND o.status NOT IN ('SHIPPED','DELIVERED','CANCELLED')" : ''} ${query.q ? 'AND (o.order_no LIKE ? OR c.name LIKE ?)' : ''} ORDER BY o.id DESC LIMIT ?`,
...(query.status ? [query.status] : []), ...(query.q ? [like(query.q), like(query.q)] : []), lim(query)));
r('GET', '/api/orders/:id', 'view', ({ params }) => {
  const o = db.get('SELECT o.*, c.name customer, pj.code project_code, pj.name project_name, pj.requires_xetq FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN projects pj ON pj.id=o.project_id WHERE o.id=?', id(params)); if (!o) throw notFound('Buyurtma');
  return { order: o, items: db.all('SELECT oi.*, p.sku, p.name, p.unit FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE order_id=?', o.id).map((i) => ({ ...i, ...orders.itemCoverage(i.id), item: undefined })),
    reservations: db.all('SELECT r.*, p.sku FROM inventory_reservations r JOIN products p ON p.id=r.product_id WHERE order_id=? ORDER BY id', o.id), shortages: db.all('SELECT s.*, pr.pr_no, pr.status pr_status FROM shortages s LEFT JOIN purchase_requests pr ON pr.id=s.purchase_request_id WHERE s.order_id=?', o.id),
    picking: db.all('SELECT t.*, u.full_name assignee FROM picking_tasks t LEFT JOIN users u ON u.id=t.assigned_to WHERE order_id=? ORDER BY id DESC', o.id), packing: db.all('SELECT * FROM packing_tasks WHERE order_id=?', o.id),
    pallets: db.all('SELECT pl.*, p.sku, l.code location FROM pallets pl LEFT JOIN products p ON p.id=pl.product_id LEFT JOIN warehouse_locations l ON l.id=pl.location_id WHERE order_id=? ORDER BY id', o.id),
    shipments: db.all('SELECT s.*, v.code vehicle FROM shipments s LEFT JOIN vehicles v ON v.id=s.vehicle_id WHERE order_id=?', o.id), history: db.all("SELECT h.*, u.full_name user FROM status_history h LEFT JOIN users u ON u.id=h.user_id WHERE entity='order' AND entity_id=? ORDER BY h.id", o.id) };
});
r('POST', '/api/orders/preview', 'view', ({ body }) => orders.analyze(body.items, V.optId(body.projectId, 'Loyiha')));
r('POST', '/api/orders', 'orders.manage', ({ body, user }) => orders.createOrder(body, user));
r('POST', '/api/orders/:id/reserve', 'stock.reserve', ({ params, user }) => db.tx(() => { for (const i of db.all('SELECT product_id FROM order_items WHERE order_id=?', id(params))) orders.allocateProduct(i.product_id, user); return { status: orders.recomputeOrderStatus(id(params)) }; }));
r('POST', '/api/orders/:id/cancel', 'orders.manage', ({ params, body, user }) => orders.cancelOrder(id(params), { reason: V.str(body.reason, 'Sabab', { max: 300 }) }, user));
r('GET', '/api/shortages', 'view', ({ query }) => db.all(`SELECT s.*, p.sku, p.name, p.unit, p.category, o.order_no, o.due_date, o.priority, c.name customer, pr.pr_no, pr.status pr_status FROM shortages s JOIN products p ON p.id=s.product_id
  LEFT JOIN orders o ON o.id=s.order_id LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN purchase_requests pr ON pr.id=s.purchase_request_id WHERE 1=1 ${query.status ? 'AND s.status=?' : "AND s.status IN ('OPEN','REQUESTED')"} ORDER BY o.due_date, s.id DESC LIMIT 500`, ...(query.status ? [query.status] : [])));
r('POST', '/api/shortages/scan', 'view', ({ user }) => ({ open: orders.detectAllShortages(user) }));
r('GET', '/api/shortages/:id/draft', 'view', ({ params }) => proc.draftFromShortage(id(params)));

// ---------------- Picking / packing / pallets ----------------
r('GET', '/api/picking', 'view', ({ query }) => db.all(`SELECT t.*, o.order_no, u.full_name assignee, (SELECT SUM(qty) FROM picking_task_lines WHERE task_id=t.id) qty, (SELECT SUM(picked_qty) FROM picking_task_lines WHERE task_id=t.id) picked
  FROM picking_tasks t JOIN orders o ON o.id=t.order_id LEFT JOIN users u ON u.id=t.assigned_to WHERE 1=1 ${query.status ? 'AND t.status=?' : ''} ORDER BY t.id DESC LIMIT 300`, ...(query.status ? [query.status] : [])));
r('GET', '/api/picking/:id', 'view', ({ params }) => { const t = db.get('SELECT t.*, o.order_no, u.full_name assignee FROM picking_tasks t JOIN orders o ON o.id=t.order_id LEFT JOIN users u ON u.id=t.assigned_to WHERE t.id=?', id(params)); if (!t) throw notFound('Picking'); return { task: { ...t, route: JSON.parse(t.route || '{}') }, lines: db.all('SELECT l.*, p.sku, p.name, p.unit, p.barcode, p.track_serial, loc.code location, b.batch_no FROM picking_task_lines l JOIN products p ON p.id=l.product_id JOIN warehouse_locations loc ON loc.id=l.location_id LEFT JOIN product_batches b ON b.id=l.batch_id WHERE task_id=? ORDER BY seq', t.id) }; });
r('POST', '/api/picking', 'picking', ({ body, user }) => orders.createPickTask(V.id(body.orderId, 'Buyurtma'), body, user));
r('POST', '/api/picking/:id/start', 'picking', ({ params, user }) => orders.startPick(id(params), user));
r('POST', '/api/picking/:id/scan', 'picking', ({ params, body, user }) => orders.scanPick(id(params), body, user));
r('POST', '/api/picking/lines/:id/pick', 'picking', ({ params, body, user }) => orders.pickLine(id(params), body, user));
r('POST', '/api/picking/:id/complete', 'picking', ({ params, body, user }) => orders.completePick(id(params), body, user));
r('GET', '/api/packing', 'view', () => db.all(`SELECT t.*, o.order_no, u.full_name assignee, (SELECT SUM(picked_qty-packed_qty) FROM order_items WHERE order_id=o.id) to_pack FROM packing_tasks t JOIN orders o ON o.id=t.order_id LEFT JOIN users u ON u.id=t.assigned_to ORDER BY t.id DESC LIMIT 300`));
r('POST', '/api/packing/:id/start', 'packing', ({ params, user }) => db.tx(() => { const t = db.get('SELECT * FROM packing_tasks WHERE id=?', id(params)); if (!t) throw notFound('Packing'); if (t.status === 'PENDING') { db.update('packing_tasks', t.id, { status: 'IN_PROGRESS', started_at: clock.iso(), assigned_to: t.assigned_to || user.id }); db.history('packing', t.id, 'PENDING', 'IN_PROGRESS', user); db.emit('PACKING_STARTED', { taskId: t.id }); } return { ok: true }; }));
r('GET', '/api/pallets', 'view', ({ query }) => db.all(`SELECT pl.*, p.sku, p.name, o.order_no, l.code location, z.zone_type, s.ship_no FROM pallets pl LEFT JOIN products p ON p.id=pl.product_id LEFT JOIN orders o ON o.id=pl.order_id
  LEFT JOIN warehouse_locations l ON l.id=pl.location_id LEFT JOIN warehouse_zones z ON z.id=l.zone_id LEFT JOIN shipments s ON s.id=pl.shipment_id WHERE 1=1 ${query.status ? 'AND pl.status=?' : ''} ${query.orderId ? 'AND pl.order_id=?' : ''} ORDER BY pl.id DESC LIMIT 500`, ...[query.status, query.orderId].filter(Boolean)));
r('GET', '/api/pallets/:id', 'view', ({ params }) => rep.tracePallet(db.val('SELECT pallet_no FROM pallets WHERE id=?', id(params))));
r('POST', '/api/pallets', 'packing', ({ body, user }) => orders.createPallets(body, user));
r('POST', '/api/pallets/:id/dispatch-zone', 'packing', ({ params, body, user }) => orders.movePalletToDispatch(id(params), body, user));
r('POST', '/api/pallets/:id/unpack', 'packing', ({ params, user }) => orders.unpackPallet(id(params), user));

// ---------------- Procurement ----------------
r('GET', '/api/purchase-requests', 'view', ({ query }) => db.all(`SELECT pr.*, p.sku, p.name, p.unit, s.company supplier, o.order_no, u.full_name created_by_name, a.full_name approved_by_name,
  (SELECT expected_date FROM supplier_deliveries d WHERE d.purchase_request_id=pr.id ORDER BY id DESC LIMIT 1) expected_date, (SELECT po_no FROM purchase_orders WHERE purchase_request_id=pr.id) po_no
  FROM purchase_requests pr JOIN products p ON p.id=pr.product_id LEFT JOIN suppliers s ON s.id=pr.supplier_id LEFT JOIN orders o ON o.id=pr.order_id LEFT JOIN users u ON u.id=pr.created_by LEFT JOIN users a ON a.id=pr.approved_by
  WHERE 1=1 ${query.status ? 'AND pr.status=?' : ''} ${query.open ? "AND pr.status NOT IN ('RECEIVED','REJECTED','CANCELLED')" : ''} ORDER BY pr.id DESC LIMIT 500`, ...(query.status ? [query.status] : [])));
r('GET', '/api/purchase-requests/:id', 'view', ({ params }) => { const x = db.get('SELECT pr.*, p.sku, p.name, p.unit, s.company supplier FROM purchase_requests pr JOIN products p ON p.id=pr.product_id LEFT JOIN suppliers s ON s.id=pr.supplier_id WHERE pr.id=?', id(params)); if (!x) throw notFound('Zayavka'); return { request: x, po: db.get('SELECT * FROM purchase_orders WHERE purchase_request_id=?', x.id), deliveries: db.all('SELECT * FROM supplier_deliveries WHERE purchase_request_id=?', x.id), history: db.all("SELECT h.*, u.full_name user FROM status_history h LEFT JOIN users u ON u.id=h.user_id WHERE entity='purchase_request' AND entity_id=? ORDER BY h.id", x.id), flow: proc.FLOW }; });
r('POST', '/api/purchase-requests', 'procurement.request', ({ body, user }) => proc.create(body, user));
r('POST', '/api/purchase-requests/:id/approve', 'procurement.approve', ({ params, body, user }) => proc.approve(id(params), body, user));
r('POST', '/api/purchase-requests/:id/reject', 'procurement.approve', ({ params, body, user }) => proc.reject(id(params), body, user));
r('POST', '/api/purchase-requests/:id/order', 'procurement.manage', ({ params, body, user }) => proc.placeOrder(id(params), body, user));
r('POST', '/api/purchase-requests/:id/confirm', 'procurement.manage', ({ params, body, user }) => proc.supplierConfirm(id(params), body, user));
r('POST', '/api/purchase-requests/:id/transit', 'procurement.manage', ({ params, body, user }) => proc.inTransit(id(params), body, user));
r('POST', '/api/purchase-requests/:id/arrive', 'stock.receive', ({ params, body, user }) => proc.arrive(id(params), body, user));
r('POST', '/api/purchase-requests/:id/qc', 'stock.qc', ({ params, user }) => proc.startQc(id(params), user));
r('POST', '/api/purchase-requests/:id/cancel', 'procurement.manage', ({ params, body, user }) => proc.cancel(id(params), body, user));
r('POST', '/api/purchase-requests/:id/document', 'documents.manage', ({ params, body, user }) => docs.generate(body.type === 'MATERIAL_REQUEST' ? 'MATERIAL_REQUEST' : 'PURCHASE_REQUEST', 'purchase_request', id(params), user));
const SUPPLIER_FIELDS = ['company', 'contact', 'phone', 'email', 'address', 'country', 'payment_terms', 'contract_no', 'contract_until', 'notes'];
r('GET', '/api/suppliers', 'view', () => { const perf = Object.fromEntries(proc.performance().map((p) => [p.supplier_id, p])); return db.all('SELECT s.*, (SELECT COUNT(*) FROM supplier_products WHERE supplier_id=s.id) products FROM suppliers s ORDER BY company').map((s) => ({ ...s, performance: perf[s.id] })); });
r('GET', '/api/suppliers/:id', 'view', ({ params }) => { const s = db.get('SELECT * FROM suppliers WHERE id=?', id(params)); if (!s) throw notFound('Supplier'); return { supplier: s, performance: proc.performance().find((p) => p.supplier_id === s.id), products: db.all('SELECT sp.*, p.sku, p.name, p.unit FROM supplier_products sp JOIN products p ON p.id=sp.product_id WHERE supplier_id=?', s.id), deliveries: db.all('SELECT d.*, p.sku FROM supplier_deliveries d LEFT JOIN products p ON p.id=d.product_id WHERE supplier_id=? ORDER BY id DESC LIMIT 100', s.id), requests: db.all('SELECT pr.pr_no, pr.status, pr.qty, p.sku, pr.created_at FROM purchase_requests pr JOIN products p ON p.id=pr.product_id WHERE supplier_id=? ORDER BY pr.id DESC LIMIT 50', s.id), documents: db.all("SELECT id, doc_no, title, doc_type FROM documents WHERE ref_type='supplier' AND ref_id=?", s.id) }; });
r('POST', '/api/suppliers', 'suppliers.manage', ({ body, user }) => db.tx(() => { const o = {}; for (const k of SUPPLIER_FIELDS) o[k] = V.str(body[k], k, { required: k === 'company', max: 500 }); if (o.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email)) throw bad('Email noto‘g‘ri'); const code = `SUP-${String((db.val('SELECT COUNT(*) FROM suppliers') || 0) + 1).padStart(3, '0')}`; const sid = db.insert('suppliers', { ...o, code, created_at: clock.iso() }); db.audit(user, 'SUPPLIER_CREATE', 'suppliers', code); return { id: sid, code }; }));
r('PUT', '/api/suppliers/:id', 'suppliers.manage', ({ params, body, user }) => db.tx(() => { const o = {}; for (const k of SUPPLIER_FIELDS) if (body[k] !== undefined) o[k] = V.str(body[k], k, { required: k === 'company', max: 500 }); if (body.active !== undefined) o.active = body.active ? 1 : 0; db.update('suppliers', id(params), o); db.audit(user, 'SUPPLIER_UPDATE', 'suppliers', params.id, o); return { ok: true }; }));
r('POST', '/api/suppliers/:id/products', 'suppliers.manage', ({ params, body, user }) => db.tx(() => { const pid = V.id(body.productId, 'Mahsulot'); inv.product(pid); db.run('INSERT INTO supplier_products(supplier_id,product_id,price,currency,lead_time_days,moq) VALUES(?,?,?,?,?,?) ON CONFLICT(supplier_id,product_id) DO UPDATE SET price=excluded.price, currency=excluded.currency, lead_time_days=excluded.lead_time_days, moq=excluded.moq', id(params), pid, V.num(body.price, 'Narx', { min: 0 }), body.currency || 'USD', V.num(body.leadTimeDays, 'Yetkazish muddati', { int: true, min: 0 }), V.num(body.moq || 1, 'MOQ', { min: 0 })); db.audit(user, 'SUPPLIER_PRODUCT', 'suppliers', params.id, { pid }); return { ok: true }; }));
r('GET', '/api/supplier-deliveries', 'view', ({ query }) => db.all(`SELECT d.*, s.company, p.sku, p.name, p.unit, pr.pr_no, po.po_no, CAST(julianday(?) - julianday(d.expected_date) AS INTEGER) days_late FROM supplier_deliveries d JOIN suppliers s ON s.id=d.supplier_id LEFT JOIN products p ON p.id=d.product_id
  LEFT JOIN purchase_requests pr ON pr.id=d.purchase_request_id LEFT JOIN purchase_orders po ON po.id=d.po_id WHERE 1=1 ${query.open ? "AND d.status IN ('CONFIRMED','IN_TRANSIT')" : ''} ORDER BY d.expected_date DESC LIMIT 500`, clock.iso()));
r('POST', '/api/supplier-deliveries/:id/reschedule', 'procurement.manage', ({ params, body, user }) => proc.reschedule(id(params), body, user));

// ---------------- Transport / shipments / loading ----------------
const VEH_FIELDS = { code: 's', type: 's', model: 's', plate: 's', length_m: 'n', width_m: 'n', height_m: 'n', volume_m3: 'n', payload_kg: 'n', pallet_capacity: 'n', owner: 's', driver_id: 'n', notes: 's' };
function vehPatch(b, create) { const o = {}; for (const [k, t] of Object.entries(VEH_FIELDS)) if (b[k] !== undefined && b[k] !== '') o[k] = t === 'n' ? V.num(b[k], k, { min: 0 }) : V.str(b[k], k, { max: 200 }); if (create) { for (const k of ['code', 'type', 'length_m', 'width_m', 'height_m', 'payload_kg']) if (o[k] == null) throw bad(`"${k}" majburiy`); if (!o.volume_m3) o.volume_m3 = +(o.length_m * o.width_m * o.height_m).toFixed(1); } return o; }
r('GET', '/api/vehicles', 'view', () => db.all(`SELECT v.*, d.full_name driver, (SELECT ship_no FROM shipments s WHERE s.vehicle_id=v.id AND s.status IN ('PLANNED','LOADING','LOADED','DISPATCHED') LIMIT 1) current_shipment FROM vehicles v LEFT JOIN drivers d ON d.id=v.driver_id ORDER BY v.payload_kg`));
r('POST', '/api/vehicles', 'transport.manage', ({ body, user }) => db.tx(() => { const o = vehPatch(body, true); if (db.get('SELECT id FROM vehicles WHERE code=?', o.code)) throw bad('Bunday kod mavjud'); const vid = db.insert('vehicles', { ...o, status: 'AVAILABLE', created_at: clock.iso() }); db.audit(user, 'VEHICLE_CREATE', 'vehicles', o.code); return { id: vid }; }));
r('PUT', '/api/vehicles/:id', 'transport.manage', ({ params, body, user }) => db.tx(() => { const o = vehPatch(body, false); db.update('vehicles', id(params), o); db.audit(user, 'VEHICLE_UPDATE', 'vehicles', params.id, o); return { ok: true }; }));
r('POST', '/api/vehicles/:id/status', 'transport.manage', ({ params, body, user }) => logi.setVehicleStatus(id(params), body, user));
r('GET', '/api/drivers', 'view', () => db.all(`SELECT d.*, (SELECT code FROM vehicles WHERE driver_id=d.id LIMIT 1) vehicle FROM drivers d ORDER BY full_name`));
r('POST', '/api/drivers', 'transport.manage', ({ body, user }) => db.tx(() => { const did = db.insert('drivers', { full_name: V.str(body.full_name, 'F.I.Sh.', { max: 150 }), phone: V.str(body.phone, 'Telefon', { required: false, max: 30 }), license_no: V.str(body.license_no, 'Guvohnoma', { required: false, max: 40 }), license_category: V.str(body.license_category, 'Toifa', { required: false, max: 20 }), status: 'AVAILABLE', created_at: clock.iso() }); db.audit(user, 'DRIVER_CREATE', 'drivers', did); return { id: did }; }));
r('PUT', '/api/drivers/:id', 'transport.manage', ({ params, body, user }) => db.tx(() => { const o = {}; for (const k of ['full_name', 'phone', 'license_no', 'license_category']) if (body[k] !== undefined) o[k] = V.str(body[k], k, { max: 150 }); if (body.status) o.status = V.oneOf(body.status, 'Holat', ['AVAILABLE', 'ASSIGNED', 'ON_TRIP', 'OFF']); db.update('drivers', id(params), o); db.audit(user, 'DRIVER_UPDATE', 'drivers', params.id, o); return { ok: true }; }));
r('POST', '/api/transport/calculate', 'view', ({ body }) => logi.calculate(body));
r('GET', '/api/shipments', 'view', ({ query }) => db.all(`SELECT s.*, o.order_no, c.name customer, v.code vehicle, v.type vehicle_type, v.plate, d.full_name driver, (SELECT status FROM loading_tasks WHERE shipment_id=s.id ORDER BY id DESC LIMIT 1) loading_status
  FROM shipments s LEFT JOIN orders o ON o.id=s.order_id LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN vehicles v ON v.id=s.vehicle_id LEFT JOIN drivers d ON d.id=s.driver_id WHERE 1=1 ${query.status ? 'AND s.status=?' : ''} ${query.active ? "AND s.status IN ('PLANNED','LOADING','LOADED','DISPATCHED')" : ''} ORDER BY s.id DESC LIMIT 500`, ...(query.status ? [query.status] : [])));
r('GET', '/api/shipments/:id', 'view', ({ params }) => { const no = db.val('SELECT ship_no FROM shipments WHERE id=?', id(params)); if (!no) throw notFound('Jo‘natma'); const t = rep.traceShipment(no); const lt = db.get('SELECT t.*, u.full_name assignee FROM loading_tasks t LEFT JOIN users u ON u.id=t.assigned_to WHERE shipment_id=? ORDER BY id DESC', id(params)); return { ...t, loading: lt && { ...lt, sequence: JSON.parse(lt.sequence || '[]'), warnings: JSON.parse(lt.warnings || '[]'), delay: JSON.parse(lt.delay_reason || '{}') }, assignment: db.get('SELECT * FROM transport_assignments WHERE shipment_id=? ORDER BY id DESC', id(params)) }; });
r('POST', '/api/shipments', 'shipments.manage', ({ body, user }) => logi.createShipment(body, user));
r('POST', '/api/shipments/:id/dispatch', 'shipments.manage', ({ params, body, user }) => logi.dispatch(id(params), body, user));
r('POST', '/api/shipments/:id/arrive', 'shipments.manage', ({ params, body, user }) => logi.arrive(id(params), body, user));
r('POST', '/api/shipments/:id/cancel', 'shipments.manage', ({ params, body, user }) => logi.cancelShipment(id(params), body, user));
r('POST', '/api/shipments/:id/documents', 'documents.manage', ({ params, user }) => docs.generateShipmentDocs(id(params), user));
r('GET', '/api/loading', 'view', () => db.all(`SELECT t.*, s.ship_no, s.status shipment_status, s.pallet_count, v.code vehicle, u.full_name assignee FROM loading_tasks t JOIN shipments s ON s.id=t.shipment_id LEFT JOIN vehicles v ON v.id=t.vehicle_id LEFT JOIN users u ON u.id=t.assigned_to ORDER BY t.id DESC LIMIT 300`));
r('POST', '/api/loading/:id/start', 'loading', ({ params, user }) => logi.startLoading(id(params), user));
r('POST', '/api/loading/:id/scan', 'loading', ({ params, body, user }) => logi.loadPallet(id(params), body, user));
r('POST', '/api/loading/:id/complete', 'loading', ({ params, body, user }) => logi.completeLoading(id(params), body, user));
r('POST', '/api/loading/:id/validate', 'view', ({ params, body }) => { const t = db.get('SELECT * FROM loading_tasks WHERE id=?', id(params)); if (!t) throw notFound('Yuklash'); const pallets = db.all('SELECT pl.* FROM shipment_items si JOIN pallets pl ON pl.id=si.pallet_id WHERE si.shipment_id=?', t.shipment_id); return { warnings: logi.validateSequence(V.arr(body.sequence, 'Ketma-ketlik'), pallets, db.get('SELECT * FROM vehicles WHERE id=?', t.vehicle_id)) }; });

// ---------------- Projects / TS / documents / XETQ ----------------
r('GET', '/api/projects', 'view', () => db.all(`SELECT p.*, c.name customer, (SELECT COUNT(*) FROM orders WHERE project_id=p.id) orders, (SELECT COUNT(*) FROM technical_specifications WHERE project_id=p.id) ts, (SELECT COUNT(*) FROM documents WHERE project_id=p.id) documents, (SELECT status FROM xetq_submissions WHERE project_id=p.id ORDER BY id DESC LIMIT 1) xetq_status FROM projects p LEFT JOIN customers c ON c.id=p.customer_id ORDER BY p.code`));
r('GET', '/api/projects/:id', 'view', ({ params }) => { const p = db.get('SELECT p.*, c.name customer FROM projects p LEFT JOIN customers c ON c.id=p.customer_id WHERE p.id=?', id(params)); if (!p) throw notFound('Loyiha'); return { project: p, ts: db.all('SELECT * FROM technical_specifications WHERE project_id=? ORDER BY ts_no, id', p.id), documents: db.all('SELECT * FROM documents WHERE project_id=? ORDER BY doc_type', p.id), xetq: db.all('SELECT * FROM xetq_submissions WHERE project_id=? ORDER BY id DESC', p.id), orders: db.all('SELECT id, order_no, status, due_date FROM orders WHERE project_id=?', p.id), reservations: db.all("SELECT r.*, pr.sku FROM inventory_reservations r JOIN products pr ON pr.id=r.product_id WHERE r.project_id=? AND r.status='ACTIVE'", p.id) }; });
r('POST', '/api/projects', 'projects.manage', ({ body, user }) => xetq.createProject(body, user));
r('GET', '/api/technical-specifications', 'view', ({ query }) => db.all(`SELECT t.*, pj.code project_code, p.sku, u.full_name created_by_name, a.full_name approved_by_name, (SELECT MAX(id) FROM technical_specifications x WHERE x.ts_no=t.ts_no)=t.id is_latest FROM technical_specifications t LEFT JOIN projects pj ON pj.id=t.project_id LEFT JOIN products p ON p.id=t.product_id LEFT JOIN users u ON u.id=t.created_by LEFT JOIN users a ON a.id=t.approved_by ${query.tsNo ? 'WHERE t.ts_no=?' : ''} ORDER BY t.ts_no, t.id DESC`, ...(query.tsNo ? [query.tsNo] : [])));
r('GET', '/api/technical-specifications/:id', 'view', ({ params }) => { const t = db.get('SELECT * FROM technical_specifications WHERE id=?', id(params)); if (!t) throw notFound('Texnik shart'); return { ts: t, versions: db.all('SELECT id, version, status, revision_note, created_at, approved_at FROM technical_specifications WHERE ts_no=? ORDER BY id', t.ts_no), history: db.all("SELECT h.*, u.full_name user FROM status_history h LEFT JOIN users u ON u.id=h.user_id WHERE entity='ts' AND entity_id IN (SELECT id FROM technical_specifications WHERE ts_no=?) ORDER BY h.id", t.ts_no) }; });
r('POST', '/api/technical-specifications', 'xetq.manage', ({ body, user }) => xetq.createTS(body, user));
r('POST', '/api/technical-specifications/:id/revise', 'xetq.manage', ({ params, body, user }) => xetq.reviseTS(id(params), body, user));
r('POST', '/api/technical-specifications/:id/status', 'documents.approve', ({ params, body, user }) => xetq.setTSStatus(id(params), body, user));
r('GET', '/api/documents', 'view', ({ query }) => db.all(`SELECT d.*, pj.code project_code, u.full_name author, a.full_name approver, (SELECT sha256 FROM document_versions v WHERE v.document_id=d.id AND v.status='CURRENT') sha256,
  (SELECT file_name FROM document_versions v WHERE v.document_id=d.id AND v.status='CURRENT') file_name FROM documents d LEFT JOIN projects pj ON pj.id=d.project_id LEFT JOIN users u ON u.id=d.author_id LEFT JOIN users a ON a.id=d.approver_id
  WHERE 1=1 ${query.type ? 'AND d.doc_type=?' : ''} ${query.projectId ? 'AND d.project_id=?' : ''} ${query.refType ? 'AND d.ref_type=?' : ''} ${query.q ? 'AND (d.doc_no LIKE ? OR d.title LIKE ?)' : ''} ORDER BY d.updated_at DESC LIMIT 500`,
...[query.type, query.projectId, query.refType].filter(Boolean), ...(query.q ? [like(query.q), like(query.q)] : [])).filter((d) => require('./modules').logisticsOn() || (!require('./modules').LOGI_DOCS.includes(d.doc_type) && !/logist/i.test(d.title || ''))));
r('GET', '/api/documents/:id', 'view', ({ params }) => { const d = db.get('SELECT d.*, u.full_name author, a.full_name approver FROM documents d LEFT JOIN users u ON u.id=d.author_id LEFT JOIN users a ON a.id=d.approver_id WHERE d.id=?', id(params)); if (!d) throw notFound('Hujjat'); return { document: d, versions: db.all('SELECT v.id, v.version, v.file_name, v.mime, v.size, v.sha256, v.status, v.change_note, v.created_at, u.full_name author FROM document_versions v LEFT JOIN users u ON u.id=v.author_id WHERE document_id=? ORDER BY v.id DESC', d.id), history: db.all("SELECT h.*, u.full_name user FROM status_history h LEFT JOIN users u ON u.id=h.user_id WHERE entity='document' AND entity_id=? ORDER BY h.id", d.id) }; });
r('POST', '/api/documents', 'documents.manage', ({ body, user }) => docs.createDocument(body, user));
r('POST', '/api/documents/generate', 'documents.manage', ({ body, user }) => docs.generate(V.str(body.type, 'Turi'), V.str(body.refType, 'Manba'), V.id(body.refId, 'Manba ID'), user));
r('POST', '/api/documents/:id/versions', 'documents.manage', ({ params, body, user }) => docs.newVersion(id(params), body, user));
r('POST', '/api/documents/:id/status', 'documents.manage', ({ params, body, user }) => { if (body.status === 'APPROVED') auth.require(user, 'documents.approve'); return docs.setDocStatus(id(params), body, user); });
r('GET', '/api/documents/versions/:id/verify', 'view', ({ params }) => docs.verify(id(params)));
r('GET', '/api/doc-templates', 'view', () => { const m = require('./modules'); return db.all('SELECT code, name, updated_at FROM doc_templates ORDER BY code').filter((t) => m.logisticsOn() || !m.LOGI_DOCS.includes(t.code)); });
r('GET', '/api/doc-templates/:code', 'view', ({ params }) => db.get('SELECT * FROM doc_templates WHERE code=?', params.code) || (() => { throw notFound('Shablon'); })());
r('PUT', '/api/doc-templates/:code', 'admin.templates', ({ params, body, user }) => docs.saveTemplate(params.code, body, user));
r('GET', '/api/xetq', 'view', () => db.all(`SELECT x.*, pj.code project_code, pj.name project_name, t.ts_no, t.version ts_version, t.status ts_status, u.full_name responsible FROM xetq_submissions x LEFT JOIN projects pj ON pj.id=x.project_id LEFT JOIN technical_specifications t ON t.id=x.ts_id LEFT JOIN users u ON u.id=x.responsible_id ORDER BY x.updated_at DESC`));
r('GET', '/api/xetq/:id', 'view', ({ params }) => { const s = db.get('SELECT x.*, pj.code project_code, pj.name project_name, u.full_name responsible FROM xetq_submissions x LEFT JOIN projects pj ON pj.id=x.project_id LEFT JOIN users u ON u.id=x.responsible_id WHERE x.id=?', id(params)); if (!s) throw notFound('XETQ'); const ids = JSON.parse(s.document_ids || '[]'); return { submission: s, ts: s.ts_id ? db.get('SELECT * FROM technical_specifications WHERE id=?', s.ts_id) : null, documents: ids.length ? db.all(`SELECT d.*, (SELECT sha256 FROM document_versions v WHERE v.document_id=d.id AND v.status='CURRENT') sha256 FROM documents d WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids) : [], reviews: db.all('SELECT r.*, u.full_name by_name, f.full_name fix_owner FROM xetq_reviews r LEFT JOIN users u ON u.id=r.created_by LEFT JOIN users f ON f.id=r.fix_owner_id WHERE submission_id=? ORDER BY r.id', s.id), checklist: xetq.checklist(s), next: xetq.XETQ_FLOW[s.status] }; });
r('POST', '/api/xetq', 'xetq.manage', ({ body, user }) => xetq.createSubmission(body, user));
r('PUT', '/api/xetq/:id', 'xetq.manage', ({ params, body, user }) => xetq.updateSubmission(id(params), body, user));
r('POST', '/api/xetq/:id/transition', 'xetq.manage', ({ params, body, user }) => { if (['UNDER_REVIEW', 'REVISION_REQUIRED', 'APPROVED'].includes(body.status)) auth.require(user, 'xetq.review'); return xetq.transition(id(params), body, user); });

// ---------------- Tasks / KPI / dashboards ----------------
r('GET', '/api/tasks', 'view', ({ user, query }) => rep.myTasks(user, query.all === '1' && auth.can(user, 'tasks.assign')));
r('GET', '/api/tasks/suggest', 'view', () => ({ worker: orders.suggestWorker() }));
r('POST', '/api/tasks/assign', 'tasks.assign', ({ body, user }) => db.tx(() => { const t = { picking: 'picking_tasks', packing: 'packing_tasks', loading: 'loading_tasks' }[body.kind]; if (!t) throw bad('Topshiriq turi noto‘g‘ri'); const uid = V.id(body.userId, 'Xodim'); db.run(`UPDATE ${t} SET assigned_to=? WHERE id=?`, uid, V.id(body.id, 'ID')); db.audit(user, 'TASK_ASSIGN', t, body.id, { uid }); db.emit('TASK_ASSIGNED', { kind: body.kind, id: body.id, assignedTo: uid }); return { ok: true }; }));
r('GET', '/api/dashboard/warehouse', 'view', () => rep.warehouseDashboard());
r('GET', '/api/dashboard/director', 'view', () => rep.directorDashboard());
r('GET', '/api/kpi/workers', 'view', ({ query }) => rep.workerKpi(Number(query.days) || 30));

// ---------------- AI ----------------
r('GET', '/api/ai/alerts', 'view', ({ query }) => db.all(`SELECT * FROM ai_events WHERE ${query.status === 'all' ? '1=1' : query.status ? 'status=?' : "status='OPEN'"} ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, id DESC LIMIT 300`, ...(query.status && query.status !== 'all' ? [query.status] : [])));
r('POST', '/api/ai/alerts/:id/ack', 'view', ({ params, user }) => db.tx(() => { db.run("UPDATE ai_events SET status='ACK', updated_at=? WHERE id=? AND status='OPEN'", clock.iso(), id(params)); db.audit(user, 'AI_ALERT_ACK', 'ai_events', params.id); db.emit('AI_ALERT_ACK', { id: id(params) }); return { ok: true }; }));
r('POST', '/api/ai/scan', 'view', () => ai.scan());
r('GET', '/api/ai/forecast', 'view', ({ query }) => ({ days: Number(query.days) || 7, items: ai.forecast(Number(query.days) || 7), note: 'Bu faqat tavsiya. Xarid faqat tasdiqlangan zayavka workflow orqali amalga oshiriladi.' }));
r('GET', '/api/ai/insights', 'view', () => ({ capacity: ai.capacity(), cycleCount: ai.cycleCountSuggestions(), space: ai.spaceSuggestions(), suppliers: proc.performance() }));
r('POST', '/api/ai/ask', 'ai.use', ({ body, user }) => ai.ask(V.str(body.question, 'Savol', { max: 1000 }), user));

// ---------------- Reports / trace / search ----------------
r('GET', '/api/reports', 'view', () => rep.REPORTS);
r('GET', '/api/reports/:type', 'view', ({ params, query, res }) => { const t = params.type.replace(/\.csv$/, ''); const out = rep.report(t, query); if (params.type.endsWith('.csv')) return { __raw: rep.toCsv(out), type: 'text/csv; charset=utf-8', filename: `${t}-${clock.today()}.csv` }; return out; });
r('GET', '/api/trace/serial/:s', 'view', ({ params }) => rep.traceSerial(params.s));
r('GET', '/api/trace/pallet/:s', 'view', ({ params }) => rep.tracePallet(params.s));
r('GET', '/api/trace/shipment/:s', 'view', ({ params }) => rep.traceShipment(params.s));
r('GET', '/api/qr/:code', 'view', ({ params }) => rep.resolveCode(params.code));
r('GET', '/api/search', 'view', ({ query }) => rep.search(query.q));

// ---------------- Admin / audit / notifications ----------------
r('GET', '/api/users', 'view', () => db.all("SELECT u.id, u.username, u.full_name, u.role_code, u.section, u.active, u.last_login, u.created_at, r.name role_name FROM users u JOIN roles r ON r.code=u.role_code WHERE u.password_hash LIKE 'scrypt$%' ORDER BY CASE u.role_code WHEN 'SUPERADMIN' THEN 0 WHEN 'ADMIN' THEN 1 ELSE 2 END, u.full_name").filter((u) => require('./modules').logisticsOn() || !require('./modules').isLogiUser(u)));
const ADMIN_ROLES = ['ADMIN', 'SUPERADMIN'];
const normLogin = (v) => { const un = V.str(v, 'Login', { min: 3, max: 40 }).replace(/\s+/g, ' ').toLowerCase(); if (!/^[\p{L}\p{N}._\- ]+$/u.test(un)) throw bad('Login: harf, raqam, bo‘sh joy, . _ - belgilaridan iborat bo‘lsin'); return un; };
r('POST', '/api/users', 'admin.users', ({ body, user }) => db.tx(() => {
  const role = V.oneOf(body.role_code, 'Rol', Object.keys(auth.ROLES));
  if (role === 'SUPERADMIN') throw bad('Super admin faqat bitta bo‘ladi');
  if (ADMIN_ROLES.includes(role)) auth.require(user, 'admin.admins');
  const un = normLogin(body.username); if (db.get('SELECT id FROM users WHERE username=?', un)) throw bad('Login band');
  auth.validatePasswordPolicy(body.password);
  const uid = db.insert('users', { username: un, password_hash: auth.hashPassword(body.password), full_name: V.str(body.full_name, 'F.I.Sh.', { max: 150 }), role_code: role, active: 1, created_at: clock.iso() });
  db.audit(user, role === 'ADMIN' ? 'ADMIN_CREATE' : 'USER_CREATE', 'users', un, { role }); return { id: uid };
}));
// ---- bo‘lim hisoblari: login (bo‘lim kodi + raqam) va parol tizim tomonidan yaratiladi, faqat bir marta ko‘rsatiladi ----
const sections = require('./sections');
r('GET', '/api/sections', 'view', () => ({ sections: sections.publicList(), levels: sections.LEVELS }));
r('POST', '/api/users/section-account', 'admin.users', ({ body, user }) => db.tx(() => {
  const section = V.oneOf(body.section, 'Bo‘lim', Object.keys(sections.SECTIONS).filter((k) => !sections.SECTIONS[k].hidden));
  const level = V.oneOf(body.level || 'STAFF', 'Daraja', Object.keys(sections.LEVELS));
  const fullName = V.str(body.full_name, 'F.I.Sh.', { max: 150 });
  const cred = sections.generateCredentials(section, (l) => !!db.get('SELECT id FROM users WHERE username=?', l));
  const role = sections.SECTIONS[section].roles[level];
  const uid = db.insert('users', { username: cred.login, password_hash: auth.hashPassword(cred.password), full_name: fullName, role_code: role, section, active: 1, created_at: clock.iso() });
  db.audit(user, 'SECTION_ACCOUNT_CREATE', 'users', cred.login, { section, level, role });
  return { id: uid, login: cred.login, password: cred.password, section, sectionLabel: sections.SECTIONS[section].label, level: sections.LEVELS[level], fullName };
}));
r('POST', '/api/users/:id/reset-password', 'admin.users', ({ params, user }) => db.tx(() => {
  const t = db.get('SELECT * FROM users WHERE id=?', id(params)); if (!t) throw notFound('Foydalanuvchi');
  if (!t.section) throw bad('Faqat bo‘lim hisoblari uchun (boshqalarga “Tahrirlash” orqali parol bering)');
  const pw = sections.generateCredentials(t.section, () => false).password;
  db.update('users', t.id, { password_hash: auth.hashPassword(pw), failed_logins: 0, locked_until: null });
  db.run('DELETE FROM sessions WHERE user_id=?', t.id);
  db.audit(user, 'SECTION_PASSWORD_RESET', 'users', t.username);
  return { login: t.username, password: pw };
}));
r('PUT', '/api/users/:id', 'admin.users', ({ params, body, user }) => db.tx(() => {
  const target = db.get('SELECT * FROM users WHERE id=?', id(params)); if (!target) throw notFound('Foydalanuvchi');
  if (target.role_code === 'SUPERADMIN' && target.id !== user.id) throw bad('Super admin hisobini faqat uning o‘zi o‘zgartira oladi');
  if (ADMIN_ROLES.includes(target.role_code) && target.id !== user.id) auth.require(user, 'admin.admins');
  const o = {};
  if (body.full_name) o.full_name = V.str(body.full_name, 'F.I.Sh.', { max: 150 });
  if (body.role_code && body.role_code !== target.role_code) { const role = V.oneOf(body.role_code, 'Rol', Object.keys(auth.ROLES)); if (role === 'SUPERADMIN' || target.role_code === 'SUPERADMIN') throw bad('Super admin rolini o‘zgartirib bo‘lmaydi'); if (ADMIN_ROLES.includes(role)) auth.require(user, 'admin.admins'); o.role_code = role; }
  if (body.active !== undefined) o.active = body.active ? 1 : 0;
  if (body.section !== undefined) {
    const sec = body.section ? V.oneOf(body.section, 'Bo‘lim', Object.keys(sections.SECTIONS)) : null;
    if (sec && ['ADMIN', 'SUPERADMIN', 'DIRECTOR'].includes(o.role_code || target.role_code)) throw bad('Admin/direktor bo‘limga cheklanmaydi');
    if (sec !== (target.section || null)) o.section = sec;
  }
  if (o.role_code && ['ADMIN', 'SUPERADMIN', 'DIRECTOR'].includes(o.role_code)) o.section = null;
  if (body.username && normLogin(body.username) !== target.username) { const un = normLogin(body.username); if (db.get('SELECT id FROM users WHERE username=?', un)) throw bad('Login band'); o.username = un; }
  if (body.password) { auth.validatePasswordPolicy(body.password); o.password_hash = auth.hashPassword(body.password); }
  if (target.id === user.id && (o.active === 0 || o.role_code)) throw bad('O‘z rolingizni/holatingizni o‘zgartira olmaysiz');
  db.update('users', target.id, o);
  if (o.active === 0 || o.password_hash || o.role_code || o.username || o.section !== undefined) db.run('DELETE FROM sessions WHERE user_id=? AND user_id<>?', target.id, user.id);
  db.audit(user, 'USER_UPDATE', 'users', params.id, { ...o, password_hash: o.password_hash ? '***' : undefined }); return { ok: true };
}));
r('GET', '/api/roles', 'view', () => {
  const m = require('./modules'); const on = m.logisticsOn();
  const roleOk = (rl) => on || rl !== 'LOGISTICS'; const permOk = (p) => on || !m.LOGI_PERMS.includes(p);
  return { roles: db.all('SELECT * FROM roles').filter((x) => roleOk(x.code)), permissions: Object.keys(auth.PERMISSIONS).filter(permOk),
    matrix: Object.fromEntries(Object.keys(auth.ROLES).filter(roleOk).map((rl) => [rl, auth.permsOf(rl).filter(permOk)])), full: auth.FULL };
});
r('PUT', '/api/roles/:code/permissions', 'admin.users', ({ params, body, user }) => { auth.setPermission(params.code, V.str(body.permission, 'Ruxsat'), !!body.enabled, user); return { ok: true }; });
r('GET', '/api/audit', 'audit.view', ({ query }) => db.all(`SELECT * FROM audit_logs WHERE 1=1 ${query.q ? 'AND (action LIKE ? OR entity LIKE ? OR entity_id LIKE ? OR username LIKE ? OR details LIKE ?)' : ''} ${query.entity ? 'AND entity=?' : ''} ORDER BY id DESC LIMIT ? OFFSET ?`, ...(query.q ? Array(5).fill(like(query.q)) : []), ...(query.entity ? [query.entity] : []), lim(query, 300), Number(query.offset) || 0).filter((a) => require('./modules').logisticsOn() || !require('./modules').isLogiAudit(a)));
r('GET', '/api/events', 'view', ({ query }) => db.all('SELECT * FROM system_events WHERE id>? ORDER BY id DESC LIMIT 200', Number(query.since) || 0).map((e) => ({ ...e, payload: JSON.parse(e.payload || '{}') })));
r('GET', '/api/notifications', 'view', ({ user }) => db.all("SELECT * FROM notifications WHERE (user_id IS NULL OR user_id=?) ORDER BY id DESC LIMIT 50", user.id));
r('POST', '/api/notifications/read', 'view', ({ user }) => { db.run('UPDATE notifications SET is_read=1 WHERE (user_id IS NULL OR user_id=?) AND is_read=0', user.id); return { ok: true }; });
r('GET', '/api/settings', 'view', () => Object.fromEntries(db.all('SELECT key, value FROM settings').map((s) => [s.key, JSON.parse(s.value)])));
r('PUT', '/api/settings', 'admin.settings', ({ body, user }) => db.tx(() => { const allowed = ['module_logistics', 'company_name', 'company_address', 'qc_deadline_hours', 'pick_deadline_hours', 'pack_deadline_hours', 'loading_setup_min', 'loading_min_per_pallet', 'avg_speed_kmh', 'report_morning_hour', 'report_evening_hour']; for (const [k, v] of Object.entries(body)) { if (!allowed.includes(k)) throw bad(`Noma’lum sozlama: ${k}`); if (k === 'module_logistics' && user.role !== 'SUPERADMIN') throw bad('Modulni faqat super admin yoqadi'); db.setSetting(k, k === 'module_logistics' ? !!v : typeof v === 'string' && /_(hours|min|pallet|kmh)$/.test(k) ? V.num(v, k, { min: 0 }) : v); } db.audit(user, 'SETTINGS_UPDATE', 'settings', null, body); return { ok: true }; }));

// ---------------- Telegram bot ----------------
const bot = () => require('./bot');
r('GET', '/api/bot/status', 'view', ({ user }) => {
  const s = bot().status(user);
  if (user.section) { delete s.all; delete s.stats; delete s.lastError; } // bo‘lim xodimi faqat o‘z chatlarini ko‘radi
  return s;
});
r('POST', '/api/bot/link-code', 'view', ({ user }) => { if (!bot().enabled()) throw bad('Bot o‘chirilgan: serverdagi .env faylga TELEGRAM_BOT_TOKEN qo‘shing'); return bot().createLinkCode(user); });
r('PUT', '/api/bot/prefs/:chatId', 'view', ({ user, params, body }) => bot().savePrefs(user, params.chatId, body));
r('POST', '/api/bot/unlink/:chatId', 'view', ({ user, params }) => bot().unlink(user, params.chatId, auth.can(user, 'admin.users')));
r('POST', '/api/bot/test', 'view', ({ user }) => bot().testMessage(user));
r('POST', '/api/bot/briefing', 'ai.scan', ({ user }) => bot().briefingNow(user));
r('GET', '/api/bot/preview', 'view', () => ({ text: bot().briefingText('now').text }));
r('GET', '/api/bot/messages', 'audit.view', ({ query }) => bot().messages(lim(query, 200)));

// ---------------- API kalitlari: AI, Telegram, integratsiyalar (super admin) ----------------
const secrets = require('./secrets');
const integ = require('./integration');
r('GET', '/api/keys', 'admin.apikeys', () => ({ secrets: secrets.list(), ai: ai.llmInfo(), integrations: integ.listIntegrations(), apiKeys: integ.listApiKeys(), entities: integ.ENTITIES }));
r('PUT', '/api/keys/:name', 'admin.apikeys', async ({ params, body, user }) => {
  const meta = params.name === 'AI_API_KEY' ? { provider: body.provider ? V.oneOf(body.provider, 'Provayder', ['gemini', 'vertex', 'anthropic']) : undefined, model: body.model ? V.str(body.model, 'Model', { max: 80 }) : undefined } : undefined;
  if (body.value) secrets.set(params.name, body.value, user, meta);
  else if (meta) { const row = db.get('SELECT meta FROM secrets WHERE name=?', params.name); if (!row) throw bad('Avval kalitni kiriting'); db.run('UPDATE secrets SET meta=? WHERE name=?', JSON.stringify(meta), params.name); db.audit(user, 'SECRET_META', 'secrets', params.name, meta); }
  else throw bad('Kalit qiymatini kiriting');
  if (params.name === 'TELEGRAM_BOT_TOKEN') return { ok: true, bot: await require('./bot').reload() };
  return { ok: true };
});
r('DELETE', '/api/keys/:name', 'admin.apikeys', async ({ params, user }) => { secrets.remove(params.name, user); if (params.name === 'TELEGRAM_BOT_TOKEN') await require('./bot').reload(); return { ok: true }; });
// ---------------- Odoo ERP (API kalit bilan o‘qish) ----------------
const odoo = require('./odoo');
r('GET', '/api/odoo', 'admin.apikeys', () => ({ config: odoo.publicConfig(), counts: { purchases: db.val('SELECT COUNT(*) FROM odoo_purchases'), deliveries: db.val('SELECT COUNT(*) FROM odoo_deliveries'), suppliers: db.val("SELECT COUNT(*) FROM suppliers WHERE code LIKE 'ODOO-%'"), products: db.val("SELECT COUNT(*) FROM products WHERE external_ref LIKE 'odoo:%'") } }));
r('PUT', '/api/odoo', 'admin.apikeys', ({ body, user }) => odoo.save(body, user));
r('DELETE', '/api/odoo', 'admin.apikeys', ({ user }) => odoo.remove(user));
r('POST', '/api/odoo/test', 'admin.apikeys', async ({ body }) => { try { return await odoo.test(body); } catch (e) { return { ok: false, error: e.message }; } });
r('POST', '/api/odoo/sync', 'admin.apikeys', ({ user }) => odoo.sync({ user, force: true }));
r('GET', '/api/odoo/purchases', 'view', ({ query }) => db.all(`SELECT * FROM odoo_purchases ${query.late ? 'WHERE is_late=1' : ''} ORDER BY is_late DESC, date_planned`).map((x) => ({ ...x, lines: JSON.parse(x.lines || '[]') })));
r('GET', '/api/odoo/deliveries', 'view', ({ query }) => db.all(`SELECT * FROM odoo_deliveries ${query.late ? 'WHERE is_late=1' : ''} ORDER BY CASE WHEN state IN ('done','cancel') THEN 1 ELSE 0 END, scheduled_date`).map((x) => ({ ...x, lines: JSON.parse(x.lines || '[]') })));
// ---------------- ishlab chiqarish ----------------
const prod = require('./production');
r('GET', '/api/production/overview', 'view', () => prod.overview());
r('GET', '/api/production/orders', 'view', ({ query }) => prod.list({ status: query.status, all: query.all === '1' }));
r('GET', '/api/production/orders/:id', 'view', ({ params }) => prod.detail(id(params)));
r('POST', '/api/production/orders', 'production.manage', ({ body, user }) => prod.create(body, user));
r('POST', '/api/production/orders/:id/release', 'production.manage', ({ params, body, user }) => prod.release(id(params), { partial: !!body.partial }, user));
r('POST', '/api/production/orders/:id/start', 'production.report', ({ params, user }) => prod.start(id(params), user));
r('POST', '/api/production/orders/:id/report', 'production.report', ({ params, body, user }) => prod.report(id(params), body, user));
r('POST', '/api/production/orders/:id/complete', 'production.manage', ({ params, user }) => prod.complete(id(params), user));
r('POST', '/api/production/orders/:id/cancel', 'production.manage', ({ params, body, user }) => prod.cancel(id(params), body.reason, user));
r('GET', '/api/production/suggestions', 'view', () => prod.suggestions());
r('GET', '/api/production/mrp', 'view', () => prod.mrp());
r('POST', '/api/production/mrp/request', 'production.manage', ({ body, user }) => prod.requestShortfalls(Array.isArray(body.componentIds) ? body.componentIds.map(Number) : null, user));
r('GET', '/api/production/bom', 'view', () => prod.bomList());
r('GET', '/api/production/bom/:id', 'view', ({ params }) => ({ product: inv.product(id(params)), items: prod.bomOf(id(params)) }));
r('PUT', '/api/production/bom/:id', 'production.manage', ({ params, body, user }) => prod.saveBom(id(params), body.items, user));

// ---------------- jamoa botlari (Ta’minot, Ombor, Ishlab chiqarish, Xulosa) ----------------
const tbots = () => require('./teambots');
r('GET', '/api/teambots', 'admin.apikeys', () => tbots().status());
r('PUT', '/api/teambots', 'admin.apikeys', async ({ body, user }) => {
  const ids = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map((x) => String(x).trim()).filter((x) => /^-?\d{3,20}$/.test(x));
  const hour = (v, d) => (v === undefined ? d : Math.min(23, Math.max(0, Math.round(Number(v)))));
  const c = tbots().config();
  const patch = { groupIds: body.groupIds !== undefined ? ids(body.groupIds) : c.groupIds, adminIds: body.adminIds !== undefined ? ids(body.adminIds) : c.adminIds,
    morningHour: hour(body.morningHour, c.morningHour), eveningHour: hour(body.eveningHour, c.eveningHour), workStart: hour(body.workStart, c.workStart), workEnd: hour(body.workEnd, c.workEnd),
    summaryEveryHours: body.summaryEveryHours === undefined ? c.summaryEveryHours : Math.min(24, Math.max(0, Number(body.summaryEveryHours))),
    notify: body.notify === undefined ? c.notify : !!body.notify, hourly: body.hourly === undefined ? c.hourly : !!body.hourly, enabled: { ...c.enabled, ...(body.enabled || {}) } };
  tbots().saveConfig(patch);
  for (const g of patch.groupIds) db.run('UPDATE teambot_groups SET allowed=1 WHERE chat_id=?', g);
  db.run(`UPDATE teambot_groups SET allowed=0 WHERE chat_id NOT IN (${patch.groupIds.map(() => '?').join(',') || "''"})`, ...patch.groupIds);
  db.audit(user, 'TEAMBOTS_CONFIG', 'teambots', null, patch);
  for (const k of Object.keys(patch.enabled)) if (!!patch.enabled[k] !== !!c.enabled[k]) await tbots().reload(k); // faqat yoqilgan/o‘chirilgan bot qayta ishga tushadi
  return tbots().status();
});
r('PUT', '/api/teambots/token/:bot', 'admin.apikeys', async ({ params, body, user }) => {
  const map = { taminot: 'TAMINOT_BOT_TOKEN', ombor: 'OMBOR_BOT_TOKEN', ishlab: 'ISHLAB_BOT_TOKEN', xulosa: 'XULOSA_BOT_TOKEN', stt: 'STT_API_KEY' };
  const name = map[params.bot]; if (!name) throw notFound('Bot');
  if (name !== 'STT_API_KEY' && !/^\d{5,15}:[\w-]{30,}$/.test(String(body.value || '').trim())) throw bad('Token formati: 1234567890:AAH… (@BotFather dan)');
  secrets.set(name, body.value, user);
  if (name !== 'STT_API_KEY') await tbots().reload(params.bot);
  return tbots().status();
});
r('DELETE', '/api/teambots/token/:bot', 'admin.apikeys', async ({ params, user }) => {
  const map = { taminot: 'TAMINOT_BOT_TOKEN', ombor: 'OMBOR_BOT_TOKEN', ishlab: 'ISHLAB_BOT_TOKEN', xulosa: 'XULOSA_BOT_TOKEN', stt: 'STT_API_KEY' };
  const name = map[params.bot]; if (!name) throw notFound('Bot');
  secrets.remove(name, user); if (name !== 'STT_API_KEY') await tbots().reload(params.bot);
  return tbots().status();
});
r('POST', '/api/teambots/reload', 'admin.apikeys', () => tbots().reload());
r('POST', '/api/teambots/:bot/test', 'admin.apikeys', ({ params }) => tbots().testMessage(params.bot));
r('POST', '/api/teambots/summary', 'admin.apikeys', () => tbots().runSummary({ reason: 'manual' }));

// ---------------- diagnostika: brauzer va server xatolari jurnali ----------------
r('POST', '/api/client-errors', 'view', ({ body, user, req }) => {
  auth.rateLimit(`clienterr:${user.id}`, 30, 60000);
  db.insert('client_errors', { user_id: user.id, username: user.username, page: String(body.page || '').slice(0, 200), api: body.api ? String(body.api).slice(0, 300) : null, status: Number.isFinite(Number(body.status)) ? Number(body.status) : null,
    message: String(body.message || '').slice(0, 500), stack: String(body.stack || '').slice(0, 800), ua: String(req.headers['user-agent'] || '').slice(0, 200), created_at: clock.iso() });
  db.run('DELETE FROM client_errors WHERE id <= (SELECT MAX(id) - 500 FROM client_errors)');
  return { ok: true };
});
r('GET', '/api/diagnostics', 'admin.users', () => {
  const fs = require('node:fs'); let dbSize = null; try { dbSize = fs.statSync(db.file()).size; try { dbSize += fs.statSync(`${db.file()}-wal`).size; } catch { /* no wal */ } } catch { /* serverless */ }
  let integrity = 'ok'; try { integrity = db.raw().prepare('PRAGMA quick_check').get()?.quick_check || 'ok'; } catch (e) { integrity = e.message; }
  const o = db.setting('odoo', null);
  return { node: process.version, platform: `${process.platform} ${process.arch}`, serverless: !!process.env.VERCEL || process.env.WMS_SERVERLESS === '1', uptimeSec: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576), dbSize, integrity, sqlite: db.raw().constructor.name === 'DatabaseSync' ? 'node:sqlite' : 'better-sqlite3',
    ai: ai.llmInfo(), odoo: o ? { lastSyncAt: o.lastSyncAt || null, status: o.lastStatus || null, error: o.lastError || null } : null,
    clientErrors: db.all('SELECT * FROM client_errors ORDER BY id DESC LIMIT 50'), serverErrors: db.all('SELECT * FROM server_errors ORDER BY id DESC LIMIT 50'), at: clock.iso() };
});
r('DELETE', '/api/diagnostics/errors', 'admin.users', ({ user }) => { db.run('DELETE FROM client_errors'); db.run('DELETE FROM server_errors'); db.audit(user, 'DIAG_CLEAR', 'diagnostics'); return { ok: true }; });

// ---------------- demo → real ----------------
r('GET', '/api/admin/mode', 'admin.admins', () => require('./realmode').status());
r('POST', '/api/admin/go-real', 'admin.admins', ({ body, user }) => {
  if (String(body.confirm || '').trim().toUpperCase() !== 'REAL') throw bad('Tasdiqlash uchun REAL deb yozing');
  const r = require('./realmode').switchToReal(user);
  if (r.odoo) require('./odoo').sync({ force: true }).catch((e) => console.error('odoo', e.message));
  return r;
});
r('GET', '/api/ai/pulse', 'view', ({ user }) => require('./pulse').pulse(user));
r('GET', '/api/odoo/status', 'view', () => { const c = odoo.publicConfig(); return { configured: c.configured, lastSyncAt: c.lastSyncAt || null, lastStatus: c.lastStatus || null, version: c.version || null }; });

// ---------------- boshqa kompyuterga ko‘chirish (faqat super admin) ----------------
r('POST', '/api/admin/transfer/export', 'admin.admins', ({ body, user }) => { const x = require('./transfer').exportPackage(body.password, user); return { __raw: x.buffer, type: 'application/octet-stream', filename: x.filename }; });
r('POST', '/api/admin/transfer/import', 'admin.admins', ({ body, user }) => {
  const b64 = V.str(body.file?.base64 ?? body.base64, 'Paket fayli', { max: 800_000_000 });
  return require('./transfer').importPackage(Buffer.from(b64, 'base64'), body.password, user, { dryRun: !!body.dryRun });
});
r('GET', '/api/admin/filecheck', 'view', () => ({ ...require('./filecheck').scannerInfo(), allowed: require('./filecheck').ALLOWED_LIST }));
r('POST', '/api/keys/AI_API_KEY/test', 'admin.apikeys', async () => { try { return await ai.testLLM(); } catch (err) { return { ok: false, error: err.message, ...ai.llmInfo() }; } });
r('POST', '/api/integrations', 'admin.apikeys', ({ body, user }) => integ.saveIntegration(null, body, user));
r('PUT', '/api/integrations/:id', 'admin.apikeys', ({ params, body, user }) => integ.saveIntegration(id(params), body, user));
r('DELETE', '/api/integrations/:id', 'admin.apikeys', ({ params, user }) => integ.deleteIntegration(id(params), user));
r('POST', '/api/integrations/test', 'admin.apikeys', ({ body }) => integ.testIntegration(body));
r('POST', '/api/integrations/:id/sync', 'admin.apikeys', ({ params, user }) => integ.runIntegration(id(params), { user }));
r('POST', '/api/api-keys', 'admin.apikeys', ({ body, user }) => integ.createApiKey(body, user));
r('POST', '/api/api-keys/:id/revoke', 'admin.apikeys', ({ params, user }) => integ.revokeApiKey(id(params), user));

// ---------------- AI dispetcher ----------------
const dsp = require('./dispatcher');
r('GET', '/api/dispatch', 'view', () => ({ settings: dsp.settings(), jobs: dsp.list() }));
r('PUT', '/api/dispatch/settings', 'dispatch.manage', ({ body, user }) => dsp.saveSettings(body, user));
r('POST', '/api/dispatch/run', 'dispatch.manage', () => dsp.cycle());
r('POST', '/api/dispatch/plan/:id', 'dispatch.manage', ({ params, user }) => dsp.planOrder(id(params), user));
r('POST', '/api/dispatch/:id/dispatch', 'dispatch.manage', ({ params, user }) => dsp.dispatchJob(id(params), user));
r('POST', '/api/dispatch/:id/replan', 'dispatch.manage', ({ params, user }) => dsp.decline(id(params), `${user.fullName} boshqa transport so‘radi`, user));
r('POST', '/api/dispatch/:id/cancel', 'dispatch.manage', ({ params, user }) => dsp.cancel(id(params), user));
r('POST', '/api/drivers/:id/telegram-code', 'transport.manage', ({ params, user }) => { if (!require('./bot').enabled()) throw bad('Telegram bot yoqilmagan: API kalitlari bo‘limida bot tokenini kiriting'); return require('./bot').createDriverLinkCode(id(params), user); });

// ---------------- Kunlik AI hisobotlari (08:00 / 22:00) ----------------
const daily = require('./daily');
r('GET', '/api/daily-reports', 'view', () => ({ hours: daily.hours(), reports: daily.list() }));
r('GET', '/api/daily-reports/preview/:kind', 'view', ({ params }) => { const k = V.oneOf(params.kind, 'Turi', ['morning', 'evening']); return { text: (k === 'morning' ? daily.morning : daily.evening)(daily.localParts().date).text }; });
r('POST', '/api/daily-reports/:kind', 'ai.scan', ({ params, body }) => daily.build(V.oneOf(params.kind, 'Turi', ['morning', 'evening']), { force: true, send: body.send !== false }));

module.exports = { match, routes };
