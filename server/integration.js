'use strict';
// Company data integration.
//  • PULL: the company's API (base URL + API key) is polled on an interval; products, stock, orders, vehicles
//    and drivers are imported. Field names are mapped per integration.
//  • PUSH: the company's systems call /api/ext/v1/* with an API key issued here (real-time).
// Every stock change still goes through inventory.move() (ADJUSTMENT transactions) — the audit trail stays intact.
const crypto = require('node:crypto');
const db = require('./db');
const inv = require('./inventory');
const secrets = require('./secrets');
const { clock, bad, notFound, V, round } = require('./core');

const ENTITIES = ['products', 'stock', 'drivers', 'vehicles', 'orders'];
const CATS = ['FINISHED', 'RAW', 'WIP', 'MATERIAL', 'PACKAGING'];
const sysUser = (name = 'integratsiya') => { const u = db.get('SELECT id, username, full_name, role_code FROM users WHERE username=?', name); return u ? { id: u.id, username: u.username, fullName: u.full_name, role: u.role_code } : null; };
const pick = (obj, pathStr) => (!pathStr ? obj : String(pathStr).split('.').reduce((a, k) => (a == null ? a : a[k]), obj));
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

// ---------------- ingestion (shared by push & pull) ----------------
function upsertProducts(items, ctx) {
  const r = { received: items.length, created: 0, updated: 0, errors: [] };
  for (const it of items) {
    try {
      const sku = V.str(it.sku, 'sku', { max: 60 });
      const ex = db.get('SELECT * FROM products WHERE sku=?', sku);
      const row = { name: it.name ? String(it.name).slice(0, 200) : undefined, model: it.model || undefined, unit: it.unit || undefined, power_w: num(it.power_w) ?? undefined,
        net_weight_kg: num(it.net_weight_kg ?? it.weight) ?? undefined, gross_weight_kg: num(it.gross_weight_kg) ?? undefined, units_per_pallet: num(it.units_per_pallet) ?? undefined,
        length_mm: num(it.length_mm) ?? undefined, width_mm: num(it.width_mm) ?? undefined, height_mm: num(it.height_mm) ?? undefined, min_stock: num(it.min_stock) ?? undefined,
        barcode: it.barcode ? String(it.barcode) : undefined, external_ref: it.id != null ? String(it.id) : undefined };
      if (it.category && CATS.includes(String(it.category).toUpperCase())) row.category = String(it.category).toUpperCase();
      if (ex) { db.update('products', ex.id, { ...row, updated_at: clock.iso() }); r.updated++; }
      else { db.insert('products', { sku, name: row.name || sku, category: row.category || 'FINISHED', unit: row.unit || 'dona', units_per_pallet: row.units_per_pallet || 1, ...row, status: 'ACTIVE', created_at: clock.iso(), updated_at: clock.iso() }); r.created++; }
    } catch (err) { r.errors.push(`${it.sku || '?'}: ${err.message}`); }
  }
  if (r.created || r.updated) db.emit('PRODUCT_CHANGED', { source: ctx.source });
  return r;
}
/** Absolute stock snapshot: [{sku, qty, location?}] → ADJUSTMENT transactions for the difference in AVAILABLE stock. */
function syncStock(items, ctx) {
  const r = { received: items.length, created: 0, updated: 0, errors: [], adjustments: 0 };
  const totals = new Map();
  for (const it of items) { if (!it.sku) { r.errors.push('sku yo‘q'); continue; } const k = String(it.sku); const t = totals.get(k) || { qty: 0, location: it.location, name: it.name, unit: it.unit, category: it.category }; t.qty += Number(it.qty ?? it.quantity ?? 0); totals.set(k, t); }
  for (const [sku, t] of totals) {
    try {
      db.tx(() => {
        let p = db.get('SELECT * FROM products WHERE sku=?', sku);
        if (!p) { upsertProducts([{ sku, name: t.name, unit: t.unit, category: t.category }], ctx); p = db.get('SELECT * FROM products WHERE sku=?', sku); r.created++; }
        const target = Math.max(0, p.track_serial ? Math.round(t.qty) : round(t.qty, 4));
        const current = db.val("SELECT COALESCE(SUM(qty),0) FROM inventory WHERE product_id=? AND status='AVAILABLE'", p.id) || 0;
        const delta = round(target - current, 4);
        if (!delta) return;
        const reason = `Tashqi tizim sinxronizatsiyasi (${ctx.source})`;
        if (delta > 0) {
          const loc = t.location ? db.get('SELECT id FROM warehouse_locations WHERE code=?', String(t.location)) : null;
          const plan = loc ? [{ locationId: loc.id, qty: delta }] : inv.putawayPlan(p, delta);
          for (const leg of plan) inv.move({ type: 'ADJUSTMENT', productId: p.id, qty: leg.qty, to: { locationId: leg.locationId, status: 'AVAILABLE' }, user: ctx.user, reference: ctx.reference, reason });
        } else {
          for (const leg of inv.take({ productId: p.id, qty: -delta, status: 'AVAILABLE' })) inv.move({ type: 'ADJUSTMENT', productId: p.id, qty: leg.qty, from: { locationId: leg.locationId, status: 'AVAILABLE', batchId: leg.batchId }, user: ctx.user, reference: ctx.reference, reason });
        }
        r.adjustments++; r.updated++;
        if (delta > 0) require('./orders').allocateProduct(p.id, ctx.user);
      });
    } catch (err) { r.errors.push(`${sku}: ${err.message}`); }
  }
  return r;
}
function upsertDrivers(items, ctx) {
  const r = { received: items.length, created: 0, updated: 0, errors: [] };
  for (const it of items) {
    try {
      const name = V.str(it.full_name ?? it.name, 'name', { max: 150 });
      const ext = it.id != null ? String(it.id) : null; const phone = it.phone ? String(it.phone) : null;
      const ex = (ext && db.get('SELECT * FROM drivers WHERE external_ref=?', ext)) || (phone && db.get('SELECT * FROM drivers WHERE phone=?', phone)) || db.get('SELECT * FROM drivers WHERE full_name=?', name);
      const row = { full_name: name, phone: phone || undefined, license_no: it.license_no || undefined, license_category: it.license_category || undefined, carrier: it.carrier || it.company || undefined, external_ref: ext || undefined };
      if (ex) { db.update('drivers', ex.id, row); r.updated++; } else { db.insert('drivers', { ...row, status: 'AVAILABLE', created_at: clock.iso() }); r.created++; }
    } catch (err) { r.errors.push(`${it.name || '?'}: ${err.message}`); }
  }
  return r;
}
const VSTAT = ['AVAILABLE', 'RESERVED', 'LOADING', 'IN_TRANSIT', 'MAINTENANCE', 'UNAVAILABLE'];
function upsertVehicles(items, ctx) {
  const r = { received: items.length, created: 0, updated: 0, errors: [] };
  for (const it of items) {
    try {
      const code = V.str(it.code ?? it.plate ?? it.id, 'code', { max: 40 });
      const ex = db.get('SELECT * FROM vehicles WHERE code=? OR (external_ref IS NOT NULL AND external_ref=?)', code, it.id != null ? String(it.id) : '');
      const L = num(it.length_m); const W = num(it.width_m); const H = num(it.height_m);
      let driverId;
      if (it.driver || it.driver_phone) { const d = db.get('SELECT id FROM drivers WHERE phone=? OR full_name=?', it.driver_phone || '', it.driver || ''); driverId = d?.id; }
      const row = { type: it.type || undefined, model: it.model || undefined, plate: it.plate || undefined, length_m: L ?? undefined, width_m: W ?? undefined, height_m: H ?? undefined,
        volume_m3: num(it.volume_m3) ?? (L && W && H ? round(L * W * H, 1) : undefined), payload_kg: num(it.payload_kg) ?? undefined, pallet_capacity: num(it.pallet_capacity) ?? undefined,
        owner: it.owner || it.carrier || undefined, driver_id: driverId, external_ref: it.id != null ? String(it.id) : undefined };
      const st = it.status && VSTAT.includes(String(it.status).toUpperCase()) ? String(it.status).toUpperCase() : undefined;
      if (ex) {
        // never override statuses the WMS itself manages for an active shipment
        const busy = db.val("SELECT COUNT(*) FROM shipments WHERE vehicle_id=? AND status IN ('PLANNED','LOADING','LOADED','DISPATCHED')", ex.id);
        db.update('vehicles', ex.id, { ...row, ...(st && !busy ? { status: st } : {}) }); r.updated++;
      } else {
        for (const k of ['length_m', 'width_m', 'height_m', 'payload_kg']) if (row[k] == null) throw bad(`"${k}" majburiy`);
        db.insert('vehicles', { code, ...row, type: row.type || 'Yuk mashinasi', status: st || 'AVAILABLE', created_at: clock.iso() }); r.created++;
      }
    } catch (err) { r.errors.push(`${it.code || it.plate || '?'}: ${err.message}`); }
  }
  if (r.created || r.updated) db.emit('VEHICLE_STATUS', { source: ctx.source });
  return r;
}
function upsertOrders(items, ctx) {
  const r = { received: items.length, created: 0, updated: 0, errors: [] };
  for (const it of items) {
    try {
      const ref = V.str(it.order_no ?? it.orderNo ?? it.id, 'order_no', { max: 80 });
      const ex = db.get('SELECT * FROM orders WHERE external_ref=?', ref);
      const due = it.due_date || it.dueDate || it.ship_date || it.shipDate;
      if (ex) {
        if (!['SHIPPED', 'DELIVERED', 'CANCELLED'].includes(ex.status)) db.update('orders', ex.id, { due_date: due ? V.date(due, 'due_date') : ex.due_date, destination: it.destination || ex.destination, updated_at: clock.iso() });
        r.updated++; continue;
      }
      const lines = V.arr(it.items || it.lines, 'items').map((l) => {
        const sku = String(l.sku); let p = db.get('SELECT id FROM products WHERE sku=?', sku);
        if (!p) { upsertProducts([{ sku, name: l.name }], ctx); p = db.get('SELECT id FROM products WHERE sku=?', sku); }
        return { productId: p.id, qty: Number(l.qty ?? l.quantity) };
      });
      const o = require('./orders').createOrder({ customerName: it.customer || it.customer_name || 'Tashqi mijoz', items: lines, dueDate: due, destination: it.destination, priority: ['URGENT', 'HIGH', 'NORMAL', 'LOW'].includes(it.priority) ? it.priority : 'NORMAL', notes: `Tashqi tizimdan (${ctx.source}): ${ref}` }, ctx.user);
      db.update('orders', o.id, { external_ref: ref });
      r.created++;
    } catch (err) { r.errors.push(`${it.order_no || it.id || '?'}: ${err.message}`); }
  }
  return r;
}
const HANDLERS = { products: upsertProducts, stock: syncStock, drivers: upsertDrivers, vehicles: upsertVehicles, orders: upsertOrders };

function ingest(entity, payload, ctx) {
  if (!HANDLERS[entity]) throw notFound('Obyekt turi');
  const items = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : null;
  if (!items) throw bad('JSON massiv yoki {"items": [...]} kutilgan');
  if (items.length > 20000) throw bad('Bir so‘rovda ko‘pi bilan 20000 ta yozuv');
  const user = ctx.user || sysUser();
  const res = db.withUser(user, () => HANDLERS[entity](items, { ...ctx, user, reference: ctx.reference || `INT-${clock.today()}` }));
  db.insert('integration_runs', { integration_id: ctx.integrationId || null, source: ctx.source, entity, received: res.received, created: res.created, updated: res.updated, errors: res.errors.length, message: res.errors.slice(0, 5).join('; ') || null, created_at: clock.iso() });
  db.audit(user, 'INTEGRATION_SYNC', entity, ctx.source, { received: res.received, created: res.created, updated: res.updated, errors: res.errors.length });
  db.emit('INTEGRATION_SYNC', { entity, source: ctx.source, ...res, errors: res.errors.length });
  return { ...res, errors: res.errors.slice(0, 50) };
}

// ---------------- inbound API keys (push) ----------------
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const SCOPES = ['read', 'write'];
function createApiKey(input, user) {
  const name = V.str(input.name, 'Nomi', { max: 100 });
  const scopes = (input.scopes || ['read', 'write']).filter((s) => SCOPES.includes(s));
  if (!scopes.length) throw bad('Kamida bitta ruxsat tanlang');
  const prefix = crypto.randomBytes(4).toString('hex');
  const key = `wms_${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
  const id = db.insert('api_keys', { name, prefix, key_hash: sha(key), scopes: JSON.stringify(scopes), created_by: user?.id, created_at: clock.iso() });
  db.audit(user, 'API_KEY_CREATE', 'api_keys', id, { name, scopes });
  return { id, key, prefix, scopes, note: 'Kalit faqat hozir bir marta ko‘rsatiladi — xavfsiz joyga saqlang.' };
}
function revokeApiKey(id, user) { db.run('UPDATE api_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL', clock.iso(), id); db.audit(user, 'API_KEY_REVOKE', 'api_keys', id); return { ok: true }; }
function listApiKeys() { return db.all('SELECT k.id, k.name, k.prefix, k.scopes, k.created_at, k.last_used_at, k.last_ip, k.uses, k.revoked_at, u.full_name created_by FROM api_keys k LEFT JOIN users u ON u.id=k.created_by ORDER BY k.id DESC').map((k) => ({ ...k, scopes: JSON.parse(k.scopes) })); }
function authApiKey(raw, ip) {
  if (!raw) return null;
  const k = db.get('SELECT * FROM api_keys WHERE key_hash=? AND revoked_at IS NULL', sha(String(raw).trim()));
  if (!k) return null;
  db.run('UPDATE api_keys SET last_used_at=?, last_ip=?, uses=uses+1 WHERE id=?', clock.iso(), ip, k.id);
  return { id: k.id, name: k.name, scopes: JSON.parse(k.scopes) };
}

// ---------------- pull connectors ----------------
function parseJson(v, name, fallback) { if (v == null || v === '') return fallback; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { throw bad(`${name}: JSON noto‘g‘ri`); } }
function validateConfig(input) {
  const base = V.str(input.baseUrl, 'Base URL', { max: 500 });
  if (!/^https?:\/\//i.test(base)) throw bad('Base URL http:// yoki https:// bilan boshlanishi kerak');
  const endpoints = parseJson(input.endpoints, 'Endpointlar', {});
  for (const k of Object.keys(endpoints)) if (!ENTITIES.includes(k)) throw bad(`Noma’lum endpoint: ${k}`);
  if (!Object.values(endpoints).some(Boolean)) throw bad('Kamida bitta endpoint kiriting (masalan stock: /api/stock)');
  return { name: V.str(input.name, 'Nomi', { max: 100 }), base_url: base.replace(/\/$/, ''), auth_type: V.oneOf(input.authType || 'bearer', 'Avtorizatsiya', ['bearer', 'header', 'query', 'none']),
    auth_name: V.str(input.authName, 'Header / parametr nomi', { required: false, max: 60 }), endpoints: JSON.stringify(endpoints), mapping: JSON.stringify(parseJson(input.mapping, 'Mapping', {})),
    poll_seconds: V.num(input.pollSeconds ?? 60, 'Yangilanish oralig‘i', { int: true, min: 10, max: 86400 }) };
}
function saveIntegration(id, input, user) {
  return db.tx(() => {
    const row = validateConfig(input);
    if (input.apiKey) row.secret_enc = secrets.encrypt(String(input.apiKey).trim());
    if (id) { if (!db.get('SELECT id FROM integrations WHERE id=?', id)) throw notFound('Integratsiya'); db.update('integrations', id, { ...row, active: input.active === false ? 0 : 1, updated_at: clock.iso() }); }
    else { if (!input.apiKey && row.auth_type !== 'none') throw bad('API kalitini kiriting'); id = db.insert('integrations', { ...row, active: 1, created_by: user?.id, created_at: clock.iso(), updated_at: clock.iso() }); }
    db.audit(user, 'INTEGRATION_SAVE', 'integrations', id, { name: row.name, base: row.base_url });
    return { id };
  });
}
function listIntegrations() {
  return db.all('SELECT * FROM integrations ORDER BY id').map((i) => ({ id: i.id, name: i.name, baseUrl: i.base_url, authType: i.auth_type, authName: i.auth_name, hasKey: !!i.secret_enc,
    keyMasked: i.secret_enc ? secrets.mask(secrets.decrypt(i.secret_enc)) : null, endpoints: JSON.parse(i.endpoints || '{}'), mapping: JSON.parse(i.mapping || '{}'), pollSeconds: i.poll_seconds,
    active: !!i.active, lastSyncAt: i.last_sync_at, lastStatus: i.last_status, lastError: i.last_error, stats: i.stats ? JSON.parse(i.stats) : null,
    runs: db.all('SELECT entity, received, created, updated, errors, message, created_at FROM integration_runs WHERE integration_id=? ORDER BY id DESC LIMIT 10', i.id) }));
}
function deleteIntegration(id, user) { db.run('DELETE FROM integrations WHERE id=?', id); db.audit(user, 'INTEGRATION_DELETE', 'integrations', id); return { ok: true }; }

async function fetchEntity(i, entity) {
  const endpoints = JSON.parse(i.endpoints || '{}'); const mapping = JSON.parse(i.mapping || '{}');
  const ep = endpoints[entity]; if (!ep) return null;
  const url = new URL(/^https?:/i.test(ep) ? ep : `${i.base_url}${ep.startsWith('/') ? '' : '/'}${ep}`);
  const key = i.secret_enc ? secrets.decrypt(i.secret_enc) : null;
  const headers = { accept: 'application/json' };
  if (key && i.auth_type === 'bearer') headers.authorization = `Bearer ${key}`;
  if (key && i.auth_type === 'header') headers[i.auth_name || 'X-API-Key'] = key;
  if (key && i.auth_type === 'query') url.searchParams.set(i.auth_name || 'api_key', key);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${entity}: HTTP ${res.status}`);
  const body = await res.json();
  let items = pick(body, mapping.root?.[entity]);
  if (!Array.isArray(items)) items = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : Array.isArray(body?.data) ? body.data : null;
  if (!Array.isArray(items)) throw new Error(`${entity}: javobda massiv topilmadi (mapping.root.${entity} ni ko‘rsating)`);
  const fields = mapping.fields?.[entity];
  return fields ? items.map((x) => { const o = { ...x }; for (const [ours, theirs] of Object.entries(fields)) o[ours] = pick(x, theirs); return o; }) : items;
}
const running = new Set();
async function runIntegration(id, { user } = {}) {
  const i = db.get('SELECT * FROM integrations WHERE id=?', id); if (!i) throw notFound('Integratsiya');
  if (running.has(id)) return { skipped: true };
  running.add(id);
  const stats = {}; const errs = [];
  try {
    for (const entity of ENTITIES) {
      try { const items = await fetchEntity(i, entity); if (!items) continue; const r = ingest(entity, items, { source: i.name, integrationId: i.id, user: user || sysUser(), reference: `INT-${i.id}` }); stats[entity] = { received: r.received, created: r.created, updated: r.updated, errors: r.errors.length }; if (r.errors.length) errs.push(...r.errors.slice(0, 3)); }
      catch (err) { errs.push(err.message); stats[entity] = { error: err.message }; }
    }
    db.update('integrations', i.id, { last_sync_at: clock.iso(), last_status: errs.length ? (Object.values(stats).some((s) => !s.error) ? 'PARTIAL' : 'ERROR') : 'OK', last_error: errs.slice(0, 5).join('; ') || null, stats: JSON.stringify(stats) });
    return { stats, errors: errs };
  } finally { running.delete(id); }
}
async function testIntegration(input) {
  const cfg = validateConfig(input);
  const i = { ...cfg, secret_enc: input.apiKey ? secrets.encrypt(input.apiKey) : input.id ? db.val('SELECT secret_enc FROM integrations WHERE id=?', input.id) : null };
  const out = {};
  for (const entity of ENTITIES) { try { const items = await fetchEntity(i, entity); if (items) out[entity] = { ok: true, count: items.length, sample: items[0] || null }; } catch (err) { out[entity] = { ok: false, error: err.message }; } }
  return out;
}
let timer = null;
function startScheduler() {
  timer = setInterval(() => {
    for (const i of db.all('SELECT id, poll_seconds, last_sync_at FROM integrations WHERE active=1')) {
      if (!i.last_sync_at || Date.now() - new Date(i.last_sync_at).getTime() >= i.poll_seconds * 1000) runIntegration(i.id).catch((err) => console.error('integration', i.id, err.message));
    }
  }, 5000);
  timer.unref();
}

module.exports = { ENTITIES, ingest, createApiKey, revokeApiKey, listApiKeys, authApiKey, saveIntegration, listIntegrations, deleteIntegration, runIntegration, testIntegration, startScheduler };
