'use strict';
// Database layer: schema, helpers, transactions, event outbox, audit.
let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* older Node: better-sqlite3 fallback in openDatabase() */ }
const { clock, bus } = require('./core');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, val INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);

CREATE TABLE IF NOT EXISTS roles (code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT);
CREATE TABLE IF NOT EXISTS permissions (role_code TEXT NOT NULL REFERENCES roles(code), permission TEXT NOT NULL, PRIMARY KEY(role_code, permission));
CREATE TABLE IF NOT EXISTS employees (id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, position TEXT, department TEXT, phone TEXT, hired_at TEXT, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, full_name TEXT NOT NULL,
  role_code TEXT NOT NULL REFERENCES roles(code), employee_id INTEGER REFERENCES employees(id), active INTEGER DEFAULT 1,
  failed_logins INTEGER DEFAULT 0, locked_until TEXT, last_login TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, ip TEXT, user_agent TEXT, created_at TEXT, expires_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS warehouses (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT, address TEXT,
  length_m REAL, width_m REAL, height_m REAL, usable_volume_m3 REAL, pallet_positions INTEGER, max_load_kg REAL, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS warehouse_zones (id TEXT PRIMARY KEY, warehouse_id TEXT NOT NULL REFERENCES warehouses(id), code TEXT NOT NULL, name TEXT NOT NULL,
  zone_type TEXT NOT NULL, pallet_positions INTEGER DEFAULT 0, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS warehouse_locations (id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  zone_id TEXT NOT NULL REFERENCES warehouse_zones(id), rack TEXT, shelf TEXT, position TEXT, max_pallets INTEGER DEFAULT 1, max_weight_kg REAL DEFAULT 1500,
  x REAL DEFAULT 0, y REAL DEFAULT 0, active INTEGER DEFAULT 1);

CREATE TABLE IF NOT EXISTS suppliers (id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, company TEXT NOT NULL, contact TEXT, phone TEXT, email TEXT, address TEXT,
  country TEXT, payment_terms TEXT, contract_no TEXT, contract_until TEXT, notes TEXT, active INTEGER DEFAULT 1, created_at TEXT);

CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL, model TEXT, category TEXT NOT NULL,
  manufacturer TEXT, power_w REAL, length_mm REAL, width_mm REAL, height_mm REAL, net_weight_kg REAL DEFAULT 0, gross_weight_kg REAL DEFAULT 0,
  volume_m3 REAL DEFAULT 0, unit TEXT DEFAULT 'dona', units_per_pallet INTEGER DEFAULT 1, pallet_weight_kg REAL DEFAULT 25,
  pallet_length_mm REAL DEFAULT 1200, pallet_width_mm REAL DEFAULT 800, pallet_height_mm REAL DEFAULT 1200, packaging_type TEXT,
  packaging_weight_kg REAL DEFAULT 0, barcode TEXT UNIQUE, track_serial INTEGER DEFAULT 0, min_stock REAL DEFAULT 0, fragile INTEGER DEFAULT 0,
  max_stack INTEGER DEFAULT 1, orientation TEXT, packing_standard TEXT, electrical_spec TEXT, default_supplier_id INTEGER REFERENCES suppliers(id),
  lead_time_days INTEGER DEFAULT 7, default_location_id INTEGER REFERENCES warehouse_locations(id), status TEXT DEFAULT 'ACTIVE', created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS supplier_products (supplier_id INTEGER NOT NULL REFERENCES suppliers(id), product_id INTEGER NOT NULL REFERENCES products(id),
  price REAL, currency TEXT DEFAULT 'USD', lead_time_days INTEGER, moq REAL DEFAULT 1, PRIMARY KEY(supplier_id, product_id));
CREATE TABLE IF NOT EXISTS product_batches (id INTEGER PRIMARY KEY, batch_no TEXT UNIQUE NOT NULL, product_id INTEGER NOT NULL REFERENCES products(id),
  source TEXT, production_order TEXT, supplier_id INTEGER REFERENCES suppliers(id), mfg_date TEXT, expiry_date TEXT, qty REAL, created_at TEXT);
CREATE TABLE IF NOT EXISTS serial_numbers (id INTEGER PRIMARY KEY, serial TEXT UNIQUE NOT NULL, product_id INTEGER NOT NULL REFERENCES products(id),
  batch_id INTEGER, status TEXT NOT NULL, location_id INTEGER, order_id INTEGER, pallet_id INTEGER, shipment_id INTEGER, receiving_id INTEGER,
  created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS ix_serial_loc ON serial_numbers(product_id, location_id, status, batch_id);
CREATE INDEX IF NOT EXISTS ix_serial_pallet ON serial_numbers(pallet_id);

CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),
  location_id INTEGER NOT NULL REFERENCES warehouse_locations(id), batch_id INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
  qty REAL NOT NULL CHECK (qty >= 0), updated_at TEXT, UNIQUE(product_id, location_id, batch_id, status));
CREATE TABLE IF NOT EXISTS inventory_transactions (id INTEGER PRIMARY KEY, txn_no TEXT UNIQUE NOT NULL, type TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id), qty REAL NOT NULL, batch_id INTEGER, from_location_id INTEGER, to_location_id INTEGER,
  from_status TEXT, to_status TEXT, user_id INTEGER, created_at TEXT NOT NULL, ref_type TEXT, ref_id INTEGER, reference TEXT, reason TEXT, serials TEXT);
CREATE INDEX IF NOT EXISTS ix_txn_product ON inventory_transactions(product_id, created_at);
CREATE INDEX IF NOT EXISTS ix_txn_ref ON inventory_transactions(ref_type, ref_id);
CREATE TRIGGER IF NOT EXISTS trg_txn_no_update BEFORE UPDATE ON inventory_transactions BEGIN SELECT RAISE(ABORT, 'Inventory transaction o‘zgartirilmaydi'); END;
CREATE TRIGGER IF NOT EXISTS trg_txn_no_delete BEFORE DELETE ON inventory_transactions BEGIN SELECT RAISE(ABORT, 'Inventory transaction o‘chirilmaydi'); END;

CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, contact TEXT, phone TEXT, address TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, customer_id INTEGER REFERENCES customers(id),
  capacity_mw REAL, location TEXT, requires_xetq INTEGER DEFAULT 0, status TEXT DEFAULT 'ACTIVE', manager_id INTEGER REFERENCES users(id),
  start_date TEXT, end_date TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, order_no TEXT UNIQUE NOT NULL, customer_id INTEGER REFERENCES customers(id),
  project_id INTEGER REFERENCES projects(id), priority TEXT DEFAULT 'NORMAL', due_date TEXT, destination TEXT, status TEXT NOT NULL,
  notes TEXT, created_by INTEGER, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL CHECK(qty > 0), picked_qty REAL DEFAULT 0, packed_qty REAL DEFAULT 0, shipped_qty REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS inventory_reservations (id INTEGER PRIMARY KEY, res_no TEXT UNIQUE, product_id INTEGER NOT NULL REFERENCES products(id),
  order_id INTEGER REFERENCES orders(id), order_item_id INTEGER REFERENCES order_items(id), project_id INTEGER REFERENCES projects(id),
  qty REAL NOT NULL CHECK(qty >= 0), picked_qty REAL DEFAULT 0, status TEXT NOT NULL, note TEXT, created_by INTEGER, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS shortages (id INTEGER PRIMARY KEY, shortage_no TEXT UNIQUE, product_id INTEGER NOT NULL REFERENCES products(id),
  order_id INTEGER REFERENCES orders(id), order_item_id INTEGER REFERENCES order_items(id), required_qty REAL, available_qty REAL, reserved_qty REAL,
  shortage_qty REAL NOT NULL, status TEXT NOT NULL, purchase_request_id INTEGER, created_at TEXT, updated_at TEXT, resolved_at TEXT);

CREATE TABLE IF NOT EXISTS purchase_requests (id INTEGER PRIMARY KEY, pr_no TEXT UNIQUE NOT NULL, supplier_id INTEGER REFERENCES suppliers(id),
  product_id INTEGER NOT NULL REFERENCES products(id), qty REAL NOT NULL CHECK(qty > 0), required_date TEXT, priority TEXT DEFAULT 'NORMAL', reason TEXT,
  production_order TEXT, order_id INTEGER REFERENCES orders(id), shortage_id INTEGER, warehouse_id TEXT, status TEXT NOT NULL, ai_generated INTEGER DEFAULT 0,
  received_qty REAL DEFAULT 0, created_by INTEGER, approved_by INTEGER, approved_at TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS purchase_orders (id INTEGER PRIMARY KEY, po_no TEXT UNIQUE NOT NULL, supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  purchase_request_id INTEGER REFERENCES purchase_requests(id), status TEXT NOT NULL, order_date TEXT, expected_date TEXT, total REAL, currency TEXT,
  created_by INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS purchase_items (id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL REFERENCES purchase_orders(id), product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL, price REAL, received_qty REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS supplier_deliveries (id INTEGER PRIMARY KEY, delivery_no TEXT UNIQUE NOT NULL, po_id INTEGER REFERENCES purchase_orders(id),
  purchase_request_id INTEGER REFERENCES purchase_requests(id), supplier_id INTEGER NOT NULL REFERENCES suppliers(id), product_id INTEGER REFERENCES products(id),
  qty REAL, received_qty REAL DEFAULT 0, rejected_qty REAL DEFAULT 0, expected_date TEXT, original_expected_date TEXT, actual_date TEXT,
  status TEXT NOT NULL, vehicle TEXT, driver TEXT, notes TEXT, created_at TEXT, updated_at TEXT);

CREATE TABLE IF NOT EXISTS receiving_orders (id INTEGER PRIMARY KEY, rcv_no TEXT UNIQUE NOT NULL, source TEXT NOT NULL, supplier_id INTEGER,
  po_id INTEGER, delivery_id INTEGER, purchase_request_id INTEGER, delivery_number TEXT, vehicle TEXT, driver TEXT, received_date TEXT,
  product_id INTEGER NOT NULL REFERENCES products(id), batch_id INTEGER, qty_expected REAL, qty_received REAL NOT NULL, weight_kg REAL,
  production_order TEXT, production_total REAL, rework_qty REAL DEFAULT 0, reject_qty REAL DEFAULT 0, location_id INTEGER,
  status TEXT NOT NULL, documents TEXT, deadline TEXT, notes TEXT, created_by INTEGER, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS quality_checks (id INTEGER PRIMARY KEY, qc_no TEXT UNIQUE NOT NULL, receiving_id INTEGER REFERENCES receiving_orders(id),
  product_id INTEGER NOT NULL, batch_id INTEGER, qty REAL, passed_qty REAL, failed_qty REAL, rework_qty REAL, result TEXT, inspector_id INTEGER,
  notes TEXT, created_at TEXT);

CREATE TABLE IF NOT EXISTS picking_tasks (id INTEGER PRIMARY KEY, task_no TEXT UNIQUE NOT NULL, order_id INTEGER NOT NULL REFERENCES orders(id),
  status TEXT NOT NULL, assigned_to INTEGER REFERENCES users(id), deadline TEXT, route TEXT, errors INTEGER DEFAULT 0, scans INTEGER DEFAULT 0,
  started_at TEXT, completed_at TEXT, created_by INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS picking_task_lines (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES picking_tasks(id), product_id INTEGER NOT NULL,
  location_id INTEGER NOT NULL, batch_id INTEGER DEFAULT 0, qty REAL NOT NULL, picked_qty REAL DEFAULT 0, seq INTEGER, status TEXT DEFAULT 'PENDING');
CREATE TABLE IF NOT EXISTS packing_tasks (id INTEGER PRIMARY KEY, task_no TEXT UNIQUE NOT NULL, order_id INTEGER NOT NULL REFERENCES orders(id),
  status TEXT NOT NULL, assigned_to INTEGER, deadline TEXT, started_at TEXT, completed_at TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS pallets (id INTEGER PRIMARY KEY, pallet_no TEXT UNIQUE NOT NULL, order_id INTEGER REFERENCES orders(id),
  product_id INTEGER REFERENCES products(id), batch_id INTEGER DEFAULT 0, qty REAL NOT NULL, net_weight_kg REAL, pallet_weight_kg REAL, packaging_weight_kg REAL,
  gross_weight_kg REAL, length_mm REAL, width_mm REAL, height_mm REAL, volume_m3 REAL, stackable INTEGER DEFAULT 1, fragile INTEGER DEFAULT 0,
  location_id INTEGER, status TEXT NOT NULL, shipment_id INTEGER, label TEXT, created_by INTEGER, created_at TEXT, updated_at TEXT);

CREATE TABLE IF NOT EXISTS drivers (id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, phone TEXT, license_no TEXT, license_category TEXT, status TEXT DEFAULT 'AVAILABLE', created_at TEXT);
CREATE TABLE IF NOT EXISTS vehicles (id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, type TEXT NOT NULL, model TEXT, plate TEXT,
  length_m REAL NOT NULL, width_m REAL NOT NULL, height_m REAL NOT NULL, volume_m3 REAL NOT NULL, payload_kg REAL NOT NULL, pallet_capacity INTEGER,
  owner TEXT, driver_id INTEGER REFERENCES drivers(id), status TEXT NOT NULL DEFAULT 'AVAILABLE', notes TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS shipments (id INTEGER PRIMARY KEY, ship_no TEXT UNIQUE NOT NULL, order_id INTEGER REFERENCES orders(id), project_id INTEGER,
  vehicle_id INTEGER REFERENCES vehicles(id), driver_id INTEGER REFERENCES drivers(id), status TEXT NOT NULL, destination TEXT, distance_km REAL,
  planned_departure TEXT, loading_start TEXT, loading_end TEXT, departure TEXT, eta TEXT, actual_arrival TEXT,
  total_weight_kg REAL, total_volume_m3 REAL, pallet_count INTEGER, total_qty REAL, created_by INTEGER, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS shipment_items (id INTEGER PRIMARY KEY, shipment_id INTEGER NOT NULL REFERENCES shipments(id), pallet_id INTEGER REFERENCES pallets(id),
  product_id INTEGER NOT NULL, qty REAL NOT NULL, loaded INTEGER DEFAULT 0, load_seq INTEGER, load_position TEXT);
CREATE TABLE IF NOT EXISTS loading_tasks (id INTEGER PRIMARY KEY, task_no TEXT UNIQUE NOT NULL, shipment_id INTEGER NOT NULL REFERENCES shipments(id),
  vehicle_id INTEGER, status TEXT NOT NULL, assigned_to INTEGER, loading_location_id INTEGER, sequence TEXT, warnings TEXT, planned_start TEXT,
  deadline TEXT, estimated_minutes REAL, started_at TEXT, completed_at TEXT, actual_minutes REAL, delay_reason TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS transport_assignments (id INTEGER PRIMARY KEY, shipment_id INTEGER NOT NULL REFERENCES shipments(id), vehicle_id INTEGER NOT NULL,
  driver_id INTEGER, weight_util REAL, volume_util REAL, pallet_util REAL, assigned_by INTEGER, assigned_at TEXT, status TEXT DEFAULT 'ACTIVE');

CREATE TABLE IF NOT EXISTS technical_specifications (id INTEGER PRIMARY KEY, ts_no TEXT NOT NULL, version TEXT NOT NULL, project_id INTEGER REFERENCES projects(id),
  product_id INTEGER REFERENCES products(id), title TEXT, model TEXT, power TEXT, dimensions TEXT, weight TEXT, electrical_spec TEXT, material_spec TEXT,
  packaging_spec TEXT, quality_requirements TEXT, standards TEXT, revision_note TEXT, status TEXT NOT NULL, created_by INTEGER, approved_by INTEGER,
  approved_at TEXT, created_at TEXT, UNIQUE(ts_no, version));
CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY, doc_no TEXT UNIQUE NOT NULL, doc_type TEXT NOT NULL, title TEXT NOT NULL,
  project_id INTEGER, ref_type TEXT, ref_id INTEGER, current_version TEXT, status TEXT NOT NULL, author_id INTEGER, approver_id INTEGER,
  approved_at TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS document_versions (id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id), version TEXT NOT NULL,
  content TEXT, file_path TEXT, file_name TEXT, mime TEXT, size INTEGER, sha256 TEXT NOT NULL, status TEXT NOT NULL, change_note TEXT,
  author_id INTEGER, created_at TEXT, UNIQUE(document_id, version));
CREATE TRIGGER IF NOT EXISTS trg_docver_no_delete BEFORE DELETE ON document_versions BEGIN SELECT RAISE(ABORT, 'Hujjat versiyasi o‘chirilmaydi'); END;
CREATE TABLE IF NOT EXISTS doc_templates (code TEXT PRIMARY KEY, name TEXT NOT NULL, html TEXT NOT NULL, updated_by INTEGER, updated_at TEXT);
CREATE TABLE IF NOT EXISTS xetq_submissions (id INTEGER PRIMARY KEY, sub_no TEXT UNIQUE NOT NULL, title TEXT NOT NULL, project_id INTEGER REFERENCES projects(id),
  product_id INTEGER, qty REAL, ts_id INTEGER REFERENCES technical_specifications(id), document_ids TEXT, packing_spec TEXT, logistics_info TEXT,
  responsible_id INTEGER, status TEXT NOT NULL, version TEXT DEFAULT '1.0', submitted_at TEXT, approved_at TEXT, created_by INTEGER, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS xetq_reviews (id INTEGER PRIMARY KEY, submission_id INTEGER NOT NULL REFERENCES xetq_submissions(id), from_status TEXT, to_status TEXT,
  comment TEXT, required_changes TEXT, fix_owner_id INTEGER, deadline TEXT, new_version TEXT, reviewer TEXT, created_by INTEGER, created_at TEXT);

CREATE TABLE IF NOT EXISTS inventory_counts (id INTEGER PRIMARY KEY, count_no TEXT UNIQUE NOT NULL, warehouse_id TEXT, zone_id TEXT, status TEXT NOT NULL,
  created_by INTEGER, posted_by INTEGER, created_at TEXT, posted_at TEXT, reason TEXT);
CREATE TABLE IF NOT EXISTS inventory_count_lines (id INTEGER PRIMARY KEY, count_id INTEGER NOT NULL REFERENCES inventory_counts(id), product_id INTEGER, location_id INTEGER,
  batch_id INTEGER DEFAULT 0, status TEXT, system_qty REAL, physical_qty REAL, counted_by INTEGER);

CREATE TABLE IF NOT EXISTS status_history (id INTEGER PRIMARY KEY, entity TEXT NOT NULL, entity_id INTEGER NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
  note TEXT, user_id INTEGER, created_at TEXT);
CREATE INDEX IF NOT EXISTS ix_hist ON status_history(entity, entity_id);
CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, user_id INTEGER, role_code TEXT, level TEXT, title TEXT, message TEXT, ref_type TEXT, ref_id INTEGER,
  is_read INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY, user_id INTEGER, username TEXT, action TEXT NOT NULL, entity TEXT, entity_id TEXT, details TEXT, ip TEXT, created_at TEXT);
CREATE TRIGGER IF NOT EXISTS trg_audit_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'Audit log o‘zgartirilmaydi'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'Audit log o‘chirilmaydi'); END;
CREATE TABLE IF NOT EXISTS ai_events (id INTEGER PRIMARY KEY, dedupe_key TEXT, type TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL, message TEXT,
  ref_type TEXT, ref_id INTEGER, data TEXT, status TEXT DEFAULT 'OPEN', created_at TEXT, updated_at TEXT, resolved_at TEXT);
CREATE INDEX IF NOT EXISTS ix_ai_key ON ai_events(dedupe_key, status);
CREATE TABLE IF NOT EXISTS system_events (id INTEGER PRIMARY KEY, type TEXT NOT NULL, payload TEXT, user_id INTEGER, created_at TEXT);

CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value_enc TEXT NOT NULL, last4 TEXT, meta TEXT, updated_by INTEGER, updated_at TEXT);
CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT UNIQUE NOT NULL, scopes TEXT NOT NULL,
  created_by INTEGER, created_at TEXT, last_used_at TEXT, last_ip TEXT, uses INTEGER DEFAULT 0, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS integrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, auth_type TEXT NOT NULL, auth_name TEXT, secret_enc TEXT,
  endpoints TEXT, mapping TEXT, poll_seconds INTEGER DEFAULT 60, active INTEGER DEFAULT 1, last_sync_at TEXT, last_status TEXT, last_error TEXT, stats TEXT,
  created_by INTEGER, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS integration_runs (id INTEGER PRIMARY KEY, integration_id INTEGER, source TEXT, entity TEXT, received INTEGER, created INTEGER, updated INTEGER,
  errors INTEGER, message TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS dispatch_jobs (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), shipment_id INTEGER, vehicle_id INTEGER, driver_id INTEGER,
  status TEXT NOT NULL, planned_at TEXT, contacted_at TEXT, attempts INTEGER DEFAULT 0, tried TEXT, note TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS teambot_messages (id INTEGER PRIMARY KEY, chat_id TEXT, message_id INTEGER, bot TEXT, from_id TEXT, from_name TEXT, is_bot INTEGER DEFAULT 0, kind TEXT, text TEXT, created_at TEXT, UNIQUE(chat_id, message_id));
CREATE INDEX IF NOT EXISTS ix_tbmsg ON teambot_messages(chat_id, id);
CREATE TABLE IF NOT EXISTS teambot_groups (chat_id TEXT PRIMARY KEY, title TEXT, allowed INTEGER DEFAULT 0, first_bot TEXT, seen_at TEXT);
CREATE TABLE IF NOT EXISTS bom_items (id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), component_id INTEGER NOT NULL REFERENCES products(id),
  qty_per_unit REAL NOT NULL CHECK(qty_per_unit > 0), scrap_pct REAL DEFAULT 0, note TEXT, updated_at TEXT, UNIQUE(product_id, component_id));
CREATE TABLE IF NOT EXISTS production_orders (id INTEGER PRIMARY KEY, po_no TEXT UNIQUE NOT NULL, product_id INTEGER NOT NULL REFERENCES products(id), qty REAL NOT NULL CHECK(qty > 0),
  produced_qty REAL DEFAULT 0, good_qty REAL DEFAULT 0, rework_qty REAL DEFAULT 0, reject_qty REAL DEFAULT 0, status TEXT NOT NULL, priority TEXT DEFAULT 'NORMAL', line TEXT,
  planned_start TEXT, planned_end TEXT, released_at TEXT, started_at TEXT, completed_at TEXT, order_id INTEGER REFERENCES orders(id), notes TEXT, created_by INTEGER, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS ix_prod_status ON production_orders(status);
CREATE TABLE IF NOT EXISTS production_materials (id INTEGER PRIMARY KEY, production_order_id INTEGER NOT NULL REFERENCES production_orders(id), component_id INTEGER NOT NULL REFERENCES products(id),
  required_qty REAL NOT NULL, issued_qty REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS client_errors (id INTEGER PRIMARY KEY, user_id INTEGER, username TEXT, page TEXT, api TEXT, status INTEGER, message TEXT, stack TEXT, ua TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS server_errors (id INTEGER PRIMARY KEY, method TEXT, path TEXT, message TEXT, stack TEXT, user_id INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS odoo_purchases (odoo_id INTEGER PRIMARY KEY, name TEXT, partner TEXT, state TEXT, receipt_status TEXT, date_order TEXT, date_planned TEXT,
  user_name TEXT, currency TEXT, amount_total REAL, lines TEXT, is_late INTEGER DEFAULT 0, synced_at TEXT);
CREATE TABLE IF NOT EXISTS odoo_deliveries (odoo_id INTEGER PRIMARY KEY, name TEXT, partner TEXT, state TEXT, scheduled_date TEXT, date_done TEXT, origin TEXT,
  picking_type TEXT, lines TEXT, is_late INTEGER DEFAULT 0, synced_at TEXT);
CREATE TABLE IF NOT EXISTS daily_reports (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, report_date TEXT NOT NULL, text TEXT NOT NULL, data TEXT, ai_summary TEXT,
  sent_to INTEGER DEFAULT 0, created_at TEXT, UNIQUE(kind, report_date));
`;

let db = null;
let depth = 0;
let pending = [];
let currentUserId = null;

function openDatabase(file) {
  if (DatabaseSync) return new DatabaseSync(file);
  // fallback for hosts with Node < 22.5 (no built-in node:sqlite): same synchronous API
  try { const BetterSqlite = require('better-sqlite3'); return new BetterSqlite(file); }
  catch (e) { throw new Error(`SQLite topilmadi: Node.js 22.5+ kerak (hozir ${process.version}) yoki "npm install better-sqlite3" bajaring. (${e.message})`); }
}
let dbFile = null;
function init(file) {
  dbFile = file;
  db = openDatabase(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
  db.exec(SCHEMA);
  // additive migrations (safe to re-run)
  for (const sql of ['ALTER TABLE orders ADD COLUMN external_ref TEXT', 'ALTER TABLE products ADD COLUMN external_ref TEXT', 'ALTER TABLE vehicles ADD COLUMN external_ref TEXT',
    'ALTER TABLE drivers ADD COLUMN external_ref TEXT', 'ALTER TABLE drivers ADD COLUMN telegram_chat_id TEXT', 'ALTER TABLE drivers ADD COLUMN carrier TEXT', 'ALTER TABLE document_versions ADD COLUMN file_data BLOB', 'ALTER TABLE users ADD COLUMN section TEXT']) {
    try { db.exec(sql); } catch { /* column exists */ }
  }
  return db;
}
const raw = () => db;
/** Serverless helpers: close / reopen after the file was replaced, change counter, consistent snapshot. */
function close() { cache.clear(); if (db) { try { db.close(); } catch { /* already closed */ } } db = null; }
let reopened = 0; // replacing the file (import) must count as a change for serverless sync
function reopen(file) { close(); reopened++; return init(file || dbFile); }
const totalChanges = () => Number(db.prepare('SELECT total_changes() c').get().c) + reopened * 1e9;
function snapshot(dest) { try { require('node:fs').unlinkSync(dest); } catch { /* none */ } db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); return dest; }
const file = () => dbFile;
const cache = new Map();
function stmt(sql) { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; }
const norm = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
const all = (sql, ...p) => stmt(sql).all(...norm(p)).map((r) => ({ ...r }));
const get = (sql, ...p) => { const r = stmt(sql).get(...norm(p)); return r ? { ...r } : null; };
const run = (sql, ...p) => stmt(sql).run(...norm(p));
const val = (sql, ...p) => { const r = stmt(sql).get(...norm(p)); return r ? Object.values(r)[0] : null; };

function insert(table, obj) {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  const r = run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => obj[k]));
  return Number(r.lastInsertRowid);
}
function update(table, id, obj, idCol = 'id') {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  if (!keys.length) return;
  run(`UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(',')} WHERE ${idCol}=?`, ...keys.map((k) => obj[k]), id);
}

// Nested-safe transactions; events emitted only after the outermost COMMIT.
function tx(fn) {
  const outer = depth === 0;
  const sp = `sp${depth}`;
  db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  depth++;
  try {
    const res = fn();
    depth--;
    db.exec(outer ? 'COMMIT' : `RELEASE ${sp}`);
    if (outer) { const evs = pending; pending = []; for (const e of evs) bus.emit('event', e); }
    return res;
  } catch (e) {
    depth--;
    db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    if (outer) pending = [];
    throw e;
  }
}

function emit(type, payload = {}) {
  const created_at = clock.iso();
  const id = insert('system_events', { type, payload: JSON.stringify(payload), user_id: currentUserId, created_at });
  const ev = { id, type, payload, created_at, user_id: currentUserId };
  if (depth > 0) pending.push(ev); else bus.emit('event', ev);
  return ev;
}

function nextNo(prefix, pad = 4, withYear = true) {
  const year = clock.now().getUTCFullYear();
  const key = withYear ? `${prefix}-${year}` : prefix;
  run('INSERT INTO counters(key,val) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET val=val+1', key);
  const n = val('SELECT val FROM counters WHERE key=?', key);
  return `${key}-${String(n).padStart(pad, '0')}`;
}

function audit(user, action, entity, entityId, details, ip) {
  insert('audit_logs', {
    user_id: user ? user.id : null, username: user ? user.username : 'system', action, entity,
    entity_id: entityId == null ? null : String(entityId), details: details ? JSON.stringify(details) : null, ip: ip || (user && user.ip) || null,
    created_at: clock.iso(),
  });
}
function history(entity, entityId, from, to, user, note) {
  insert('status_history', { entity, entity_id: entityId, from_status: from, to_status: to, note: note || null, user_id: user ? user.id : null, created_at: clock.iso() });
}
function setting(key, def) { const v = val('SELECT value FROM settings WHERE key=?', key); return v == null ? def : JSON.parse(v); }
function setSetting(key, value) { run('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', key, JSON.stringify(value), clock.iso()); }
function withUser(user, fn) { const prev = currentUserId; currentUserId = user ? user.id : null; try { return fn(); } finally { currentUserId = prev; } }

module.exports = { init, openDatabase, raw, close, reopen, totalChanges, snapshot, file, all, get, run, val, insert, update, tx, emit, nextNo, audit, history, setting, setSetting, withUser };
