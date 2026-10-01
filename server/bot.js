'use strict';
// Telegram bot: pushes every WMS event to the right people (role + personal preferences),
// runs an AI supervisor (daily briefings, escalation of unresolved critical alerts), answers questions,
// and lets authorised users act (approve/reject purchase requests, create AI purchase drafts, ack alerts).
// Zero dependencies: Telegram Bot API over fetch + long polling. Token lives only in .env.
const crypto = require('node:crypto');
const db = require('./db');
const auth = require('./auth');
const { bus, clock, AppError, fmt } = require('./core');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_links (chat_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), chat_type TEXT, chat_title TEXT, tg_username TEXT,
  prefs TEXT, active INTEGER DEFAULT 1, linked_at TEXT, last_seen TEXT);
CREATE TABLE IF NOT EXISTS bot_link_codes (code TEXT PRIMARY KEY, user_id INTEGER NOT NULL, driver_id INTEGER, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS bot_messages (id INTEGER PRIMARY KEY, chat_id TEXT, direction TEXT, kind TEXT, text TEXT, status TEXT, error TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS ix_botmsg ON bot_messages(created_at);
CREATE TABLE IF NOT EXISTS bot_escalations (event_id INTEGER PRIMARY KEY, at TEXT);
CREATE TABLE IF NOT EXISTS bot_state (chat_id TEXT PRIMARY KEY, state TEXT, data TEXT, updated_at TEXT);
`;

const CATEGORIES = { ombor: '📦 Ombor (kirim, chiqim, QC, harakatlar)', buyurtma: '🛒 Buyurtma, yig‘ish, packing', taminot: '🧾 Ta’minot, supplier, yetishmovchilik',
  logistika: '🚚 Transport, yuklash, jo‘natma', xetq: '📑 XETQ va hujjatlar', ai: '🤖 AI ogohlantirishlar', brifing: '📰 AI kunlik brifing / kechki hisobot' };
const ROLE_DEFAULTS = { SUPERADMIN: Object.keys(CATEGORIES), DIRECTOR: Object.keys(CATEGORIES), ADMIN: Object.keys(CATEGORIES), MANAGER: Object.keys(CATEGORIES), STOREKEEPER: ['ombor', 'buyurtma', 'ai'],
  QC: ['ombor', 'xetq', 'ai'], LOGISTICS: ['logistika', 'buyurtma', 'ai', 'brifing'], PROCUREMENT: ['taminot', 'ai', 'brifing'], VIEWER: ['ai', 'brifing'] };
const LEVELS = ['CRITICAL', 'WARNING', 'INFO'];
const TXN = { RECEIVE: '📥 Kirim', ISSUE: '📤 Chiqim', TRANSFER: '🔁 Ko‘chirish', RESERVE: '🔒 Rezerv', RELEASE: '🔓 Rezerv bo‘shatildi', ADJUSTMENT: '⚖️ Tuzatish', RETURN: '↩️ Qaytarish', REJECT: '🗑 Reject', SCRAP: '🗑 Scrap', REWORK: '🛠 Rework', PACK: '📦 Qadoqlash', UNPACK: '📭 Ochish', SHIP: '🚛 Jo‘natish' };
const ST = { NEW: 'Yangi', RESERVED: 'Rezervlangan', PARTIALLY_RESERVED: 'Qisman rezerv', PICKING: 'Yig‘ilmoqda', PICKED: 'Yig‘ildi', PACKED: 'Qadoqlandi', LOADING: 'Yuklanmoqda', SHIPPED: 'Jo‘natildi', DELIVERED: 'Yetkazildi', CANCELLED: 'Bekor qilindi',
  REQUESTED: 'So‘ralgan', APPROVED: 'Tasdiqlandi', ORDERED: 'Buyurtma berildi', SUPPLIER_CONFIRMED: 'Supplier tasdiqladi', IN_TRANSIT: 'Yo‘lda', ARRIVED: 'Keldi', QC: 'QC', RECEIVED: 'Qabul qilindi', REJECTED: 'Rad etildi',
  DRAFT: 'Qoralama', INTERNAL_REVIEW: 'Ichki tekshiruv', READY_FOR_SUBMISSION: 'Topshirishga tayyor', SUBMITTED: 'Topshirildi', UNDER_REVIEW: 'XETQ ko‘rmoqda', REVISION_REQUIRED: 'Tuzatish talab qilinadi',
  AVAILABLE: 'Available', MAINTENANCE: 'Ta’mirda', UNAVAILABLE: 'Mavjud emas', IN_TRANSIT_V: 'Yo‘lda', LOADING_V: 'Yuklanmoqda' };
const VEH = { AVAILABLE: '🟢', RESERVED: '🟡', LOADING: '🔵', IN_TRANSIT: '🟠', MAINTENANCE: '🔴', UNAVAILABLE: '⚫' };

const e = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const n = (v) => fmt(Math.round(Number(v || 0) * 100) / 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cfg = {
  token: () => require('./secrets').get('TELEGRAM_BOT_TOKEN') || '',
  api: () => `${(process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '')}/bot${activeToken || cfg.token()}`,
  baseUrl: () => (process.env.WMS_BASE_URL || '').replace(/\/$/, ''),
  batchMs: () => Number(process.env.BOT_BATCH_SECONDS || 20) * 1000,
  tzMin: () => Number(process.env.BOT_TZ_OFFSET_MIN ?? 300),
  morning: () => Number(process.env.BOT_MORNING_HOUR ?? 8),
  evening: () => Number(process.env.BOT_EVENING_HOUR ?? 18),
  escalateMin: () => Number(process.env.BOT_ESCALATE_MINUTES ?? 30),
  pollTimeout: () => Number(process.env.BOT_POLL_TIMEOUT ?? 25),
};
const SERVERLESS = !!process.env.VERCEL || process.env.WMS_SERVERLESS === '1';
let me = null; let running = false; let lastError = null; let startedAt = null; let activeToken = null; let generation = 0;
const link = (path, label = 'Saytda ochish') => (cfg.baseUrl() ? ` · <a href="${e(cfg.baseUrl())}/#${e(path)}">${e(label)}</a>` : '');
const urlButton = (path, text = '🌐 Saytda ochish') => (cfg.baseUrl() && /^https:\/\//.test(cfg.baseUrl()) ? [{ text, url: `${cfg.baseUrl()}/#${path}` }] : null);

// ---------------- Telegram transport ----------------
async function tg(method, params = {}, timeoutMs = 15000) {
  const res = await fetch(`${cfg.api()}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(timeoutMs) });
  const j = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!j.ok) { const err = new Error(j.description || 'Telegram xatosi'); err.code = j.error_code || res.status; err.retryAfter = j.parameters?.retry_after; throw err; }
  return j.result;
}
const queue = []; let pumping = false;
function logMsg(chatId, direction, kind, text, status, error) {
  try { db.insert('bot_messages', { chat_id: String(chatId), direction, kind, text: String(text || '').slice(0, 1000), status, error: error || null, created_at: clock.iso() }); } catch {}
}
function send(chatId, text, extra = {}, kind = 'message') {
  if (!enabled()) return;
  queue.push({ chatId: String(chatId), text: String(text).slice(0, 4000), extra, kind }); pump();
}
async function pump() {
  if (pumping) return; pumping = true;
  while (queue.length) {
    const m = queue.shift();
    try { await tg('sendMessage', { chat_id: m.chatId, text: m.text, parse_mode: 'HTML', disable_web_page_preview: true, ...m.extra }); logMsg(m.chatId, 'OUT', m.kind, m.text, 'SENT'); }
    catch (err) {
      if (err.retryAfter) { queue.unshift(m); await sleep(err.retryAfter * 1000 + 200); continue; }
      if (err.code === 403 || /chat not found|bot was blocked|kicked/i.test(err.message)) db.run('UPDATE bot_links SET active=0 WHERE chat_id=?', m.chatId);
      logMsg(m.chatId, 'OUT', m.kind, m.text, 'FAILED', err.message); lastError = err.message;
    }
    await sleep(45); // ~20 msg/s — under Telegram's global limit
  }
  pumping = false;
}
const kb = (rows) => (rows && rows.filter((r) => r && r.length).length ? { reply_markup: { inline_keyboard: rows.filter((r) => r && r.length) } } : {});

// ---------------- users, links, preferences ----------------
function userOf(id) { const u = db.get('SELECT id, username, full_name, role_code, active FROM users WHERE id=?', id); return u && u.active ? { id: u.id, username: u.username, fullName: u.full_name, role: u.role_code, ip: 'telegram' } : null; }
function prefsOf(l) { const p = l.prefs ? JSON.parse(l.prefs) : {}; const u = userOf(l.user_id); return { cats: p.cats || ROLE_DEFAULTS[u?.role] || ['ai'], level: p.level || 'WARNING', mute: !!p.mute }; }
function links() { return db.all('SELECT * FROM bot_links WHERE active=1').map((l) => ({ ...l, user: userOf(l.user_id) })).filter((l) => l.user); }
function linkOfChat(chatId) { const l = db.get('SELECT * FROM bot_links WHERE chat_id=? AND active=1', String(chatId)); if (!l) return null; const u = userOf(l.user_id); return u ? { ...l, user: u } : null; }

/** Deliver one event to every matching chat. opts: { cat, roles, perm, userIds, level, buttons(user), always } */
function notify(text, opts = {}) {
  for (const l of links()) {
    const p = prefsOf(l);
    const personal = opts.userIds && opts.userIds.includes(l.user.id);
    if (!personal) {
      if (opts.userIds && opts.only) continue;
      if (p.mute && !opts.always) continue;
      if (opts.cat && !p.cats.includes(opts.cat)) continue;
      if (opts.level && LEVELS.indexOf(opts.level) > LEVELS.indexOf(p.level)) continue;
      if (opts.roles && !opts.roles.includes(l.user.role)) continue;
      if (opts.perm && !auth.can(l.user, opts.perm)) continue;
    }
    send(l.chat_id, text, kb(opts.buttons ? opts.buttons(l.user) : null), opts.kind || opts.cat || 'event');
  }
  const group = process.env.TELEGRAM_GROUP_CHAT_ID;
  if (group && !opts.only && !db.get('SELECT 1 FROM bot_links WHERE chat_id=? AND active=1', group)) send(group, text, {}, 'group');
}
const actor = (ev) => { if (!ev.user_id) return '🤖 tizim'; const u = db.get('SELECT full_name FROM users WHERE id=?', ev.user_id); return `👤 ${e(u?.full_name || '—')}`; };

// ---------------- event → message formatting ----------------
let stockBuf = []; let stockTimer = null;
function flushStock() {
  stockTimer = null; const nos = stockBuf.splice(0); if (!nos.length) return;
  const rows = db.all(`SELECT t.type, t.qty, t.reference, t.reason, p.sku, p.unit, u.full_name, lf.code f, lt.code tt FROM inventory_transactions t JOIN products p ON p.id=t.product_id LEFT JOIN users u ON u.id=t.user_id
    LEFT JOIN warehouse_locations lf ON lf.id=t.from_location_id LEFT JOIN warehouse_locations lt ON lt.id=t.to_location_id WHERE t.txn_no IN (${nos.map(() => '?').join(',')}) ORDER BY t.id`, ...nos);
  if (!rows.length) return;
  // aggregate same type+sku+reference
  const agg = new Map();
  for (const r of rows) { const k = `${r.type}|${r.sku}|${r.reference || ''}`; const a = agg.get(k) || { ...r, qty: 0, n: 0 }; a.qty += r.qty; a.n++; agg.set(k, a); }
  const lines = [...agg.values()];
  const sign = (t) => (['RECEIVE', 'RETURN'].includes(t) ? '+' : ['ISSUE', 'SHIP', 'SCRAP'].includes(t) ? '−' : '');
  const txt = `📦 <b>Ombor harakatlari</b> — ${rows.length} ta tranzaksiya\n${lines.slice(0, 15).map((r) => `• ${TXN[r.type] || r.type}: <b>${sign(r.type)}${n(r.qty)}</b> ${e(r.unit)} ${e(r.sku)}${r.reference ? ` · ${e(r.reference)}` : ''}${r.full_name ? ` · ${e(r.full_name)}` : ''}`).join('\n')}${lines.length > 15 ? `\n… yana ${lines.length - 15} ta` : ''}${link('/transactions', 'Jurnal')}`;
  notify(txt, { cat: 'ombor', kind: 'stock' });
}

function onEvent(ev) {
  const d = ev.payload || {};
  const who = actor(ev);
  switch (ev.type) {
    case 'STOCK_CHANGED': if (d.txnNo) { stockBuf.push(d.txnNo); if (!stockTimer) stockTimer = setTimeout(flushStock, cfg.batchMs()); } return;
    case 'ORDER_CREATED': {
      const o = db.get(`SELECT o.*, c.name customer, pj.code project, (SELECT SUM(qty) FROM order_items WHERE order_id=o.id) qty,
        (SELECT GROUP_CONCAT(p.sku || ' × ' || oi.qty, ', ') FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=o.id) items FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN projects pj ON pj.id=o.project_id WHERE o.id=?`, d.orderId);
      if (!o) return;
      return notify(`🛒 <b>Yangi buyurtma ${e(o.order_no)}</b>\nMijoz: ${e(o.customer)}${o.project ? ` · loyiha ${e(o.project)}` : ''}\nMahsulot: ${e(o.items)}\nMuddat: ${o.due_date ? e(o.due_date.slice(0, 16).replace('T', ' ')) : '—'} · muhimlik ${e(o.priority)}\n${who}${link(`/orders/${o.id}`)}`, { cat: 'buyurtma' });
    }
    case 'ORDER_STATUS': if (!['PACKED', 'SHIPPED', 'DELIVERED', 'CANCELLED'].includes(d.status)) return; {
      const o = db.get('SELECT order_no FROM orders WHERE id=?', d.orderId);
      return notify(`${d.status === 'CANCELLED' ? '⛔' : '✅'} Buyurtma <b>${e(o?.order_no)}</b> → ${e(ST[d.status] || d.status)}${link(`/orders/${d.orderId}`)}`, { cat: 'buyurtma' });
    }
    case 'SHORTAGE_DETECTED': {
      const s = db.get('SELECT s.*, p.name, p.unit, o.due_date FROM shortages s JOIN products p ON p.id=s.product_id LEFT JOIN orders o ON o.id=s.order_id WHERE s.id=?', d.shortageId);
      if (!s) return;
      return notify(`🔴 <b>YETISHMOVCHILIK</b> ${e(s.shortage_no)}\n${e(s.name)}: <b>${n(s.shortage_qty)} ${e(s.unit)}</b> yetishmaydi\nBuyurtma ${e(d.orderNo)} · kerak ${n(s.required_qty)} · muddat ${e((s.due_date || '').slice(0, 10))}\n🤖 AI: ta’minot zayavkasi loyihasini tayyorlashni tavsiya qiladi (yuborishdan oldin tasdiq talab qilinadi).${link('/shortages')}`,
        { cat: 'taminot', buttons: (u) => [auth.can(u, 'procurement.request') ? [{ text: '🤖 AI zayavka yaratish', callback_data: `sh:pr:${s.id}` }] : null, urlButton('/shortages')] });
    }
    case 'SHORTAGE_RESOLVED': { const s = db.get('SELECT s.shortage_no, p.sku FROM shortages s JOIN products p ON p.id=s.product_id WHERE s.id=?', d.shortageId); return notify(`✅ Yetishmovchilik yopildi: ${e(s?.shortage_no)} (${e(s?.sku)}) — stock yetarli, rezerv qilindi.`, { cat: 'taminot' }); }
    case 'SUPPLIER_REQUEST_CREATED': {
      const r = db.get('SELECT pr.*, p.name, p.unit, s.company, u.full_name creator FROM purchase_requests pr JOIN products p ON p.id=pr.product_id LEFT JOIN suppliers s ON s.id=pr.supplier_id LEFT JOIN users u ON u.id=pr.created_by WHERE pr.id=?', d.id);
      if (!r) return;
      return notify(`🧾 <b>Yangi ta’minot zayavkasi ${e(r.pr_no)}</b>${r.ai_generated ? ' 🤖' : ''}\n${e(r.name)}: <b>${n(r.qty)} ${e(r.unit)}</b>\nSupplier: ${e(r.company)} · kerak: ${e((r.required_date || '').slice(0, 10))} · ${e(r.priority)}\nSabab: ${e(r.reason)}\nTuzdi: ${e(r.creator || '—')} · holat: <b>tasdiqlash kutilmoqda</b>${link(`/purchase?open=${r.id}`)}`,
        { cat: 'taminot', buttons: (u) => [auth.can(u, 'procurement.approve') && (u.id !== r.created_by || auth.FULL.includes(u.role)) ? [{ text: '✅ Tasdiqlash', callback_data: `pr:ok:${r.id}` }, { text: '❌ Rad etish', callback_data: `pr:no:${r.id}` }] : null] });
    }
    case 'PURCHASE_REQUEST_STATUS': return notify(`🧾 Zayavka <b>${e(d.prNo)}</b>: ${e(ST[d.from] || d.from || '—')} → <b>${e(ST[d.to] || d.to)}</b>\n${who}`, { cat: 'taminot' });
    case 'DELIVERY_DELAYED': return notify(`🔴 <b>DELIVERY DELAY</b>\n${e(d.message)}${link('/deliveries')}`, { cat: 'taminot', buttons: (u) => [d.alertId ? [{ text: '👁 Ko‘rildi', callback_data: `al:ack:${d.alertId}` }] : null] });
    case 'DELIVERY_UPDATED': { const x = db.get('SELECT d.delivery_no, d.expected_date, s.company FROM supplier_deliveries d JOIN suppliers s ON s.id=d.supplier_id WHERE d.id=?', d.deliveryId); return notify(`📅 Yetkazish sanasi o‘zgardi: ${e(x?.delivery_no)} (${e(x?.company)}) → ${e((x?.expected_date || '').slice(0, 10))}\n${who}`, { cat: 'taminot' }); }
    case 'SUPPLIER_DELIVERY_ARRIVED': return notify(`🚚 Supplier yuki keldi: <b>${n(d.qty)}</b> — qabul zonasida, QC kutilmoqda.\n${who}`, { cat: 'taminot' });
    case 'MATERIAL_RECEIVED': return notify(`📥 <b>Kirim ${e(d.rcvNo)}</b>: ${e(d.sku)} <b>+${n(d.qty)}</b> (${e(d.source)})\nHolat: RECEIVING — QC o‘tkazilishi kerak.\n${who}${link('/receiving')}`, { cat: 'ombor' });
    case 'QC_FAILED': return notify(`⚠️ <b>QC FAIL</b>: ${e(d.sku)} — ${n(d.failed)} dona brak zonasiga o‘tkazildi.\n${who}${link('/quality')}`, { cat: 'ombor' });
    case 'PICKING_STARTED': return notify(`🟡 Picking boshlandi: <b>${e(d.taskNo)}</b>\n${who}`, { cat: 'buyurtma' });
    case 'PICKING_COMPLETED': { const o = db.get('SELECT order_no FROM orders WHERE id=?', d.orderId); return notify(`✅ <b>Picking completed</b>: ${e(d.taskNo)} (${e(o?.order_no)}) — mahsulot Packing zonasida.\n${who}`, { cat: 'buyurtma' }); }
    case 'PACKING_COMPLETED': return notify(`📦 <b>Qadoqlash tugadi</b>: ${e(d.orderNo)} — ${n(d.pallets)} ta pallet. Transport tanlash kerak.\n${who}${link(`/orders/${d.orderId}`)}`, { cat: 'buyurtma' });
    case 'TASK_CREATED': case 'TASK_ASSIGNED': {
      if (!d.assignedTo) return;
      const kind = { picking: '🛒 Picking', packing: '📦 Packing', loading: '🚛 Yuklash' }[d.kind] || d.kind;
      const table = { picking: 'picking_tasks', packing: 'packing_tasks', loading: 'loading_tasks' }[d.kind];
      const t = table ? db.get(`SELECT task_no, deadline FROM ${table} WHERE id=?`, d.taskId || d.id) : null;
      return notify(`📋 <b>Sizga yangi topshiriq</b>\n${kind}: <b>${e(t?.task_no || d.taskNo)}</b>\nDeadline: ${e((t?.deadline || '').slice(0, 16).replace('T', ' '))}${link(d.kind === 'picking' ? `/picking/${d.taskId || d.id}` : '/tasks')}`, { userIds: [d.assignedTo], only: true, kind: 'task' });
    }
    case 'SHIPMENT_CREATED': {
      const s = db.get('SELECT s.*, v.code vc, v.type vt, dr.full_name drv FROM shipments s LEFT JOIN vehicles v ON v.id=s.vehicle_id LEFT JOIN drivers dr ON dr.id=s.driver_id WHERE s.id=?', d.shipmentId);
      return notify(`🚛 <b>Jo‘natma yaratildi ${e(s?.ship_no)}</b>\nTransport: ${e(s?.vc)} ${e(s?.vt)} · haydovchi ${e(s?.drv)}\n${n(s?.pallet_count)} pallet · ${n(s?.total_weight_kg)} kg · ${n(s?.total_volume_m3)} m³\nJo‘nash: ${e((s?.planned_departure || '').slice(0, 16).replace('T', ' '))} → ${e(s?.destination)}\n${who}${link(`/shipments/${s?.ship_no}`)}`, { cat: 'logistika' });
    }
    case 'LOADING_STARTED': return notify(`🔵 Yuklash boshlandi: <b>${e(d.shipNo)}</b>\n${who}`, { cat: 'logistika' });
    case 'LOADING_COMPLETED': return notify(`✅ Yuklash tugadi: <b>${e(d.shipNo)}</b> — ${n(d.minutes)} daqiqa. Hujjatlar avtomatik yaratildi, dispatch mumkin.\n${who}`, { cat: 'logistika' });
    case 'SHIPMENT_DISPATCHED': return notify(`🟠 <b>Jo‘natildi ${e(d.shipNo)}</b> — ETA ${e((d.eta || '').slice(0, 16).replace('T', ' '))}\nInventardan chiqarildi (SHIP).\n${who}${link(`/shipments/${d.shipNo}`)}`, { cat: 'logistika' });
    case 'SHIPMENT_ARRIVED': return notify(`🏁 <b>Yetkazildi ${e(d.shipNo)}</b>\n${who}`, { cat: 'logistika' });
    case 'VEHICLE_STATUS': { const v = db.get('SELECT code, type FROM vehicles WHERE id=?', d.vehicleId); return notify(`${VEH[d.status] || '🚚'} Transport ${e(v?.code)} (${e(v?.type)}) → ${e(d.status)}\n${who}`, { cat: 'logistika' }); }
    case 'DOCUMENT_SUBMITTED': return notify(`📑 <b>XETQ ga topshirildi</b>: ${e(d.subNo)} — status SUBMITTED\n${who}${link(`/xetq/${d.id}`)}`, { cat: 'xetq' });
    case 'DOCUMENT_APPROVED': return notify(`✅ <b>Tasdiqlandi</b>: ${e(d.subNo || d.docNo || `${d.tsNo || ''} v${d.version || ''}`)} (${e(d.kind === 'xetq' ? 'XETQ kelishuvi' : d.kind === 'ts' ? 'Texnik shart' : 'Hujjat')})\n${who}`, { cat: 'xetq' });
    case 'XETQ_STATUS': return notify(`${d.status === 'REVISION_REQUIRED' ? '🔴' : '📑'} XETQ <b>${e(d.subNo)}</b> → ${e(ST[d.status] || d.status)}\n${who}${link(`/xetq/${d.id}`)}`, { cat: 'xetq' });
    case 'DISPATCH_PLANNED': return contactForJob(d.jobId);
    case 'DISPATCH_DRIVER_ACCEPTED': { const j = jobInfo(d.jobId); return notify(`✅ <b>Haydovchi qabul qildi</b>: ${e(j?.driver)} — ${e(j?.ship_no)} (${e(j?.order_no)}), jo‘nash ${e(hmLocal(j?.planned_at))}`, { roles: ['SUPERADMIN', 'ADMIN', 'DIRECTOR', 'MANAGER', 'LOGISTICS'], cat: 'logistika', kind: 'dispatch' }); }
    case 'DISPATCH_DECLINED': { const o = db.get('SELECT order_no FROM orders WHERE id=?', d.orderId); return notify(`🔄 AI dispetcher: ${e(o?.order_no)} — ${e(d.reason)}. Boshqa transport/haydovchi qidirilmoqda…`, { roles: ['SUPERADMIN', 'ADMIN', 'DIRECTOR', 'MANAGER', 'LOGISTICS'], cat: 'logistika', kind: 'dispatch' }); }
    case 'DISPATCH_NO_TRANSPORT': return notify(`🔴 <b>AI dispetcher: transport topilmadi</b> — ${e(d.orderNo)}\n${e(d.reason)}\nTransport yoki haydovchi qo‘shing (sayt → Transport / Haydovchilar).`, { roles: ['SUPERADMIN', 'ADMIN', 'DIRECTOR', 'MANAGER', 'LOGISTICS'], always: true, kind: 'dispatch' });
    case 'DISPATCH_DONE': { const j = jobInfo(d.jobId); return notify(`🚛 <b>Yuk ombordan chiqdi</b>: ${e(j?.ship_no)} (${e(j?.order_no)}) · ${n(j?.total_qty)} dona → ${e(j?.destination)} · ${e(j?.vehicle)} / ${e(j?.driver)} · tasdiqladi: ${e(d.by)}`, { roles: ['SUPERADMIN', 'ADMIN', 'DIRECTOR', 'MANAGER', 'LOGISTICS'], cat: 'logistika', kind: 'dispatch' }); }
    case 'AI_ALERT': {
      const icon = d.severity === 'CRITICAL' ? '🔴' : d.severity === 'WARNING' ? '🟠' : '🔵';
      return notify(`${icon} <b>AI ${e(d.severity)}</b> · ${e(d.title)}\n${e(d.message)}`, { cat: 'ai', level: d.severity, kind: 'ai', buttons: () => [d.severity !== 'INFO' ? [{ text: '👁 Ko‘rildi', callback_data: `al:ack:${d.id}` }] : null] });
    }
    default: return;
  }
}

// ---------------- AI dispatcher: contacting drivers / logisticians ----------------
const tzMinDaily = () => Number(db.setting('report_tz_offset_min', Number(process.env.BOT_TZ_OFFSET_MIN ?? 300)));
const hmLocal = (iso) => (iso ? new Date(new Date(iso).getTime() + tzMinDaily() * 60000).toISOString().slice(0, 16).replace('T', ' ') : '—');
function jobInfo(jobId) {
  return db.get(`SELECT j.*, o.order_no, o.destination, c.name customer, s.ship_no, s.total_qty, s.pallet_count, s.total_weight_kg, s.total_volume_m3, v.code vehicle, v.type vehicle_type, v.plate,
    d.full_name driver, d.phone driver_phone, d.telegram_chat_id FROM dispatch_jobs j JOIN orders o ON o.id=j.order_id LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN shipments s ON s.id=j.shipment_id
    LEFT JOIN vehicles v ON v.id=j.vehicle_id LEFT JOIN drivers d ON d.id=j.driver_id WHERE j.id=?`, jobId);
}
function contactForJob(jobId) {
  const j = jobInfo(jobId); if (!j) return;
  const cargo = `${n(j.total_qty)} dona · ${j.pallet_count} pallet · ${n(j.total_weight_kg)} kg · ${n(j.total_volume_m3)} m³`;
  if (j.telegram_chat_id) {
    send(j.telegram_chat_id, `🚚 <b>Yangi yuk taklifi</b> (AI dispetcher)\n\nJo‘natma: <b>${e(j.ship_no)}</b>\nYuk: ${cargo}\nManzil: <b>${e(j.destination)}</b>\nMijoz: ${e(j.customer)}\nTransport: ${e(j.vehicle)} ${e(j.vehicle_type)} ${e(j.plate || '')}\nOmborga kelish / jo‘nash: <b>${e(hmLocal(j.planned_at))}</b>\n\nQabul qilasizmi?`,
      kb([[{ text: '✅ Qabul qilaman', callback_data: `dr:acc:${j.id}` }, { text: '❌ Qila olmayman', callback_data: `dr:dec:${j.id}` }]]), 'dispatch-driver');
  }
  notify(`🤖 <b>AI dispetcher: transport tanlandi</b>\n${e(j.order_no)} → <b>${e(j.ship_no)}</b> · ${e(j.customer)}\nYuk: ${cargo}\nTransport: <b>${e(j.vehicle)}</b> ${e(j.vehicle_type)} ${e(j.plate || '')} (${e(j.note || '')})\nHaydovchi: <b>${e(j.driver)}</b> ${e(j.driver_phone || '')}\nJo‘nash: <b>${e(hmLocal(j.planned_at))}</b> → ${e(j.destination)}\n${j.telegram_chat_id ? '📨 Haydovchiga Telegram orqali taklif yuborildi.' : `📞 Haydovchi Telegramga ulanmagan — telefon qiling: ${e(j.driver_phone || '—')}`}`,
    { roles: ['SUPERADMIN', 'ADMIN', 'DIRECTOR', 'MANAGER', 'LOGISTICS'], cat: 'logistika', kind: 'dispatch',
      buttons: (u) => (auth.can(u, 'dispatch.manage') ? [[{ text: '🚛 Yuk chiqdi (dispatch)', callback_data: `dp:go:${j.id}` }, { text: '🔄 Boshqa transport', callback_data: `dp:re:${j.id}` }]] : null) });
}
/** Daily 08:00 / 22:00 report → admins (always) + subscribers of the "brifing" category. */
function sendReport(text, kind) {
  if (!enabled()) return 0;
  let count = 0;
  for (const l of links()) {
    const admin = ['SUPERADMIN', 'ADMIN', 'DIRECTOR'].includes(l.user.role);
    if (!admin && !prefsOf(l).cats.includes('brifing')) continue;
    send(l.chat_id, text, {}, `report-${kind}`); count++;
  }
  const group = process.env.TELEGRAM_GROUP_CHAT_ID; if (group && !db.get('SELECT 1 FROM bot_links WHERE chat_id=? AND active=1', group)) { send(group, text, {}, `report-${kind}`); count++; }
  return count;
}
function createDriverLinkCode(driverId, user) {
  const d = db.get('SELECT * FROM drivers WHERE id=?', driverId); if (!d) throw new AppError(404, 'Haydovchi topilmadi');
  db.run('DELETE FROM bot_link_codes WHERE expires_at<? OR (driver_id=? AND used_at IS NULL)', new Date().toISOString(), driverId);
  const code = String(crypto.randomInt(100000, 1000000)); const expires = new Date(Date.now() + 24 * 3600000).toISOString();
  db.insert('bot_link_codes', { code, user_id: user.id, driver_id: driverId, expires_at: expires, created_at: clock.iso() });
  db.audit(user, 'TELEGRAM_DRIVER_CODE', 'drivers', driverId);
  return { code, expiresAt: expires, deepLink: me ? `https://t.me/${me.username}?start=${code}` : null, bot: me?.username || null, driver: d.full_name };
}

// ---------------- AI supervisor ----------------
function briefingText(kind = 'morning') {
  const rep = require('./reports'); const ai = require('./ai');
  const d = rep.directorDashboard();
  const today = new Date(Date.now() + cfg.tzMin() * 60000).toISOString().slice(0, 10);
  const alerts = db.all("SELECT severity, message FROM ai_events WHERE status='OPEN' AND severity<>'INFO' ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 ELSE 1 END, id DESC LIMIT 6");
  const lines = [`🤖 <b>AI ${kind === 'morning' ? 'ertalabki brifing' : kind === 'evening' ? 'kechki hisobot' : 'holat hisoboti'}</b> — ${e(today)}`, '',
    `🏭 Ombor: band <b>${d.warehouse.pct}%</b> · panel erkin ${n(d.stock.free)} / rezerv ${n(d.stock.reserved)}`,
    `${d.supply.shortages ? '🔴' : '✅'} Yetishmovchilik: <b>${d.supply.shortages}</b> ta (${n(d.supply.shortageQty)} dona) · tasdiq kutayotgan zayavka: ${d.supply.awaitingApproval}`,
    `${d.supplier.delays ? '🔴' : '✅'} Supplier kechikishlari: <b>${d.supplier.delays}</b> · yo‘lda: ${d.supplier.inTransit}`,
    `🛒 Yig‘ish: ${n(d.picking.picked)} / ${n(d.picking.required)} · ochiq picking: ${d.picking.openTasks}`,
    !require('./modules').logisticsOn() ? null : `🚛 Faol jo‘natma: ${d.logistics.active} (yo‘lda ${d.logistics.inTransit}${d.logistics.late ? `, 🔴 kechikmoqda ${d.logistics.late}` : ''}) · bo‘sh transport: ${d.transport.available}/${d.transport.total}`,
    `📑 XETQ: reviewda ${d.xetq.inReview} · tuzatish kerak ${d.xetq.revision}`];
  if (kind === 'evening') {
    const tz = cfg.tzMin() * 60000; // start of the company's local day, expressed in UTC
    const since = new Date(Math.floor((Date.now() + tz) / 86400000) * 86400000 - tz);
    const t = Object.fromEntries(db.all('SELECT type, COUNT(*) c, SUM(qty) q FROM inventory_transactions WHERE created_at>=? GROUP BY type', since.toISOString()).map((r) => [r.type, r]));
    const cnt = (sql) => db.val(sql, since.toISOString()) || 0;
    lines.push('', '<b>Bugungi faoliyat:</b>', `📥 Kirim: ${n(t.RECEIVE?.q)} · 📤 Chiqim: ${n(t.ISSUE?.q)} · 🚛 Jo‘natildi: ${n(t.SHIP?.q)} · 📦 Qadoqlandi: ${n(t.PACK?.q)}`,
      `🛒 Yangi buyurtma: ${cnt('SELECT COUNT(*) FROM orders WHERE created_at>=?')} · 🧾 Zayavka: ${cnt('SELECT COUNT(*) FROM purchase_requests WHERE created_at>=?')} · ⚠️ QC fail: ${cnt("SELECT COUNT(*) FROM quality_checks WHERE created_at>=? AND failed_qty>0")} · 📑 Hujjat: ${cnt('SELECT COUNT(*) FROM documents WHERE created_at>=?')}`);
  }
  if (alerts.length) lines.push('', '<b>⚠️ AI ko‘rayotgan xavflar:</b>', ...alerts.map((a) => `${a.severity === 'CRITICAL' ? '🔴' : '🟠'} ${e(a.message)}`));
  const fc = ai.forecast(7).filter((f) => f.gap > 0).slice(0, 3);
  if (fc.length) lines.push('', '<b>📈 7 kunlik prognoz (tavsiya):</b>', ...fc.map((f) => `• ${e(f.sku)}: ${e(f.text)}`));
  const recs = [];
  if (d.supply.awaitingApproval) recs.push(`${d.supply.awaitingApproval} ta zayavkani tasdiqlang (/zayavkalar)`);
  if (d.supply.shortages) recs.push('ochiq yetishmovchiliklar uchun zayavka holatini tekshiring (/yetishmovchilik)');
  if (d.logistics.late && require('./modules').logisticsOn()) recs.push('kechikayotgan jo‘natma haydovchisi bilan bog‘laning (/jonatmalar)');
  if (d.xetq.revision) recs.push('XETQ tuzatishlarini muddatida yakunlang');
  if (recs.length) lines.push('', '<b>✅ Tavsiyalar:</b>', ...recs.map((r) => `• ${r}`));
  return { text: lines.join('\n'), facts: { dashboard: d, alerts, forecast: fc } };
}
async function sendBriefing(kind) {
  const b = briefingText(kind);
  let text = b.text;
  const llm = await require('./ai').callLLM(`Ombor/logistika bo‘yicha ${kind === 'morning' ? 'bugungi kun uchun 3 ta eng muhim ustuvor vazifani' : 'kun yakuni bo‘yicha qisqa xulosani'} yozing.`, b.facts).catch(() => null);
  if (llm) text += `\n\n🧠 <b>AI xulosasi:</b>\n${e(llm).slice(0, 1500)}`;
  notify(text, { cat: 'brifing', kind: `brifing-${kind}` });
}
let supTimer = null;
async function supervise() {
  try {
    // 1) escalate critical alerts nobody acknowledged
    const cutoff = new Date(Date.now() - cfg.escalateMin() * 60000).toISOString();
    for (const a of db.all("SELECT * FROM ai_events WHERE status='OPEN' AND severity='CRITICAL' AND created_at<? AND id NOT IN (SELECT event_id FROM bot_escalations) ORDER BY id LIMIT 10", cutoff)) {
      db.insert('bot_escalations', { event_id: a.id, at: clock.iso() });
      notify(`⏰ <b>ESKALATSIYA</b> — ${cfg.escalateMin()} daqiqadan beri hal qilinmagan kritik muammo:\n🔴 ${e(a.title)}\n${e(a.message)}`, { roles: ['SUPERADMIN', 'ADMIN', 'DIRECTOR', 'MANAGER'], always: true, kind: 'escalation', buttons: () => [[{ text: '👁 Ko‘rildi', callback_data: `al:ack:${a.id}` }]] });
    }
  } catch (err) { lastError = err.message; console.error('bot supervisor:', err.message); }
}

// ---------------- commands ----------------
const HELP = `🤖 <b>Solar Factory WMS bot</b>
/holat — umumiy holat (direktor paneli)
/brifing — AI brifing hozir
/hisobot — bugungi faoliyat hisoboti
/ombor [SKU] — qoldiq (Available / Reserved / Free)
/yetishmovchilik — ochiq yetishmovchiliklar
/zayavkalar — tasdiq kutayotgan zayavkalar (tugmalar bilan)
/jonatmalar — faol jo‘natmalar
/alertlar — AI ogohlantirishlar
/vazifalar — mening topshiriqlarim
/sozlamalar — qaysi xabarlar kelsin
/unlink — botni hisobdan uzish
Istalgan savolni oddiy matn bilan yozing — AI database asosida javob beradi (masalan: <i>Ertangi buyurtmaga yetadimi?</i>).`;

async function command(chat, text, from) {
  const [raw, ...args] = text.trim().split(/\s+/); const cmd = raw.split('@')[0].toLowerCase(); const arg = args.join(' ');
  const l = linkOfChat(chat.id);
  if (cmd === '/start' || cmd === '/link') {
    if (!arg) return send(chat.id, l ? `✅ Siz <b>${e(l.user.fullName)}</b> (${e(l.user.role)}) sifatida ulangansiz.\n\n${HELP}` : `👋 Assalomu alaykum! Bu <b>Solar Factory WMS</b> boti.\n\nUlash uchun: saytda <b>Sozlamalar → Telegram bot</b> bo‘limida kod oling va shu yerga <code>/start KOD</code> yuboring.\nChat ID: <code>${e(chat.id)}</code>`);
    return linkChat(chat, arg, from);
  }
  if (!l) return send(chat.id, '🔒 Avval hisobingizni ulang: saytda <b>Sozlamalar → Telegram bot</b> → kod → <code>/start KOD</code>');
  db.run('UPDATE bot_links SET last_seen=? WHERE chat_id=?', clock.iso(), String(chat.id));
  const u = l.user; const inv = require('./inventory'); const rep = require('./reports');
  switch (cmd) {
    case '/help': case '/yordam': return send(chat.id, HELP);
    case '/unlink': db.run('UPDATE bot_links SET active=0 WHERE chat_id=?', String(chat.id)); db.audit(u, 'TELEGRAM_UNLINK', 'bot_links', chat.id); return send(chat.id, '🔌 Bot hisobingizdan uzildi.');
    case '/holat': case '/brifing': return send(chat.id, briefingText('now').text, {}, 'command');
    case '/hisobot': return send(chat.id, briefingText('evening').text, {}, 'command');
    case '/ombor': case '/qoldiq': {
      const rows = inv.stockSummary(arg ? { q: arg } : { category: 'FINISHED' }).slice(0, 15);
      return send(chat.id, rows.length ? `🏭 <b>Qoldiq</b>${arg ? ` — “${e(arg)}”` : ' (tayyor mahsulot)'}\n${rows.map((r) => `• <b>${e(r.sku)}</b>: available ${n(r.available)} · rezerv ${n(r.reserved)} · <b>free ${n(r.free)}</b>${r.shortage ? ` · 🔴 yetishmaydi ${n(r.shortage)}` : ''}${r.receiving ? ` · QC kutmoqda ${n(r.receiving)}` : ''} ${e(r.unit)}`).join('\n')}` : 'Hech narsa topilmadi.');
    }
    case '/yetishmovchilik': {
      const rows = db.all("SELECT s.*, p.sku, p.unit, o.order_no, pr.pr_no FROM shortages s JOIN products p ON p.id=s.product_id LEFT JOIN orders o ON o.id=s.order_id LEFT JOIN purchase_requests pr ON pr.id=s.purchase_request_id WHERE s.status IN ('OPEN','REQUESTED') ORDER BY s.id DESC LIMIT 10");
      if (!rows.length) return send(chat.id, '✅ Ochiq yetishmovchilik yo‘q.');
      for (const s of rows) send(chat.id, `🔴 ${e(s.shortage_no)}: <b>${e(s.sku)}</b> — ${n(s.shortage_qty)} ${e(s.unit)} (${e(s.order_no)})\n${s.pr_no ? `Zayavka: ${e(s.pr_no)}` : 'Zayavka yo‘q'}`, kb([s.status === 'OPEN' && auth.can(u, 'procurement.request') ? [{ text: '🤖 AI zayavka yaratish', callback_data: `sh:pr:${s.id}` }] : null]), 'command');
      return;
    }
    case '/zayavkalar': {
      const rows = db.all("SELECT pr.*, p.sku, p.unit, s.company FROM purchase_requests pr JOIN products p ON p.id=pr.product_id LEFT JOIN suppliers s ON s.id=pr.supplier_id WHERE pr.status='REQUESTED' ORDER BY pr.id DESC LIMIT 10");
      if (!rows.length) return send(chat.id, '✅ Tasdiq kutayotgan zayavka yo‘q.');
      for (const r of rows) send(chat.id, `🧾 <b>${e(r.pr_no)}</b>${r.ai_generated ? ' 🤖' : ''}: ${e(r.sku)} × ${n(r.qty)} ${e(r.unit)}\n${e(r.company)} · ${e(r.priority)} · ${e(r.reason)}`, kb([auth.can(u, 'procurement.approve') && (u.id !== r.created_by || auth.FULL.includes(u.role)) ? [{ text: '✅ Tasdiqlash', callback_data: `pr:ok:${r.id}` }, { text: '❌ Rad etish', callback_data: `pr:no:${r.id}` }] : null]), 'command');
      return;
    }
    case '/jonatmalar': {
      const rows = db.all("SELECT s.*, v.code vc, d.full_name drv FROM shipments s LEFT JOIN vehicles v ON v.id=s.vehicle_id LEFT JOIN drivers d ON d.id=s.driver_id WHERE s.status IN ('PLANNED','LOADING','LOADED','DISPATCHED') ORDER BY s.id DESC LIMIT 15");
      return send(chat.id, rows.length ? `🚛 <b>Faol jo‘natmalar</b>\n${rows.map((s) => `• <b>${e(s.ship_no)}</b> — ${e(s.status)} · ${e(s.vc)} / ${e(s.drv)} → ${e(s.destination)}${s.status === 'DISPATCHED' ? ` · ETA ${e((s.eta || '').slice(0, 16).replace('T', ' '))}${new Date(s.eta) < new Date() ? ' 🔴 kechikmoqda' : ''}` : ''}`).join('\n')}` : 'Faol jo‘natma yo‘q.');
    }
    case '/alertlar': {
      const rows = db.all("SELECT * FROM ai_events WHERE status='OPEN' AND severity<>'INFO' ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 ELSE 1 END, id DESC LIMIT 8");
      if (!rows.length) return send(chat.id, '✅ Ochiq AI ogohlantirish yo‘q.');
      for (const a of rows) send(chat.id, `${a.severity === 'CRITICAL' ? '🔴' : '🟠'} <b>${e(a.title)}</b>\n${e(a.message)}`, kb([[{ text: '👁 Ko‘rildi', callback_data: `al:ack:${a.id}` }]]), 'command');
      return;
    }
    case '/vazifalar': {
      const rows = rep.myTasks(u, false);
      return send(chat.id, rows.length ? `📋 <b>Topshiriqlaringiz</b>\n${rows.map((t) => `• ${e(t.kind)} <b>${e(t.task_no)}</b> (${e(t.ref)}) — ${e(t.status)} · deadline ${e((t.deadline || '').slice(0, 16).replace('T', ' '))}${t.overdue ? ' 🔴' : ''}`).join('\n')}` : '✅ Ochiq topshiriq yo‘q.');
    }
    case '/sozlamalar': return sendPrefs(chat.id, l);
    default: return send(chat.id, `Noma’lum buyruq. ${HELP}`);
  }
}
function prefsKeyboard(l) {
  const p = prefsOf(l);
  return kb([...Object.entries(CATEGORIES).map(([k, v]) => [{ text: `${p.cats.includes(k) ? '✅' : '⬜'} ${v}`, callback_data: `set:cat:${k}` }]),
    [{ text: `AI darajasi: ${p.level === 'CRITICAL' ? 'faqat 🔴' : p.level === 'WARNING' ? '🔴 + 🟠' : 'hammasi'}`, callback_data: 'set:lvl' }], [{ text: p.mute ? '🔕 Ovozsiz (yoqish)' : '🔔 Xabarlar yoqilgan', callback_data: 'set:mute' }]]);
}
function sendPrefs(chatId, l) { send(chatId, '⚙️ <b>Qaysi xabarlar kelsin?</b> Bosib yoqing/o‘chiring. Shaxsiy topshiriqlar va eskalatsiyalar doim keladi.', prefsKeyboard(l), 'command'); }

const linkFails = new Map();
function linkChat(chat, code, from) {
  const f = linkFails.get(String(chat.id)) || { n: 0, until: 0 };
  if (f.until > Date.now()) return send(chat.id, '⏳ Juda ko‘p noto‘g‘ri urinish. 10 daqiqadan so‘ng qayta urinib ko‘ring.');
  const c = db.get('SELECT * FROM bot_link_codes WHERE code=? AND used_at IS NULL AND expires_at>?', String(code).trim(), new Date().toISOString());
  if (!c) { f.n++; if (f.n >= 5) { f.until = Date.now() + 600000; f.n = 0; } linkFails.set(String(chat.id), f); return send(chat.id, '❌ Kod noto‘g‘ri yoki muddati o‘tgan. Saytdan yangi kod oling.'); }
  if (c.driver_id) {
    const d = db.get('SELECT * FROM drivers WHERE id=?', c.driver_id); if (!d) return send(chat.id, '❌ Haydovchi topilmadi.');
    db.run('UPDATE bot_link_codes SET used_at=? WHERE code=?', clock.iso(), c.code);
    db.run('UPDATE drivers SET telegram_chat_id=NULL WHERE telegram_chat_id=?', String(chat.id));
    db.run('UPDATE drivers SET telegram_chat_id=? WHERE id=?', String(chat.id), d.id);
    db.audit(userOf(c.user_id), 'TELEGRAM_DRIVER_LINK', 'drivers', d.id, { tgUser: from?.username });
    db.emit('BOT_LINKED', { driverId: d.id });
    return send(chat.id, `✅ Ulandi! Siz haydovchi <b>${e(d.full_name)}</b> sifatida ro‘yxatdan o‘tdingiz.\nAI dispetcher sizga yuk bo‘yicha takliflarni shu yerga yuboradi — tugmalar orqali javob bering.`);
  }
  const u = userOf(c.user_id); if (!u) return send(chat.id, '❌ Foydalanuvchi faol emas.');
  db.run('UPDATE bot_link_codes SET used_at=? WHERE code=?', clock.iso(), c.code);
  db.run(`INSERT INTO bot_links(chat_id,user_id,chat_type,chat_title,tg_username,active,linked_at,last_seen) VALUES(?,?,?,?,?,1,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET user_id=excluded.user_id, chat_type=excluded.chat_type, chat_title=excluded.chat_title, tg_username=excluded.tg_username, active=1, linked_at=excluded.linked_at`,
  String(chat.id), u.id, chat.type || 'private', chat.title || [from?.first_name, from?.last_name].filter(Boolean).join(' ') || null, from?.username || null, clock.iso(), clock.iso());
  db.audit(u, 'TELEGRAM_LINK', 'bot_links', chat.id, { chatType: chat.type, tgUser: from?.username });
  db.emit('BOT_LINKED', { userId: u.id });
  send(chat.id, `✅ Ulandi! Siz <b>${e(u.fullName)}</b> (${e(u.role)}).\nSaytdagi barcha muhim ishlar haqida shu yerga xabar keladi.\n\n${HELP}`);
  sendPrefs(chat.id, linkOfChat(chat.id));
}

async function callback(q) {
  const chatId = q.message?.chat?.id; const l = linkOfChat(chatId);
  const answer = (text, alert) => tg('answerCallbackQuery', { callback_query_id: q.id, text: String(text).slice(0, 190), show_alert: !!alert }).catch(() => {});
  const [ns, action, idStr] = String(q.data || '').split(':'); const id = Number(idStr);
  const finish = async (resultLine) => { await tg('editMessageText', { chat_id: chatId, message_id: q.message.message_id, text: `${q.message.text || ''}\n\n${resultLine}`.slice(0, 4000), disable_web_page_preview: true }).catch(() => {}); };
  if (ns === 'dr') { // driver answering an AI dispatcher offer
    try {
      const dsp = require('./dispatcher');
      if (action === 'acc') { dsp.driverAnswer(id, true, chatId); await finish('✅ Siz qabul qildingiz. Yukni ortgach “Yo‘lga chiqdim” tugmasini bosing.'); await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, ...kb([[{ text: '🚛 Yuk ortildi — yo‘lga chiqdim', callback_data: `dr:go:${id}` }]]) }).catch(() => {}); return answer('Qabul qilindi'); }
      if (action === 'dec') { dsp.driverAnswer(id, false, chatId); await finish('❌ Rad etildi. AI boshqa haydovchini tanlaydi.'); return answer('Rad etildi'); }
      if (action === 'go') {
        const j = db.get('SELECT * FROM dispatch_jobs WHERE id=?', id); const d = j && db.get('SELECT * FROM drivers WHERE id=?', j.driver_id);
        if (!d || String(d.telegram_chat_id) !== String(chatId)) throw new AppError(403, 'Bu topshiriq sizga tegishli emas');
        const r = dsp.dispatchJob(id); await finish(`🚛 Jo‘natildi — ETA ${r.eta.slice(0, 16).replace('T', ' ')}. Oq yo‘l!`); return answer('Jo‘natildi');
      }
    } catch (err) { return answer(`❌ ${err.message}`, true); }
  }
  if (!l) return answer('Avval hisobni ulang', true);
  const u = l.user;
  try {
    if (ns === 'dp') {
      auth.require(u, 'dispatch.manage');
      const dsp = require('./dispatcher');
      if (action === 'go') { const r = db.withUser(u, () => dsp.dispatchJob(id, u)); await finish(`🚛 Jo‘natildi (${u.fullName}) — ETA ${r.eta.slice(0, 16).replace('T', ' ')}`); return answer('Jo‘natildi'); }
      if (action === 're') { const r = db.withUser(u, () => dsp.decline(id, `${u.fullName} boshqa transport so‘radi`, u)); await finish(`🔄 Qayta rejalashtirildi — ${r.shipNo ? `${r.shipNo}, ${r.vehicle}, ${r.driver}` : r.reason || r.status}`); return answer('Qayta rejalashtirildi'); }
    }
    if (ns === 'set') {
      const p = prefsOf(l);
      if (action === 'cat') p.cats = p.cats.includes(idStr) ? p.cats.filter((c) => c !== idStr) : [...p.cats, idStr];
      if (action === 'lvl') p.level = LEVELS[(LEVELS.indexOf(p.level) + 1) % LEVELS.length];
      if (action === 'mute') p.mute = !p.mute;
      db.run('UPDATE bot_links SET prefs=? WHERE chat_id=?', JSON.stringify(p), String(chatId));
      await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, ...prefsKeyboard(linkOfChat(chatId)) }).catch(() => {});
      return answer('Saqlandi');
    }
    if (ns === 'pr' && action === 'ok') {
      auth.require(u, 'procurement.approve');
      const r = db.withUser(u, () => require('./procurement').approve(id, { note: 'Telegram orqali' }, u));
      await finish(`✅ Tasdiqlandi — ${u.fullName}`); return answer(`Holat: ${r.status}`);
    }
    if (ns === 'pr' && action === 'no') {
      auth.require(u, 'procurement.approve');
      db.run('INSERT INTO bot_state(chat_id,state,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET state=excluded.state, data=excluded.data, updated_at=excluded.updated_at', String(chatId), 'reject_reason', JSON.stringify({ id, messageId: q.message.message_id, text: q.message.text }), clock.iso());
      send(chatId, '✍️ Rad etish sababini yozing (yoki /bekor):', { reply_markup: { force_reply: true } });
      return answer('Sababni yozing');
    }
    if (ns === 'sh' && action === 'pr') {
      auth.require(u, 'procurement.request');
      const proc = require('./procurement'); const dr = proc.draftFromShortage(id);
      if (!dr.supplierId) throw new AppError(400, 'Supplier topilmadi — saytda qo‘lda yarating');
      const r = db.withUser(u, () => proc.create({ productId: dr.productId, qty: dr.qty, supplierId: dr.supplierId, requiredDate: dr.requiredDate, priority: dr.priority, reason: dr.reason, shortageId: id, orderId: dr.orderId, warehouseId: dr.warehouseId, aiGenerated: true }, u));
      await finish(`🤖 ${r.prNo} yaratildi (REQUESTED) — ${u.fullName}. Tasdiqlash kutilmoqda.`); return answer(r.prNo);
    }
    if (ns === 'al' && action === 'ack') {
      db.withUser(u, () => db.tx(() => { db.run("UPDATE ai_events SET status='ACK', updated_at=? WHERE id=? AND status='OPEN'", clock.iso(), id); db.audit(u, 'AI_ALERT_ACK', 'ai_events', id, { via: 'telegram' }); db.emit('AI_ALERT_ACK', { id }); }));
      await finish(`👁 Ko‘rildi — ${u.fullName}`); return answer('Belgilandi');
    }
    return answer('Noma’lum amal');
  } catch (err) { return answer(`❌ ${err.message}`, true); }
}

async function handleUpdate(up) {
  if (up.callback_query) { logMsg(up.callback_query.message?.chat?.id, 'IN', 'callback', up.callback_query.data, 'OK'); return callback(up.callback_query); }
  const m = up.message; if (!m || !m.chat) return;
  const text = (m.text || '').trim(); if (!text) return;
  logMsg(m.chat.id, 'IN', 'message', text, 'OK');
  const st = db.get('SELECT * FROM bot_state WHERE chat_id=?', String(m.chat.id));
  if (st && st.state === 'reject_reason' && !text.startsWith('/')) {
    db.run('DELETE FROM bot_state WHERE chat_id=?', String(m.chat.id));
    const l = linkOfChat(m.chat.id); if (!l) return;
    const data = JSON.parse(st.data);
    try { auth.require(l.user, 'procurement.approve'); db.withUser(l.user, () => require('./procurement').reject(data.id, { reason: text }, l.user)); send(m.chat.id, `❌ Zayavka rad etildi. Sabab: ${e(text)}`); await tg('editMessageText', { chat_id: m.chat.id, message_id: data.messageId, text: `${data.text}\n\n❌ Rad etildi — ${l.user.fullName}: ${text}`.slice(0, 4000) }).catch(() => {}); }
    catch (err) { send(m.chat.id, `❌ ${e(err.message)}`); }
    return;
  }
  if (text === '/bekor') { db.run('DELETE FROM bot_state WHERE chat_id=?', String(m.chat.id)); return send(m.chat.id, 'Bekor qilindi.'); }
  if (text.startsWith('/')) return command(m.chat, text, m.from);
  const l = linkOfChat(m.chat.id);
  if (!l) return send(m.chat.id, '🔒 Avval hisobingizni ulang: saytda <b>Sozlamalar → Telegram bot</b> → kod → <code>/start KOD</code>');
  if (m.chat.type !== 'private' && !(me && text.includes(`@${me.username}`))) return; // in groups answer only when mentioned
  auth.require(l.user, 'ai.use');
  tg('sendChatAction', { chat_id: m.chat.id, action: 'typing' }).catch(() => {});
  const r = await require('./ai').ask(text.replace(`@${me?.username}`, '').trim(), l.user);
  send(m.chat.id, `${e(r.answer)}\n\n<i>Manba: ${r.source === 'database' ? 'real vaqtdagi database' : 'database + LLM'}</i>`, {}, 'ai-answer');
}

async function poll(gen) {
  let offset = db.setting('tg_offset', 0);
  while (running && gen === generation) {
    try {
      const ups = await tg('getUpdates', { offset, timeout: cfg.pollTimeout(), allowed_updates: ['message', 'callback_query'] }, (cfg.pollTimeout() + 15) * 1000);
      for (const up of ups) {
        offset = up.update_id + 1; db.setSetting('tg_offset', offset);
        try { await handleUpdate(up); } catch (err) { const chat = up.message?.chat?.id; if (chat) send(chat, `❌ ${e(err.message)}`); }
      }
      lastError = null;
    } catch (err) { if (!running || gen !== generation) break; lastError = err.message; await sleep(err.code === 409 ? 10000 : 3000); }
  }
}

// ---------------- public API (web) ----------------
function enabled() { return !!cfg.token(); }
function init() { db.raw().exec(SCHEMA); try { db.raw().exec('ALTER TABLE bot_link_codes ADD COLUMN driver_id INTEGER'); } catch { /* exists */ } }
let listening = false;
async function start() {
  init();
  if (!listening) { listening = true; bus.on('event', (ev) => { if (!enabled() || !activeToken) return; try { onEvent(ev); } catch (err) { console.error('bot event:', err.message); } }); }
  if (!supTimer) { supTimer = setInterval(supervise, Number(process.env.BOT_SUPERVISE_SECONDS || 60) * 1000); supTimer.unref(); }
  return reload();
}
/** (Re)connect with the current token (from the API keys page or .env). */
async function reload() {
  generation++; running = false; me = null; activeToken = null;
  if (!enabled()) { console.log('Telegram bot: o‘chirilgan (token berilmagan)'); return { running: false }; }
  activeToken = cfg.token(); const gen = generation;
  try { me = await tg('getMe'); await tg('setMyCommands', { commands: [['holat', 'Umumiy holat'], ['brifing', 'AI brifing'], ['hisobot', 'Bugungi hisobot'], ['ombor', 'Qoldiq'], ['yetishmovchilik', 'Yetishmovchiliklar'], ['zayavkalar', 'Tasdiq kutayotgan zayavkalar'], ['jonatmalar', 'Faol jo‘natmalar'], ['alertlar', 'AI ogohlantirishlar'], ['vazifalar', 'Mening topshiriqlarim'], ['sozlamalar', 'Xabar sozlamalari'], ['help', 'Yordam']].map(([command, description]) => ({ command, description })) }).catch(() => {}); }
  catch (err) {
    lastError = err.message; console.error('Telegram bot: ulanib bo‘lmadi —', err.message);
    if (err.code === 401 || err.code === 404) return { running: false, error: `Token noto‘g‘ri: ${err.message}` }; // noto‘g‘ri token bilan polling boshlanmaydi
  }
  if (gen !== generation) return { running: false };
  if (SERVERLESS) {
    // webhook mode: Telegram pushes updates to /api/telegram/webhook
    const url = webhookUrl();
    if (!url) { lastError = 'WMS_BASE_URL (yoki VERCEL_PROJECT_PRODUCTION_URL) aniqlanmadi — webhook o‘rnatilmadi'; return { running: false, error: lastError }; }
    const key = `${url}|${webhookSecret()}`;
    try {
      if (db.setting('bot_webhook', '') !== key) {
        await tg('setWebhook', { url, secret_token: webhookSecret(), allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
        db.setSetting('bot_webhook', key);
      }
      running = true; startedAt = clock.iso(); lastError = null;
    } catch (err) { lastError = `setWebhook: ${err.message}`; }
    return { running, bot: me?.username || null, error: lastError, webhook: url };
  }
  running = true; startedAt = clock.iso();
  console.log(`Telegram bot: @${me?.username || '?'} ishga tushdi`);
  poll(gen);
  return { running: true, bot: me?.username || null, error: lastError };
}
function webhookUrl() {
  const base = (process.env.WMS_BASE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')).replace(/\/$/, '');
  return base ? `${base}/api/telegram/webhook` : null;
}
const webhookSecret = () => crypto.createHash('sha256').update(`wms-webhook:${activeToken || cfg.token()}`).digest('hex').slice(0, 48);
function checkWebhookSecret(given) { if (!enabled()) return false; const exp = webhookSecret(); return typeof given === 'string' && given.length === exp.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(exp)); }
async function handleWebhook(update) {
  if (!activeToken) activeToken = cfg.token();
  if (!me) me = await tg('getMe').catch(() => null);
  try { await handleUpdate(update); } catch (err) { const chat = update?.message?.chat?.id; if (chat) send(chat, `❌ ${e(err.message)}`); }
  await flush();
}
/** Wait until every queued Telegram message is delivered (serverless requests must not end earlier). */
async function flush(timeoutMs = 15000) {
  if (stockBuf.length) { if (stockTimer) clearTimeout(stockTimer); flushStock(); }
  const t0 = Date.now();
  while ((queue.length || pumping) && Date.now() - t0 < timeoutMs) await sleep(25);
}
function stop() { running = false; generation++; if (supTimer) clearInterval(supTimer); supTimer = null; }

function createLinkCode(user) {
  db.run('DELETE FROM bot_link_codes WHERE expires_at<? OR (user_id=? AND used_at IS NULL)', new Date().toISOString(), user.id);
  const code = String(crypto.randomInt(100000, 1000000));
  const expires = new Date(Date.now() + 10 * 60000).toISOString();
  db.insert('bot_link_codes', { code, user_id: user.id, expires_at: expires, created_at: clock.iso() });
  db.audit(user, 'TELEGRAM_CODE', 'bot_link_codes', null);
  return { code, expiresAt: expires, deepLink: me ? `https://t.me/${me.username}?start=${code}` : null, bot: me?.username || null };
}
function status(user) {
  const mine = db.all('SELECT chat_id, chat_type, chat_title, tg_username, prefs, active, linked_at, last_seen FROM bot_links WHERE user_id=? AND active=1', user.id)
    .map((l) => ({ ...l, prefs: prefsOf({ ...l, user_id: user.id }) }));
  const full = auth.can(user, 'admin.users') || auth.can(user, 'audit.view');
  return { enabled: enabled(), running, bot: me ? { username: me.username, name: me.first_name } : null, lastError: full ? lastError : undefined, startedAt, categories: CATEGORIES,
    mine, groupChat: full ? process.env.TELEGRAM_GROUP_CHAT_ID || null : undefined, baseUrl: cfg.baseUrl() || null,
    schedule: { ...require('./daily').hours(), tzOffsetMin: tzMinDaily(), escalateMin: cfg.escalateMin() },
    all: full ? db.all('SELECT b.chat_id, b.chat_type, b.chat_title, b.tg_username, b.linked_at, b.last_seen, u.full_name, u.role_code FROM bot_links b JOIN users u ON u.id=b.user_id WHERE b.active=1 ORDER BY b.linked_at DESC') : undefined,
    stats: full ? db.get("SELECT SUM(direction='OUT' AND status='SENT') sent, SUM(status='FAILED') failed, SUM(direction='IN') incoming FROM bot_messages WHERE created_at>=?", new Date(Date.now() - 86400000).toISOString()) : undefined };
}
function savePrefs(user, chatId, prefs) {
  const l = db.get('SELECT * FROM bot_links WHERE chat_id=? AND user_id=? AND active=1', String(chatId), user.id); if (!l) throw new AppError(404, 'Ulangan chat topilmadi');
  const cats = (prefs.cats || []).filter((c) => CATEGORIES[c]); const level = LEVELS.includes(prefs.level) ? prefs.level : 'WARNING';
  db.run('UPDATE bot_links SET prefs=? WHERE chat_id=?', JSON.stringify({ cats, level, mute: !!prefs.mute }), String(chatId));
  return { ok: true };
}
function unlink(user, chatId, isAdmin) {
  const r = db.run(`UPDATE bot_links SET active=0 WHERE chat_id=? ${isAdmin ? '' : 'AND user_id=?'}`, String(chatId), ...(isAdmin ? [] : [user.id]));
  if (!r.changes) throw new AppError(404, 'Chat topilmadi');
  db.audit(user, 'TELEGRAM_UNLINK', 'bot_links', chatId); send(chatId, '🔌 Bot hisobdan uzildi (web tizim orqali).');
  return { ok: true };
}
function testMessage(user) {
  const mine = db.all('SELECT chat_id FROM bot_links WHERE user_id=? AND active=1', user.id);
  if (!enabled()) throw new AppError(400, 'Bot o‘chirilgan: API kalitlari bo‘limida Telegram bot tokenini kiriting');
  if (!mine.length) throw new AppError(400, 'Telegram hali ulanmagan');
  for (const m of mine) send(m.chat_id, `🔔 Test xabar — ${e(user.fullName)}. Bot ishlayapti ✅`, {}, 'test');
  return { sent: mine.length };
}
function messages(limit = 200) { return db.all('SELECT * FROM bot_messages ORDER BY id DESC LIMIT ?', limit); }
async function briefingNow(user) { if (!enabled()) throw new AppError(400, 'Bot o‘chirilgan'); await sendBriefing('now'); db.audit(user, 'TELEGRAM_BRIEFING', 'bot', null); return { ok: true }; }

module.exports = { init, start, reload, stop, enabled, flush, supervise, handleWebhook, checkWebhookSecret, webhookUrl, sendReport, createDriverLinkCode, createLinkCode, status, savePrefs, unlink, testMessage, messages, briefingNow, briefingText, CATEGORIES, _test: { handleUpdate, flushStock, supervise } };
