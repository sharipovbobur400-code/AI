'use strict';
// AI Ombor boshqaruvi: data-grounded analysis. Every alert/answer is computed from the database;
// an external LLM (optional, server-side key only) is used just to phrase answers from these facts.
const db = require('./db');
const inv = require('./inventory');
const { clock, round, fmt } = require('./core');

const SEV_RANK = { CRITICAL: 3, WARNING: 2, INFO: 1 };

function raise(a) {
  const now = clock.iso();
  const ex = a.key ? db.get("SELECT * FROM ai_events WHERE dedupe_key=? AND status<>'RESOLVED' ORDER BY id DESC LIMIT 1", a.key) : null;
  if (ex) {
    if (ex.message !== a.message || ex.severity !== a.severity || (a.type && ex.type !== a.type)) db.update('ai_events', ex.id, { ...(a.type ? { type: a.type } : {}), message: a.message, severity: a.severity, title: a.title, data: a.data ? JSON.stringify(a.data) : ex.data, updated_at: now });
    if (SEV_RANK[a.severity] > SEV_RANK[ex.severity]) db.emit('AI_ALERT', { id: ex.id, severity: a.severity, title: a.title, message: a.message });
    return ex.id;
  }
  const id = db.insert('ai_events', { dedupe_key: a.key || null, type: a.type, severity: a.severity, title: a.title, message: a.message, ref_type: a.ref_type || null, ref_id: a.ref_id || null,
    data: a.data ? JSON.stringify(a.data) : null, status: 'OPEN', created_at: now, updated_at: now });
  if (a.severity !== 'INFO') db.insert('notifications', { level: a.severity, title: a.title, message: a.message, ref_type: a.ref_type || null, ref_id: a.ref_id || null, created_at: now });
  db.emit('AI_ALERT', { id, type: a.type, severity: a.severity, title: a.title, message: a.message });
  if (a.type === 'DELIVERY_DELAY') db.emit('DELIVERY_DELAYED', { alertId: id, deliveryId: a.ref_id, message: a.message });
  return id;
}

// ---- Capacity -----------------------------------------------------------------------
function capacity() {
  const whs = db.all('SELECT * FROM warehouses WHERE active=1 ORDER BY id');
  const rows = db.all(`SELECT l.warehouse_id, i.location_id, i.product_id, SUM(i.qty) qty, p.units_per_pallet upp, p.gross_weight_kg gw, p.net_weight_kg nw, p.volume_m3 vol
    FROM inventory i JOIN warehouse_locations l ON l.id=i.location_id JOIN products p ON p.id=i.product_id WHERE i.qty>0 GROUP BY i.location_id, i.product_id`);
  return whs.map((w) => {
    const r = rows.filter((x) => x.warehouse_id === w.id);
    const used = r.reduce((a, x) => a + Math.ceil(x.qty / Math.max(1, x.upp || 1)), 0);
    const weight = r.reduce((a, x) => a + x.qty * (x.gw || x.nw || 0), 0);
    const volume = r.reduce((a, x) => a + x.qty * (x.vol || 0), 0);
    const positions = w.pallet_positions || db.val('SELECT COALESCE(SUM(max_pallets),0) FROM warehouse_locations WHERE warehouse_id=?', w.id) || 1;
    return { id: w.id, name: w.name, type: w.type, positions, usedPallets: used, freePallets: Math.max(0, positions - used), pct: round((used / positions) * 100, 1),
      weightKg: round(weight), maxLoadKg: w.max_load_kg, weightPct: w.max_load_kg ? round((weight / w.max_load_kg) * 100, 1) : null,
      volumeM3: round(volume, 1), usableVolumeM3: w.usable_volume_m3, volumePct: w.usable_volume_m3 ? round((volume / w.usable_volume_m3) * 100, 1) : null,
      dims: `${w.length_m}×${w.width_m}×${w.height_m} m` };
  });
}

// ---- Forecast (recommendation only) -----------------------------------------------------
function forecast(days = 7) {
  const since = clock.addDays(-28);
  const until = clock.addDays(days);
  return inv.stockSummary().map((s) => {
    const out = db.val("SELECT COALESCE(SUM(qty),0) FROM inventory_transactions WHERE product_id=? AND type IN ('SHIP','ISSUE') AND created_at>=?", s.product_id, since) || 0;
    const prodIn = db.val("SELECT COALESCE(SUM(qty_received),0) FROM receiving_orders WHERE product_id=? AND source='PRODUCTION' AND created_at>=?", s.product_id, since) || 0;
    const ordersDue = db.val(`SELECT COALESCE(SUM(oi.qty - oi.shipped_qty),0) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=?
      AND o.status NOT IN ('CANCELLED','SHIPPED','DELIVERED') AND (o.due_date IS NULL OR o.due_date<=?)`, s.product_id, until) || 0;
    const inbound = db.val(`SELECT COALESCE(SUM(pr.qty - pr.received_qty),0) FROM purchase_requests pr LEFT JOIN supplier_deliveries d ON d.purchase_request_id=pr.id AND d.status NOT IN ('CANCELLED')
      WHERE pr.product_id=? AND pr.status IN ('ORDERED','SUPPLIER_CONFIRMED','IN_TRANSIT') AND COALESCE(d.expected_date, pr.required_date)<=?`, s.product_id, until) || 0;
    const avgDaily = out / 28;
    const demand = Math.max(ordersDue, Math.round(avgDaily * days));
    const production = s.category === 'FINISHED' ? Math.round((prodIn / 28) * days) : 0;
    const supply = s.available + s.picked + s.packed + s.receiving + inbound + production;
    const gap = Math.max(0, Math.round(demand - supply));
    return { product_id: s.product_id, sku: s.sku, name: s.name, unit: s.unit, category: s.category, avgDaily: round(avgDaily, 1), ordersDue, demand, available: s.available, inbound, production, supply: round(supply), gap,
      text: demand > 0 ? `Keyingi ${days} kunlik reja bo‘yicha taxminan ${fmt(demand)} ${s.unit} kerak bo‘ladi${gap ? `; mavjud + kutilayotgan ta'minot bilan ${fmt(gap)} ${s.unit} yetishmasligi mumkin` : ' — ta’minot yetarli'}.` : null };
  }).filter((f) => f.demand > 0 || f.gap > 0).sort((a, b) => b.gap - a.gap || b.demand - a.demand);
}

function cycleCountSuggestions() {
  const since = clock.addDays(-14);
  return db.all(`SELECT z.id zone_id, z.warehouse_id, z.name, COUNT(t.id) moves,
      (SELECT MAX(c.posted_at) FROM inventory_counts c WHERE c.zone_id=z.id AND c.status='POSTED') last_count
    FROM warehouse_zones z JOIN warehouse_locations l ON l.zone_id=z.id JOIN inventory_transactions t ON (t.from_location_id=l.id OR t.to_location_id=l.id) AND t.created_at>=?
    WHERE z.zone_type IN ('FINISHED','RAW','WIP') GROUP BY z.id ORDER BY moves DESC LIMIT 5`, since)
    .filter((z) => !z.last_count || new Date(z.last_count) < new Date(clock.addDays(-30)));
}
function spaceSuggestions() {
  const out = [];
  const frag = db.all(`SELECT l.warehouse_id, p.sku, p.name, p.units_per_pallet upp, COUNT(DISTINCT i.location_id) locs, SUM(i.qty) qty FROM inventory i JOIN warehouse_locations l ON l.id=i.location_id
    JOIN warehouse_zones z ON z.id=l.zone_id JOIN products p ON p.id=i.product_id WHERE i.status='AVAILABLE' AND z.zone_type IN ('FINISHED','RAW') GROUP BY l.warehouse_id, p.id HAVING locs>1`);
  for (const f of frag) {
    const minLocs = Math.ceil(f.qty / Math.max(1, f.upp));
    if (f.locs - minLocs >= 2) out.push({ warehouse: f.warehouse_id, text: `${f.warehouse_id} da ${f.sku} ${f.locs} ta lokatsiyada qisman pallet holatida saqlanmoqda; ${minLocs} ta lokatsiyaga jamlash orqali ${f.locs - minLocs} ta pallet pozitsiyasi bo‘shaydi.` });
  }
  const cap = capacity();
  for (const c of cap.filter((x) => x.pct >= 85)) {
    const alt = cap.filter((x) => x.id !== c.id && x.type === c.type && x.pct < 60)[0];
    out.push({ warehouse: c.id, text: `${c.id} ${c.pct}% to‘lgan (${c.freePallets} ta bo‘sh pallet pozitsiyasi).${alt ? ` ${alt.id} da ${alt.freePallets} ta bo‘sh joy mavjud — ko‘chirish tavsiya etiladi.` : ' Sekin aylanadigan mahsulotlarni yuqori qavat/uzoq zonaga o‘tkazish tavsiya etiladi.'}` });
  }
  return out;
}

/** Full periodic scan. Keeps alerts in sync with reality (auto-resolves stale ones). */
function scan() {
  return db.tx(() => {
    require('./orders').detectAllShortages(null);
    const raised = new Set();
    const R = (a) => { raised.add(a.key); raise(a); };
    const now = clock.now();
    const tomorrowEnd = new Date(now); tomorrowEnd.setUTCHours(23, 59, 59, 999); tomorrowEnd.setUTCDate(tomorrowEnd.getUTCDate() + 1);

    for (const s of db.all(`SELECT s.*, p.name, p.unit, p.sku, o.order_no, o.due_date FROM shortages s JOIN products p ON p.id=s.product_id JOIN orders o ON o.id=s.order_id
      WHERE s.status IN ('OPEN','REQUESTED') AND o.due_date IS NOT NULL AND o.due_date<=?`, tomorrowEnd.toISOString())) {
      R({ key: `due-short-${s.id}`, type: 'ORDER_RISK', severity: 'CRITICAL', title: `${s.name}: buyurtma uchun yetarli emas`, ref_type: 'order', ref_id: s.order_id,
        message: `${s.name} stocki ${s.order_no} (muddat ${s.due_date.slice(0, 10)}) buyurtmasi uchun yetarli emas: ${s.shortage_qty} ${s.unit} yetishmaydi.${s.status === 'REQUESTED' ? ' Ta’minot zayavkasi berilgan.' : ' Zayavka hali yaratilmagan!'}` });
    }
    for (const s of inv.stockSummary().filter((x) => x.min_stock > 0 && x.free <= x.min_stock * 1.1)) {
      const crit = s.free <= s.min_stock * 0.5;
      R({ key: `low-${s.product_id}`, type: 'LOW_STOCK', severity: crit ? 'CRITICAL' : 'WARNING', title: `${s.name}: minimal daraja`, ref_type: 'product', ref_id: s.product_id,
        message: `${s.name} materialining erkin miqdori (${fmt(s.free)} ${s.unit}) minimal darajaga ${crit ? 'yetdi' : 'yaqin'} (min: ${fmt(s.min_stock)}). Kutilayotgan: ${fmt(s.inbound)} ${s.unit}.` });
    }
    for (const d of db.all(`SELECT d.*, s.company, p.name, p.unit FROM supplier_deliveries d JOIN suppliers s ON s.id=d.supplier_id LEFT JOIN products p ON p.id=d.product_id
      WHERE d.status IN ('CONFIRMED','IN_TRANSIT') AND d.expected_date IS NOT NULL`)) {
      const days = Math.floor((now - new Date(d.expected_date)) / 86400000);
      if (days >= 1) R({ key: `delay-${d.id}`, type: 'DELIVERY_DELAY', severity: 'CRITICAL', title: `SUPPLIER DELAY: ${d.company}`, ref_type: 'delivery', ref_id: d.id,
        message: `Supplier ${d.company} tomonidan ${fmt(d.qty)} ${d.unit || ''} ${d.name || ''} ${days} kun kechikmoqda (kutilgan: ${d.expected_date.slice(0, 10)}).` });
    }
    for (const c of capacity().filter((x) => x.pct >= 85)) R({ key: `cap-${c.id}`, type: 'WAREHOUSE_CAPACITY', severity: c.pct >= 95 ? 'CRITICAL' : 'WARNING', title: `WAREHOUSE CAPACITY: ${c.id}`, ref_type: 'warehouse',
      message: `${c.id} (${c.name}) ${c.pct}% to‘ldi — ${c.freePallets} ta bo‘sh pallet pozitsiyasi qoldi.` });
    const iso = now.toISOString();
    for (const t of db.all("SELECT t.*, o.order_no FROM picking_tasks t JOIN orders o ON o.id=t.order_id WHERE t.status IN ('PENDING','IN_PROGRESS') AND t.deadline<?", iso))
      R({ key: `overdue-pick-${t.id}`, type: 'TASK_OVERDUE', severity: 'WARNING', title: `Picking kechikmoqda: ${t.task_no}`, ref_type: 'picking', ref_id: t.id, message: `${t.task_no} (${t.order_no}) muddati ${t.deadline.slice(0, 16).replace('T', ' ')} o‘tdi.` });
    for (const t of db.all("SELECT t.*, o.order_no FROM packing_tasks t JOIN orders o ON o.id=t.order_id WHERE t.status IN ('PENDING','IN_PROGRESS') AND t.deadline<?", iso))
      R({ key: `overdue-pack-${t.id}`, type: 'TASK_OVERDUE', severity: 'WARNING', title: `Packing kechikmoqda: ${t.task_no}`, ref_type: 'packing', ref_id: t.id, message: `${t.task_no} (${t.order_no}) qadoqlash muddati o‘tdi.` });
    for (const r of db.all("SELECT r.*, p.name FROM receiving_orders r JOIN products p ON p.id=r.product_id WHERE r.status='RECEIVING' AND r.deadline<?", iso))
      R({ key: `overdue-rcv-${r.id}`, type: 'TASK_OVERDUE', severity: 'WARNING', title: `QC kutilmoqda: ${r.rcv_no}`, ref_type: 'receiving', ref_id: r.id, message: `${r.rcv_no} (${r.name}, ${r.qty_received}) QC muddati o‘tdi — yuk qabul zonasida turibdi.` });
    if (require('./modules').logisticsOn()) for (const s of db.all("SELECT * FROM shipments WHERE status IN ('PLANNED','LOADING','LOADED') AND planned_departure<?", iso))
      R({ key: `overdue-dispatch-${s.id}`, type: 'TASK_OVERDUE', severity: 'CRITICAL', title: `Jo‘natish kechikmoqda: ${s.ship_no}`, ref_type: 'shipment', ref_id: s.id, message: `${s.ship_no} rejalashtirilgan jo‘nash vaqti (${s.planned_departure.slice(0, 16).replace('T', ' ')}) o‘tdi, holat: ${s.status}.` });
    if (require('./modules').logisticsOn()) for (const s of db.all("SELECT * FROM shipments WHERE status='DISPATCHED' AND eta<?", iso))
      R({ key: `ship-late-${s.id}`, type: 'SHIPMENT_DELAY', severity: 'WARNING', title: `Jo‘natma kechikmoqda: ${s.ship_no}`, ref_type: 'shipment', ref_id: s.id, message: `${s.ship_no} ETA ${s.eta.slice(0, 16).replace('T', ' ')} o‘tdi, yetib kelgani qayd etilmagan.` });
    for (const r of db.all(`SELECT r.*, x.sub_no, x.status FROM xetq_reviews r JOIN xetq_submissions x ON x.id=r.submission_id WHERE r.to_status='REVISION_REQUIRED' AND x.status='REVISION_REQUIRED' AND r.deadline<?`, iso))
      R({ key: `xetq-rev-${r.submission_id}-${r.id}`, type: 'XETQ_DEADLINE', severity: 'WARNING', title: `XETQ tuzatish muddati o‘tdi: ${r.sub_no}`, ref_type: 'xetq', ref_id: r.submission_id, message: `${r.sub_no}: "${r.required_changes}" tuzatish muddati ${r.deadline.slice(0, 10)} o‘tdi.` });
    for (const z of cycleCountSuggestions().slice(0, 2)) R({ key: `cycle-${z.zone_id}`, type: 'CYCLE_COUNT', severity: 'INFO', title: `Inventarizatsiya tavsiyasi: ${z.zone_id}`, ref_type: 'zone',
      message: `${z.warehouse_id} ${z.name} inventarizatsiyasini tekshirish tavsiya qilinadi: oxirgi 14 kunda ${z.moves} ta harakat, ${z.last_count ? `oxirgi hisob ${z.last_count.slice(0, 10)}` : 'hali hisoblanmagan'}.` });
    for (const [i, s] of spaceSuggestions().slice(0, 3).entries()) R({ key: `space-${s.warehouse}-${i}`, type: 'SPACE_OPTIMIZATION', severity: 'INFO', title: `Joydan foydalanish: ${s.warehouse}`, ref_type: 'warehouse', message: s.text });

    const prefixes = ['due-short-', 'low-', 'delay-', 'cap-', 'overdue-', 'ship-late-', 'xetq-rev-', 'cycle-', 'space-'];
    for (const e of db.all("SELECT id, dedupe_key FROM ai_events WHERE status<>'RESOLVED' AND dedupe_key IS NOT NULL")) {
      if (prefixes.some((p) => e.dedupe_key.startsWith(p)) && !raised.has(e.dedupe_key)) db.update('ai_events', e.id, { status: 'RESOLVED', resolved_at: clock.iso() });
    }
    db.emit('AI_SCAN', { alerts: db.val("SELECT COUNT(*) FROM ai_events WHERE status='OPEN' AND severity<>'INFO'") });
    return { raised: raised.size };
  });
}

/** Loading root cause — only reasons backed by recorded data. */
function loadingRootCause(taskId) {
  const t = db.get('SELECT * FROM loading_tasks WHERE id=?', taskId);
  if (!t || !t.actual_minutes) return null;
  const norm = t.estimated_minutes || 60;
  if (t.actual_minutes <= norm * 1.5 || t.actual_minutes - norm < 15) return null;
  const snap = JSON.parse(t.delay_reason || '{}');
  const s = db.get('SELECT * FROM shipments WHERE id=?', t.shipment_id);
  const reasons = [];
  if (snap.notReadyPallets > 0) reasons.push(`pallet tayyor emasligi (yuklash boshlanganda ${snap.notReadyPallets} ta pallet jo‘natish zonasida bo‘lmagan)`);
  if (snap.concurrentLoadings > 0) reasons.push(`dispatch zonadagi tirbandlik (bir vaqtda ${snap.concurrentLoadings + 1} ta yuklash)`);
  if (snap.lateStartMin > 15) reasons.push(`yuklash rejadan ${snap.lateStartMin} daqiqa kech boshlangan`);
  const text = `Yuklash vaqti me'yordan yuqori: ${t.actual_minutes} daqiqa (me'yor ${norm}). ` + (reasons.length ? `Asosiy sabablar sifatida ${reasons.join(', ')} qayd etilgan.` : 'Tizimda sababni aniqlash uchun yetarli ma’lumot qayd etilmagan — izoh kiritish tavsiya etiladi.');
  db.update('loading_tasks', t.id, { delay_reason: JSON.stringify({ ...snap, analysis: text }) });
  raise({ key: `rootcause-${t.id}`, type: 'ROOT_CAUSE', severity: 'WARNING', title: `Yuklash kechikishi: ${s.ship_no}`, ref_type: 'shipment', ref_id: s.id, message: text });
  return text;
}

// ---- Director Q&A ---------------------------------------------------------------------------
const norm = (s) => String(s || '').toLowerCase().replace(/[‘’`ʻʼ']/g, "'");
function productFromText(q) {
  const ps = db.all('SELECT id, sku, name, power_w FROM products');
  return ps.find((p) => q.includes(norm(p.sku))) || ps.find((p) => p.power_w && q.includes(`${p.power_w}`)) || null;
}
function facts(q) {
  const f = {}; const sections = [];
  const has = (re) => re.test(q);
  const p = productFromText(q);
  if (has(/yetishma|shortage|kam kel|nima yetish/)) {
    const rows = db.all(`SELECT s.shortage_no, p.sku, p.name, p.unit, s.shortage_qty, s.status, o.order_no, o.due_date, pr.pr_no FROM shortages s JOIN products p ON p.id=s.product_id
      LEFT JOIN orders o ON o.id=s.order_id LEFT JOIN purchase_requests pr ON pr.id=s.purchase_request_id WHERE s.status IN ('OPEN','REQUESTED') ORDER BY o.due_date`);
    const low = inv.stockSummary().filter((x) => x.low);
    f.shortages = rows; f.lowStock = low.map((x) => ({ sku: x.sku, name: x.name, free: x.free, min: x.min_stock }));
    sections.push(rows.length ? `🔴 Yetishmovchilik (${rows.length}):\n` + rows.map((r) => `• ${r.name}: ${fmt(r.shortage_qty)} ${r.unit} — ${r.order_no}${r.due_date ? ` (muddat ${r.due_date.slice(0, 10)})` : ''}; ${r.pr_no ? `zayavka ${r.pr_no}` : 'zayavka yo‘q'}`).join('\n') : '✅ Ochiq yetishmovchilik yo‘q.');
    if (low.length) sections.push('🟠 Minimal darajadagi materiallar:\n' + low.map((x) => `• ${x.name}: erkin ${fmt(x.free)} ${x.unit} (min ${fmt(x.min_stock)})`).join('\n'));
  }
  if (has(/supplier|ta'minotchi|yetkazib|kechik/) && !has(/jo'natma|shipment|yo'lda/)) {
    const perf = require('./procurement').performance();
    const late = db.all(`SELECT d.delivery_no, s.company, p.name, d.qty, d.expected_date, d.status FROM supplier_deliveries d JOIN suppliers s ON s.id=d.supplier_id LEFT JOIN products p ON p.id=d.product_id
      WHERE d.status IN ('CONFIRMED','IN_TRANSIT') AND d.expected_date < ?`, clock.addDays(-1));
    f.lateDeliveries = late; f.supplierPerformance = perf;
    sections.push(late.length ? '🔴 Kechikayotgan yetkazishlar:\n' + late.map((d) => `• ${d.company}: ${fmt(d.qty)} ${d.name} — kutilgan ${d.expected_date.slice(0, 10)} (${Math.floor((clock.now() - new Date(d.expected_date)) / 86400000)} kun)`).join('\n') : '✅ Hozir kechikayotgan yetkazish yo‘q.');
    const worst = perf.filter((x) => x.delivered).sort((a, b) => a.on_time_rate - b.on_time_rate).slice(0, 3);
    if (worst.length) sections.push('📊 Vaqtida yetkazish ko‘rsatkichi eng pastlari:\n' + worst.map((x) => `• ${x.company}: ${x.on_time_rate}% vaqtida, o‘rtacha kechikish ${x.avg_delay_days} kun, sifat ${x.quality_rate}%`).join('\n'));
  }
  if (has(/ertang|ertaga|yetadimi/)) {
    const end = new Date(clock.now()); end.setUTCDate(end.getUTCDate() + 1); end.setUTCHours(23, 59, 59);
    const items = db.all(`SELECT o.order_no, o.due_date, oi.id, oi.qty, oi.picked_qty, oi.shipped_qty, p.id pid, p.name, p.unit FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id
      WHERE o.status NOT IN ('CANCELLED','SHIPPED','DELIVERED') AND o.due_date<=? ORDER BY o.due_date`, end.toISOString());
    const orders = require('./orders');
    const lines = items.map((it) => {
      const c = orders.itemCoverage(it.id);
      const incoming = db.val(`SELECT COALESCE(SUM(pr.qty-pr.received_qty),0) FROM purchase_requests pr JOIN supplier_deliveries d ON d.purchase_request_id=pr.id WHERE pr.product_id=? AND pr.status IN ('SUPPLIER_CONFIRMED','IN_TRANSIT') AND d.expected_date<=?`, it.pid, end.toISOString()) || 0;
      const rcv = inv.productStock(it.pid).receiving;
      const ok = c.need === 0; const okWithIncoming = c.need <= incoming + rcv;
      return { order: it.order_no, product: it.name, required: it.qty, covered: round(c.reserved + c.picked, 2), need: c.need, confirmedIncoming: incoming, atDock: rcv, ok, okWithIncoming, unit: it.unit };
    });
    f.tomorrow = lines;
    sections.push(lines.length ? '📦 Ertangi jo‘natmalar (stock + rezerv + tasdiqlangan kirim asosida):\n' + lines.map((l) => `• ${l.order} — ${l.product}: kerak ${fmt(l.required)}, ta'minlangan ${fmt(l.covered)}. ${l.ok ? '✅ Yetadi.' : l.okWithIncoming ? `🟡 ${fmt(l.need)} ${l.unit} yetishmaydi, lekin tasdiqlangan kirim/qabul zonasidagi yuk (${fmt(l.confirmedIncoming + l.atDock)}) bilan yopiladi.` : `🔴 ${fmt(l.need - l.confirmedIncoming - l.atDock)} ${l.unit} yetmaydi.`}`).join('\n') : 'Ertangi kunga muddatli ochiq buyurtma yo‘q.');
  }
  if (has(/mashina|transport|sig'im/)) {
    const o = db.get(`SELECT o.id, o.order_no FROM orders o WHERE o.status IN ('PACKED','PICKED','RESERVED','PICKING','PARTIALLY_RESERVED') ORDER BY (o.status='PACKED') DESC, o.due_date LIMIT 1`);
    if (o) { const c = require('./logistics').calculate({ orderId: o.id }); f.transport = { order: o.order_no, totals: c.totals, recommended: c.recommended && { code: c.recommended.code, type: c.recommended.type, util: c.recommended.checks }, split: c.split };
      sections.push(`🚚 ${o.order_no}: ${c.aiText}`); }
    const av = db.all("SELECT code, type, payload_kg, volume_m3 FROM vehicles WHERE status='AVAILABLE'"); f.availableVehicles = av;
    sections.push(`Bo‘sh transport: ${av.length ? av.map((v) => `${v.code} (${v.type}, ${fmt(v.payload_kg)} kg / ${v.volume_m3} m³)`).join(', ') : 'yo‘q'}.`);
  }
  if (has(/nechta|qancha|bor\b|qoldiq|stock/) && !has(/rezerv|yetishma/)) {
    const rows = inv.stockSummary(p ? { productId: p.id } : { category: 'FINISHED' }); f.stock = rows;
    sections.push('🏭 Omborda:\n' + rows.map((r) => `• ${r.name}: mavjud ${fmt(r.available)}, rezerv ${fmt(r.reserved)}, erkin ${fmt(r.free)}, qabulda ${fmt(r.receiving)}, rework ${fmt(r.rework)}, brak ${fmt(r.scrap)} ${r.unit}`).join('\n'));
  }
  if (has(/qayerda|joy|lokatsiya|qaysi panel/)) {
    const rows = inv.inventoryRows(p ? { productId: p.id } : { status: 'AVAILABLE' }).filter((r) => r.zone_type === 'FINISHED' || p).slice(0, 15); f.locations = rows;
    sections.push('📍 Joylashuv:\n' + rows.map((r) => `• ${r.sku} — ${r.location} (${r.zone}): ${fmt(r.qty)} ${r.unit}, partiya ${r.batch_no || '—'}, ${r.status}`).join('\n'));
  }
  if (has(/rezerv/)) {
    const rows = inv.stockSummary().filter((r) => r.reserved > 0); f.reserved = rows.map((r) => ({ sku: r.sku, reserved: r.reserved }));
    sections.push('🔒 Rezerv:\n' + (rows.map((r) => `• ${r.name}: ${fmt(r.reserved)} ${r.unit}`).join('\n') || 'Rezerv yo‘q'));
  }
  if (has(/pallet|og'irlik|hajm|yig'il/)) {
    const pl = db.get("SELECT COUNT(*) n, COALESCE(SUM(qty),0) q, COALESCE(SUM(gross_weight_kg),0) w, COALESCE(SUM(volume_m3),0) v FROM pallets WHERE status IN ('PACKED','LOADED')");
    const pk = db.get(`SELECT COALESCE(SUM(oi.qty),0) req, COALESCE(SUM(oi.picked_qty),0) picked FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.status IN ${"('NEW','PARTIALLY_RESERVED','RESERVED','PICKING','PICKED','PACKED','LOADING')"}`);
    f.pallets = pl; f.picking = pk;
    sections.push(`📦 Tayyor pallet: ${pl.n} ta (${fmt(pl.q)} dona), umumiy og‘irlik ${fmt(round(pl.w))} kg, hajm ${round(pl.v, 2)} m³. Yig‘ish: ${fmt(pk.picked)} / ${fmt(pk.req)}.`);
  }
  if (has(/yo'lda|jo'natma|shipment|yuklan/)) {
    const rows = db.all(`SELECT s.ship_no, s.status, s.destination, s.eta, s.planned_departure, v.code vehicle, d.full_name driver, u.full_name loader FROM shipments s LEFT JOIN vehicles v ON v.id=s.vehicle_id LEFT JOIN drivers d ON d.id=s.driver_id
      LEFT JOIN loading_tasks lt ON lt.shipment_id=s.id LEFT JOIN users u ON u.id=lt.assigned_to WHERE s.status IN ('PLANNED','LOADING','LOADED','DISPATCHED') ORDER BY s.planned_departure`);
    f.shipments = rows;
    sections.push('🚛 Jo‘natmalar:\n' + (rows.map((s) => `• ${s.ship_no} — ${s.status}${s.status === 'DISPATCHED' ? `, ETA ${s.eta?.slice(0, 16).replace('T', ' ')}${new Date(s.eta) < clock.now() ? ' 🔴 kechikmoqda' : ''}` : `, jo‘nash ${s.planned_departure?.slice(0, 16).replace('T', ' ')}, yuklovchi ${s.loader || '—'}`}; ${s.vehicle} / ${s.driver}; → ${s.destination}`).join('\n') || 'Faol jo‘natma yo‘q'));
  }
  if (has(/xetq|kelishuv|bosqich|qaytarilgan|revision/)) {
    const rows = db.all(`SELECT x.sub_no, x.title, x.status, x.version, (SELECT required_changes FROM xetq_reviews r WHERE r.submission_id=x.id AND r.to_status='REVISION_REQUIRED' ORDER BY id DESC LIMIT 1) changes FROM xetq_submissions x ORDER BY x.updated_at DESC`);
    f.xetq = rows;
    sections.push('📑 XETQ:\n' + (rows.map((x) => `• ${x.sub_no} ${x.title} — ${x.status} (v${x.version})${x.status === 'REVISION_REQUIRED' ? ` — tuzatish: ${x.changes}` : ''}`).join('\n') || 'Topshiruv yo‘q'));
  }
  if (has(/texnik shart|ts-|versiya/)) {
    const rows = db.all("SELECT ts_no, version, title, status FROM technical_specifications t WHERE id IN (SELECT MAX(id) FROM technical_specifications GROUP BY ts_no)"); f.ts = rows;
    sections.push('📐 Texnik shartlar (oxirgi versiya):\n' + rows.map((t) => `• ${t.ts_no} v${t.version} — ${t.title} (${t.status})`).join('\n'));
  }
  if (has(/hujjat/) && !has(/xetq/)) {
    const rows = db.all("SELECT doc_no, title, status, current_version FROM documents ORDER BY updated_at DESC LIMIT 10"); f.documents = rows;
    sections.push('📄 Oxirgi hujjatlar:\n' + rows.map((d) => `• ${d.doc_no} ${d.title} — ${d.status} v${d.current_version}`).join('\n'));
  }
  if (has(/xavf|risk|alert|ogohlantir|muammo/) || !sections.length) {
    const rows = db.all("SELECT severity, title, message FROM ai_events WHERE status='OPEN' ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, id DESC LIMIT 10"); f.alerts = rows;
    if (!sections.length) {
      const d = require('./reports').directorDashboard();
      f.summary = d;
      sections.push(`Umumiy holat: ombor ${d.warehouse.pct}% band, ${d.supply.shortages} ta yetishmovchilik, ${d.supplier.delays} ta supplier kechikishi, yig‘ish ${d.picking.picked}/${d.picking.required}, ${d.logistics.active} ta faol jo‘natma, ${d.transport.available} ta bo‘sh transport, XETQ reviewda ${d.xetq.inReview}, AI alertlar ${d.ai.alerts}.`);
    }
    sections.push('⚠️ AI ko‘rayotgan xavflar:\n' + (rows.map((r) => `• [${r.severity}] ${r.message}`).join('\n') || 'Ochiq xavf yo‘q.'));
  }
  return { facts: f, text: sections.join('\n\n') };
}

// ---- LLM provider (key is server-side only; Gemini / Vertex AI or Anthropic, detected from the key) ----
const SYSTEM_PROMPT = 'Siz quyosh paneli zavodining ombor/logistika AI nazoratchisisiz. Faqat berilgan JSON ma’lumotlar asosida o‘zbek tilida qisqa va aniq javob bering. Ma’lumotda yo‘q narsani taxmin qilmang; yetarli ma’lumot bo‘lmasa shuni ayting. Raqamlarni o‘zgartirmang.';
let llmState = { lastOkAt: null, lastError: null, lastErrorAt: null };
function llmConfig() {
  const key = require('./secrets').get('AI_API_KEY');
  if (!key) return null;
  const meta = (db.get("SELECT meta FROM secrets WHERE name='AI_API_KEY'") || {}).meta;
  const m = meta ? JSON.parse(meta) : {};
  const provider = m.provider || process.env.AI_PROVIDER || (key.startsWith('sk-ant-') ? 'anthropic' : 'gemini');
  const model = m.model || process.env.AI_MODEL || (provider === 'anthropic' ? 'claude-sonnet-5' : 'gemini-flash-latest');
  return { key, provider, model };
}
function llmInfo() { const c = llmConfig(); return { configured: !!c, provider: c?.provider || null, model: c?.model || null, ...llmState }; }
async function rawLLM(system, user, maxTokens = 900) {
  const c = llmConfig(); if (!c) return null;
  let res;
  if (c.provider === 'anthropic') {
    res = await fetch(`${(process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`, { method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { 'x-api-key': c.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: c.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error?.message || `HTTP ${res.status}`);
    return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n') || null;
  }
  const url = c.provider === 'vertex'
    ? `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(c.model)}:generateContent`
    : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(c.model)}:generateContent`;
  res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(30000), headers: { 'content-type': 'application/json', 'x-goog-api-key': c.key },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 } }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || `HTTP ${res.status}`);
  return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim() || null;
}
async function callLLM(question, factsObj, maxTokens = 900) {
  if (!llmConfig()) return null;
  try {
    const out = await rawLLM(SYSTEM_PROMPT, `Savol / vazifa: ${question}\n\nMa'lumotlar bazasidan olingan faktlar (JSON):\n${JSON.stringify(factsObj).slice(0, 60000)}`, maxTokens);
    llmState = { ...llmState, lastOkAt: clock.iso(), lastError: null };
    return out;
  } catch (err) { llmState = { ...llmState, lastError: err.message, lastErrorAt: clock.iso() }; return null; }
}
async function testLLM() {
  const t0 = Date.now();
  const out = await rawLLM('Siz qisqa javob beruvchi yordamchisiz.', 'Faqat "OK" deb javob bering.', 20);
  llmState = { ...llmState, lastOkAt: clock.iso(), lastError: null };
  return { ok: true, reply: out, ms: Date.now() - t0, ...llmInfo() };
}

async function ask(question, user) {
  const q = norm(question);
  const { facts: f, text } = facts(q);
  const llm = await callLLM(question, f);
  db.audit(user, 'AI_QUESTION', 'ai', null, { question: String(question).slice(0, 300) });
  return { answer: llm || text, dataAnswer: text, source: llm ? 'llm+database' : 'database', facts: f };
}

module.exports = { raise, capacity, forecast, scan, loadingRootCause, ask, callLLM, rawLLM, llmConfig, testLLM, llmInfo, cycleCountSuggestions, spaceSuggestions };
