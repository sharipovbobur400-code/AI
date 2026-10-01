'use strict';
// Odoo ERP ulagichi (JSON-RPC, Odoo 14–18): API kalit bilan Ombor, Ta’minot va Logistika ma’lumotlarini tortadi.
//   Ombor     — mahsulotlar (storable), qoldiq (qty_available), minimal qoldiq (reordering rules)
//   Ta’minot  — yetkazib beruvchilar, xarid buyurtmalari (RFQ/PO + qatorlar, kechikish)
//   Logistika — chiquvchi jo‘natmalar (stock.picking outgoing)
// Sozlama settings.odoo da, API kalit AES-256-GCM bilan shifrlangan. Odoo'ga hech narsa yozilmaydi (faqat o‘qish).
const db = require('./db');
const secrets = require('./secrets');
const { clock, bad } = require('./core');

const CATS = [[/tayyor|finished|готов/i, 'FINISHED'], [/xom\s*ashyo|xomashyo|raw|сырь/i, 'RAW'], [/yarim|wip|полуфаб/i, 'WIP'], [/qadoq|pack|упаков/i, 'PACKAGING']];
const m2o = (v) => (Array.isArray(v) && v.length > 1 ? v[1] : null);
const m2oId = (v) => (Array.isArray(v) && v.length ? v[0] : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor({ url, db: database, login, apiKey }) { this.url = String(url).replace(/\/+$/, ''); this.db = database; this.login = login; this.key = apiKey; this.uid = null; this.fields = {}; this.version = null; this.id = 0; }
  async call(service, method, args) {
    let last;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`${this.url}/jsonrpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000),
          body: JSON.stringify({ jsonrpc: '2.0', method: 'call', id: ++this.id, params: { service, method, args } }) });
        if (res.status >= 500) throw Object.assign(new Error(`Odoo server xatosi HTTP ${res.status}`), { transient: true });
        if (!res.ok) throw new Error(res.status === 404 ? 'Odoo manzili noto‘g‘ri (/jsonrpc topilmadi)' : `Odoo HTTP ${res.status}`);
        const j = await res.json().catch(() => { throw new Error('Odoo javobi JSON emas — manzilni tekshiring'); });
        if (j.error) throw new Error(j.error.data?.message || j.error.message || 'Odoo xatosi');
        return j.result;
      } catch (e) {
        last = e.name === 'TimeoutError' || e.cause ? Object.assign(new Error(`Odoo serveriga ulanib bo‘lmadi: ${e.cause?.code || e.message}`), { transient: true }) : e;
        if (!last.transient || attempt === 3) throw last;
        await sleep(1000 * attempt);
      }
    }
    throw last;
  }
  async auth() {
    const v = await this.call('common', 'version', []);
    this.version = v?.server_version || null;
    const uid = await this.call('common', 'authenticate', [this.db, this.login, this.key, {}]);
    if (!uid) throw new Error('Odoo: login yoki API kalit noto‘g‘ri');
    this.uid = uid; return uid;
  }
  async exec(model, method, args = [], kwargs = {}) { if (!this.uid) await this.auth(); return this.call('object', 'execute_kw', [this.db, this.uid, this.key, model, method, args, kwargs]); }
  async has(model) { try { return !!(await this.exec('ir.model', 'search_count', [[['model', '=', model]]])); } catch { return false; } }
  async fieldsOf(model) { if (!this.fields[model]) this.fields[model] = new Set(Object.keys(await this.exec(model, 'fields_get', [], { attributes: ['type'] }) || {})); return this.fields[model]; }
  /** Faqat shu Odoo versiyasida mavjud maydonlarni so‘raydi. */
  async read(model, domain, fields, opts = {}) { const have = await this.fieldsOf(model); return (await this.exec(model, 'search_read', [domain], { fields: fields.filter((f) => have.has(f)), ...opts })) || []; }
}

// ---------------- sozlama ----------------
function config() { const c = db.setting('odoo', null); return c ? { ...c, apiKey: c.apiKeyEnc ? (() => { try { return secrets.decrypt(c.apiKeyEnc); } catch { return null; } })() : null } : null; }
function publicConfig() {
  const c = db.setting('odoo', null); if (!c) return { configured: false };
  const { apiKeyEnc, ...rest } = c;
  return { ...rest, configured: true, apiKeyMasked: apiKeyEnc ? (() => { try { return secrets.mask(secrets.decrypt(apiKeyEnc)); } catch { return '••••'; } })() : null };
}
function normalize(input, existing) {
  const url = String(input.url || existing?.url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/i.test(url)) throw bad('Odoo manzili: https://kompaniya.odoo.com ko‘rinishida');
  const dbName = String(input.db || existing?.db || '').trim(); if (!dbName) throw bad('Baza nomi (database) kerak');
  const login = String(input.login || existing?.login || '').trim(); if (!login) throw bad('Login (email) kerak');
  const apiKey = input.apiKey ? String(input.apiKey).trim() : existing?.apiKey;
  if (!apiKey || apiKey.length < 8) throw bad('API kalit kerak (Odoo → Sozlamalar → Foydalanuvchi → Account Security → New API Key)');
  const interval = Math.min(1440, Math.max(5, Number(input.intervalMin || existing?.intervalMin || 15)));
  const modules = { stock: input.modules?.stock ?? existing?.modules?.stock ?? true, purchase: input.modules?.purchase ?? existing?.modules?.purchase ?? true, delivery: input.modules?.delivery ?? existing?.modules?.delivery ?? true };
  return { url, db: dbName, login, apiKey, intervalMin: interval, modules, enabled: input.enabled ?? existing?.enabled ?? true };
}
async function test(input) {
  const c = normalize(input, config());
  const cl = new Client(c);
  await cl.auth();
  const out = { ok: true, version: cl.version, uid: cl.uid, models: {} };
  for (const [k, m] of [['stock', 'stock.quant'], ['purchase', 'purchase.order'], ['delivery', 'stock.picking']]) out.models[k] = await cl.has(m);
  return out;
}
function save(input, user) {
  const c = normalize(input, config());
  const prev = db.setting('odoo', {}) || {};
  db.setSetting('odoo', { ...prev, url: c.url, db: c.db, login: c.login, apiKeyEnc: secrets.encrypt(c.apiKey), intervalMin: c.intervalMin, modules: c.modules, enabled: !!c.enabled, updatedAt: clock.iso() });
  db.audit(user, 'ODOO_CONFIG', 'settings', 'odoo', { url: c.url, db: c.db, login: c.login, modules: c.modules, intervalMin: c.intervalMin });
  return publicConfig();
}
function remove(user) { db.run("DELETE FROM settings WHERE key='odoo'"); db.audit(user, 'ODOO_REMOVE', 'settings', 'odoo'); return { ok: true }; }

// ---------------- sinxronizatsiya ----------------
function category(name) { for (const [re, c] of CATS) if (re.test(name || '')) return c; return 'MATERIAL'; }
const skuOf = (p) => (p.default_code ? String(p.default_code).trim().slice(0, 60) : `ODOO-${p.id}`);

async function syncStock(cl, integration, ctx) {
  const have = await cl.fieldsOf('product.product');
  const domain = [['active', '=', true]];
  if (have.has('is_storable')) domain.push(['is_storable', '=', true]); else if (have.has('detailed_type')) domain.push(['detailed_type', '=', 'product']); else if (have.has('type')) domain.push(['type', '=', 'product']);
  const products = await cl.read('product.product', domain, ['id', 'default_code', 'name', 'categ_id', 'uom_id', 'qty_available', 'barcode', 'weight'], { limit: 20000 });
  const rules = {};
  if (await cl.has('stock.warehouse.orderpoint')) for (const r of await cl.read('stock.warehouse.orderpoint', [['active', '=', true]], ['product_id', 'product_min_qty'], { limit: 20000 })) { const pid = m2oId(r.product_id); if (pid) rules[pid] = (rules[pid] || 0) + Number(r.product_min_qty || 0); }
  const items = products.map((p) => ({ id: `odoo:${p.id}`, sku: skuOf(p), name: p.name, unit: m2o(p.uom_id) || 'dona', category: category(m2o(p.categ_id)), barcode: p.barcode || undefined,
    net_weight_kg: p.weight || undefined, min_stock: rules[p.id] ?? undefined }));
  const r1 = integration.ingest('products', items, ctx);
  const r2 = integration.ingest('stock', products.map((p) => ({ sku: skuOf(p), qty: Math.max(0, Number(p.qty_available || 0)), name: p.name })), ctx);
  return { products: r1.received, created: r1.created, updated: r1.updated, stockAdjusted: r2.adjustments || 0, errors: [...r1.errors, ...r2.errors].slice(0, 10) };
}

async function syncPurchase(cl) {
  // yetkazib beruvchilar
  const pf = await cl.fieldsOf('res.partner');
  const sdom = pf.has('supplier_rank') ? [['supplier_rank', '>', 0]] : pf.has('supplier') ? [['supplier', '=', true]] : [];
  const partners = await cl.read('res.partner', [...sdom, ['active', '=', true]], ['id', 'name', 'phone', 'mobile', 'email', 'street', 'city', 'country_id', 'vat'], { limit: 10000 });
  let sCreated = 0; let sUpdated = 0;
  db.tx(() => {
    for (const p of partners) {
      const code = `ODOO-${p.id}`; const ex = db.get('SELECT id FROM suppliers WHERE code=?', code);
      const row = { company: String(p.name || code).slice(0, 200), phone: p.phone || p.mobile || null, email: p.email || null, address: [p.street, p.city].filter(Boolean).join(', ') || null, country: m2o(p.country_id), notes: 'Odoo' };
      if (ex) { db.update('suppliers', ex.id, row); sUpdated++; } else { db.insert('suppliers', { code, ...row, active: 1, created_at: clock.iso() }); sCreated++; }
    }
  });
  // xarid buyurtmalari (ochiq + oxirgi 90 kun)
  const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const orders = await cl.read('purchase.order', ['|', ['state', 'in', ['draft', 'sent', 'to approve', 'purchase']], '&', ['state', '=', 'done'], ['date_order', '>=', since]],
    ['id', 'name', 'partner_id', 'state', 'date_order', 'date_planned', 'user_id', 'currency_id', 'amount_total', 'receipt_status', 'order_line'], { limit: 5000, order: 'date_order desc' });
  const lineIds = orders.flatMap((o) => o.order_line || []);
  const lines = lineIds.length ? await cl.read('purchase.order.line', [['id', 'in', lineIds]], ['order_id', 'product_id', 'name', 'product_qty', 'qty_received', 'price_unit', 'product_uom']) : [];
  const byOrder = {};
  for (const l of lines) (byOrder[m2oId(l.order_id)] ||= []).push({ product: m2o(l.product_id) || l.name, qty: Number(l.product_qty || 0), received: Number(l.qty_received || 0), price: Number(l.price_unit || 0), uom: m2o(l.product_uom) });
  const now = new Date(); let late = 0;
  db.tx(() => {
    db.run('DELETE FROM odoo_purchases');
    for (const o of orders) {
      const ls = byOrder[o.id] || [];
      const receipt = o.receipt_status ?? (ls.length ? (ls.every((l) => l.received >= l.qty) ? 'full' : ls.some((l) => l.received) ? 'partial' : 'pending') : null);
      const isLate = o.state === 'purchase' && receipt !== 'full' && o.date_planned && new Date(`${o.date_planned.replace(' ', 'T')}Z`) < now;
      if (isLate) late++;
      db.insert('odoo_purchases', { odoo_id: o.id, name: o.name, partner: m2o(o.partner_id), state: o.state, receipt_status: receipt, date_order: o.date_order, date_planned: o.date_planned || null,
        user_name: m2o(o.user_id), currency: m2o(o.currency_id), amount_total: Number(o.amount_total || 0), lines: JSON.stringify(ls), is_late: isLate ? 1 : 0, synced_at: clock.iso() });
    }
  });
  // kechikkanlar — AI ogohlantirish (bitta holat uchun bitta alert)
  const ai = require('./ai');
  for (const o of db.all('SELECT * FROM odoo_purchases WHERE is_late=1')) {
    ai.raise({ key: `ODOO_PO_LATE:${o.odoo_id}`, type: 'DELIVERY_DELAY', severity: o.receipt_status === 'partial' ? 'WARNING' : 'CRITICAL', title: `Odoo: ${o.name} kechikmoqda`,
      message: `${o.partner || 'Yetkazib beruvchi'} — ${o.name}, kutilgan sana ${String(o.date_planned || '').slice(0, 10)}, holat: ${o.receipt_status === 'partial' ? 'qisman kelgan' : 'kelmagan'}.`, ref_type: 'odoo_purchase', ref_id: o.odoo_id });
  }
  for (const a of db.all("SELECT id, dedupe_key FROM ai_events WHERE status<>'RESOLVED' AND dedupe_key LIKE 'ODOO_PO_LATE:%'")) {
    if (!db.get('SELECT 1 FROM odoo_purchases WHERE is_late=1 AND odoo_id=?', Number(a.dedupe_key.split(':')[1]))) db.update('ai_events', a.id, { status: 'RESOLVED', resolved_at: clock.iso() });
  }
  return { suppliers: partners.length, suppliersCreated: sCreated, suppliersUpdated: sUpdated, purchaseOrders: orders.length, late };
}

async function syncDelivery(cl) {
  const pf = await cl.fieldsOf('stock.picking');
  const typeDomain = pf.has('picking_type_code') ? [['picking_type_code', '=', 'outgoing']] : [];
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const picks = await cl.read('stock.picking', [...typeDomain, '|', ['state', 'not in', ['done', 'cancel']], ['date_done', '>=', since]],
    ['id', 'name', 'partner_id', 'state', 'scheduled_date', 'date_done', 'origin', 'picking_type_id', 'move_ids', 'move_lines'], { limit: 5000, order: 'scheduled_date asc' });
  const moveIds = picks.flatMap((p) => p.move_ids || p.move_lines || []);
  const moves = moveIds.length ? await cl.read('stock.move', [['id', 'in', moveIds]], ['picking_id', 'product_id', 'product_uom_qty', 'quantity', 'quantity_done', 'product_uom']) : [];
  const byPick = {};
  for (const m of moves) (byPick[m2oId(m.picking_id)] ||= []).push({ product: m2o(m.product_id), qty: Number(m.product_uom_qty || 0), done: Number(m.quantity ?? m.quantity_done ?? 0), uom: m2o(m.product_uom) });
  const now = new Date(); let late = 0;
  db.tx(() => {
    db.run('DELETE FROM odoo_deliveries');
    for (const p of picks) {
      const isLate = !['done', 'cancel'].includes(p.state) && p.scheduled_date && new Date(`${p.scheduled_date.replace(' ', 'T')}Z`) < now;
      if (isLate) late++;
      db.insert('odoo_deliveries', { odoo_id: p.id, name: p.name, partner: m2o(p.partner_id), state: p.state, scheduled_date: p.scheduled_date || null, date_done: p.date_done || null,
        origin: p.origin || null, picking_type: m2o(p.picking_type_id), lines: JSON.stringify(byPick[p.id] || []), is_late: isLate ? 1 : 0, synced_at: clock.iso() });
    }
  });
  return { deliveries: picks.length, late };
}

let running = false;
async function sync({ user, force = false } = {}) {
  const c = config();
  if (!c || !c.apiKey) throw bad('Odoo ulanmagan: Sozlamalar → API kalitlari → Odoo');
  if (!c.enabled && !force) return { skipped: true };
  if (running) return { skipped: true, reason: 'sinxronizatsiya davom etmoqda' };
  running = true;
  const started = clock.iso(); const stats = {}; const errors = [];
  try {
    const cl = new Client(c);
    await cl.auth();
    const integration = require('./integration');
    const sysUser = db.get("SELECT id, username, full_name, role_code FROM users WHERE username='integratsiya'");
    const ctx = { source: 'Odoo', reference: 'ODOO', user: user || (sysUser ? { id: sysUser.id, username: sysUser.username, fullName: sysUser.full_name, role: sysUser.role_code } : null) };
    const steps = [['stock', 'Ombor', () => syncStock(cl, integration, ctx), 'stock.quant'], ['purchase', 'Ta’minot', () => syncPurchase(cl), 'purchase.order'], ['delivery', 'Logistika', () => syncDelivery(cl), 'stock.picking']];
    for (const [k, label, fn, model] of steps) {
      if (c.modules?.[k] === false) continue;
      if (!(await cl.has(model))) { stats[k] = { skipped: `Odoo'da ${model} moduli o‘rnatilmagan` }; continue; }
      try { stats[k] = await fn(); } catch (e) { errors.push(`${label}: ${e.message}`); stats[k] = { error: e.message }; }
    }
    const cur = db.setting('odoo', {});
    db.setSetting('odoo', { ...cur, version: cl.version, lastSyncAt: clock.iso(), lastStatus: errors.length ? 'PARTIAL' : 'OK', lastError: errors.join('; ') || null, stats });
    db.emit('INTEGRATION_SYNC', { source: 'Odoo', stats, errors: errors.length });
    db.audit(user || null, 'ODOO_SYNC', 'odoo', c.url, { stats, errors, started });
    return { ok: !errors.length, version: cl.version, stats, errors };
  } catch (e) {
    const cur = db.setting('odoo', {});
    db.setSetting('odoo', { ...cur, lastSyncAt: clock.iso(), lastStatus: 'ERROR', lastError: e.message });
    require('./ai').raise({ key: 'ODOO_DOWN', type: 'INTEGRATION', severity: 'CRITICAL', title: 'Odoo bilan aloqa yo‘q', message: e.message });
    throw bad(e.message);
  } finally { running = false; }
}
/** Scheduler / cron uchun: vaqti kelgan bo‘lsa sinxronlaydi. */
async function tick() {
  const c = db.setting('odoo', null);
  if (!c || !c.enabled || !c.apiKeyEnc) return { skipped: true };
  if (c.lastSyncAt && Date.now() - new Date(c.lastSyncAt).getTime() < (c.intervalMin || 15) * 60000) return { skipped: true };
  const r = await sync().catch((e) => ({ error: e.message }));
  if (!r.error) { const a = db.get("SELECT id FROM ai_events WHERE dedupe_key='ODOO_DOWN' AND status<>'RESOLVED'"); if (a) db.update('ai_events', a.id, { status: 'RESOLVED', resolved_at: clock.iso() }); }
  return r;
}
let timer = null;
function start() { if (timer) return; timer = setInterval(() => { tick().catch((e) => console.error('odoo', e.message)); }, 60000); timer.unref(); setTimeout(() => tick().catch(() => {}), 5000).unref(); }

module.exports = { Client, config, publicConfig, test, save, remove, sync, tick, start };
