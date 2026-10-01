'use strict';
// Logistika: load calculation, vehicle fit, shipments, loading plan/sequence, dispatch, arrival, root cause.
const db = require('./db');
const inv = require('./inventory');
const orders = require('./orders');
const { clock, bad, notFound, V, round } = require('./core');

const VEHICLE_STATUSES = ['AVAILABLE', 'RESERVED', 'LOADING', 'IN_TRANSIT', 'MAINTENANCE', 'UNAVAILABLE'];

function fit(v, L, W, H, maxStack) {
  const vL = v.length_m * 1000; const vW = v.width_m * 1000; const vH = v.height_m * 1000;
  if (H > vH) return { positions: 0, stack: 0, capacity: 0, across: 0, rowLen: L, orientation: '-' };
  const stack = Math.max(1, Math.min(maxStack || 1, Math.floor(vH / H)));
  const a = { across: Math.floor(vW / W), rows: Math.floor(vL / L), rowLen: L, orientation: 'uzunasiga' };
  const b = { across: Math.floor(vW / L), rows: Math.floor(vL / W), rowLen: W, orientation: 'ko‘ndalang' };
  const best = a.across * a.rows >= b.across * b.rows ? a : b;
  const positions = best.across * best.rows;
  return { positions, stack, capacity: positions * stack, across: best.across, rowLen: best.rowLen, orientation: best.orientation };
}

/** Gather real pallets (or planned pallets for unpacked qty) for a load. */
function loadUnits(input) {
  const units = [];
  if (input.palletIds && input.palletIds.length) {
    for (const id of input.palletIds) { const p = db.get('SELECT * FROM pallets WHERE id=?', id); if (!p) throw notFound(`Pallet ${id}`); units.push({ ...p, planned: false }); }
  } else if (input.orderId) {
    const o = db.get('SELECT * FROM orders WHERE id=?', input.orderId); if (!o) throw notFound('Buyurtma');
    units.push(...db.all("SELECT * FROM pallets WHERE order_id=? AND status IN ('PACKED','LOADED') AND (shipment_id IS NULL OR shipment_id=?)", o.id, input.shipmentId || 0).map((p) => ({ ...p, planned: false })));
    // not-yet-palletized remainder is planned with the product's standard pallet
    for (const it of db.all('SELECT * FROM order_items WHERE order_id=? AND packed_qty<qty', o.id)) addPlanned(units, it.product_id, round(it.qty - it.packed_qty, 4));
  } else if (input.items && input.items.length) {
    for (const it of input.items) addPlanned(units, V.id(it.productId, 'Mahsulot'), V.qty(it.qty));
  } else throw bad('Yuk tanlanmagan: buyurtma, pallet yoki mahsulot kiriting');
  return units;
}
function addPlanned(units, productId, qty) {
  if (!(qty > 0)) return;
  const p = inv.product(productId); const per = Math.max(1, p.units_per_pallet || 1);
  for (let left = qty; left > 0; left = round(left - per, 4)) {
    const q = Math.min(per, left);
    units.push({ id: null, pallet_no: '(reja)', product_id: p.id, qty: q, ...orders.palletMetrics(p, q), stackable: (p.max_stack || 1) > 1 ? 1 : 0, fragile: p.fragile, planned: true });
  }
}

function evaluate(v, units) {
  const totals = summarize(units);
  const L = Math.max(...units.map((u) => u.length_mm)); const W = Math.max(...units.map((u) => u.width_mm)); const H = Math.max(...units.map((u) => u.height_mm));
  const maxStack = units.every((u) => u.stackable) ? Math.min(...units.map((u) => inv.product(u.product_id).max_stack || 1)) : 1;
  const f = fit(v, L, W, H, maxStack);
  const stackable = units.filter((u) => u.stackable && !u.fragile).length; const floorOnly = units.length - stackable;
  const floorNeeded = Math.ceil(stackable / Math.max(1, f.stack)) + floorOnly;
  const palletOk = f.positions > 0 && floorNeeded <= f.positions;
  const checks = {
    weight: { ok: totals.grossWeight <= v.payload_kg, need: totals.grossWeight, cap: v.payload_kg, util: round((totals.grossWeight / v.payload_kg) * 100, 1) },
    volume: { ok: totals.volume <= v.volume_m3, need: totals.volume, cap: v.volume_m3, util: round((totals.volume / v.volume_m3) * 100, 1) },
    pallets: { ok: palletOk, need: totals.palletCount, cap: f.capacity, floorNeeded, floorCap: f.positions, util: f.capacity ? round((totals.palletCount / f.capacity) * 100, 1) : null },
    height: { ok: H <= v.height_m * 1000, need: H, cap: v.height_m * 1000 },
  };
  const fits = Object.values(checks).every((c) => c.ok);
  const ldm = f.across ? round((Math.ceil(floorNeeded / f.across) * f.rowLen) / 1000, 2) : null;
  const reasons = [];
  if (!checks.weight.ok) reasons.push(`og‘irlik ${round(totals.grossWeight)} kg > ${v.payload_kg} kg`);
  if (!checks.volume.ok) reasons.push(`hajm ${totals.volume} m³ > ${v.volume_m3} m³`);
  if (!checks.height.ok) reasons.push(`pallet balandligi ${H} mm > ${v.height_m * 1000} mm`);
  if (!checks.pallets.ok) reasons.push(`pallet joyi yetmaydi (${floorNeeded} pol joyi kerak, sig‘im ${f.positions})`);
  return { vehicleId: v.id, code: v.code, type: v.type, model: v.model, plate: v.plate, status: v.status, payload_kg: v.payload_kg, volume_m3: v.volume_m3,
    dims: `${v.length_m}×${v.width_m}×${v.height_m} m`, eurPallets: v.pallet_capacity, fitCapacity: f.capacity, stack: f.stack, orientation: f.orientation, ldm, fits, checks, reasons,
    score: fits ? round((checks.weight.util + checks.volume.util + (checks.pallets.util || 0)) / 3, 1) : 0 };
}
function summarize(units) {
  return { qty: round(units.reduce((a, u) => a + u.qty, 0), 4), netWeight: round(units.reduce((a, u) => a + (u.net_weight_kg || 0), 0), 1),
    grossWeight: round(units.reduce((a, u) => a + (u.gross_weight_kg || 0), 0), 1), volume: round(units.reduce((a, u) => a + (u.volume_m3 || 0), 0), 2),
    palletCount: units.length, plannedPallets: units.filter((u) => u.planned).length };
}

/** Transport calculation for a load: totals + every vehicle checked against weight/volume/pallet/height limits. */
function calculate(input) {
  const units = loadUnits(input);
  if (!units.length) throw bad('Hisoblash uchun yuk yo‘q');
  const totals = summarize(units);
  const vehicles = db.all('SELECT * FROM vehicles ORDER BY payload_kg');
  const evals = vehicles.map((v) => evaluate(v, units));
  const fitting = evals.filter((e) => e.fits);
  const recommended = fitting.filter((e) => e.status === 'AVAILABLE').sort((a, b) => a.payload_kg - b.payload_kg || b.score - a.score)[0] || null;
  let split = null;
  if (!fitting.length && vehicles.length) {
    const big = evals.slice().sort((a, b) => b.payload_kg - a.payload_kg)[0];
    const n = Math.max(Math.ceil(totals.grossWeight / big.payload_kg), Math.ceil(totals.volume / big.volume_m3), big.fitCapacity ? Math.ceil(totals.palletCount / big.fitCapacity) : 1);
    split = { vehicle: big.code, type: big.type, count: n, text: `Yuk bitta transportga sig‘maydi: kamida ${n} ta ${big.type} (${big.code}) kerak.` };
  }
  const p0 = units[0];
  const est = estimateLoading(totals.palletCount);
  const text = [`Ushbu yuk uchun taxminiy talab: og‘irlik ${totals.grossWeight} kg, hajm ${totals.volume} m³, pallet ${totals.palletCount} ta${recommended?.ldm ? `, yuklash uzunligi ~${recommended.ldm} m (LDM)` : ''}.`,
    recommended ? `Mos transport: ${recommended.type} ${recommended.model || ''} (${recommended.code}) — og‘irlik ${recommended.checks.weight.util}%, hajm ${recommended.checks.volume.util}%, pallet ${recommended.checks.pallets.util}% band.` : (split ? split.text : 'Hozir bo‘sh mos transport yo‘q.'),
    `Yuklash uchun taxminan ${est.minutes} daqiqa kerak (${est.basis}).`].join(' ');
  return { totals, palletDims: { length_mm: p0.length_mm, width_mm: p0.width_mm, height_mm: Math.max(...units.map((u) => u.height_mm)) }, units: units.map((u) => ({ id: u.id, pallet_no: u.pallet_no, qty: u.qty, gross_weight_kg: u.gross_weight_kg, volume_m3: u.volume_m3, planned: u.planned })),
    vehicles: evals, recommended, split, loadingEstimate: est, aiText: text };
}

function estimateLoading(palletCount) {
  const hist = db.all("SELECT actual_minutes, (SELECT pallet_count FROM shipments s WHERE s.id=t.shipment_id) pc FROM loading_tasks t WHERE status='COMPLETED' AND actual_minutes>0 ORDER BY id DESC LIMIT 30").filter((h) => h.pc > 0);
  const setup = db.setting('loading_setup_min', 15);
  if (hist.length >= 3) {
    const perPallet = hist.reduce((a, h) => a + Math.max(0, h.actual_minutes - setup) / h.pc, 0) / hist.length;
    return { minutes: Math.round(setup + perPallet * palletCount), perPallet: round(perPallet, 1), basis: `oxirgi ${hist.length} ta yuklash tarixi asosida` };
  }
  const per = db.setting('loading_min_per_pallet', 4);
  return { minutes: Math.round(setup + per * palletCount), perPallet: per, basis: 'me’yoriy ko‘rsatkich asosida' };
}

/** Heavy at bottom/front, fragile protected & not stacked, flags wrong combinations. */
function loadingPlan(pallets, v) {
  const L = Math.max(...pallets.map((u) => u.length_mm)); const W = Math.max(...pallets.map((u) => u.width_mm)); const H = Math.max(...pallets.map((u) => u.height_mm));
  const stackOk = pallets.filter((p) => p.stackable && !p.fragile).sort((a, b) => b.gross_weight_kg - a.gross_weight_kg);
  const floorOnly = pallets.filter((p) => !(p.stackable && !p.fragile)).sort((a, b) => b.gross_weight_kg - a.gross_weight_kg);
  const maxStack = stackOk.length ? Math.min(...stackOk.map((p) => inv.product(p.product_id).max_stack || 1)) : 1;
  const f = fit(v, L, W, H, maxStack);
  const nStacks = Math.ceil(stackOk.length / Math.max(1, f.stack));
  const bottoms = stackOk.slice(0, nStacks); const tops = stackOk.slice(nStacks);
  const seq = []; let pos = 0;
  const posName = (i) => { const row = Math.floor(i / Math.max(1, f.across)) + 1; const side = f.across > 1 ? (i % f.across === 0 ? 'chap' : i % f.across === f.across - 1 ? 'o‘ng' : 'o‘rta') : 'markaz'; return `Qator ${row} / ${side}`; };
  bottoms.forEach((p, i) => { seq.push({ palletId: p.id, palletNo: p.pallet_no, weight: p.gross_weight_kg, position: `${posName(pos)} / pastki`, layer: 1, slot: pos }); if (tops[i]) seq.push({ palletId: tops[i].id, palletNo: tops[i].pallet_no, weight: tops[i].gross_weight_kg, position: `${posName(pos)} / ustki`, layer: 2, slot: pos }); pos++; });
  floorOnly.forEach((p) => { seq.push({ palletId: p.id, palletNo: p.pallet_no, weight: p.gross_weight_kg, position: `${posName(pos)} / pastki${p.fragile ? ' (himoyalangan, eshik tomonda)' : ''}`, layer: 1, slot: pos, fragile: !!p.fragile }); pos++; });
  seq.forEach((s, i) => { s.seq = i + 1; });
  return { sequence: seq, warnings: validateSequence(seq, pallets, v), fit: f };
}
function validateSequence(seq, pallets, v) {
  const byId = Object.fromEntries(pallets.map((p) => [p.id, p]));
  const w = [];
  const slots = {};
  for (const s of seq) (slots[s.slot] ||= []).push(s);
  for (const [slot, list] of Object.entries(slots)) {
    const sorted = list.sort((a, b) => a.layer - b.layer);
    for (let i = 1; i < sorted.length; i++) {
      const top = byId[sorted[i].palletId]; const bottom = byId[sorted[i - 1].palletId];
      if (top.gross_weight_kg > bottom.gross_weight_kg) w.push(`❗ ${top.pallet_no} (${top.gross_weight_kg} kg) ${bottom.pallet_no} (${bottom.gross_weight_kg} kg) ustiga qo‘yilgan — og‘ir yuk pastda bo‘lishi kerak`);
      if (!bottom.stackable || bottom.fragile) w.push(`❗ ${bottom.pallet_no} ustiga yuk qo‘yib bo‘lmaydi (nozik/stack taqiqlangan)`);
      if (top.fragile) w.push(`❗ Nozik ${top.pallet_no} yuqori qatlamda — himoyalangan joyga qo‘ying`);
      if (i + 1 > (inv.product(bottom.product_id).max_stack || 1)) w.push(`❗ Slot ${Number(slot) + 1}: stack balandligi ruxsat etilgandan oshgan`);
    }
  }
  const total = pallets.reduce((a, p) => a + p.gross_weight_kg, 0);
  if (v && total > v.payload_kg * 0.9 && total <= v.payload_kg) w.push(`⚠️ Og‘irlik yuk ko‘tarish qobiliyatining ${round((total / v.payload_kg) * 100, 1)}% ini tashkil qiladi — o‘qlar bo‘yicha taqsimotni tekshiring`);
  const stds = new Set(pallets.map((p) => inv.product(p.product_id)).filter((p) => p.orientation).map((p) => `${p.sku}: ${p.orientation === 'VERTICAL' ? 'vertikal' : 'gorizontal'} joylashuv — ${p.packing_standard || 'korxona qadoqlash standarti'}`));
  for (const s of stds) w.push(`ℹ️ ${s}`);
  return w;
}

function createShipment(input, user) {
  return db.tx(() => {
    const orderId = V.id(input.orderId, 'Buyurtma');
    const o = db.get('SELECT * FROM orders WHERE id=?', orderId); if (!o) throw notFound('Buyurtma');
    const v = db.get('SELECT * FROM vehicles WHERE id=?', V.id(input.vehicleId, 'Transport')); if (!v) throw notFound('Transport');
    if (v.status !== 'AVAILABLE') throw bad(`Transport ${v.code} band: ${v.status}`);
    const palletIds = input.palletIds && input.palletIds.length ? input.palletIds.map(Number)
      : db.all("SELECT id FROM pallets WHERE order_id=? AND status='PACKED' AND shipment_id IS NULL", orderId).map((p) => p.id);
    if (!palletIds.length) throw bad('Jo‘natish uchun tayyor (PACKED) pallet yo‘q');
    const pallets = palletIds.map((id) => { const p = db.get('SELECT * FROM pallets WHERE id=?', id); if (!p || p.status !== 'PACKED' || p.shipment_id) throw bad(`Pallet ${p ? p.pallet_no : id} jo‘natishga tayyor emas`); if (p.order_id !== orderId) throw bad(`Pallet ${p.pallet_no} boshqa buyurtmaga tegishli`); return p; });
    const e = evaluate(v, pallets);
    if (!e.fits) throw bad(`Transport sig‘imi yetarli emas: ${e.reasons.join('; ')}`, e);
    const driverId = V.optId(input.driverId, 'Haydovchi') || v.driver_id;
    if (!driverId) throw bad('Haydovchi biriktirilmagan');
    const drv = db.get('SELECT * FROM drivers WHERE id=?', driverId); if (!drv) throw notFound('Haydovchi');
    if (drv.status !== 'AVAILABLE') throw bad(`Haydovchi ${drv.full_name} band (${drv.status})`);
    const t = summarize(pallets);
    const no = db.nextNo('SHIP');
    const planned = input.plannedDeparture ? V.date(input.plannedDeparture, 'Rejalashtirilgan jo‘nash') : clock.addDays(4 / 24);
    const sid = db.insert('shipments', { ship_no: no, order_id: orderId, project_id: o.project_id, vehicle_id: v.id, driver_id: driverId, status: 'PLANNED',
      destination: V.str(input.destination || o.destination, 'Manzil', { max: 300 }), distance_km: V.num(input.distanceKm, 'Masofa', { required: false, min: 0 }), planned_departure: planned,
      total_weight_kg: t.grossWeight, total_volume_m3: t.volume, pallet_count: t.palletCount, total_qty: t.qty, created_by: user?.id, created_at: clock.iso(), updated_at: clock.iso() });
    const plan = loadingPlan(pallets, v);
    for (const s of plan.sequence) {
      const p = pallets.find((x) => x.id === s.palletId);
      db.insert('shipment_items', { shipment_id: sid, pallet_id: p.id, product_id: p.product_id, qty: p.qty, load_seq: s.seq, load_position: s.position });
      db.update('pallets', p.id, { shipment_id: sid, updated_at: clock.iso() });
    }
    db.update('vehicles', v.id, { status: 'RESERVED' });
    db.update('drivers', driverId, { status: 'ASSIGNED' });
    db.insert('transport_assignments', { shipment_id: sid, vehicle_id: v.id, driver_id: driverId, weight_util: e.checks.weight.util, volume_util: e.checks.volume.util, pallet_util: e.checks.pallets.util, assigned_by: user?.id, assigned_at: clock.iso() });
    const est = estimateLoading(t.palletCount);
    const worker = input.assignedTo ? db.get('SELECT id, full_name FROM users WHERE id=?', input.assignedTo) : orders.suggestWorker();
    const ltNo = db.nextNo('LOAD');
    const ltId = db.insert('loading_tasks', { task_no: ltNo, shipment_id: sid, vehicle_id: v.id, status: 'PENDING', assigned_to: worker?.id, loading_location_id: input.loadingLocationId || inv.zoneLocation('DISPATCH'),
      sequence: JSON.stringify(plan.sequence), warnings: JSON.stringify(plan.warnings), planned_start: new Date(new Date(planned).getTime() - (est.minutes + 15) * 60000).toISOString(),
      deadline: planned, estimated_minutes: est.minutes, created_at: clock.iso() });
    db.history('shipment', sid, null, 'PLANNED', user);
    db.audit(user, 'SHIPMENT_CREATE', 'shipments', no, { order: o.order_no, vehicle: v.code, driver: drv.full_name, pallets: t.palletCount, weight: t.grossWeight });
    db.audit(user, 'TRANSPORT_ASSIGN', 'vehicles', v.code, { shipment: no });
    db.emit('SHIPMENT_CREATED', { shipmentId: sid, shipNo: no, orderId });
    db.emit('TASK_CREATED', { kind: 'loading', taskId: ltId, taskNo: ltNo, assignedTo: worker?.id });
    return { id: sid, shipNo: no, loadingTask: { id: ltId, taskNo: ltNo, estimatedMinutes: est.minutes, assignedTo: worker }, totals: t, utilization: e.checks, sequence: plan.sequence, warnings: plan.warnings };
  });
}

const shipmentOf = (id) => { const s = db.get('SELECT * FROM shipments WHERE id=?', id); if (!s) throw notFound('Jo‘natma'); return s; };
function setShipment(s, to, user, extra = {}, note) {
  db.update('shipments', s.id, { status: to, updated_at: clock.iso(), ...extra });
  db.history('shipment', s.id, s.status, to, user, note);
}

function startLoading(taskId, user) {
  return db.tx(() => {
    const t = db.get('SELECT * FROM loading_tasks WHERE id=?', taskId); if (!t) throw notFound('Yuklash topshirig‘i');
    if (t.status !== 'PENDING') throw bad(`Topshiriq holati: ${t.status}`);
    const s = shipmentOf(t.shipment_id);
    const notReady = db.val(`SELECT COUNT(*) FROM pallets p JOIN warehouse_locations l ON l.id=p.location_id JOIN warehouse_zones z ON z.id=l.zone_id WHERE p.shipment_id=? AND z.zone_type<>'DISPATCH'`, s.id);
    const concurrent = db.val("SELECT COUNT(*) FROM loading_tasks WHERE status='IN_PROGRESS' AND id<>?", t.id);
    db.update('loading_tasks', t.id, { status: 'IN_PROGRESS', started_at: clock.iso(), assigned_to: t.assigned_to || user?.id, delay_reason: JSON.stringify({ notReadyPallets: notReady, concurrentLoadings: concurrent, lateStartMin: t.planned_start ? Math.max(0, Math.round((clock.now() - new Date(t.planned_start)) / 60000)) : 0 }) });
    setShipment(s, 'LOADING', user, { loading_start: clock.iso() });
    db.update('vehicles', s.vehicle_id, { status: 'LOADING' });
    db.history('loading', t.id, 'PENDING', 'IN_PROGRESS', user);
    db.audit(user, 'LOADING_START', 'shipments', s.ship_no);
    db.emit('LOADING_STARTED', { shipmentId: s.id, shipNo: s.ship_no, taskId: t.id });
    orders.recomputeOrderStatus(s.order_id);
    return { status: 'IN_PROGRESS', warnings: notReady ? [`${notReady} ta pallet hali jo‘natish zonasida emas`] : [] };
  });
}

function loadPallet(taskId, input, user) {
  return db.tx(() => {
    const t = db.get('SELECT * FROM loading_tasks WHERE id=?', taskId); if (!t) throw notFound('Yuklash topshirig‘i');
    if (t.status !== 'IN_PROGRESS') throw bad('Avval yuklashni boshlang');
    const code = V.str(input.code, 'Pallet kodi', { max: 80 });
    const pl = db.get('SELECT * FROM pallets WHERE pallet_no=? OR id=?', code, Number(code) || -1);
    if (!pl) return { ok: false, message: `❌ Pallet topilmadi: ${code}` };
    if (pl.shipment_id !== t.shipment_id) return { ok: false, message: `❌ ${pl.pallet_no} ushbu jo‘natmaga tegishli emas` };
    if (pl.status === 'LOADED') return { ok: true, message: `ℹ️ ${pl.pallet_no} allaqachon yuklangan` };
    const p = inv.product(pl.product_id);
    const f = p.track_serial ? { pallet_id: pl.id } : undefined;
    const to = t.loading_location_id || inv.zoneLocation('DISPATCH');
    for (const leg of inv.take({ productId: p.id, qty: pl.qty, status: 'PACKED', locationId: pl.location_id, serialFilter: f }))
      inv.move({ type: 'TRANSFER', productId: p.id, qty: leg.qty, from: { locationId: pl.location_id, status: 'PACKED', batchId: leg.batchId }, to: { locationId: to, status: 'LOADED' }, user,
        ref: { type: 'loading', id: t.id }, reference: pl.pallet_no, reason: 'Mashinaga yuklandi', serialFilter: f, serialPatch: { shipment_id: t.shipment_id } });
    db.update('pallets', pl.id, { status: 'LOADED', location_id: to, updated_at: clock.iso() });
    db.run('UPDATE shipment_items SET loaded=1 WHERE shipment_id=? AND pallet_id=?', t.shipment_id, pl.id);
    db.audit(user, 'PALLET_LOAD', 'pallets', pl.pallet_no);
    const left = db.val('SELECT COUNT(*) FROM shipment_items WHERE shipment_id=? AND loaded=0', t.shipment_id);
    return { ok: true, message: `✅ ${pl.pallet_no} yuklandi. Qoldi: ${left}`, remaining: left };
  });
}

function completeLoading(taskId, input, user) {
  return db.tx(() => {
    const t = db.get('SELECT * FROM loading_tasks WHERE id=?', taskId); if (!t) throw notFound('Yuklash topshirig‘i');
    if (t.status !== 'IN_PROGRESS') throw bad('Yuklash jarayonda emas');
    if (input.loadAll) for (const it of db.all('SELECT p.pallet_no FROM shipment_items si JOIN pallets p ON p.id=si.pallet_id WHERE si.shipment_id=? AND si.loaded=0', t.shipment_id)) loadPallet(t.id, { code: it.pallet_no }, user);
    const left = db.val('SELECT COUNT(*) FROM shipment_items WHERE shipment_id=? AND loaded=0', t.shipment_id);
    if (left) throw bad(`${left} ta pallet hali yuklanmagan`);
    const s = shipmentOf(t.shipment_id);
    const minutes = Math.max(1, Math.round((clock.now() - new Date(t.started_at)) / 60000));
    db.update('loading_tasks', t.id, { status: 'COMPLETED', completed_at: clock.iso(), actual_minutes: minutes });
    setShipment(s, 'LOADED', user, { loading_end: clock.iso() });
    db.history('loading', t.id, 'IN_PROGRESS', 'COMPLETED', user);
    const docs = require('./documents').generateShipmentDocs(s.id, user);
    db.audit(user, 'LOADING_COMPLETE', 'shipments', s.ship_no, { minutes });
    db.emit('LOADING_COMPLETED', { shipmentId: s.id, shipNo: s.ship_no, minutes });
    require('./ai').loadingRootCause(t.id);
    return { status: 'LOADED', minutes, documents: docs };
  });
}

function dispatch(shipmentId, input, user) {
  return db.tx(() => {
    const s = shipmentOf(shipmentId);
    if (s.status !== 'LOADED') throw bad(`Jo‘natma holati ${s.status}; avval yuklashni yakunlang`);
    const missing = ['PACKING_LIST', 'DELIVERY_NOTE', 'LOADING_SHEET'].filter((c) => !db.val("SELECT COUNT(*) FROM documents WHERE ref_type='shipment' AND ref_id=? AND doc_type=?", s.id, c));
    if (missing.length) throw bad(`Hujjatlar tayyor emas: ${missing.join(', ')}`);
    if (s.project_id) {
      const pj = db.get('SELECT * FROM projects WHERE id=?', s.project_id);
      if (pj?.requires_xetq && !db.val("SELECT COUNT(*) FROM xetq_submissions WHERE project_id=? AND status='APPROVED'", pj.id)) throw bad(`Loyiha ${pj.code} uchun XETQ kelishuvi tasdiqlanmagan — jo‘natish bloklangan`);
    }
    const items = db.all('SELECT si.*, p.pallet_no, p.location_id FROM shipment_items si JOIN pallets p ON p.id=si.pallet_id WHERE si.shipment_id=?', s.id);
    for (const it of items) {
      const p = inv.product(it.product_id); const f = p.track_serial ? { pallet_id: it.pallet_id } : undefined;
      for (const leg of inv.take({ productId: p.id, qty: it.qty, status: 'LOADED', locationId: it.location_id, serialFilter: f }))
        inv.move({ type: 'SHIP', productId: p.id, qty: leg.qty, from: { locationId: it.location_id, status: 'LOADED', batchId: leg.batchId }, user, ref: { type: 'shipment', id: s.id },
          reference: s.ship_no, reason: `Jo‘natildi: ${s.destination || ''}`, serialFilter: f, serialPatch: { shipment_id: s.id } });
      db.run('UPDATE order_items SET shipped_qty=shipped_qty+? WHERE order_id=? AND product_id=?', it.qty, s.order_id, it.product_id);
      db.update('pallets', it.pallet_id, { status: 'SHIPPED', location_id: null, updated_at: clock.iso() });
    }
    const departure = clock.iso();
    const eta = input.eta ? V.date(input.eta, 'ETA') : new Date(clock.now().getTime() + ((s.distance_km || 100) / (db.setting('avg_speed_kmh', 55)) + 1) * 3600000).toISOString();
    setShipment(s, 'DISPATCHED', user, { departure, eta });
    db.update('vehicles', s.vehicle_id, { status: 'IN_TRANSIT' });
    db.update('drivers', s.driver_id, { status: 'ON_TRIP' });
    db.audit(user, 'SHIPMENT_DISPATCH', 'shipments', s.ship_no, { eta });
    db.emit('SHIPMENT_DISPATCHED', { shipmentId: s.id, shipNo: s.ship_no, eta });
    orders.recomputeOrderStatus(s.order_id);
    return { status: 'DISPATCHED', departure, eta };
  });
}

function arrive(shipmentId, input, user) {
  return db.tx(() => {
    const s = shipmentOf(shipmentId);
    if (s.status !== 'DISPATCHED') throw bad('Jo‘natma yo‘lda emas');
    setShipment(s, 'DELIVERED', user, { actual_arrival: input.arrivedAt ? V.date(input.arrivedAt, 'Kelgan vaqt') : clock.iso() });
    db.update('vehicles', s.vehicle_id, { status: 'AVAILABLE' });
    db.update('drivers', s.driver_id, { status: 'AVAILABLE' });
    db.run("UPDATE transport_assignments SET status='DONE' WHERE shipment_id=?", s.id);
    db.run("UPDATE ai_events SET status='RESOLVED', resolved_at=? WHERE dedupe_key=? AND status<>'RESOLVED'", clock.iso(), `ship-late-${s.id}`);
    const o = db.get('SELECT * FROM orders WHERE id=?', s.order_id);
    if (o.status === 'SHIPPED' && !db.val("SELECT COUNT(*) FROM shipments WHERE order_id=? AND status NOT IN ('DELIVERED','CANCELLED')", o.id)) { db.update('orders', o.id, { status: 'DELIVERED', updated_at: clock.iso() }); db.history('order', o.id, 'SHIPPED', 'DELIVERED', user); }
    db.audit(user, 'SHIPMENT_ARRIVE', 'shipments', s.ship_no);
    db.emit('SHIPMENT_ARRIVED', { shipmentId: s.id, shipNo: s.ship_no });
    return { status: 'DELIVERED' };
  });
}

function cancelShipment(shipmentId, input, user) {
  return db.tx(() => {
    const s = shipmentOf(shipmentId);
    if (!['PLANNED', 'LOADING', 'LOADED'].includes(s.status)) throw bad('Jo‘natilgan yukni bekor qilib bo‘lmaydi');
    const reason = V.str(input.reason, 'Sabab', { max: 300 });
    for (const pl of db.all("SELECT * FROM pallets WHERE shipment_id=?", s.id)) {
      if (pl.status === 'LOADED') {
        const p = inv.product(pl.product_id); const f = p.track_serial ? { pallet_id: pl.id } : undefined; const to = inv.zoneLocation('DISPATCH');
        for (const leg of inv.take({ productId: p.id, qty: pl.qty, status: 'LOADED', locationId: pl.location_id, serialFilter: f }))
          inv.move({ type: 'TRANSFER', productId: p.id, qty: leg.qty, from: { locationId: pl.location_id, status: 'LOADED', batchId: leg.batchId }, to: { locationId: to, status: 'PACKED' }, user, reference: s.ship_no, reason: 'Yuk tushirildi (bekor)', serialFilter: f, serialPatch: { shipment_id: null } });
        db.update('pallets', pl.id, { location_id: to });
      }
      db.update('pallets', pl.id, { status: 'PACKED', shipment_id: null, updated_at: clock.iso() });
    }
    db.run("UPDATE loading_tasks SET status='CANCELLED' WHERE shipment_id=? AND status<>'COMPLETED'", s.id);
    db.run("UPDATE transport_assignments SET status='CANCELLED' WHERE shipment_id=?", s.id);
    db.update('vehicles', s.vehicle_id, { status: 'AVAILABLE' });
    db.update('drivers', s.driver_id, { status: 'AVAILABLE' });
    setShipment(s, 'CANCELLED', user, {}, reason);
    db.audit(user, 'SHIPMENT_CANCEL', 'shipments', s.ship_no, { reason });
    orders.recomputeOrderStatus(s.order_id);
    return { status: 'CANCELLED' };
  });
}

function setVehicleStatus(id, input, user) {
  return db.tx(() => {
    const v = db.get('SELECT * FROM vehicles WHERE id=?', id); if (!v) throw notFound('Transport');
    const st = V.oneOf(input.status, 'Holat', VEHICLE_STATUSES);
    if (['RESERVED', 'LOADING', 'IN_TRANSIT'].includes(v.status) && ['AVAILABLE', 'MAINTENANCE', 'UNAVAILABLE'].includes(st) && db.val("SELECT COUNT(*) FROM shipments WHERE vehicle_id=? AND status IN ('PLANNED','LOADING','LOADED','DISPATCHED')", id))
      throw bad('Transport faol jo‘natmaga biriktirilgan');
    db.update('vehicles', id, { status: st, notes: input.notes ?? v.notes });
    db.audit(user, 'VEHICLE_STATUS', 'vehicles', v.code, { from: v.status, to: st });
    db.emit('VEHICLE_STATUS', { vehicleId: id, status: st });
    return { status: st };
  });
}

module.exports = { VEHICLE_STATUSES, fit, calculate, estimateLoading, loadingPlan, validateSequence, createShipment, startLoading, loadPallet, completeLoading, dispatch, arrive, cancelShipment, setVehicleStatus };
