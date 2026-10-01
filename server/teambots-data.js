'use strict';
// Jamoa botlari uchun bo‘lim ma’lumotlari: har bir bot faqat o‘z sohasidagi real ma’lumotni oladi (sayt bazasi = Odoo + WMS).
//   taminot — yetishmovchilik, zayavkalar, yetkazib berish, supplierlar, buyurtma kerak bo‘lgan mahsulotlar
//   ombor   — qoldiq, minimaldan past, sig‘im, QC kutayotgan kirim, picking/packing, bugungi harakatlar
//   ishlab  — ishlab chiqarishdan kirim, tayyor mahsulotga talab (buyurtma − erkin qoldiq), xomashyo, brak
//   xulosa  — hammasi qisqa + guruh suhbati
const db = require('./db');
const inv = require('./inventory');
const { clock, fmt } = require('./core');

const n = (v) => fmt(Math.round(Number(v || 0) * 100) / 100);
const day = (iso) => (iso ? String(iso).slice(0, 10) : '—');
const todayLocal = () => { const off = Number(process.env.BOT_TZ_OFFSET_MIN ?? 300); return new Date(Date.now() + off * 60000).toISOString().slice(0, 10); };
const sinceIso = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
const safe = (fn, def) => { try { return fn(); } catch { return def; } };
const TXN = { RECEIVE: 'Kirim', ISSUE: 'Chiqim', TRANSFER: 'Ko‘chirish', RESERVE: 'Rezerv', RELEASE: 'Rezerv bo‘shatildi', ADJUSTMENT: 'Tuzatish', RETURN: 'Qaytarish', REJECT: 'Brak', SCRAP: 'Scrap', REWORK: 'Rework', PACK: 'Qadoqlash', UNPACK: 'Ochish', SHIP: 'Jo‘natish' };

// ---------------- faktlar ----------------
function taminotFacts() {
  const stock = inv.stockSummary();
  const shortages = db.all(`SELECT s.shortage_no, s.shortage_qty, s.status, p.name, p.unit, o.order_no, o.due_date FROM shortages s JOIN products p ON p.id=s.product_id LEFT JOIN orders o ON o.id=s.order_id
    WHERE s.status IN ('OPEN','REQUESTED') ORDER BY o.due_date LIMIT 25`);
  const prs = db.all(`SELECT pr.pr_no, pr.qty, pr.status, pr.required_date, pr.priority, p.name, p.unit, s.company supplier FROM purchase_requests pr JOIN products p ON p.id=pr.product_id LEFT JOIN suppliers s ON s.id=pr.supplier_id
    WHERE pr.status NOT IN ('RECEIVED','REJECTED','CANCELLED') ORDER BY pr.required_date LIMIT 40`);
  const byStatus = Object.fromEntries(db.all("SELECT status, COUNT(*) n FROM purchase_requests WHERE status NOT IN ('RECEIVED','REJECTED','CANCELLED') GROUP BY status").map((r) => [r.status, r.n]));
  const now = clock.iso();
  const lateDeliveries = db.all(`SELECT d.delivery_no, d.qty, d.expected_date, d.status, s.company supplier, p.name FROM supplier_deliveries d JOIN suppliers s ON s.id=d.supplier_id LEFT JOIN products p ON p.id=d.product_id
    WHERE d.status IN ('CONFIRMED','IN_TRANSIT') AND d.expected_date<? ORDER BY d.expected_date LIMIT 20`, now);
  const upcoming = db.all(`SELECT d.delivery_no, d.qty, d.expected_date, d.status, s.company supplier, p.name FROM supplier_deliveries d JOIN suppliers s ON s.id=d.supplier_id LEFT JOIN products p ON p.id=d.product_id
    WHERE d.status IN ('CONFIRMED','IN_TRANSIT') AND d.expected_date>=? AND d.expected_date<? ORDER BY d.expected_date LIMIT 20`, now, clock.addDays(7));
  const needOrder = stock.filter((s) => s.low && !s.requested && !s.inbound).slice(0, 25).map((s) => ({ name: s.name, sku: s.sku, free: s.free, min: s.min_stock, unit: s.unit }));
  const odoo = safe(() => ({ open: db.val("SELECT COUNT(*) FROM odoo_purchases WHERE state IN ('draft','sent','to approve','purchase')"), late: db.val('SELECT COUNT(*) FROM odoo_purchases WHERE is_late=1'),
    lateList: db.all('SELECT name, partner, date_planned, receipt_status FROM odoo_purchases WHERE is_late=1 ORDER BY date_planned LIMIT 10') }), null);
  const t = todayLocal();
  return {
    sana: t, yetishmovchilik: shortages, zayavkalar_holat_boyicha: byStatus, ochiq_zayavkalar: prs, kechikkan_yetkazib_berish: lateDeliveries, yaqin_7_kunda_keladigan: upcoming,
    buyurtma_kerak_mahsulotlar: needOrder, supplierlar_soni: db.val('SELECT COUNT(*) FROM suppliers WHERE active=1'),
    bugun: { yangi_zayavka: db.val('SELECT COUNT(*) FROM purchase_requests WHERE substr(created_at,1,10)=?', t), kelgan_yetkazib_berish: db.val("SELECT COUNT(*) FROM supplier_deliveries WHERE substr(actual_date,1,10)=?", t) },
    odoo_xaridlar: odoo,
  };
}

function omborFacts() {
  const stock = inv.stockSummary();
  const cats = {};
  for (const s of stock) { const c = (cats[s.category] ||= { mahsulot: 0, mavjud: 0, rezerv: 0, erkin: 0 }); c.mahsulot++; c.mavjud += s.available; c.rezerv += s.reserved; c.erkin += s.free; }
  const cap = safe(() => require('./ai').capacity(), []);
  const pos = cap.reduce((a, c) => a + (c.positions || 0), 0); const used = cap.reduce((a, c) => a + (c.usedPallets || 0), 0);
  const t = todayLocal();
  const todayTx = db.all("SELECT type, COUNT(*) n, SUM(qty) qty FROM inventory_transactions WHERE substr(created_at,1,10)=? GROUP BY type", t);
  const lastTx = db.all(`SELECT t.type, t.qty, t.created_at, t.reference, p.name, p.unit FROM inventory_transactions t JOIN products p ON p.id=t.product_id ORDER BY t.id DESC LIMIT 12`);
  return {
    sana: t, kategoriyalar: cats, jami_mahsulot: stock.length,
    bugun_omborga_kelgan: (() => { const r = receiptsSince(dayStartIso()); return { kirimlar_soni: r.count, jami: r.total, manba_boyicha: r.bySource, mahsulotlar: r.products.slice(0, 25) }; })(),
    minimaldan_past: stock.filter((s) => s.low).slice(0, 25).map((s) => ({ name: s.name, sku: s.sku, erkin: s.free, min: s.min_stock, unit: s.unit, kelmoqda: s.inbound })),
    eng_kop_qoldiq: [...stock].sort((a, b) => b.available - a.available).slice(0, 10).map((s) => ({ name: s.name, mavjud: s.available, erkin: s.free, unit: s.unit })),
    sigim: { band_foiz: pos ? Math.round((used / pos) * 1000) / 10 : null, pallet_joy: pos, band_pallet: used, omborlar: cap.map((c) => ({ ombor: c.name || c.code, foiz: c.pct })) },
    qc_kutayotgan_kirim: db.all("SELECT r.rcv_no, r.qty_received, r.source, r.deadline, p.name, p.unit FROM receiving_orders r JOIN products p ON p.id=r.product_id WHERE r.status='RECEIVING' ORDER BY r.deadline LIMIT 15"),
    ochiq_picking: db.val("SELECT COUNT(*) FROM picking_tasks WHERE status IN ('PENDING','IN_PROGRESS')"),
    bugungi_harakatlar: todayTx.map((r) => ({ turi: TXN[r.type] || r.type, soni: r.n, miqdor: r.qty })), oxirgi_harakatlar: lastTx.map((r) => ({ turi: TXN[r.type] || r.type, miqdor: r.qty, unit: r.unit, mahsulot: r.name, vaqt: r.created_at, hujjat: r.reference })),
  };
}

function ishlabFacts() {
  const t = todayLocal();
  const week = clock.addDays(-7);
  const produced = db.all(`SELECT r.rcv_no, r.qty_received, r.received_date, r.production_order, r.status, p.name, p.unit FROM receiving_orders r JOIN products p ON p.id=r.product_id
    WHERE r.source='PRODUCTION' AND r.received_date>=? ORDER BY r.id DESC LIMIT 20`, week);
  const producedToday = db.get("SELECT COUNT(*) n, COALESCE(SUM(qty_received),0) q FROM receiving_orders WHERE source='PRODUCTION' AND substr(received_date,1,10)=?", t);
  // tayyor mahsulotga talab: ochiq buyurtmalar (jo‘natilmagan qism) − erkin qoldiq
  const demand = db.all(`SELECT oi.product_id, SUM(oi.qty - oi.shipped_qty) need, MIN(o.due_date) due FROM order_items oi JOIN orders o ON o.id=oi.order_id
    WHERE o.status NOT IN ('SHIPPED','DELIVERED','CANCELLED') GROUP BY oi.product_id`);
  const stock = Object.fromEntries(inv.stockSummary().map((s) => [s.product_id, s]));
  const toProduce = demand.map((d) => { const s = stock[d.product_id]; const free = s ? s.free + s.reserved : 0; return { name: s?.name, sku: s?.sku, unit: s?.unit, buyurtmada: d.need, omborda: free, ishlab_chiqarish_kerak: Math.max(0, d.need - free), muddat: d.due }; })
    .filter((x) => x.ishlab_chiqarish_kerak > 0).sort((a, b) => String(a.muddat).localeCompare(String(b.muddat))).slice(0, 20);
  const all = Object.values(stock);
  const rawLow = all.filter((s) => ['RAW', 'MATERIAL', 'PACKAGING'].includes(s.category) && s.low).slice(0, 20).map((s) => ({ name: s.name, erkin: s.free, min: s.min_stock, unit: s.unit, kelmoqda: s.inbound }));
  const defects = db.all("SELECT t.type, SUM(t.qty) qty, p.name, p.unit FROM inventory_transactions t JOIN products p ON p.id=t.product_id WHERE t.type IN ('REJECT','SCRAP','REWORK') AND t.created_at>=? GROUP BY t.type, p.id ORDER BY qty DESC LIMIT 10", week);
  const prodOrders = safe(() => db.all(`SELECT o.po_no, o.qty, o.good_qty, o.reject_qty, o.status, o.planned_end, o.line, p.name, p.unit FROM production_orders o JOIN products p ON p.id=o.product_id
    WHERE o.status IN ('PLANNED','RELEASED','IN_PROGRESS') ORDER BY o.planned_end LIMIT 20`), []);
  const mrpShort = safe(() => require('./production').mrp().filter((m) => m.status === 'SHORT').slice(0, 15).map((m) => ({ material: m.name, kerak: m.need, omborda: m.free, yetishmaydi: m.shortfall, unit: m.unit })), []);
  return {
    sana: t, bugun_ishlab_chiqarildi: { kirimlar: producedToday.n, miqdor: producedToday.q }, oxirgi_7_kun_kirimlar: produced,
    ishlab_chiqarish_buyurtmalari: prodOrders.map((o) => ({ raqam: o.po_no, mahsulot: o.name, reja: o.qty, bajarildi: o.good_qty, brak: o.reject_qty, holat: o.status, muddat: o.planned_end, liniya: o.line, kechikkan: o.planned_end && o.planned_end < clock.iso() })),
    material_yetishmaydi: mrpShort,
    ishlab_chiqarish_kerak: toProduce, yarim_tayyor_wip: all.filter((s) => s.category === 'WIP' && s.available > 0).slice(0, 15).map((s) => ({ name: s.name, mavjud: s.available, unit: s.unit })),
    tayyor_mahsulot: all.filter((s) => s.category === 'FINISHED').slice(0, 20).map((s) => ({ name: s.name, mavjud: s.available, erkin: s.free, rezerv: s.reserved, unit: s.unit })),
    xomashyo_kam: rawLow, brak_7_kun: defects.map((d) => ({ turi: TXN[d.type] || d.type, mahsulot: d.name, miqdor: d.qty, unit: d.unit })),
  };
}

function xulosaFacts() {
  const tm = taminotFacts(); const om = omborFacts(); const ish = ishlabFacts();
  return {
    sana: tm.sana,
    taminot: { yetishmovchilik: tm.yetishmovchilik.length, buyurtma_kerak: tm.buyurtma_kerak_mahsulotlar.slice(0, 10), kechikkan: tm.kechikkan_yetkazib_berish.slice(0, 8), keladigan_7_kun: tm.yaqin_7_kunda_keladigan.slice(0, 8), zayavkalar: tm.zayavkalar_holat_boyicha },
    ombor: { sigim: om.sigim.band_foiz, minimaldan_past: om.minimaldan_past.slice(0, 10), qc_kutmoqda: om.qc_kutayotgan_kirim.length, bugungi_harakatlar: om.bugungi_harakatlar },
    ishlab_chiqarish: { bugun: ish.bugun_ishlab_chiqarildi, kerak: ish.ishlab_chiqarish_kerak.slice(0, 10), xomashyo_kam: ish.xomashyo_kam.slice(0, 10), brak: ish.brak_7_kun.slice(0, 5) },
    jonatmalar: { faol: db.val("SELECT COUNT(*) FROM shipments WHERE status IN ('PLANNED','LOADING','LOADED','DISPATCHED')"), bugun_yetkazildi: db.val("SELECT COUNT(*) FROM shipments WHERE status IN ('ARRIVED','DELIVERED') AND substr(actual_arrival,1,10)=?", tm.sana) },
    ai_ogohlantirishlar: db.all("SELECT severity, title FROM ai_events WHERE status='OPEN' AND severity<>'INFO' ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 ELSE 1 END, id DESC LIMIT 10"),
  };
}
const FACTS = { taminot: taminotFacts, ombor: omborFacts, ishlab: ishlabFacts, xulosa: xulosaFacts };

// ---------------- AI'siz (deterministik) javoblar ----------------
const list = (rows, fn, empty = '—', max = 10) => (rows.length ? rows.slice(0, max).map((r, i) => `${i + 1}. ${fn(r)}`).join('\n') + (rows.length > max ? `\n… yana ${rows.length - max} ta` : '') : empty);

function dailyStats(domain, kind = 'evening') {
  const f = FACTS[domain]();
  const head = kind === 'morning' ? '🌅 Ertalabki reja' : '📊 Kunlik statistika';
  if (domain === 'taminot') {
    return `${head} — TA’MINOT · ${f.sana}\n\n🔴 Yetishmovchilik: ${f.yetishmovchilik.length} ta\n${list(f.yetishmovchilik, (s) => `${s.name}: ${n(s.shortage_qty)} ${s.unit} (${s.order_no || '—'}, muddat ${day(s.due_date)})`, '✅ yo‘q', 6)}
\n🧾 Ochiq zayavkalar: ${Object.entries(f.zayavkalar_holat_boyicha).map(([k, v]) => `${k} ${v}`).join(' · ') || 'yo‘q'}\n⏰ Kechikkan yetkazib berish: ${f.kechikkan_yetkazib_berish.length}${f.odoo_xaridlar?.late ? ` (+ Odoo: ${f.odoo_xaridlar.late})` : ''}\n${list(f.kechikkan_yetkazib_berish, (d) => `${d.supplier} — ${d.name || ''} ${n(d.qty)} (kutilgan ${day(d.expected_date)})`, '✅ yo‘q', 5)}
\n🚚 7 kunda keladi: ${f.yaqin_7_kunda_keladigan.length}\n🛒 Buyurtma berish kerak: ${f.buyurtma_kerak_mahsulotlar.length}\n${list(f.buyurtma_kerak_mahsulotlar, (p) => `${p.name}: erkin ${n(p.free)} / min ${n(p.min)} ${p.unit}`, '✅ yo‘q', 6)}
\nBugun: ${f.bugun.yangi_zayavka} ta yangi zayavka, ${f.bugun.kelgan_yetkazib_berish} ta yetkazib berish keldi.`;
  }
  if (domain === 'ombor') {
    return `${head} — OMBOR · ${f.sana}\n\n🏭 Sig‘im: ${f.sigim.band_foiz ?? '—'}% band (${n(f.sigim.band_pallet)} / ${n(f.sigim.pallet_joy)} pallet joyi)\n📦 Mahsulot turi: ${f.jami_mahsulot}\n${Object.entries(f.kategoriyalar).map(([c, v]) => `• ${c}: mavjud ${n(v.mavjud)}, rezerv ${n(v.rezerv)}, erkin ${n(v.erkin)}`).join('\n')}
\n🟡 Minimaldan past: ${f.minimaldan_past.length}\n${list(f.minimaldan_past, (p) => `${p.name}: ${n(p.erkin)} / min ${n(p.min)} ${p.unit}${p.kelmoqda ? ` (kelmoqda ${n(p.kelmoqda)})` : ''}`, '✅ yo‘q', 6)}
\n🧪 QC kutayotgan kirim: ${f.qc_kutayotgan_kirim.length} · 🛒 ochiq picking: ${f.ochiq_picking}\n🔁 Bugungi harakatlar: ${f.bugungi_harakatlar.map((h) => `${h.turi} ${h.soni}`).join(' · ') || 'yo‘q'}`;
  }
  if (domain === 'ishlab') {
    return `${head} — ISHLAB CHIQARISH · ${f.sana}\n\n🏭 Bugun ishlab chiqarildi: ${n(f.bugun_ishlab_chiqarildi.miqdor)} (${f.bugun_ishlab_chiqarildi.kirimlar} ta kirim)\n\n🎯 Buyurtmalar uchun ishlab chiqarish kerak: ${f.ishlab_chiqarish_kerak.length}\n${list(f.ishlab_chiqarish_kerak, (x) => `${x.name}: ${n(x.ishlab_chiqarish_kerak)} ${x.unit || ''} (buyurtmada ${n(x.buyurtmada)}, omborda ${n(x.omborda)}, muddat ${day(x.muddat)})`, '✅ talab qoldiq bilan qoplangan', 8)}
\n🧱 Xomashyo kam: ${f.xomashyo_kam.length}\n${list(f.xomashyo_kam, (p) => `${p.name}: ${n(p.erkin)} / min ${n(p.min)} ${p.unit}`, '✅ yetarli', 6)}
\n♻️ Brak/rework (7 kun): ${f.brak_7_kun.map((d) => `${d.mahsulot} ${d.turi} ${n(d.miqdor)}`).join(', ') || 'yo‘q'}`;
  }
  return null;
}

/** AI ishlamaganda: savoldagi kalit so‘zlarga qarab tegishli faktlarni matnga aylantiradi. */
function quickAnswer(domain, q) {
  const s = String(q || '').toLowerCase();
  const f = FACTS[domain]();
  if (domain === 'taminot') {
    if (/kechik|kelmadi|kelmagan/.test(s)) return `⏰ Kechikkan yetkazib berishlar (${f.kechikkan_yetkazib_berish.length}):\n${list(f.kechikkan_yetkazib_berish, (d) => `${d.supplier} — ${d.name || ''} ${n(d.qty)}, kutilgan ${day(d.expected_date)}`, '✅ Kechikish yo‘q')}${f.odoo_xaridlar?.lateList?.length ? `\n\nOdoo:\n${list(f.odoo_xaridlar.lateList, (o) => `${o.name} — ${o.partner}, ${day(o.date_planned)}`)}` : ''}`;
    if (/zayavka|so‘rov|so'rov|tasdiq/.test(s)) return `🧾 Ochiq zayavkalar (${f.ochiq_zayavkalar.length}):\n${list(f.ochiq_zayavkalar, (p) => `${p.pr_no} — ${p.name} ${n(p.qty)} ${p.unit} · ${p.status}${p.supplier ? ` · ${p.supplier}` : ''}`, 'yo‘q', 12)}`;
    if (/supplier|yetkazib beruvchi|ta.minotchi/.test(s)) return `🏢 Faol supplierlar: ${f.supplierlar_soni}. 7 kunda keladi:\n${list(f.yaqin_7_kunda_keladigan, (d) => `${d.supplier} — ${d.name || ''} ${n(d.qty)}, ${day(d.expected_date)}`, 'kutilayotgan yetkazib berish yo‘q')}`;
    if (/buyurtma ber|olish kerak|sotib ol|kam/.test(s)) return `🛒 Buyurtma berish kerak (${f.buyurtma_kerak_mahsulotlar.length}):\n${list(f.buyurtma_kerak_mahsulotlar, (p) => `${p.name}: erkin ${n(p.free)} / min ${n(p.min)} ${p.unit}`, '✅ hammasi yetarli')}`;
  }
  if (domain === 'ombor') {
    if (/bugun|keldi|kelgan|kirim/.test(s) && !/chiqim/.test(s)) return receiptsText('📥 Bugun omborga kelgan mahsulotlar', receiptsSince(dayStartIso()));
    const m =/(.+?)\s+(qancha|nechta|qoldig|bormi)/.exec(s);
    if (m) {
      const rows = inv.stockSummary({ q: m[1].trim() }).slice(0, 6);
      if (rows.length) return `📦 ${rows.map((r) => `${r.name} (${r.sku}): mavjud ${n(r.available)}, rezerv ${n(r.reserved)}, erkin ${n(r.free)} ${r.unit}${r.min_stock ? ` · min ${n(r.min_stock)}` : ''}`).join('\n')}`;
    }
    if (/kam|minimal|tugay/.test(s)) return `🟡 Minimaldan past (${f.minimaldan_past.length}):\n${list(f.minimaldan_past, (p) => `${p.name}: ${n(p.erkin)} / min ${n(p.min)} ${p.unit}`, '✅ yo‘q')}`;
    if (/sig.im|joy|band/.test(s)) return `🏭 Ombor ${f.sigim.band_foiz ?? '—'}% band: ${f.sigim.omborlar.map((o) => `${o.ombor} ${o.foiz}%`).join(', ')}`;
    if (/qc|sifat|tekshir/.test(s)) return `🧪 QC kutayotgan kirimlar (${f.qc_kutayotgan_kirim.length}):\n${list(f.qc_kutayotgan_kirim, (r) => `${r.rcv_no} — ${r.name} ${n(r.qty_received)} ${r.unit}`, 'yo‘q')}`;
  }
  if (domain === 'ishlab') {
    if (/jarayon|holat|buyurtmalar|prd|bajaril/.test(s) && f.ishlab_chiqarish_buyurtmalari.length) return `⚙️ Ishlab chiqarish buyurtmalari (${f.ishlab_chiqarish_buyurtmalari.length}):\n${list(f.ishlab_chiqarish_buyurtmalari, (o) => `${o.raqam} — ${o.mahsulot}: ${n(o.bajarildi)}/${n(o.reja)} · ${({ PLANNED: 'rejada', RELEASED: 'material berildi', IN_PROGRESS: 'jarayonda' })[o.holat] || o.holat}${o.kechikkan ? ' · ⏰ kechikdi' : ''}`, 'yo‘q')}`;
    if (/kerak|reja|nima ishlab|buyurtma/.test(s)) return `🎯 Ishlab chiqarish kerak (${f.ishlab_chiqarish_kerak.length}):\n${list(f.ishlab_chiqarish_kerak, (x) => `${x.name}: ${n(x.ishlab_chiqarish_kerak)} (muddat ${day(x.muddat)})`, '✅ talab qoplangan')}`;
    if (/xom|material/.test(s) && f.material_yetishmaydi.length) return `🧱 Ishlab chiqarish uchun material yetishmaydi (${f.material_yetishmaydi.length}):\n${list(f.material_yetishmaydi, (m) => `${m.material}: kerak ${n(m.kerak)}, omborda ${n(m.omborda)} → −${n(m.yetishmaydi)} ${m.unit}`, '')}`;
    if (/xom|material/.test(s)) return `🧱 Xomashyo kam (${f.xomashyo_kam.length}):\n${list(f.xomashyo_kam, (p) => `${p.name}: ${n(p.erkin)} / min ${n(p.min)} ${p.unit}`, '✅ yetarli')}`;
    if (/brak|rework|nuqson/.test(s)) return `♻️ Brak/rework (7 kun):\n${list(f.brak_7_kun, (d) => `${d.mahsulot}: ${d.turi} ${n(d.miqdor)} ${d.unit}`, '✅ yo‘q')}`;
  }
  return dailyStats(domain === 'xulosa' ? 'taminot' : domain, 'now');
}

// ---------------- hodisalar: qaysi bot nimani e’lon qiladi ----------------
function eventLine(ev) {
  const d = ev.payload || {};
  const p = (id) => (id ? db.get('SELECT name, unit, category FROM products WHERE id=?', id) : null);
  switch (ev.type) {
    case 'SHORTAGE_DETECTED': return { taminot: `🔴 Yetishmovchilik: ${d.sku} — ${n(d.shortage)} (${d.orderNo})`, ishlab: (p(d.productId)?.category === 'FINISHED') ? `🎯 ${d.sku}: buyurtma ${d.orderNo} uchun ${n(d.shortage)} ishlab chiqarish kerak` : null };
    case 'SHORTAGE_RESOLVED': return { taminot: '✅ Yetishmovchilik yopildi' };
    case 'SUPPLIER_REQUEST_CREATED': { const r = db.get('SELECT pr.pr_no, pr.qty, p.name, p.unit FROM purchase_requests pr JOIN products p ON p.id=pr.product_id WHERE pr.id=?', d.id); return r ? { taminot: `🧾 Yangi zayavka ${r.pr_no}: ${r.name} ${n(r.qty)} ${r.unit}` } : null; }
    case 'PURCHASE_REQUEST_STATUS': return { taminot: `🧾 Zayavka ${d.prNo}: ${d.from || ''} → ${d.to}` };
    case 'DELIVERY_DELAYED': return { taminot: `⏰ ${d.message}` };
    case 'SUPPLIER_DELIVERY_ARRIVED': return { taminot: `🚚 Supplier yuki keldi: ${n(d.qty)}`, ombor: `📥 Supplier yuki qabul zonasida: ${n(d.qty)} — QC kerak` };
    case 'MATERIAL_RECEIVED': return d.source === 'PRODUCTION' ? { ishlab: `🏭 Ishlab chiqarishdan kirim ${d.rcvNo}: ${d.sku} +${n(d.qty)}`, ombor: `📥 Kirim ${d.rcvNo}: ${d.sku} +${n(d.qty)} (ishlab chiqarishdan)` } : { ombor: `📥 Kirim ${d.rcvNo}: ${d.sku} +${n(d.qty)} (${d.source})` };
    case 'QC_FAILED': return { ombor: `⚠️ QC: ${d.sku} — ${n(d.failed)} brak zonasiga`, ishlab: `⚠️ Sifat: ${d.sku} — ${n(d.failed)} QC dan o‘tmadi` };
    case 'PICKING_COMPLETED': return { ombor: `✅ Picking tugadi: ${d.taskNo}` };
    case 'PACKING_COMPLETED': return { ombor: `📦 Qadoqlash tugadi: ${d.orderNo} (${n(d.pallets)} pallet)` };
    case 'PRODUCTION_CREATED': return { ishlab: `📝 Yangi ishlab chiqarish buyurtmasi ${d.poNo}: ${d.sku} — ${n(d.qty)}` };
    case 'PRODUCTION_STATUS': return { ishlab: `⚙️ ${d.poNo}: ${({ PLANNED: 'rejada', RELEASED: 'materiallar berildi', IN_PROGRESS: 'jarayonda', DONE: 'bajarildi ✅', CANCELLED: 'bekor qilindi' })[d.to] || d.to}` };
    case 'PRODUCTION_OUTPUT': return { ishlab: `🏭 ${d.poNo} natija: yaroqli ${n(d.good)}${d.reject ? `, brak ${n(d.reject)}` : ''}${d.rework ? `, rework ${n(d.rework)}` : ''}` };
    case 'ORDER_CREATED': { const o = db.get("SELECT o.order_no, (SELECT GROUP_CONCAT(p.sku || ' × ' || oi.qty, ', ') FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=o.id) items FROM orders o WHERE o.id=?", d.orderId); return o ? { ishlab: `🛒 Yangi buyurtma ${o.order_no}: ${o.items}` } : null; }
    case 'PRODUCT_CHANGED': return d.source ? { ombor: `🔄 Mahsulotlar yangilandi (${d.source})` } : null;
    case 'INTEGRATION_SYNC': return d.source === 'Odoo' ? { taminot: `🔄 Odoo sinxronizatsiyasi: ${d.stats?.purchase?.purchaseOrders ?? 0} xarid, ${d.stats?.purchase?.late ?? 0} kechikkan`, ombor: `🔄 Odoo: ${d.stats?.stock?.products ?? 0} mahsulot qoldig‘i yangilandi` } : null;
    case 'AI_ALERT': if (d.severity === 'INFO') return null; return d.type === 'DELIVERY_DELAY' || d.type === 'SHORTAGE' ? { taminot: `🤖 ${d.title}` } : ['LOW_STOCK', 'WAREHOUSE_CAPACITY', 'CYCLE_COUNT'].includes(d.type) ? { ombor: `🤖 ${d.title}` } : null;
    default: return null;
  }
}

// ---------------- bugun / oxirgi soat ----------------
/** Mahalliy (Toshkent) kun boshining UTC ISO vaqti. */
function dayStartIso() { const off = Number(process.env.BOT_TZ_OFFSET_MIN ?? 300); return new Date(Date.parse(`${todayLocal()}T00:00:00Z`) - off * 60000).toISOString(); }
/** Omborga kelgan mahsulotlar (kirimlar) — berilgan vaqtdan beri. */
function receiptsSince(iso) {
  const rows = db.all(`SELECT r.rcv_no, r.source, r.qty_received qty, r.status, r.created_at, p.name, p.unit, s.company supplier FROM receiving_orders r JOIN products p ON p.id=r.product_id
    LEFT JOIN suppliers s ON s.id=r.supplier_id WHERE r.created_at>=? ORDER BY r.id`, iso);
  const byProduct = {};
  for (const r of rows) { const k = `${r.name}|${r.unit}`; (byProduct[k] ||= { name: r.name, unit: r.unit, qty: 0, n: 0 }); byProduct[k].qty += r.qty; byProduct[k].n++; }
  const src = { SUPPLIER: 'supplierdan', PRODUCTION: 'ishlab chiqarishdan', RETURN: 'qaytarilgan', REWORK: 'qayta ishlangan', OTHER: 'boshqa', TRANSFER: 'ko‘chirilgan' };
  const bySource = {}; for (const r of rows) bySource[src[r.source] || r.source] = (bySource[src[r.source] || r.source] || 0) + r.qty;
  return { count: rows.length, total: rows.reduce((a, r) => a + r.qty, 0), products: Object.values(byProduct).sort((a, b) => b.qty - a.qty), bySource, rows };
}
const issuesSince = (iso) => db.get("SELECT COUNT(*) n, COALESCE(SUM(qty),0) q FROM inventory_transactions WHERE type IN ('ISSUE','SHIP') AND created_at>=?", iso);

function receiptsText(title, r) {
  if (!r.count) return `${title}: omborga hali mahsulot kelmagan.`;
  return `${title}: ${r.count} ta kirim, jami ${n(r.total)} birlik (${Object.entries(r.bySource).map(([s, q]) => `${s} ${n(q)}`).join(', ')}).\n${list(r.products, (p) => `${p.name}: ${n(p.qty)} ${p.unit}${p.n > 1 ? ` (${p.n} ta kirim)` : ''}`, '', 12)}`;
}

/** Soatlik hisobot (guruhga har soatda). */
function hourlyReport(domain, hhmm) {
  const hourAgo = sinceIso(1); const today = dayStartIso();
  if (domain === 'ombor') {
    const h = receiptsSince(hourAgo); const t = receiptsSince(today); const out = issuesSince(hourAgo); const f = omborFacts();
    return `🕐 ${hhmm} · OMBOR — soatlik hisobot\n\n📥 Oxirgi soatda kirim: ${h.count} ta (${n(h.total)})${h.products.length ? `\n${list(h.products, (p) => `${p.name}: +${n(p.qty)} ${p.unit}`, '', 6)}` : ''}\n📤 Oxirgi soatda chiqim: ${out.n} ta (${n(out.q)})\n📦 Bugun jami kelgan: ${n(t.total)} (${t.count} ta kirim)\n🟡 Minimaldan past: ${f.minimaldan_past.length} · 🧪 QC navbati: ${f.qc_kutayotgan_kirim.length} · 🏭 band: ${f.sigim.band_foiz ?? '—'}%`;
  }
  if (domain === 'taminot') {
    const f = taminotFacts();
    const prH = db.val('SELECT COUNT(*) FROM purchase_requests WHERE created_at>=?', hourAgo);
    const arrivedH = db.all('SELECT d.qty, s.company supplier, p.name FROM supplier_deliveries d JOIN suppliers s ON s.id=d.supplier_id LEFT JOIN products p ON p.id=d.product_id WHERE d.actual_date>=?', hourAgo);
    return `🕐 ${hhmm} · TA’MINOT — soatlik hisobot\n\n🧾 Oxirgi soatda yangi zayavka: ${prH} · ochiq: ${Object.values(f.zayavkalar_holat_boyicha).reduce((a, b) => a + b, 0)}\n🚚 Oxirgi soatda kelgan yetkazib berish: ${arrivedH.length}${arrivedH.length ? `\n${list(arrivedH, (d) => `${d.supplier}: ${d.name || ''} ${n(d.qty)}`, '', 5)}` : ''}\n⏰ Kechikkan: ${f.kechikkan_yetkazib_berish.length}${f.odoo_xaridlar?.late ? ` (+ Odoo ${f.odoo_xaridlar.late})` : ''} · 🔴 yetishmovchilik: ${f.yetishmovchilik.length}\n🛒 Buyurtma berish kerak: ${f.buyurtma_kerak_mahsulotlar.length}${f.buyurtma_kerak_mahsulotlar.length ? ` — ${f.buyurtma_kerak_mahsulotlar.slice(0, 4).map((p) => p.name).join(', ')}` : ''}`;
  }
  if (domain === 'ishlab') {
    const f = ishlabFacts();
    const h = db.get("SELECT COUNT(*) n, COALESCE(SUM(qty_received),0) q FROM receiving_orders WHERE source='PRODUCTION' AND created_at>=?", hourAgo);
    const t = db.get("SELECT COALESCE(SUM(qty_received),0) q FROM receiving_orders WHERE source='PRODUCTION' AND created_at>=?", today);
    const def = db.get("SELECT COALESCE(SUM(qty),0) q FROM inventory_transactions WHERE type IN ('REJECT','SCRAP') AND created_at>=?", hourAgo);
    const po = f.ishlab_chiqarish_buyurtmalari;
    return `🕐 ${hhmm} · ISHLAB CHIQARISH — soatlik hisobot\n\n⚙️ Ochiq buyurtmalar: ${po.length} (jarayonda ${po.filter((o) => o.holat === 'IN_PROGRESS').length}, kechikkan ${po.filter((o) => o.kechikkan).length})${f.material_yetishmaydi.length ? ` · 🧱 material yetishmaydi: ${f.material_yetishmaydi.length}` : ''}\n🏭 Oxirgi soatda ishlab chiqarildi: ${n(h.q)} (${h.n} ta kirim) · bugun jami: ${n(t.q)}\n🎯 Buyurtmalar uchun ishlab chiqarish kerak: ${f.ishlab_chiqarish_kerak.length}${f.ishlab_chiqarish_kerak.length ? `\n${list(f.ishlab_chiqarish_kerak, (x) => `${x.name}: ${n(x.ishlab_chiqarish_kerak)} (muddat ${day(x.muddat)})`, '', 4)}` : ''}\n🧱 Xomashyo kam: ${f.xomashyo_kam.length}${f.xomashyo_kam.length ? ` — ${f.xomashyo_kam.slice(0, 4).map((p) => p.name).join(', ')}` : ''} · ♻️ oxirgi soatda brak: ${n(def.q)}`;
  }
  return null;
}

/** Botlar suhbati: bir bot javob bergach, boshqa bot o‘z ma’lumoti bilan qo‘shimcha qiladi. */
const FOLLOW = { ombor: 'taminot', taminot: 'ombor', ishlab: 'ombor' };
function followUp(from, to, question) {
  const s = String(question || '').toLowerCase();
  if (to === 'taminot') {
    const f = taminotFacts(); const today = dayStartIso();
    const arrived = db.all('SELECT d.qty, s.company supplier, p.name FROM supplier_deliveries d JOIN suppliers s ON s.id=d.supplier_id LEFT JOIN products p ON p.id=d.product_id WHERE d.actual_date>=?', today);
    const fromSup = receiptsSince(today).bySource.supplierdan || 0;
    return `🧾 Ta’minot qo‘shimchasi: bugun supplierlardan ${n(fromSup)} birlik keldi${arrived.length ? ` (${arrived.slice(0, 4).map((d) => `${d.supplier}: ${d.name || ''} ${n(d.qty)}`).join('; ')})` : ''}.\n🚚 Yaqin 7 kunda yana ${f.yaqin_7_kunda_keladigan.length} ta yetkazib berish kutilmoqda${f.yaqin_7_kunda_keladigan[0] ? ` (eng yaqini: ${f.yaqin_7_kunda_keladigan[0].supplier}, ${day(f.yaqin_7_kunda_keladigan[0].expected_date)})` : ''}.\n⏰ Kechikkan: ${f.kechikkan_yetkazib_berish.length}${f.kechikkan_yetkazib_berish[0] ? ` — ${f.kechikkan_yetkazib_berish[0].supplier}` : ''} · 🛒 buyurtma kerak: ${f.buyurtma_kerak_mahsulotlar.length}`;
  }
  if (to === 'ombor') {
    const f = omborFacts();
    if (from === 'ishlab' || /xom|material|ishlab/.test(s)) {
      const raw = ishlabFacts().xomashyo_kam;
      return `📦 Ombor qo‘shimchasi: xomashyo ${raw.length ? `kam — ${raw.slice(0, 5).map((p) => `${p.name} ${n(p.erkin)}/${n(p.min)} ${p.unit}`).join(', ')}` : 'yetarli ✅'}. Tayyor mahsulot erkin qoldig‘i: ${n(f.kategoriyalar.FINISHED?.erkin || 0)}.`;
    }
    return `📦 Ombor qo‘shimchasi: kiruvchi yuklar uchun joy ${f.sigim.band_foiz != null ? `${Math.max(0, 100 - f.sigim.band_foiz).toFixed(1)}% bo‘sh` : 'ma’lum emas'}, QC navbatida ${f.qc_kutayotgan_kirim.length} ta kirim, minimaldan past ${f.minimaldan_past.length} ta mahsulot.`;
  }
  return null;
}

module.exports = { FACTS, dailyStats, quickAnswer, eventLine, todayLocal, sinceIso, n, receiptsSince, receiptsText, dayStartIso, hourlyReport, followUp, FOLLOW };
