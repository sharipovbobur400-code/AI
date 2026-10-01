'use strict';
// Daily AI reports to admins: 08:00 — how much cargo is in the warehouse and what must leave today (with times);
// 22:00 — what left today and what remains. Stored in daily_reports (visible on the web) and sent to the Telegram bot.
const db = require('./db');
const { clock, fmt } = require('./core');

const tzMin = () => Number(db.setting('report_tz_offset_min', Number(process.env.BOT_TZ_OFFSET_MIN ?? 300)));
const hours = () => ({ morning: Number(db.setting('report_morning_hour', Number(process.env.BOT_MORNING_HOUR || 8))), evening: Number(db.setting('report_evening_hour', Number(process.env.BOT_EVENING_HOUR || 22))) });
const n = (v) => fmt(Math.round(Number(v || 0) * 100) / 100);
const e = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function localParts(d = new Date()) { const l = new Date(d.getTime() + tzMin() * 60000); return { date: l.toISOString().slice(0, 10), hour: l.getUTCHours(), minute: l.getUTCMinutes() }; }
function dayBounds(date) { const start = new Date(new Date(`${date}T00:00:00Z`).getTime() - tzMin() * 60000); return { start: start.toISOString(), end: new Date(start.getTime() + 86400000).toISOString() }; }
const hm = (iso) => (iso ? new Date(new Date(iso).getTime() + tzMin() * 60000).toISOString().slice(11, 16) : '—');
const dmy = (date) => date.split('-').reverse().join('.');

function stockNow() {
  const rows = require('./inventory').stockSummary({ category: 'FINISHED' });
  const pal = db.get("SELECT COUNT(*) n, COALESCE(SUM(qty),0) q, COALESCE(SUM(gross_weight_kg),0) w FROM pallets WHERE status='PACKED'");
  const loaded = db.val("SELECT COALESCE(SUM(qty),0) FROM pallets WHERE status='LOADED'") || 0;
  return { skus: rows.filter((r) => r.on_hand > 0 || r.reserved > 0).map((r) => ({ sku: r.sku, name: r.name, unit: r.unit, available: r.available, reserved: r.reserved, free: r.free, packed: r.packed, picked: r.picked, onHand: r.on_hand })),
    onHand: rows.reduce((a, r) => a + r.on_hand, 0), available: rows.reduce((a, r) => a + r.available, 0), reserved: rows.reduce((a, r) => a + r.reserved, 0), free: rows.reduce((a, r) => a + Math.max(0, r.free), 0),
    readyPallets: pal.n, readyQty: pal.q, readyWeight: pal.w, loadedQty: loaded,
    materials: require('./inventory').stockSummary().filter((r) => r.category !== 'FINISHED' && r.low).map((r) => ({ sku: r.sku, free: r.free, min: r.min_stock, unit: r.unit })) };
}
function todayPlan(date) {
  const { end } = dayBounds(date);
  const shipments = db.all(`SELECT s.*, o.order_no, c.name customer, v.code vehicle, v.plate, d.full_name driver, d.phone driver_phone FROM shipments s LEFT JOIN orders o ON o.id=s.order_id LEFT JOIN customers c ON c.id=o.customer_id
    LEFT JOIN vehicles v ON v.id=s.vehicle_id LEFT JOIN drivers d ON d.id=s.driver_id WHERE s.status IN ('PLANNED','LOADING','LOADED') AND s.planned_departure<? ORDER BY s.planned_departure`, end);
  const orders = db.all(`SELECT o.*, c.name customer, (SELECT SUM(qty-shipped_qty) FROM order_items WHERE order_id=o.id) qty, (SELECT COALESCE(SUM(shortage_qty),0) FROM shortages WHERE order_id=o.id AND status IN ('OPEN','REQUESTED')) shortage,
      (SELECT status FROM dispatch_jobs j WHERE j.order_id=o.id ORDER BY id DESC LIMIT 1) dispatch_status
    FROM orders o LEFT JOIN customers c ON c.id=o.customer_id WHERE o.status NOT IN ('SHIPPED','DELIVERED','CANCELLED') AND o.due_date IS NOT NULL AND o.due_date<?
      AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.order_id=o.id AND s.status IN ('PLANNED','LOADING','LOADED')) ORDER BY o.due_date`, end);
  return { shipments, orders, qty: shipments.reduce((a, s) => a + (s.total_qty || 0), 0) + orders.reduce((a, o) => a + (o.qty || 0), 0),
    weight: shipments.reduce((a, s) => a + (s.total_weight_kg || 0), 0), pallets: shipments.reduce((a, s) => a + (s.pallet_count || 0), 0) };
}
const ORDER_ST = { NEW: 'yangi', PARTIALLY_RESERVED: 'qisman rezerv', RESERVED: 'rezervlangan, yig‘ilmagan', PICKING: 'yig‘ilmoqda', PICKED: 'yig‘ilgan, qadoqlanmagan', PACKED: 'qadoqlangan, transport kutilmoqda', LOADING: 'yuklanmoqda' };

function morning(date) {
  const st = stockNow(); const plan = todayPlan(date);
  const late = db.val("SELECT COUNT(*) FROM supplier_deliveries WHERE status IN ('CONFIRMED','IN_TRANSIT') AND expected_date<?", clock.addDays(-1));
  const freeVeh = db.val("SELECT COUNT(*) FROM vehicles WHERE status='AVAILABLE'"); const freeDrv = db.val("SELECT COUNT(*) FROM drivers WHERE status='AVAILABLE'");
  const L = [`🌅 <b>${hours().morning.toString().padStart(2, '0')}:00 — AI ombor hisoboti</b> · ${dmy(date)}`, '',
    `📦 <b>Omborda jami yuk: ${n(st.onHand)} dona</b> tayyor mahsulot`, `   • mavjud ${n(st.available)} · rezerv ${n(st.reserved)} · erkin ${n(st.free)}`,
    `   • jo‘natishga tayyor: <b>${n(st.readyQty)} dona / ${st.readyPallets} pallet</b> (${n(st.readyWeight)} kg)`,
    ...st.skus.slice(0, 8).map((s) => `   ▫️ ${e(s.sku)}: ${n(s.onHand)} ${e(s.unit)} (erkin ${n(s.free)})`), ''];
  if (plan.shipments.length || plan.orders.length) {
    L.push(`🚛 <b>Bugun chiqib ketishi kerak: ${n(plan.qty)} dona</b> — ${plan.shipments.length + plan.orders.length} ta jo‘natma/buyurtma${plan.weight ? `, ${n(plan.weight)} kg` : ''}${plan.pallets ? `, ${plan.pallets} pallet` : ''}`);
    for (const s of plan.shipments) L.push(`   • <b>${hm(s.planned_departure)}</b> — ${e(s.ship_no)} (${e(s.order_no)}) · ${n(s.total_qty)} dona · ${s.pallet_count} pallet → ${e(s.destination)} · ${e(s.vehicle)} ${e(s.plate || '')} / ${e(s.driver || '—')}${s.driver_phone ? ` ${e(s.driver_phone)}` : ''} · ${s.status === 'PLANNED' ? 'yuklanishi kerak' : s.status === 'LOADING' ? 'yuklanmoqda' : 'yuklangan'}`);
    for (const o of plan.orders) L.push(`   • <b>${hm(o.due_date)}</b> — ${e(o.order_no)} · ${e(o.customer)} · ${n(o.qty)} dona → ${e(o.destination || '—')} · ⚠️ ${e(ORDER_ST[o.status] || o.status)}${o.shortage ? ` · 🔴 ${n(o.shortage)} dona yetishmaydi` : ''}${o.dispatch_status === 'NO_TRANSPORT' ? ' · 🔴 transport topilmadi' : ''}`);
  } else L.push('🚛 Bugun jo‘natish rejalashtirilmagan.');
  L.push('', `🚚 Bo‘sh transport: ${freeVeh} · bo‘sh haydovchi: ${freeDrv}${late ? ` · 🔴 kechikayotgan supplier yetkazishlari: ${late}` : ''}`);
  if (st.materials.length) L.push(`🟠 Minimal darajadagi materiallar: ${st.materials.slice(0, 5).map((m) => `${e(m.sku)} (${n(m.free)} ${e(m.unit)})`).join(', ')}`);
  return { text: L.join('\n'), data: { stock: st, plan: { ...plan, shipments: plan.shipments.map((s) => ({ ship: s.ship_no, order: s.order_no, qty: s.total_qty, pallets: s.pallet_count, time: hm(s.planned_departure), destination: s.destination, vehicle: s.vehicle, driver: s.driver, status: s.status })), orders: plan.orders.map((o) => ({ order: o.order_no, customer: o.customer, qty: o.qty, time: hm(o.due_date), status: o.status, shortage: o.shortage })) }, freeVehicles: freeVeh, freeDrivers: freeDrv, lateSupplierDeliveries: late } };
}
function evening(date) {
  const { start, end } = dayBounds(date);
  const shipped = db.all(`SELECT s.*, o.order_no, c.name customer, v.code vehicle, d.full_name driver FROM shipments s LEFT JOIN orders o ON o.id=s.order_id LEFT JOIN customers c ON c.id=o.customer_id
    LEFT JOIN vehicles v ON v.id=s.vehicle_id LEFT JOIN drivers d ON d.id=s.driver_id WHERE s.departure>=? AND s.departure<? ORDER BY s.departure`, start, end);
  const txn = Object.fromEntries(db.all('SELECT type, COALESCE(SUM(qty),0) q FROM inventory_transactions t JOIN products p ON p.id=t.product_id WHERE p.category=\'FINISHED\' AND t.created_at>=? AND t.created_at<? GROUP BY type', start, end).map((r) => [r.type, r.q]));
  const st = stockNow(); const plan = todayPlan(date);
  const q = shipped.reduce((a, s) => a + (s.total_qty || 0), 0);
  const L = [`🌙 <b>${hours().evening.toString().padStart(2, '0')}:00 — AI kunlik yakun</b> · ${dmy(date)}`, '',
    `✅ <b>Bugun chiqib ketdi: ${n(q)} dona</b> — ${shipped.length} ta jo‘natma, ${shipped.reduce((a, s) => a + (s.pallet_count || 0), 0)} pallet, ${n(shipped.reduce((a, s) => a + (s.total_weight_kg || 0), 0))} kg`,
    ...shipped.map((s) => `   • ${hm(s.departure)} — ${e(s.ship_no)} (${e(s.order_no)}) · ${n(s.total_qty)} dona → ${e(s.destination)} · ${e(s.vehicle)} / ${e(s.driver || '—')}${s.status === 'DELIVERED' ? ' · yetkazildi' : ''}`), '',
    `📦 <b>Omborda qoldi: ${n(st.onHand)} dona</b> tayyor mahsulot (erkin ${n(st.free)}, rezerv ${n(st.reserved)}); jo‘natishga tayyor ${n(st.readyQty)} dona / ${st.readyPallets} pallet`,
    `📥 Bugun kirim: ${n(txn.RECEIVE)} dona · 📤 jo‘natildi (SHIP): ${n(txn.SHIP)} dona`];
  const left = [...plan.shipments.map((s) => `   • ${e(s.ship_no)} (${e(s.order_no)}) · ${n(s.total_qty)} dona · reja ${hm(s.planned_departure)} · ${s.status}`), ...plan.orders.map((o) => `   • ${e(o.order_no)} · ${n(o.qty)} dona · muddat ${hm(o.due_date)} · ${e(ORDER_ST[o.status] || o.status)}`)];
  if (left.length) L.push('', `❌ <b>Bugungi rejadan chiqmay qoldi: ${n(plan.qty)} dona</b>`, ...left);
  else L.push('', '✅ Bugungi reja to‘liq bajarildi.');
  const tomorrow = todayPlan(new Date(new Date(`${date}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10));
  L.push(`📅 Ertaga (shu jumladan bugundan qolganlar): ${n(tomorrow.qty)} dona chiqishi kerak.`);
  return { text: L.join('\n'), data: { shipped: shipped.map((s) => ({ ship: s.ship_no, order: s.order_no, qty: s.total_qty, time: hm(s.departure), destination: s.destination })), shippedQty: q, remaining: st, notShipped: left.length, receivedToday: txn.RECEIVE || 0, tomorrowQty: tomorrow.qty } };
}

async function build(kind, { send = true, date, force = false } = {}) {
  date = date || localParts().date;
  if (!force && db.get('SELECT id FROM daily_reports WHERE kind=? AND report_date=?', kind, date)) return db.get('SELECT * FROM daily_reports WHERE kind=? AND report_date=?', kind, date);
  const r = kind === 'morning' ? morning(date) : evening(date);
  const ask = kind === 'morning' ? 'Bugungi jo‘natish rejasi va ombor holati bo‘yicha 3-5 qatorli xulosa va eng muhim ustuvor vazifalarni yozing (qaysi yuk qachon chiqishi, qanday xavf bor).'
    : 'Kun yakuni: nima bajarildi, nima qoldi va ertaga nimaga e’tibor berish kerakligi haqida 3-5 qatorli xulosa yozing.';
  const ai = await require('./ai').callLLM(ask, r.data, 500).catch(() => null);
  const text = ai ? `${r.text}\n\n🧠 <b>AI xulosasi:</b>\n${e(ai).slice(0, 1500)}` : r.text;
  db.run(`INSERT INTO daily_reports(kind,report_date,text,data,ai_summary,sent_to,created_at) VALUES(?,?,?,?,?,0,?)
    ON CONFLICT(kind,report_date) DO UPDATE SET text=excluded.text, data=excluded.data, ai_summary=excluded.ai_summary, created_at=excluded.created_at`, kind, date, text, JSON.stringify(r.data), ai, clock.iso());
  let sent = 0;
  if (send) sent = require('./bot').sendReport(text, kind);
  db.run('UPDATE daily_reports SET sent_to=? WHERE kind=? AND report_date=?', sent, kind, date);
  db.emit('DAILY_REPORT', { kind, date, sent });
  return db.get('SELECT * FROM daily_reports WHERE kind=? AND report_date=?', kind, date);
}
function list(limit = 60) { return db.all('SELECT id, kind, report_date, text, ai_summary IS NOT NULL has_ai, sent_to, created_at FROM daily_reports ORDER BY report_date DESC, kind DESC LIMIT ?', limit); }

let timer = null;
const inflight = new Set();
function start() {
  timer = setInterval(() => {
    if (!require('./modules').logisticsOn()) return; // jo‘natma hisobotlari — logistika moduli bilan
    const { date, hour } = localParts(); const h = hours();
    for (const [kind, hh] of [['morning', h.morning], ['evening', h.evening]]) {
      const key = `${kind}:${date}`;
      if (hour === hh && !inflight.has(key) && !db.get('SELECT id FROM daily_reports WHERE kind=? AND report_date=?', kind, date)) {
        inflight.add(key);
        build(kind).catch((err) => console.error('daily report:', err.message)).finally(() => inflight.delete(key));
      }
    }
  }, 30000);
  timer.unref();
}
/** Serverless variant (Vercel Cron): builds any report whose hour has come and that was not sent yet today. */
async function tick() {
  if (!require('./modules').logisticsOn()) return { skipped: 'Logistika moduli o‘chirilgan' };
  const { date, hour } = localParts(); const h = hours(); const built = [];
  for (const [kind, hh] of [['morning', h.morning], ['evening', h.evening]]) {
    if (hour >= hh && hour < hh + 4 && !db.get('SELECT id FROM daily_reports WHERE kind=? AND report_date=?', kind, date)) { await build(kind); built.push(kind); }
  }
  return { date, hour, built };
}
module.exports = { build, list, start, tick, morning, evening, hours, localParts };
