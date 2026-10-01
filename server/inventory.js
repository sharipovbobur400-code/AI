'use strict';
// Inventory engine. RULE: stock is never edited directly — every change goes through move(),
// which writes an append-only inventory_transactions row inside a DB transaction.
const db = require('./db');
const { clock, bad, notFound, V, round } = require('./core');

const SERIAL_STATUS = { AVAILABLE: 'IN_STOCK', RECEIVING: 'RECEIVING', PICKED: 'PICKED', PACKED: 'PACKED', LOADED: 'LOADED', REWORK: 'REWORK', SCRAP: 'SCRAP' };
const OUT_STATUS = { SHIP: 'SHIPPED', ISSUE: 'ISSUED', ADJUSTMENT: 'ADJUSTED_OUT', SCRAP: 'DISPOSED' };
const TXN_TYPES = ['RECEIVE', 'ISSUE', 'TRANSFER', 'RESERVE', 'RELEASE', 'ADJUSTMENT', 'RETURN', 'REJECT', 'SCRAP', 'REWORK', 'PACK', 'UNPACK', 'SHIP'];
const STOCK_STATUSES = ['RECEIVING', 'AVAILABLE', 'REWORK', 'SCRAP', 'PICKED', 'PACKED', 'LOADED'];

const product = (id) => { const p = db.get('SELECT * FROM products WHERE id=?', id); if (!p) throw notFound('Mahsulot'); return p; };
const location = (id) => { const l = db.get('SELECT l.*, z.zone_type, z.name zone_name FROM warehouse_locations l JOIN warehouse_zones z ON z.id=l.zone_id WHERE l.id=?', id); if (!l) throw notFound('Lokatsiya'); return l; };

// ---- Location resolution ----------------------------------------------------
const CATEGORY_WH = { FINISHED: 'WH-03', WIP: 'WH-02', RAW: 'WH-01', MATERIAL: 'WH-01', PACKAGING: 'WH-04' };
const CATEGORY_ZONE = { FINISHED: 'FINISHED', WIP: 'WIP', RAW: 'RAW', MATERIAL: 'RAW', PACKAGING: 'RAW' };

function zoneLocation(zoneType, warehouseId) {
  const l = db.get(`SELECT l.id FROM warehouse_locations l JOIN warehouse_zones z ON z.id=l.zone_id
    WHERE z.zone_type=? AND l.active=1 ${warehouseId ? 'AND l.warehouse_id=?' : ''} ORDER BY (l.warehouse_id=?) DESC, l.id LIMIT 1`,
  ...(warehouseId ? [zoneType, warehouseId, warehouseId] : [zoneType, '']));
  if (!l) throw bad(`${zoneType} zonasi uchun lokatsiya sozlanmagan`);
  return l.id;
}
function receivingLocation(p, source) {
  if (source === 'RETURN') return zoneLocation('RETURN');
  const wh = ['FINISHED', 'WIP'].includes(p.category) ? 'WH-03' : 'WH-01';
  return zoneLocation('RECEIVING', wh);
}
const packingLocation = () => zoneLocation('PACKING', 'WH-03');

function locationPalletUse(locationId) {
  return db.val(`SELECT COALESCE(SUM((i.qty + p.units_per_pallet - 1) / p.units_per_pallet),0) FROM inventory i JOIN products p ON p.id=i.product_id
    WHERE i.location_id=? AND i.qty>0`, locationId) || 0;
}
// Suggest storage locations for putaway: consolidate with same product first, then emptiest slot.
function putawayPlan(p, qty) {
  const zoneType = CATEGORY_ZONE[p.category] || 'FINISHED';
  const wh = CATEGORY_WH[p.category] || 'WH-03';
  const locs = db.all(`SELECT l.id, l.code, l.max_pallets,
      (SELECT COALESCE(SUM(CAST((i.qty + pp.units_per_pallet - 1) / pp.units_per_pallet AS INTEGER)),0) FROM inventory i JOIN products pp ON pp.id=i.product_id WHERE i.location_id=l.id AND i.qty>0) used,
      (SELECT COALESCE(SUM(qty),0) FROM inventory i WHERE i.location_id=l.id AND i.product_id=? AND i.qty>0) same
    FROM warehouse_locations l JOIN warehouse_zones z ON z.id=l.zone_id
    WHERE z.zone_type=? AND l.warehouse_id=? AND l.active=1 ORDER BY same DESC, used ASC, l.id`, p.id, zoneType, wh);
  if (p.default_location_id) locs.unshift(...locs.splice(locs.findIndex((l) => l.id === p.default_location_id) >>> 0, 1));
  const per = Math.max(1, p.units_per_pallet || 1);
  const plan = []; let left = qty;
  for (const l of locs) {
    if (left <= 0) break;
    const freePallets = l.max_pallets - l.used;
    // allow topping-up a partially filled pallet of the same product
    const partial = l.same > 0 ? (per - (l.same % per)) % per : 0;
    const cap = Math.max(0, freePallets) * per + partial;
    if (cap <= 0) continue;
    const q = Math.min(cap, left);
    plan.push({ locationId: l.id, code: l.code, qty: q }); left -= q;
  }
  if (left > 0) { // overflow: least-loaded location of the zone (flagged)
    const l = locs.slice().sort((a, b) => a.used - b.used)[0];
    if (!l) throw bad('Saqlash zonasida bo‘sh lokatsiya yo‘q');
    const ex = plan.find((x) => x.locationId === l.id);
    if (ex) ex.qty += left; else plan.push({ locationId: l.id, code: l.code, qty: left, overflow: true });
  }
  return plan;
}

// ---- Core stock movement ------------------------------------------------------
function applyDelta(productId, locationId, batchId, status, delta) {
  const row = db.get('SELECT id, qty FROM inventory WHERE product_id=? AND location_id=? AND batch_id=? AND status=?', productId, locationId, batchId || 0, status);
  const newQty = round((row ? row.qty : 0) + delta, 4);
  if (newQty < 0) {
    const p = product(productId);
    throw bad(`Omborda yetarli mahsulot mavjud emas. ${p.sku}: mavjud ${row ? row.qty : 0}, talab ${-delta} (${status})`);
  }
  if (row) {
    if (newQty === 0) db.run('DELETE FROM inventory WHERE id=?', row.id);
    else db.run('UPDATE inventory SET qty=?, updated_at=? WHERE id=?', newQty, clock.iso(), row.id);
  } else if (newQty > 0) {
    db.insert('inventory', { product_id: productId, location_id: locationId, batch_id: batchId || 0, status, qty: newQty, updated_at: clock.iso() });
  }
}

function genSerials(p, n, batchId) {
  const d = clock.now();
  const stamp = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const base = p.sku.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const out = [];
  for (let i = 0; i < n; i++) {
    db.run('INSERT INTO counters(key,val) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET val=val+1', `SN-${base}`);
    const k = db.val('SELECT val FROM counters WHERE key=?', `SN-${base}`);
    out.push(`${base}-${stamp}-${String(k).padStart(6, '0')}`);
  }
  return out;
}

/**
 * move: the ONLY function that changes stock.
 * o = { type, productId, qty, from?:{locationId,status,batchId}, to?:{locationId,status,batchId}, user, ref:{type,id}, reference, reason,
 *       serials?:[string], serialFilter?:{order_id|pallet_id}, serialPatch?:{order_id,pallet_id,shipment_id,receiving_id} }
 */
function move(o) {
  if (!TXN_TYPES.includes(o.type)) throw bad('Noma’lum tranzaksiya turi');
  const p = product(o.productId);
  const qty = V.qty(o.qty);
  if (p.track_serial && !Number.isInteger(qty)) throw bad('Serial raqamli mahsulot miqdori butun son bo‘lishi kerak');
  if (!o.from && !o.to) throw bad('Harakat yo‘nalishi ko‘rsatilmagan');
  const batchId = (o.from ? o.from.batchId : o.to.batchId) || 0;
  const toBatch = o.to ? (o.to.batchId ?? batchId) || 0 : 0;
  if (o.from) applyDelta(p.id, o.from.locationId, batchId, o.from.status, -qty);
  if (o.to) applyDelta(p.id, o.to.locationId, toBatch, o.to.status, qty);

  let serials = [];
  if (p.track_serial) {
    const now = clock.iso();
    const patch = o.serialPatch || {};
    const patchSql = Object.keys(patch).map((k) => `, ${k}=?`).join('');
    const patchVals = Object.values(patch);
    if (!o.from) {
      const given = (o.serials || []).map((s) => String(s).trim()).filter(Boolean);
      if (given.length && given.length !== qty) throw bad(`Serial raqamlar soni (${given.length}) miqdorga (${qty}) teng emas`);
      serials = given.length ? given : genSerials(p, qty, toBatch);
      for (const s of serials) {
        const ex = db.get('SELECT id, product_id, status FROM serial_numbers WHERE serial=?', s);
        if (ex) {
          if (ex.product_id !== p.id) throw bad(`Serial ${s} boshqa mahsulotga tegishli`);
          if (!['SHIPPED', 'ISSUED', 'ADJUSTED_OUT'].includes(ex.status)) throw bad(`Serial ${s} allaqachon omborda (${ex.status})`);
          db.run(`UPDATE serial_numbers SET status=?, location_id=?, batch_id=?, pallet_id=NULL, updated_at=?${patchSql} WHERE id=?`, SERIAL_STATUS[o.to.status], o.to.locationId, toBatch, now, ...patchVals, ex.id);
        } else {
          db.insert('serial_numbers', { serial: s, product_id: p.id, batch_id: toBatch, status: SERIAL_STATUS[o.to.status], location_id: o.to.locationId, created_at: now, updated_at: now, ...patch });
        }
      }
    } else {
      const st = SERIAL_STATUS[o.from.status];
      let rows;
      if (o.serials && o.serials.length) {
        if (o.serials.length !== qty) throw bad(`Serial raqamlar soni (${o.serials.length}) miqdorga (${qty}) teng emas`);
        rows = o.serials.map((s) => {
          const r = db.get('SELECT id, serial, product_id, location_id, status, batch_id FROM serial_numbers WHERE serial=?', String(s).trim());
          if (!r || r.product_id !== p.id) throw bad(`Serial ${s} ushbu mahsulotga tegishli emas`);
          if (r.location_id !== o.from.locationId || r.status !== st) throw bad(`Serial ${s} ko‘rsatilgan joyda/holatda emas`);
          if (batchId && r.batch_id !== batchId) throw bad(`Serial ${s} boshqa partiyaga tegishli`);
          return r;
        });
      } else {
        const f = o.serialFilter || {};
        const fSql = Object.keys(f).map((k) => ` AND ${k}${f[k] === null ? ' IS NULL' : '=?'}`).join('');
        rows = db.all(`SELECT id, serial FROM serial_numbers WHERE product_id=? AND location_id=? AND status=? AND batch_id=?${fSql} ORDER BY id LIMIT ?`,
          p.id, o.from.locationId, st, batchId, ...Object.values(f).filter((v) => v !== null), qty);
        if (rows.length < qty) throw bad(`Serial raqamlar qoldiq bilan mos emas (${p.sku}: ${rows.length}/${qty})`);
      }
      const nextStatus = o.to ? SERIAL_STATUS[o.to.status] : (OUT_STATUS[o.type] || 'OUT');
      for (const r of rows) db.run(`UPDATE serial_numbers SET status=?, location_id=?, batch_id=?, updated_at=?${patchSql} WHERE id=?`, nextStatus, o.to ? o.to.locationId : null, o.to ? toBatch : batchId, now, ...patchVals, r.id);
      serials = rows.map((r) => r.serial);
    }
  }

  const txnNo = db.nextNo('TX', 6);
  const id = db.insert('inventory_transactions', {
    txn_no: txnNo, type: o.type, product_id: p.id, qty, batch_id: batchId || toBatch || null,
    from_location_id: o.from ? o.from.locationId : null, to_location_id: o.to ? o.to.locationId : null,
    from_status: o.from ? o.from.status : null, to_status: o.to ? o.to.status : null, user_id: o.user ? o.user.id : null,
    created_at: clock.iso(), ref_type: o.ref ? o.ref.type : null, ref_id: o.ref ? o.ref.id : null,
    reference: o.reference || null, reason: o.reason || null, serials: serials.length ? JSON.stringify(serials.slice(0, 2000)) : null,
  });
  db.emit('STOCK_CHANGED', { productId: p.id, sku: p.sku, type: o.type, qty, txnNo });
  return { txnId: id, txnNo, serials };
}

// Record a reservation-type transaction (no physical movement).
function logReservation(type, productId, qty, user, ref, reason) {
  const txnNo = db.nextNo('TX', 6);
  db.insert('inventory_transactions', { txn_no: txnNo, type, product_id: productId, qty, user_id: user ? user.id : null, created_at: clock.iso(),
    ref_type: ref ? ref.type : null, ref_id: ref ? ref.id : null, reference: ref ? ref.no : null, reason: reason || null });
  db.emit('STOCK_CHANGED', { productId, type, qty, txnNo });
}

/** Take qty with given status from stock rows (FIFO by batch date), producing movement legs. */
function take({ productId, qty, status, locationId, batchId, serialFilter }) {
  const p = product(productId);
  let rows;
  if (p.track_serial && serialFilter) {
    const f = serialFilter; const fSql = Object.keys(f).map((k) => ` AND s.${k}=?`).join('');
    rows = db.all(`SELECT s.location_id, s.batch_id, COUNT(*) qty FROM serial_numbers s WHERE s.product_id=? AND s.status=?${fSql}
      ${locationId ? 'AND s.location_id=?' : ''} GROUP BY s.location_id, s.batch_id ORDER BY MIN(s.id)`,
    p.id, SERIAL_STATUS[status], ...Object.values(f), ...(locationId ? [locationId] : []));
  } else {
    rows = db.all(`SELECT i.location_id, i.batch_id, i.qty FROM inventory i LEFT JOIN product_batches b ON b.id=i.batch_id
      WHERE i.product_id=? AND i.status=? AND i.qty>0 ${locationId ? 'AND i.location_id=?' : ''} ${batchId != null ? 'AND i.batch_id=?' : ''}
      ORDER BY COALESCE(b.mfg_date, '9999'), i.batch_id, i.qty DESC`, p.id, status, ...(locationId ? [locationId] : []), ...(batchId != null ? [batchId] : []));
  }
  const legs = []; let left = qty;
  for (const r of rows) { if (left <= 0) break; const q = Math.min(r.qty, left); legs.push({ locationId: r.location_id, batchId: r.batch_id, qty: q }); left = round(left - q, 4); }
  if (left > 0) throw bad(`Omborda yetarli mahsulot mavjud emas. ${p.sku}: kerak ${qty}, mavjud ${round(qty - left, 4)} (${status})`);
  return legs;
}

// ---- Stock queries -----------------------------------------------------------
function reservedMap() {
  const m = {}; for (const r of db.all("SELECT product_id, SUM(qty - picked_qty) q FROM inventory_reservations WHERE status='ACTIVE' GROUP BY product_id")) m[r.product_id] = r.q; return m;
}
function stockSummary({ productId, category, q } = {}) {
  const where = ["p.status='ACTIVE'"]; const params = [];
  if (productId) { where.push('p.id=?'); params.push(productId); }
  if (category) { where.push('p.category=?'); params.push(category); }
  if (q) { where.push('(p.sku LIKE ? OR p.name LIKE ? OR p.model LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.all(`SELECT p.id product_id, p.sku, p.name, p.model, p.category, p.unit, p.min_stock, p.units_per_pallet, p.track_serial,
      COALESCE(SUM(CASE WHEN i.status<>'SCRAP' THEN i.qty END),0) on_hand,
      ${STOCK_STATUSES.map((s) => `COALESCE(SUM(CASE WHEN i.status='${s}' THEN i.qty END),0) ${s.toLowerCase()}`).join(',')}
    FROM products p LEFT JOIN inventory i ON i.product_id=p.id WHERE ${where.join(' AND ')} GROUP BY p.id ORDER BY p.category, p.sku`, ...params);
  const res = reservedMap();
  const inbound = {}; for (const r of db.all("SELECT product_id, SUM(qty - received_qty) q FROM purchase_requests WHERE status IN ('ORDERED','SUPPLIER_CONFIRMED','IN_TRANSIT') GROUP BY product_id")) inbound[r.product_id] = r.q;
  const requested = {}; for (const r of db.all("SELECT product_id, SUM(qty) q FROM purchase_requests WHERE status IN ('REQUESTED','APPROVED') GROUP BY product_id")) requested[r.product_id] = r.q;
  const short = {}; for (const r of db.all("SELECT product_id, SUM(shortage_qty) q FROM shortages WHERE status IN ('OPEN','REQUESTED') GROUP BY product_id")) short[r.product_id] = r.q;
  return rows.map((r) => {
    const reserved = round(res[r.product_id] || 0, 4);
    return { ...r, reserved, free: round(r.available - reserved, 4), inbound: inbound[r.product_id] || 0, requested: requested[r.product_id] || 0,
      shortage: short[r.product_id] || 0, low: r.min_stock > 0 && r.available - reserved <= r.min_stock };
  });
}
function productStock(productId) { return stockSummary({ productId })[0]; }
function freeQty(productId) { const s = productStock(productId); return s ? s.free : 0; }

function inventoryRows({ productId, warehouseId, zoneId, status, locationId, q } = {}) {
  const w = ['i.qty>0']; const p = [];
  if (productId) { w.push('i.product_id=?'); p.push(productId); }
  if (warehouseId) { w.push('l.warehouse_id=?'); p.push(warehouseId); }
  if (zoneId) { w.push('l.zone_id=?'); p.push(zoneId); }
  if (locationId) { w.push('l.id=?'); p.push(locationId); }
  if (status) { w.push('i.status=?'); p.push(status); }
  if (q) { w.push('(pr.sku LIKE ? OR pr.name LIKE ? OR l.code LIKE ? OR b.batch_no LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  return db.all(`SELECT i.id, i.product_id, pr.sku, pr.name, pr.unit, i.location_id, l.code location, l.warehouse_id, z.name zone, z.zone_type,
      i.batch_id, b.batch_no, i.status, i.qty, i.updated_at
    FROM inventory i JOIN products pr ON pr.id=i.product_id JOIN warehouse_locations l ON l.id=i.location_id JOIN warehouse_zones z ON z.id=l.zone_id
    LEFT JOIN product_batches b ON b.id=i.batch_id WHERE ${w.join(' AND ')} ORDER BY l.warehouse_id, l.code, pr.sku LIMIT 2000`, ...p);
}

// ---- Operations ----------------------------------------------------------------
function ensureBatch(p, batchNo, extra = {}) {
  if (batchNo) {
    const b = db.get('SELECT * FROM product_batches WHERE batch_no=?', batchNo);
    if (b) { if (b.product_id !== p.id) throw bad(`Partiya ${batchNo} boshqa mahsulotga tegishli`); return b.id; }
  }
  const no = batchNo || `B-${p.sku.replace(/[^A-Za-z0-9]/g, '')}-${clock.today().replace(/-/g, '').slice(2)}-${db.nextNo('BATCH', 3, false).split('-').pop()}`;
  return db.insert('product_batches', { batch_no: no, product_id: p.id, mfg_date: extra.mfg_date || clock.today(), source: extra.source, production_order: extra.production_order,
    supplier_id: extra.supplier_id, created_at: clock.iso() });
}

/** Kirim: goods arrive at the receiving dock with status RECEIVING (awaiting QC). */
function receive(input, user) {
  return db.tx(() => {
    const p = product(V.id(input.productId, 'Mahsulot'));
    const qty = V.qty(input.qty);
    const source = V.oneOf(input.source || 'SUPPLIER', 'Manba', ['SUPPLIER', 'PRODUCTION', 'RETURN', 'OTHER']);
    const supplierId = V.optId(input.supplierId, 'Supplier');
    if (source === 'SUPPLIER' && !supplierId) throw bad('Supplier tanlanishi shart');
    const qtyExpected = V.num(input.qtyExpected, 'Kutilgan miqdor', { required: false, min: 0 });
    const batchId = ensureBatch(p, V.str(input.batchNo, 'Partiya', { required: false, max: 60 }), { source, supplier_id: supplierId, production_order: input.productionOrder });
    const locationId = input.locationId ? location(V.id(input.locationId, 'Lokatsiya')).id : receivingLocation(p, source);
    if (input.documents && JSON.stringify(input.documents).length > 4000) throw bad('Fayllar faqat “Hujjatlar” orqali yuklanadi (virus tekshiruvi)');
    const rcvNo = db.nextNo('RCV');
    const rid = db.insert('receiving_orders', {
      rcv_no: rcvNo, source, supplier_id: supplierId, po_id: input.poId || null, delivery_id: input.deliveryId || null, purchase_request_id: input.prId || null,
      delivery_number: V.str(input.deliveryNumber, 'Yetkazish raqami', { required: false, max: 80 }), vehicle: V.str(input.vehicle, 'Transport', { required: false, max: 80 }),
      driver: V.str(input.driver, 'Haydovchi', { required: false, max: 120 }), received_date: input.date ? V.date(input.date, 'Sana') : clock.iso(),
      product_id: p.id, batch_id: batchId, qty_expected: qtyExpected, qty_received: qty, weight_kg: V.num(input.weightKg, 'Og‘irlik', { required: false, min: 0 }) ?? round(qty * (p.gross_weight_kg || p.net_weight_kg || 0), 2),
      production_order: input.productionOrder || null, production_total: input.productionTotal || null, rework_qty: input.reworkQty || 0, reject_qty: input.rejectQty || 0,
      location_id: locationId, status: 'RECEIVING', documents: input.documents ? JSON.stringify(input.documents) : null,
      deadline: clock.addDays(db.setting('qc_deadline_hours', 4) / 24), notes: V.str(input.notes, 'Izoh', { required: false, max: 1000 }), created_by: user?.id, created_at: clock.iso(), updated_at: clock.iso(),
    });
    const r = move({ type: source === 'RETURN' ? 'RETURN' : 'RECEIVE', productId: p.id, qty, to: { locationId, status: 'RECEIVING', batchId }, user,
      ref: { type: 'receiving', id: rid }, reference: rcvNo, reason: source === 'PRODUCTION' ? `Ishlab chiqarish: ${input.productionOrder || ''}` : null,
      serials: input.serials, serialPatch: { receiving_id: rid } });
    db.run('UPDATE product_batches SET qty=COALESCE(qty,0)+? WHERE id=?', qty, batchId);
    db.history('receiving', rid, null, 'RECEIVING', user);
    db.audit(user, 'RECEIVE', 'receiving_orders', rcvNo, { product: p.sku, qty, source });
    db.emit('MATERIAL_RECEIVED', { receivingId: rid, rcvNo, productId: p.id, sku: p.sku, qty, source });
    let check = null;
    if (qtyExpected != null) {
      const short = round(qtyExpected - qty, 4);
      check = { ordered: qtyExpected, received: qty, short: Math.max(0, short), over: Math.max(0, -short) };
      if (short > 0) require('./ai').raise({ key: `rcv-short-${rid}`, type: 'RECEIVING_SHORT', severity: 'WARNING', title: `Kirim kam keldi: ${rcvNo}`,
        message: `Buyurtma bo‘yicha ${short} ${p.unit} ${p.name} yetkazilmagan (buyurtma ${qtyExpected}, keldi ${qty}).`, ref_type: 'receiving', ref_id: rid });
    }
    return { id: rid, rcvNo, batchId, serials: r.serials.length, check };
  });
}

/** Production → warehouse: only GOOD goes to receiving; rework & reject are routed to their zones. */
function productionReceipt(input, user) {
  return db.tx(() => {
    const p = product(V.id(input.productId, 'Mahsulot'));
    const total = V.num(input.total, 'Jami ishlab chiqarildi', { int: !!p.track_serial, min: 1 });
    const good = V.num(input.good, 'Yaroqli (Good)', { int: !!p.track_serial, min: 0 });
    const rework = V.num(input.rework || 0, 'Rework', { int: !!p.track_serial, min: 0 });
    const reject = V.num(input.reject || 0, 'Reject', { int: !!p.track_serial, min: 0 });
    if (round(good + rework + reject, 4) !== round(total, 4)) throw bad(`Ma'lumot mos emas: Good ${good} + Rework ${rework} + Reject ${reject} = ${good + rework + reject}, lekin jami ${total}`);
    const po = V.str(input.productionOrder, 'Ishlab chiqarish buyurtmasi', { max: 60 });
    const batchNo = input.batchNo || null;
    let res = null; let batchId;
    if (good > 0) { res = receive({ ...input, source: 'PRODUCTION', qty: good, batchNo, productionOrder: po, productionTotal: total, reworkQty: rework, rejectQty: reject }, user); batchId = res.batchId; }
    else batchId = ensureBatch(p, batchNo, { source: 'PRODUCTION', production_order: po });
    const ref = { type: 'production', id: res ? res.id : null };
    if (rework > 0) move({ type: 'REWORK', productId: p.id, qty: rework, to: { locationId: zoneLocation('REWORK'), status: 'REWORK', batchId }, user, ref, reference: po, reason: 'Ishlab chiqarishdan rework' });
    if (reject > 0) move({ type: 'REJECT', productId: p.id, qty: reject, to: { locationId: zoneLocation('SCRAP'), status: 'SCRAP', batchId }, user, ref, reference: po, reason: 'Ishlab chiqarishdan brak' });
    db.audit(user, 'PRODUCTION_RECEIPT', 'products', p.sku, { po, total, good, rework, reject });
    return { receiving: res, good, rework, reject };
  });
}

/** QC decision for a receiving order. PASS → Available (putaway), FAIL → Brak (scrap) zone, REWORK → Rework zone. */
function qualityCheck(receivingId, input, user) {
  return db.tx(() => {
    const r = db.get('SELECT * FROM receiving_orders WHERE id=?', receivingId);
    if (!r) throw notFound('Kirim');
    if (r.status !== 'RECEIVING') throw bad(`Kirim allaqachon tekshirilgan (${r.status})`);
    const p = product(r.product_id);
    const passed = V.num(input.passed ?? 0, 'O‘tdi', { min: 0 });
    const failed = V.num(input.failed ?? 0, 'Yiqildi', { min: 0 });
    const rework = V.num(input.rework ?? 0, 'Rework', { min: 0 });
    if (round(passed + failed + rework, 4) !== round(r.qty_received, 4)) throw bad(`QC natijasi yig‘indisi (${passed + failed + rework}) qabul qilingan miqdorga (${r.qty_received}) teng bo‘lishi shart`);
    const from = { locationId: r.location_id, status: 'RECEIVING', batchId: r.batch_id };
    const ref = { type: 'receiving', id: r.id };
    const placements = [];
    if (passed > 0) {
      const plan = input.locationId ? [{ locationId: V.id(input.locationId, 'Lokatsiya'), qty: passed }] : putawayPlan(p, passed);
      for (const leg of plan) {
        move({ type: 'TRANSFER', productId: p.id, qty: leg.qty, from, to: { locationId: leg.locationId, status: 'AVAILABLE' }, user, ref, reference: r.rcv_no, reason: 'QC PASS → saqlash' });
        placements.push({ ...leg, code: leg.code || location(leg.locationId).code });
      }
    }
    if (failed > 0) move({ type: 'REJECT', productId: p.id, qty: failed, from, to: { locationId: zoneLocation('SCRAP'), status: 'SCRAP' }, user, ref, reference: r.rcv_no, reason: `QC FAIL: ${input.notes || ''}` });
    if (rework > 0) move({ type: 'REWORK', productId: p.id, qty: rework, from, to: { locationId: zoneLocation('REWORK'), status: 'REWORK' }, user, ref, reference: r.rcv_no, reason: 'QC → rework' });
    const result = failed === 0 && rework === 0 ? 'PASS' : passed === 0 ? 'FAIL' : 'PARTIAL';
    const status = result === 'PASS' ? 'APPROVED' : result === 'FAIL' ? 'REJECTED' : 'PARTIAL';
    const qcNo = db.nextNo('QC');
    db.insert('quality_checks', { qc_no: qcNo, receiving_id: r.id, product_id: p.id, batch_id: r.batch_id, qty: r.qty_received, passed_qty: passed, failed_qty: failed,
      rework_qty: rework, result, inspector_id: user?.id, notes: input.notes || null, created_at: clock.iso() });
    db.update('receiving_orders', r.id, { status, updated_at: clock.iso() });
    db.history('receiving', r.id, 'RECEIVING', status, user, `QC ${qcNo}`);
    db.audit(user, 'QC', 'receiving_orders', r.rcv_no, { passed, failed, rework, result });
    if (failed > 0) {
      db.emit('QC_FAILED', { receivingId: r.id, productId: p.id, sku: p.sku, failed });
      require('./ai').raise({ key: `qc-fail-${r.id}`, type: 'QC_FAILED', severity: 'WARNING', title: `QC: ${failed} ${p.unit} brakka chiqarildi`,
        message: `${r.rcv_no} bo‘yicha ${p.name}: ${failed} ${p.unit} sifat tekshiruvidan o‘tmadi va brak zonasiga o‘tkazildi.`, ref_type: 'receiving', ref_id: r.id });
    }
    if (r.purchase_request_id) require('./procurement').onQcDone(r, { passed, failed, rework }, user);
    if (passed > 0) require('./orders').allocateProduct(p.id, user);
    return { qcNo, result, status, placements };
  });
}

/** Chiqim: issue free (unreserved) stock out of the warehouse (e.g. to production). */
function issue(input, user) {
  return db.tx(() => {
    const p = product(V.id(input.productId, 'Mahsulot'));
    const qty = V.qty(input.qty);
    const reason = V.str(input.reason, 'Sabab', { max: 300 });
    const free = freeQty(p.id);
    if (qty > free) throw bad(`Omborda yetarli mahsulot mavjud emas. Erkin qoldiq: ${free} ${p.unit}, so‘ralgan: ${qty} ${p.unit}`);
    const legs = take({ productId: p.id, qty, status: 'AVAILABLE', locationId: input.locationId || null });
    const ref = { type: 'issue', id: null }; const reference = V.str(input.reference, 'Hujjat raqami', { required: false, max: 80 }) || db.nextNo('ISS');
    const out = legs.map((l) => move({ type: 'ISSUE', productId: p.id, qty: l.qty, from: { locationId: l.locationId, status: 'AVAILABLE', batchId: l.batchId }, user, ref, reference, reason, serials: input.serials }));
    db.audit(user, 'ISSUE', 'products', p.sku, { qty, reason, reference });
    return { reference, legs: legs.length, txns: out.map((o) => o.txnNo) };
  });
}

function transfer(input, user) {
  return db.tx(() => {
    const p = product(V.id(input.productId, 'Mahsulot'));
    const qty = V.qty(input.qty);
    const from = location(V.id(input.fromLocationId, 'Qayerdan'));
    const to = location(V.id(input.toLocationId, 'Qayerga'));
    if (from.id === to.id) throw bad('Bir xil lokatsiyaga ko‘chirib bo‘lmaydi');
    const status = V.oneOf(input.status || 'AVAILABLE', 'Holat', ['AVAILABLE', 'REWORK', 'SCRAP', 'PACKED']);
    const legs = take({ productId: p.id, qty, status, locationId: from.id, batchId: input.batchId ?? null });
    const reference = db.nextNo('TRF');
    for (const l of legs) move({ type: 'TRANSFER', productId: p.id, qty: l.qty, from: { locationId: from.id, status, batchId: l.batchId }, to: { locationId: to.id, status }, user, ref: { type: 'transfer' }, reference, reason: input.reason || `${from.code} → ${to.code}`, serials: input.serials });
    db.audit(user, 'TRANSFER', 'products', p.sku, { qty, from: from.code, to: to.code });
    return { reference };
  });
}

/** Rework / scrap handling (Brak moduli). */
function disposition(input, user) {
  return db.tx(() => {
    const p = product(V.id(input.productId, 'Mahsulot'));
    const qty = V.qty(input.qty);
    const fromStatus = V.oneOf(input.fromStatus, 'Holat', ['REWORK', 'SCRAP', 'AVAILABLE']);
    const action = V.oneOf(input.action, 'Amal', ['SCRAP', 'REWORK', 'REQC', 'DISPOSE']);
    const reason = V.str(input.reason, 'Sabab', { max: 300 });
    if (fromStatus === 'AVAILABLE' && qty > freeQty(p.id)) throw bad('Rezervdagi mahsulotni brakka o‘tkazib bo‘lmaydi — avval rezervni bo‘shating');
    const legs = take({ productId: p.id, qty, status: fromStatus, locationId: input.locationId || null });
    const reference = db.nextNo('DSP');
    let rcv = null;
    for (const l of legs) {
      const from = { locationId: l.locationId, status: fromStatus, batchId: l.batchId };
      if (action === 'SCRAP') move({ type: 'SCRAP', productId: p.id, qty: l.qty, from, to: { locationId: zoneLocation('SCRAP'), status: 'SCRAP' }, user, reference, reason });
      else if (action === 'REWORK') move({ type: 'REWORK', productId: p.id, qty: l.qty, from, to: { locationId: zoneLocation('REWORK'), status: 'REWORK' }, user, reference, reason });
      else if (action === 'DISPOSE') { if (fromStatus !== 'SCRAP') throw bad('Faqat brak zonasidagi mahsulot hisobdan chiqariladi'); move({ type: 'SCRAP', productId: p.id, qty: l.qty, from, user, reference, reason: `Hisobdan chiqarish: ${reason}` }); }
      else {
        const rid = db.insert('receiving_orders', { rcv_no: db.nextNo('RCV'), source: 'REWORK', product_id: p.id, batch_id: l.batchId, qty_received: l.qty,
          location_id: zoneLocation('QC', 'WH-03'), status: 'RECEIVING', deadline: clock.addDays(1 / 6), notes: reason, created_by: user?.id, created_at: clock.iso(), updated_at: clock.iso() });
        move({ type: 'TRANSFER', productId: p.id, qty: l.qty, from, to: { locationId: zoneLocation('QC', 'WH-03'), status: 'RECEIVING' }, user, ref: { type: 'receiving', id: rid }, reference, reason: 'Qayta QC' });
        rcv = rid;
      }
    }
    db.audit(user, `DISPOSITION_${action}`, 'products', p.sku, { qty, fromStatus, reason });
    return { reference, receivingId: rcv };
  });
}

// ---- Reservations ----------------------------------------------------------------
function reserve(input, user) {
  return db.tx(() => {
    const p = product(V.id(input.productId, 'Mahsulot'));
    const qty = V.qty(input.qty);
    const free = freeQty(p.id);
    if (qty > free) throw bad(`Rezerv uchun yetarli erkin qoldiq yo‘q. Erkin: ${free} ${p.unit}, so‘ralgan: ${qty}`, { free, required: qty, shortage: round(qty - free, 4) });
    const resNo = db.nextNo('RES');
    const id = db.insert('inventory_reservations', { res_no: resNo, product_id: p.id, order_id: input.orderId || null, order_item_id: input.orderItemId || null,
      project_id: input.projectId || null, qty, status: 'ACTIVE', note: input.note || null, created_by: user?.id, created_at: clock.iso(), updated_at: clock.iso() });
    logReservation('RESERVE', p.id, qty, user, { type: 'reservation', id, no: resNo }, input.note);
    db.audit(user, 'RESERVE', 'inventory_reservations', resNo, { product: p.sku, qty, orderId: input.orderId, projectId: input.projectId });
    db.emit('ORDER_RESERVED', { reservationId: id, productId: p.id, qty, orderId: input.orderId || null, projectId: input.projectId || null });
    return { id, resNo, stock: productStock(p.id) };
  });
}
function release(resId, input, user) {
  return db.tx(() => {
    const r = db.get('SELECT * FROM inventory_reservations WHERE id=?', resId);
    if (!r) throw notFound('Rezerv');
    if (r.status !== 'ACTIVE') throw bad('Rezerv faol emas');
    const remaining = round(r.qty - r.picked_qty, 4);
    const qty = input.qty ? V.qty(input.qty) : remaining;
    if (qty > remaining) throw bad(`Bo‘shatish miqdori rezerv qoldig‘idan (${remaining}) katta`);
    const newQty = round(r.qty - qty, 4);
    db.update('inventory_reservations', r.id, { qty: newQty, status: newQty <= r.picked_qty ? (r.picked_qty > 0 ? 'CONSUMED' : 'RELEASED') : 'ACTIVE', updated_at: clock.iso() });
    logReservation('RELEASE', r.product_id, qty, user, { type: 'reservation', id: r.id, no: r.res_no }, input.reason || 'Rezerv bo‘shatildi');
    db.audit(user, 'RELEASE', 'inventory_reservations', r.res_no, { qty, reason: input.reason });
    if (r.order_item_id && !input.silent) require('./orders').refreshItem(r.order_item_id, user);
    if (!input.noAllocate) require('./orders').allocateProduct(r.product_id, user);
    return { released: qty };
  });
}

// ---- Inventory count (inventarizatsiya) ---------------------------------------
function createCount(input, user) {
  return db.tx(() => {
    const wh = V.str(input.warehouseId, 'Ombor');
    const zone = input.zoneId || null;
    const rows = db.all(`SELECT i.* FROM inventory i JOIN warehouse_locations l ON l.id=i.location_id WHERE l.warehouse_id=? ${zone ? 'AND l.zone_id=?' : ''}
      AND i.status IN ('AVAILABLE','REWORK','SCRAP') AND i.qty>0`, wh, ...(zone ? [zone] : []));
    if (!rows.length) throw bad('Tanlangan zonada hisoblanadigan qoldiq yo‘q');
    const no = db.nextNo('CNT');
    const id = db.insert('inventory_counts', { count_no: no, warehouse_id: wh, zone_id: zone, status: 'OPEN', created_by: user?.id, created_at: clock.iso() });
    for (const r of rows) db.insert('inventory_count_lines', { count_id: id, product_id: r.product_id, location_id: r.location_id, batch_id: r.batch_id, status: r.status, system_qty: r.qty });
    db.audit(user, 'COUNT_CREATE', 'inventory_counts', no, { lines: rows.length });
    return { id, countNo: no, lines: rows.length };
  });
}
function recordCount(countId, lines, user) {
  return db.tx(() => {
    const c = db.get('SELECT * FROM inventory_counts WHERE id=?', countId);
    if (!c || c.status !== 'OPEN') throw bad('Inventarizatsiya ochiq emas');
    for (const l of V.arr(lines, 'Qatorlar')) {
      const q = V.num(l.physicalQty, 'Fizik miqdor', { min: 0 });
      db.run('UPDATE inventory_count_lines SET physical_qty=?, counted_by=? WHERE id=? AND count_id=?', q, user?.id, l.id, countId);
    }
    return { ok: true };
  });
}
function postCount(countId, input, user) {
  return db.tx(() => {
    const c = db.get('SELECT * FROM inventory_counts WHERE id=?', countId);
    if (!c || c.status !== 'OPEN') throw bad('Inventarizatsiya ochiq emas');
    const lines = db.all('SELECT * FROM inventory_count_lines WHERE count_id=?', countId);
    if (lines.some((l) => l.physical_qty == null)) throw bad('Barcha qatorlar uchun fizik miqdor kiritilishi shart');
    const diffs = lines.filter((l) => round(l.physical_qty - l.system_qty, 4) !== 0);
    const reason = diffs.length ? V.str(input.reason, 'Farq sababi', { min: 3, max: 500 }) : (input.reason || 'Farq yo‘q');
    for (const l of diffs) {
      // re-check live stock so we adjust relative to the actual current value
      const cur = db.val('SELECT qty FROM inventory WHERE product_id=? AND location_id=? AND batch_id=? AND status=?', l.product_id, l.location_id, l.batch_id, l.status) || 0;
      const d = round(l.physical_qty - cur, 4);
      if (d === 0) continue;
      const leg = { locationId: l.location_id, status: l.status, batchId: l.batch_id };
      move({ type: 'ADJUSTMENT', productId: l.product_id, qty: Math.abs(d), ...(d > 0 ? { to: leg } : { from: leg }), user, ref: { type: 'count', id: c.id }, reference: c.count_no, reason });
    }
    db.update('inventory_counts', c.id, { status: 'POSTED', posted_by: user?.id, posted_at: clock.iso(), reason });
    db.audit(user, 'COUNT_POST', 'inventory_counts', c.count_no, { adjustments: diffs.length, reason });
    if (diffs.length) for (const pid of new Set(diffs.map((d) => d.product_id))) require('./orders').allocateProduct(pid, user);
    return { adjustments: diffs.length, accuracy: lines.length ? round(((lines.length - diffs.length) / lines.length) * 100, 1) : 100 };
  });
}

module.exports = {
  SERIAL_STATUS, TXN_TYPES, STOCK_STATUSES, product, location, zoneLocation, receivingLocation, packingLocation, putawayPlan, locationPalletUse,
  move, take, logReservation, stockSummary, productStock, freeQty, inventoryRows, ensureBatch,
  receive, productionReceipt, qualityCheck, issue, transfer, disposition, reserve, release, createCount, recordCount, postCount,
};
