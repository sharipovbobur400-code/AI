'use strict';
// Orders, reservation allocation, shortage detection, picking (with route), packing & pallets.
const db = require('./db');
const inv = require('./inventory');
const { clock, bad, notFound, V, round } = require('./core');

const PRIORITY_RANK = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
const OPEN_ORDER = "('NEW','PARTIALLY_RESERVED','RESERVED','PICKING','PICKED','PACKED','LOADING')";

function itemCoverage(itemId) {
  const it = db.get('SELECT * FROM order_items WHERE id=?', itemId);
  const reserved = db.val("SELECT COALESCE(SUM(qty - picked_qty),0) FROM inventory_reservations WHERE order_item_id=? AND status='ACTIVE'", itemId) || 0;
  const need = round(Math.max(0, it.qty - it.picked_qty - reserved), 4);
  return { item: it, reserved: round(reserved, 4), picked: it.picked_qty, need };
}

function upsertShortage(itemId, user) {
  const { item, reserved, need } = itemCoverage(itemId);
  const order = db.get('SELECT * FROM orders WHERE id=?', item.order_id);
  const open = db.get("SELECT * FROM shortages WHERE order_item_id=? AND status IN ('OPEN','REQUESTED')", itemId);
  if (need > 0 && !['CANCELLED', 'SHIPPED', 'DELIVERED'].includes(order.status)) {
    const st = inv.productStock(item.product_id);
    if (open) {
      if (open.shortage_qty !== need) db.update('shortages', open.id, { shortage_qty: need, required_qty: item.qty, available_qty: st.available, reserved_qty: reserved, updated_at: clock.iso() });
      return open.id;
    }
    const no = db.nextNo('SHT');
    const id = db.insert('shortages', { shortage_no: no, product_id: item.product_id, order_id: item.order_id, order_item_id: itemId, required_qty: item.qty,
      available_qty: st.available, reserved_qty: reserved, shortage_qty: need, status: 'OPEN', created_at: clock.iso(), updated_at: clock.iso() });
    const p = inv.product(item.product_id);
    db.emit('SHORTAGE_DETECTED', { shortageId: id, orderId: order.id, orderNo: order.order_no, productId: p.id, sku: p.sku, shortage: need });
    const dueSoon = order.due_date && new Date(order.due_date) - clock.now() < 3 * 86400000;
    require('./ai').raise({ key: `shortage-${id}`, type: 'SHORTAGE', severity: dueSoon ? 'CRITICAL' : 'WARNING', title: `${p.name}: ${need} ${p.unit} yetishmaydi`,
      message: `${order.order_no} buyurtmasi uchun ${item.qty} ${p.unit} kerak, ${round(item.qty - need, 4)} ${p.unit} ta'minlangan. ${need} ${p.unit} yetishmaydi. Ta'minot zayavkasi yaratilsinmi?`,
      ref_type: 'shortage', ref_id: id });
    return id;
  }
  if (open) {
    db.update('shortages', open.id, { shortage_qty: 0, status: 'RESOLVED', resolved_at: clock.iso(), updated_at: clock.iso() });
    db.run("UPDATE ai_events SET status='RESOLVED', resolved_at=? WHERE dedupe_key=? AND status<>'RESOLVED'", clock.iso(), `shortage-${open.id}`);
    db.emit('SHORTAGE_RESOLVED', { shortageId: open.id, orderId: item.order_id });
  }
  return null;
}

function reserveForItem(itemId, user, max) {
  const { item, need } = itemCoverage(itemId);
  if (need <= 0) return 0;
  const free = inv.freeQty(item.product_id);
  const q = round(Math.min(need, free, max ?? Infinity), 4);
  if (q <= 0) return 0;
  const p = inv.product(item.product_id);
  const qq = p.track_serial ? Math.floor(q) : q;
  if (qq <= 0) return 0;
  inv.reserve({ productId: item.product_id, qty: qq, orderId: item.order_id, orderItemId: item.id, note: 'Buyurtma uchun avtomatik rezerv' }, user);
  return qq;
}

// Converts an existing project-level reservation into this order's reservation.
function absorbProjectReservations(itemId, projectId, user) {
  if (!projectId) return 0;
  let { item, need } = itemCoverage(itemId);
  let moved = 0;
  const rows = db.all("SELECT * FROM inventory_reservations WHERE project_id=? AND product_id=? AND order_id IS NULL AND status='ACTIVE' ORDER BY id", projectId, item.product_id);
  for (const r of rows) {
    if (need <= 0) break;
    const rem = round(r.qty - r.picked_qty, 4);
    const q = Math.min(rem, need);
    if (q === rem) db.update('inventory_reservations', r.id, { order_id: item.order_id, order_item_id: item.id, note: `${r.note || ''} → buyurtmaga biriktirildi`.trim(), updated_at: clock.iso() });
    else {
      db.update('inventory_reservations', r.id, { qty: round(r.qty - q, 4), updated_at: clock.iso() });
      db.insert('inventory_reservations', { res_no: db.nextNo('RES'), product_id: r.product_id, order_id: item.order_id, order_item_id: item.id, project_id: projectId,
        qty: q, status: 'ACTIVE', note: `Loyiha rezervidan (${r.res_no})`, created_by: user?.id, created_at: clock.iso(), updated_at: clock.iso() });
    }
    db.audit(user, 'RESERVATION_ASSIGN', 'inventory_reservations', r.res_no, { orderId: item.order_id, qty: q });
    need = round(need - q, 4); moved += q;
  }
  return moved;
}

function recomputeOrderStatus(orderId) {
  const o = db.get('SELECT * FROM orders WHERE id=?', orderId);
  if (!o || ['CANCELLED', 'DELIVERED'].includes(o.status)) return o && o.status;
  const items = db.all('SELECT * FROM order_items WHERE order_id=?', orderId);
  const cov = items.map((i) => itemCoverage(i.id));
  const loading = db.val("SELECT COUNT(*) FROM shipments WHERE order_id=? AND status IN ('LOADING','LOADED')", orderId);
  const picking = db.val("SELECT COUNT(*) FROM picking_tasks WHERE order_id=? AND status IN ('PENDING','IN_PROGRESS')", orderId);
  let s;
  if (items.every((i) => i.shipped_qty >= i.qty)) s = 'SHIPPED';
  else if (loading) s = 'LOADING';
  else if (items.every((i) => i.packed_qty >= i.qty)) s = 'PACKED';
  else if (items.every((i) => i.picked_qty >= i.qty)) s = 'PICKED';
  else if (picking || items.some((i) => i.picked_qty > 0)) s = 'PICKING';
  else if (cov.every((c) => c.need === 0)) s = 'RESERVED';
  else if (cov.some((c) => c.reserved > 0)) s = 'PARTIALLY_RESERVED';
  else s = 'NEW';
  if (s !== o.status) { db.update('orders', o.id, { status: s, updated_at: clock.iso() }); db.history('order', o.id, o.status, s, null); db.emit('ORDER_STATUS', { orderId, status: s }); }
  return s;
}
function refreshItem(itemId, user) { const it = db.get('SELECT order_id FROM order_items WHERE id=?', itemId); upsertShortage(itemId, user); recomputeOrderStatus(it.order_id); }

/** Allocate newly available stock to open orders (priority, due date, FIFO) and resolve shortages. */
function allocateProduct(productId, user) {
  return db.tx(() => {
    const items = db.all(`SELECT oi.id, o.id order_id, o.priority, o.due_date FROM order_items oi JOIN orders o ON o.id=oi.order_id
      WHERE oi.product_id=? AND o.status IN ${OPEN_ORDER} AND oi.picked_qty < oi.qty`, productId)
      .sort((a, b) => (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2) || String(a.due_date || '9').localeCompare(String(b.due_date || '9')) || a.id - b.id);
    const touched = new Set();
    for (const it of items) { if (inv.freeQty(productId) <= 0 && itemCoverage(it.id).need > 0) { upsertShortage(it.id, user); touched.add(it.order_id); continue; } reserveForItem(it.id, user); upsertShortage(it.id, user); touched.add(it.order_id); }
    for (const o of touched) recomputeOrderStatus(o);
    return touched.size;
  });
}

/** Stock check for a planned order ("Yangi yig‘ish" preview) – no writes. */
function analyze(items, projectId) {
  return V.arr(items, 'Mahsulotlar').map((i) => {
    const p = inv.product(V.id(i.productId, 'Mahsulot'));
    const qty = V.qty(i.qty);
    const st = inv.productStock(p.id);
    const projRes = projectId ? db.val("SELECT COALESCE(SUM(qty-picked_qty),0) FROM inventory_reservations WHERE project_id=? AND product_id=? AND order_id IS NULL AND status='ACTIVE'", projectId, p.id) || 0 : 0;
    const coverable = round(Math.min(qty, projRes + Math.max(0, st.free)), 4);
    const shortage = round(qty - coverable, 4);
    return { productId: p.id, sku: p.sku, name: p.name, unit: p.unit, required: qty, onHand: st.on_hand, available: st.available, reserved: st.reserved,
      free: st.free, projectReserved: projRes, canReserve: coverable, shortage, inbound: st.inbound,
      message: shortage > 0 ? `${coverable} ${p.unit} tayyor. ${shortage} ${p.unit} yetishmaydi. Ta'minot zayavkasi yaratilsinmi?` : `${qty} ${p.unit} to‘liq ta'minlanadi.` };
  });
}

function createOrder(input, user) {
  return db.tx(() => {
    let customerId = V.optId(input.customerId, 'Mijoz');
    if (!customerId) {
      const name = V.str(input.customerName, 'Mijoz', { max: 200 });
      customerId = db.val('SELECT id FROM customers WHERE name=?', name) || db.insert('customers', { name, created_at: clock.iso() });
    }
    const projectId = V.optId(input.projectId, 'Loyiha');
    const items = V.arr(input.items, 'Mahsulotlar', { max: 50 });
    const orderNo = db.nextNo('ORD');
    const id = db.insert('orders', { order_no: orderNo, customer_id: customerId, project_id: projectId, priority: V.oneOf(input.priority || 'NORMAL', 'Muhimlik', Object.keys(PRIORITY_RANK)),
      due_date: input.dueDate ? V.date(input.dueDate, 'Muddat') : null, destination: V.str(input.destination, 'Manzil', { required: false, max: 300 }), status: 'NEW',
      notes: V.str(input.notes, 'Izoh', { required: false, max: 1000 }), created_by: user?.id, created_at: clock.iso(), updated_at: clock.iso() });
    const itemIds = items.map((i) => { const p = inv.product(V.id(i.productId, 'Mahsulot')); return db.insert('order_items', { order_id: id, product_id: p.id, qty: p.track_serial ? V.num(i.qty, 'Miqdor', { int: true, min: 1 }) : V.qty(i.qty) }); });
    db.history('order', id, null, 'NEW', user);
    db.emit('ORDER_CREATED', { orderId: id, orderNo });
    db.audit(user, 'ORDER_CREATE', 'orders', orderNo, { items });
    const analysis = [];
    for (const itemId of itemIds) {
      if (input.autoReserve !== false) { absorbProjectReservations(itemId, projectId, user); reserveForItem(itemId, user); }
      upsertShortage(itemId, user);
      const c = itemCoverage(itemId); const p = inv.product(c.item.product_id);
      analysis.push({ sku: p.sku, name: p.name, required: c.item.qty, reserved: c.reserved, shortage: c.need,
        message: c.need > 0 ? `${c.reserved} ${p.unit} tayyor. ${c.need} ${p.unit} yetishmaydi. Ta'minot zayavkasi yaratilsinmi?` : `${c.item.qty} ${p.unit} rezerv qilindi.` });
    }
    const status = recomputeOrderStatus(id);
    return { id, orderNo, status, analysis };
  });
}

function cancelOrder(orderId, input, user) {
  return db.tx(() => {
    const o = db.get('SELECT * FROM orders WHERE id=?', orderId); if (!o) throw notFound('Buyurtma');
    if (db.val('SELECT COALESCE(SUM(picked_qty),0) FROM order_items WHERE order_id=?', orderId) > 0) throw bad('Yig‘ilgan mahsulotli buyurtmani bekor qilib bo‘lmaydi — avval qaytaring');
    for (const r of db.all("SELECT id FROM inventory_reservations WHERE order_id=? AND status='ACTIVE'", orderId)) inv.release(r.id, { reason: 'Buyurtma bekor qilindi', silent: true, noAllocate: true }, user);
    db.run("UPDATE shortages SET status='CANCELLED', updated_at=? WHERE order_id=? AND status IN ('OPEN','REQUESTED')", clock.iso(), orderId);
    db.update('orders', o.id, { status: 'CANCELLED', updated_at: clock.iso() });
    db.history('order', o.id, o.status, 'CANCELLED', user, input.reason);
    db.audit(user, 'ORDER_CANCEL', 'orders', o.order_no, { reason: input.reason });
    for (const pid of db.all('SELECT DISTINCT product_id FROM order_items WHERE order_id=?', orderId)) allocateProduct(pid.product_id, user);
    return { ok: true };
  });
}

/** Periodic full scan: keep every open order's shortage in sync. */
function detectAllShortages(user) {
  return db.tx(() => {
    const items = db.all(`SELECT oi.id, oi.product_id FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.status IN ${OPEN_ORDER} AND oi.picked_qty < oi.qty`);
    for (const pid of new Set(items.map((i) => i.product_id))) allocateProduct(pid, user);
    return db.val("SELECT COUNT(*) FROM shortages WHERE status IN ('OPEN','REQUESTED')");
  });
}

// ---- Picking ------------------------------------------------------------------------
function routeOrder(lines) {
  // nearest-neighbour from the dock (0,0) over location coordinates
  const pts = lines.map((l) => ({ ...l, ...db.get('SELECT x, y, code FROM warehouse_locations WHERE id=?', l.location_id) }));
  const out = []; let cur = { x: 0, y: 0 }; let dist = 0;
  const left = [...pts];
  while (left.length) {
    let bi = 0; let bd = Infinity;
    left.forEach((p, i) => { const d = Math.abs(p.x - cur.x) + Math.abs(p.y - cur.y); if (d < bd) { bd = d; bi = i; } });
    const [p] = left.splice(bi, 1); dist += bd; out.push(p); cur = p;
  }
  const naive = pts.reduce((a, p, i) => a + (i ? Math.abs(p.x - pts[i - 1].x) + Math.abs(p.y - pts[i - 1].y) : Math.abs(p.x) + Math.abs(p.y)), 0);
  return { ordered: out, distance: round(dist, 1), naiveDistance: round(naive, 1) };
}

function suggestWorker(role = 'STOREKEEPER') {
  const w = db.all(`SELECT u.id, u.full_name,
      (SELECT COUNT(*) FROM picking_tasks t WHERE t.assigned_to=u.id AND t.status IN ('PENDING','IN_PROGRESS')) +
      (SELECT COUNT(*) FROM loading_tasks t WHERE t.assigned_to=u.id AND t.status IN ('PENDING','IN_PROGRESS')) +
      (SELECT COUNT(*) FROM packing_tasks t WHERE t.assigned_to=u.id AND t.status IN ('PENDING','IN_PROGRESS')) open_tasks,
      (SELECT COALESCE(SUM(errors),0)*1.0/MAX(1,COALESCE(SUM(scans),0)) FROM picking_tasks t WHERE t.assigned_to=u.id) err_rate
    FROM users u WHERE u.role_code=? AND u.active=1`, role);
  w.sort((a, b) => a.open_tasks - b.open_tasks || a.err_rate - b.err_rate);
  return w[0] || null;
}

function createPickTask(orderId, input, user) {
  return db.tx(() => {
    const o = db.get('SELECT * FROM orders WHERE id=?', orderId); if (!o) throw notFound('Buyurtma');
    if (['CANCELLED', 'SHIPPED', 'DELIVERED'].includes(o.status)) throw bad(`Buyurtma holati: ${o.status}`);
    if (db.val("SELECT COUNT(*) FROM picking_tasks WHERE order_id=? AND status IN ('PENDING','IN_PROGRESS')", orderId)) throw bad('Ushbu buyurtma uchun ochiq picking topshirig‘i mavjud');
    const lines = [];
    for (const it of db.all('SELECT * FROM order_items WHERE order_id=?', orderId)) {
      const c = itemCoverage(it.id);
      if (c.reserved <= 0) continue;
      // stock rows minus quantities already planned by other open pick lines
      const rows = db.all(`SELECT i.location_id, i.batch_id, i.qty - COALESCE((SELECT SUM(pl.qty-pl.picked_qty) FROM picking_task_lines pl JOIN picking_tasks t ON t.id=pl.task_id
          WHERE t.status IN ('PENDING','IN_PROGRESS') AND pl.product_id=i.product_id AND pl.location_id=i.location_id AND pl.batch_id=i.batch_id),0) q
        FROM inventory i LEFT JOIN product_batches b ON b.id=i.batch_id WHERE i.product_id=? AND i.status='AVAILABLE' AND i.qty>0
        ORDER BY COALESCE(b.mfg_date,'9999'), i.qty DESC`, it.product_id).filter((r) => r.q > 0);
      let left = c.reserved;
      for (const r of rows) { if (left <= 0) break; const q = Math.min(r.q, left); lines.push({ product_id: it.product_id, location_id: r.location_id, batch_id: r.batch_id, qty: q }); left = round(left - q, 4); }
      if (left > 0) throw bad(`${inv.product(it.product_id).sku}: rezerv ${c.reserved}, lekin saqlash joylarida faqat ${round(c.reserved - left, 4)} mavjud`);
    }
    if (!lines.length) throw bad('Yig‘ish uchun rezerv qilingan mahsulot yo‘q. Avval rezerv qiling.');
    const route = routeOrder(lines);
    const worker = input.assignedTo ? db.get('SELECT id, full_name FROM users WHERE id=?', input.assignedTo) : suggestWorker();
    const taskNo = db.nextNo('PICK');
    const id = db.insert('picking_tasks', { task_no: taskNo, order_id: orderId, status: 'PENDING', assigned_to: worker?.id, deadline: input.deadline ? V.date(input.deadline, 'Muddat') : clock.addDays(db.setting('pick_deadline_hours', 4) / 24),
      route: JSON.stringify({ path: route.ordered.map((p) => p.code), distance: route.distance, naiveDistance: route.naiveDistance }), created_by: user?.id, created_at: clock.iso() });
    route.ordered.forEach((l, i) => db.insert('picking_task_lines', { task_id: id, product_id: l.product_id, location_id: l.location_id, batch_id: l.batch_id, qty: l.qty, seq: i + 1 }));
    db.history('picking', id, null, 'PENDING', user);
    db.audit(user, 'PICK_TASK_CREATE', 'picking_tasks', taskNo, { order: o.order_no, worker: worker?.full_name });
    db.emit('TASK_CREATED', { kind: 'picking', taskId: id, taskNo, assignedTo: worker?.id });
    recomputeOrderStatus(orderId);
    return { id, taskNo, assignedTo: worker, route: route.ordered.map((p) => p.code), distance: route.distance, saved: round(route.naiveDistance - route.distance, 1) };
  });
}

function startPick(taskId, user) {
  return db.tx(() => {
    const t = db.get('SELECT * FROM picking_tasks WHERE id=?', taskId); if (!t) throw notFound('Picking topshirig‘i');
    if (t.status !== 'PENDING') return { status: t.status };
    db.update('picking_tasks', t.id, { status: 'IN_PROGRESS', started_at: clock.iso(), assigned_to: t.assigned_to || user?.id });
    db.history('picking', t.id, 'PENDING', 'IN_PROGRESS', user);
    db.emit('PICKING_STARTED', { taskId: t.id, taskNo: t.task_no, orderId: t.order_id });
    db.audit(user, 'PICK_START', 'picking_tasks', t.task_no);
    return { status: 'IN_PROGRESS' };
  });
}

/** Scan validation: returns ✅/❌ for product, serial, or location codes against the current line. */
function scanPick(taskId, input, user) {
  return db.tx(() => {
    const t = db.get('SELECT * FROM picking_tasks WHERE id=?', taskId); if (!t) throw notFound('Picking topshirig‘i');
    const code = V.str(input.code, 'Kod', { max: 200 });
    const line = input.lineId ? db.get('SELECT * FROM picking_task_lines WHERE id=? AND task_id=?', input.lineId, taskId)
      : db.get("SELECT * FROM picking_task_lines WHERE task_id=? AND picked_qty<qty ORDER BY seq LIMIT 1", taskId);
    if (!line) throw bad('Yig‘ish qatori topilmadi');
    const p = inv.product(line.product_id); const loc = inv.location(line.location_id);
    let ok = false; let kind = 'unknown'; let message;
    const serial = db.get('SELECT * FROM serial_numbers WHERE serial=?', code);
    if (code === loc.code) { ok = true; kind = 'location'; message = `✅ Lokatsiya to‘g‘ri: ${loc.code}`; }
    else if (serial) {
      kind = 'serial';
      if (serial.product_id !== p.id) message = `❌ Noto‘g‘ri mahsulot: serial ${code} boshqa mahsulotga tegishli`;
      else if (serial.status !== 'IN_STOCK') message = `❌ Serial ${code} mavjud emas (holat: ${serial.status})`;
      else if (serial.location_id !== loc.id) message = `❌ Serial ${code} boshqa joyda: ${inv.location(serial.location_id).code}`;
      else { ok = true; message = `✅ Mahsulot to‘g‘ri: ${p.sku} / ${code}`; }
    } else if (code === p.sku || code === p.barcode) { ok = true; kind = 'product'; message = `✅ Mahsulot to‘g‘ri: ${p.sku}`; }
    else { const other = db.get('SELECT sku FROM products WHERE sku=? OR barcode=?', code, code); message = other ? `❌ Noto‘g‘ri mahsulot: ${other.sku} (kerak: ${p.sku})` : `❌ Noma'lum kod: ${code}`; }
    db.run(`UPDATE picking_tasks SET scans=scans+1${ok ? '' : ', errors=errors+1'} WHERE id=?`, taskId);
    if (!ok) db.audit(user, 'PICK_SCAN_ERROR', 'picking_tasks', t.task_no, { code, expected: p.sku });
    return { ok, kind, message, lineId: line.id, serial: kind === 'serial' && ok ? code : null };
  });
}

function pickLine(lineId, input, user) {
  return db.tx(() => {
    const l = db.get('SELECT * FROM picking_task_lines WHERE id=?', lineId); if (!l) throw notFound('Yig‘ish qatori');
    const t = db.get('SELECT * FROM picking_tasks WHERE id=?', l.task_id);
    if (t.status === 'COMPLETED') throw bad('Topshiriq yakunlangan');
    if (t.status === 'PENDING') startPick(t.id, user);
    const remaining = round(l.qty - l.picked_qty, 4);
    const qty = input.qty != null ? V.qty(input.qty) : remaining;
    if (qty > remaining) throw bad(`Qatorda faqat ${remaining} qoldi`);
    const item = db.get('SELECT * FROM order_items WHERE order_id=? AND product_id=? ORDER BY id LIMIT 1', t.order_id, l.product_id);
    const order = db.get('SELECT * FROM orders WHERE id=?', t.order_id);
    const r = inv.move({ type: 'TRANSFER', productId: l.product_id, qty, from: { locationId: l.location_id, status: 'AVAILABLE', batchId: l.batch_id },
      to: { locationId: inv.packingLocation(), status: 'PICKED' }, user, ref: { type: 'picking', id: t.id }, reference: t.task_no, reason: `Picking → ${order.order_no}`,
      serials: input.serials && input.serials.length ? input.serials : undefined, serialPatch: { order_id: t.order_id } });
    // consume the order's reservation FIFO
    let left = qty;
    for (const res of db.all("SELECT * FROM inventory_reservations WHERE order_item_id=? AND status='ACTIVE' ORDER BY id", item.id)) {
      if (left <= 0) break;
      const q = Math.min(round(res.qty - res.picked_qty, 4), left);
      const picked = round(res.picked_qty + q, 4);
      db.update('inventory_reservations', res.id, { picked_qty: picked, status: picked >= res.qty ? 'CONSUMED' : 'ACTIVE', updated_at: clock.iso() });
      left = round(left - q, 4);
    }
    if (left > 0) throw bad('Rezervdan ortiq yig‘ib bo‘lmaydi');
    db.run('UPDATE order_items SET picked_qty=picked_qty+? WHERE id=?', qty, item.id);
    const picked = round(l.picked_qty + qty, 4);
    db.update('picking_task_lines', l.id, { picked_qty: picked, status: picked >= l.qty ? 'DONE' : 'PARTIAL' });
    db.audit(user, 'PICK', 'picking_tasks', t.task_no, { product: l.product_id, qty, serials: r.serials.length });
    let completed = false;
    if (!db.val('SELECT COUNT(*) FROM picking_task_lines WHERE task_id=? AND picked_qty<qty', t.id)) { completePick(t.id, {}, user); completed = true; }
    return { picked: qty, serials: r.serials, completed };
  });
}

function completePick(taskId, input, user) {
  return db.tx(() => {
    const t = db.get('SELECT * FROM picking_tasks WHERE id=?', taskId); if (!t) throw notFound('Picking topshirig‘i');
    if (t.status === 'COMPLETED') return { status: 'COMPLETED' };
    const open = db.val('SELECT COUNT(*) FROM picking_task_lines WHERE task_id=? AND picked_qty<qty', taskId);
    if (open && !input.partial) throw bad(`${open} ta qator hali yig‘ilmagan. Qisman yakunlash uchun "partial" belgilang.`);
    db.update('picking_tasks', t.id, { status: 'COMPLETED', completed_at: clock.iso(), started_at: t.started_at || clock.iso() });
    db.history('picking', t.id, t.status, 'COMPLETED', user);
    if (!db.val("SELECT COUNT(*) FROM packing_tasks WHERE order_id=? AND status IN ('PENDING','IN_PROGRESS')", t.order_id)) {
      const w = suggestWorker();
      db.insert('packing_tasks', { task_no: db.nextNo('PACK'), order_id: t.order_id, status: 'PENDING', assigned_to: w?.id, deadline: clock.addDays(db.setting('pack_deadline_hours', 3) / 24), created_at: clock.iso() });
    }
    db.emit('PICKING_COMPLETED', { taskId: t.id, taskNo: t.task_no, orderId: t.order_id });
    db.audit(user, 'PICK_COMPLETE', 'picking_tasks', t.task_no, { partial: !!open });
    recomputeOrderStatus(t.order_id);
    return { status: 'COMPLETED' };
  });
}

// ---- Packing / pallets ------------------------------------------------------------
function palletMetrics(p, qty) {
  const per = Math.max(1, p.units_per_pallet || 1);
  const net = round(qty * (p.net_weight_kg || 0), 2);
  const packaging = round((p.packaging_weight_kg || 0) * Math.min(1, qty / per), 2);
  const gross = round(net + (p.pallet_weight_kg || 0) + packaging, 2);
  const L = p.pallet_length_mm || 1200; const W = p.pallet_width_mm || 800;
  const H = round(150 + ((p.pallet_height_mm || 1200) - 150) * Math.min(1, qty / per), 0);
  return { net_weight_kg: net, pallet_weight_kg: p.pallet_weight_kg || 0, packaging_weight_kg: packaging, gross_weight_kg: gross, length_mm: L, width_mm: W, height_mm: H, volume_m3: round((L * W * H) / 1e9, 3) };
}

function createPallets(input, user) {
  return db.tx(() => {
    const orderId = V.id(input.orderId, 'Buyurtma');
    const o = db.get('SELECT * FROM orders WHERE id=?', orderId); if (!o) throw notFound('Buyurtma');
    const items = db.all('SELECT * FROM order_items WHERE order_id=? AND picked_qty>packed_qty', orderId).filter((i) => !input.productId || i.product_id === Number(input.productId));
    if (!items.length) throw bad('Qadoqlash uchun yig‘ilgan mahsulot yo‘q');
    const created = [];
    const packLoc = inv.packingLocation();
    for (const it of items) {
      const p = inv.product(it.product_id);
      let left = round(it.picked_qty - it.packed_qty, 4);
      if (input.qty) left = Math.min(left, V.qty(input.qty));
      const per = input.perPallet ? V.num(input.perPallet, 'Palletdagi soni', { int: true, min: 1 }) : Math.max(1, p.units_per_pallet || 1);
      while (left > 0) {
        const q = Math.min(per, left);
        const m = palletMetrics(p, q);
        const no = db.nextNo('PAL');
        const pid = db.insert('pallets', { pallet_no: no, order_id: orderId, product_id: p.id, qty: q, ...m, stackable: (p.max_stack || 1) > 1 ? 1 : 0, fragile: p.fragile,
          location_id: packLoc, status: 'PACKED', label: JSON.stringify({ pallet: no, order: o.order_no, sku: p.sku, qty: q, gross: m.gross_weight_kg }), created_by: user?.id, created_at: clock.iso(), updated_at: clock.iso() });
        const filter = p.track_serial ? { order_id: orderId } : undefined;
        for (const leg of inv.take({ productId: p.id, qty: q, status: 'PICKED', locationId: packLoc, serialFilter: filter })) {
          inv.move({ type: 'PACK', productId: p.id, qty: leg.qty, from: { locationId: leg.locationId, status: 'PICKED', batchId: leg.batchId }, to: { locationId: packLoc, status: 'PACKED' },
            user, ref: { type: 'pallet', id: pid }, reference: no, reason: `Pallet ${no}`, serialFilter: filter, serialPatch: { pallet_id: pid } });
          db.update('pallets', pid, { batch_id: leg.batchId });
        }
        db.run('UPDATE order_items SET packed_qty=packed_qty+? WHERE id=?', q, it.id);
        db.history('pallet', pid, null, 'PACKED', user);
        db.audit(user, 'PALLET_CREATE', 'pallets', no, { order: o.order_no, sku: p.sku, qty: q, gross: m.gross_weight_kg });
        created.push({ id: pid, palletNo: no, qty: q, ...m });
        left = round(left - q, 4);
      }
    }
    const remainingToPack = db.val('SELECT COUNT(*) FROM order_items WHERE order_id=? AND packed_qty<picked_qty', orderId);
    if (!remainingToPack) {
      for (const pt of db.all("SELECT * FROM packing_tasks WHERE order_id=? AND status IN ('PENDING','IN_PROGRESS')", orderId)) {
        db.update('packing_tasks', pt.id, { status: 'COMPLETED', started_at: pt.started_at || clock.iso(), completed_at: clock.iso(), assigned_to: pt.assigned_to || user?.id });
        db.history('packing', pt.id, pt.status, 'COMPLETED', user);
      }
      db.emit('PACKING_COMPLETED', { orderId, orderNo: o.order_no, pallets: created.length });
    }
    recomputeOrderStatus(orderId);
    return { pallets: created, totalGross: round(created.reduce((a, c) => a + c.gross_weight_kg, 0), 2) };
  });
}

function movePalletToDispatch(palletId, input, user) {
  return db.tx(() => {
    const pl = db.get('SELECT * FROM pallets WHERE id=?', palletId); if (!pl) throw notFound('Pallet');
    if (pl.status !== 'PACKED') throw bad(`Pallet holati: ${pl.status}`);
    const to = input.locationId ? V.id(input.locationId, 'Lokatsiya') : inv.zoneLocation('DISPATCH');
    if (to === pl.location_id) return { ok: true };
    const p = inv.product(pl.product_id);
    for (const leg of inv.take({ productId: p.id, qty: pl.qty, status: 'PACKED', locationId: pl.location_id, serialFilter: p.track_serial ? { pallet_id: pl.id } : undefined }))
      inv.move({ type: 'TRANSFER', productId: p.id, qty: leg.qty, from: { locationId: pl.location_id, status: 'PACKED', batchId: leg.batchId }, to: { locationId: to, status: 'PACKED' }, user,
        ref: { type: 'pallet', id: pl.id }, reference: pl.pallet_no, reason: 'Jo‘natish zonasiga', serialFilter: p.track_serial ? { pallet_id: pl.id } : undefined });
    db.update('pallets', pl.id, { location_id: to, updated_at: clock.iso() });
    db.audit(user, 'PALLET_MOVE', 'pallets', pl.pallet_no, { to: inv.location(to).code });
    return { ok: true, location: inv.location(to).code };
  });
}

function unpackPallet(palletId, user) {
  return db.tx(() => {
    const pl = db.get('SELECT * FROM pallets WHERE id=?', palletId); if (!pl) throw notFound('Pallet');
    if (pl.status !== 'PACKED' || pl.shipment_id) throw bad('Faqat jo‘natmaga biriktirilmagan PACKED pallet ochiladi');
    const p = inv.product(pl.product_id); const packLoc = inv.packingLocation();
    for (const leg of inv.take({ productId: p.id, qty: pl.qty, status: 'PACKED', locationId: pl.location_id, serialFilter: p.track_serial ? { pallet_id: pl.id } : undefined }))
      inv.move({ type: 'UNPACK', productId: p.id, qty: leg.qty, from: { locationId: pl.location_id, status: 'PACKED', batchId: leg.batchId }, to: { locationId: packLoc, status: 'PICKED' }, user,
        ref: { type: 'pallet', id: pl.id }, reference: pl.pallet_no, reason: 'Pallet ochildi', serialFilter: p.track_serial ? { pallet_id: pl.id } : undefined, serialPatch: { pallet_id: null } });
    db.update('pallets', pl.id, { status: 'UNPACKED', updated_at: clock.iso() });
    db.run('UPDATE order_items SET packed_qty=packed_qty-? WHERE order_id=? AND product_id=?', pl.qty, pl.order_id, pl.product_id);
    db.history('pallet', pl.id, 'PACKED', 'UNPACKED', user);
    db.audit(user, 'PALLET_UNPACK', 'pallets', pl.pallet_no);
    recomputeOrderStatus(pl.order_id);
    return { ok: true };
  });
}

module.exports = { itemCoverage, upsertShortage, allocateProduct, analyze, createOrder, cancelOrder, detectAllShortages, recomputeOrderStatus, refreshItem,
  createPickTask, startPick, scanPick, pickLine, completePick, palletMetrics, createPallets, movePalletToDispatch, unpackPallet, suggestWorker, routeOrder };
