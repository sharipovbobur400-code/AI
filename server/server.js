'use strict';
// HTTP(S) server: security headers, sessions, CSRF, rate limiting, REST dispatch, SSE real-time stream, static SPA, backups.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const ROOT = path.join(__dirname, '..');
(function loadEnv() { // minimal .env loader (secrets stay server-side)
  if (process.env.WMS_NO_DOTENV === '1') return; // avtomatik testlar haqiqiy kalitlarni o‘qimasin
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line); if (!m || line.trim().startsWith('#')) continue;
    let v = m[2].trim();
    const q = /^(["'])(.*)\1$/.exec(v);
    v = q ? q[2] : v.replace(/\s+#.*$/, '').replace(/^#.*$/, '').trim(); // strip inline comments on unquoted values
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

// Serverless (Vercel): no long-running process, read-only project dir, /tmp scratch disk.
const SERVERLESS = !!process.env.VERCEL || process.env.WMS_SERVERLESS === '1';
if (SERVERLESS) {
  process.env.TRUST_PROXY ??= '1';
  process.env.BEHIND_HTTPS ??= '1';
  process.env.DATA_DIR ??= '/tmp/wms-data';
  process.env.BOT_BATCH_SECONDS ??= '0';
}
const db = require('./db');
const auth = require('./auth');
const docs = require('./documents');
const sections = require('./sections');
const { AppError, bus, clock } = require('./core');

const DATA = path.resolve(ROOT, process.env.DATA_DIR || 'data');
fs.mkdirSync(DATA, { recursive: true });
try { const ht = path.join(DATA, '.htaccess'); if (!fs.existsSync(ht)) fs.writeFileSync(ht, 'Require all denied\n'); } catch { /* read-only fs */ }
db.init(path.join(DATA, process.env.DB_FILE || 'wms.db'));
docs.setFileDir(path.join(DATA, 'files'));
require('./secrets').init(DATA);
auth.seedRoles();
docs.seedTemplates();
if (!db.val('SELECT COUNT(*) FROM warehouses')) {
  // "real" (default): only warehouse structure + system accounts; "demo" is used by the automated tests
  require('./seed').run(process.env.SEED || 'real');
} else require('./seed').systemUsers();
const api = require('./api');
const ai = require('./ai');
const bot = require('./bot');
const integration = require('./integration');
if (SERVERLESS) { bot.init(); require('./teambots').start().catch((e) => console.error('teambots:', e.message)); } // webhook mode — schedulers are driven by /api/cron/tick
else {
  bot.start();
  integration.startScheduler();
  require('./dispatcher').start();
  require('./daily').start();
  require('./odoo').start();
  require('./teambots').start().catch((e) => console.error('teambots:', e.message));
}

const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const TLS = process.env.TLS_CERT && process.env.TLS_KEY;
const CSP = "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; frame-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

function secHeaders(res, extra = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  if (TLS || process.env.BEHIND_HTTPS === '1') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', extra.csp || CSP);
}
function cookies(req) { return Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((c) => c[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])); }
function ipOf(req) { return (process.env.TRUST_PROXY === '1' && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || ''; }
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
function readBody(req, max = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new AppError(413, 'So‘rov hajmi juda katta')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { const o = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(o && typeof o === 'object' ? o : {}); } catch { reject(new AppError(400, 'JSON noto‘g‘ri')); } });
    req.on('error', reject);
  });
}
const cookieOpts = () => `Path=/; HttpOnly; SameSite=Strict${TLS || process.env.BEHIND_HTTPS === '1' ? '; Secure' : ''}`;

// ---- SSE clients ----
const clients = new Set();
bus.on('event', (ev) => {
  const msg = `id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify({ ...ev.payload, _at: ev.created_at })}\n\n`;
  for (const c of clients) { if (c.section && !sections.eventAllowed(c.section, ev.type)) continue; try { c.res.write(msg); } catch { clients.delete(c); } }
});
setInterval(() => { for (const c of clients) { try { c.res.write(`: ping ${Date.now()}\n\n`); } catch { clients.delete(c); } } }, 25000).unref();

async function handleApi(req, res, url) {
  const ip = ipOf(req);
  auth.rateLimit(`api:${ip}`, Number(process.env.RATE_LIMIT_PER_MIN || 1200), 60000);
  const c = cookies(req);
  const token = c.sid;
  const method = req.method;

  if (url.pathname === '/api/auth/login' && method === 'POST') {
    auth.rateLimit(`login:${ip}`, 10, 60000);
    const body = await readBody(req, 10000);
    const r = auth.login(body.username, body.password, { ip, ua: req.headers['user-agent'] });
    return send(res, 200, { user: r.user, csrf: r.csrf }, { 'Set-Cookie': `sid=${r.token}; Max-Age=${12 * 3600}; ${cookieOpts()}` });
  }
  // ---- first-run setup: create the super admin (only while none exists) ----
  if (url.pathname === '/api/setup/status' && method === 'GET') return send(res, 200, { needsSetup: !db.get("SELECT id FROM users WHERE role_code='SUPERADMIN'") });
  if (url.pathname === '/api/setup' && method === 'POST') {
    auth.rateLimit(`setup:${ip}`, 5, 60000);
    if (db.get("SELECT id FROM users WHERE role_code='SUPERADMIN'")) throw new AppError(403, 'Tizim allaqachon sozlangan');
    const b = await readBody(req, 10000);
    const login = String(b.login || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!/^[\p{L}\p{N}._\- ]{3,40}$/u.test(login)) throw new AppError(400, 'Login 3-40 belgi (harf, raqam, bo‘sh joy, . _ -)');
    auth.validatePasswordPolicy(b.password);
    if (db.get('SELECT id FROM users WHERE username=?', login)) throw new AppError(400, 'Login band');
    const id = db.insert('users', { username: login, password_hash: auth.hashPassword(b.password), full_name: String(b.fullName || b.login).trim().slice(0, 150), role_code: 'SUPERADMIN', active: 1, created_at: clock.iso() });
    db.audit({ id, username: login }, 'SETUP_SUPERADMIN', 'users', id, null, ip);
    return send(res, 200, { ok: true });
  }
  // ---- Telegram webhook (serverless mode) ----
  if (url.pathname === '/api/telegram/webhook' && method === 'POST') {
    if (!bot.checkWebhookSecret(req.headers['x-telegram-bot-api-secret-token'])) throw new AppError(401, 'Webhook secret noto‘g‘ri');
    const update = await readBody(req, 1024 * 1024);
    await bot.handleWebhook(update);
    return send(res, 200, { ok: true });
  }
  // ---- jamoa botlari webhook (serverless) ----
  { const wm = /^\/api\/teambots\/webhook\/(\w+)$/.exec(url.pathname);
    if (wm && method === 'POST') {
      const tbots = require('./teambots');
      if (!tbots.checkWebhook(wm[1], req.headers['x-telegram-bot-api-secret-token'])) throw new AppError(401, 'Webhook secret noto‘g‘ri');
      await tbots.handleWebhook(wm[1], await readBody(req, 1024 * 1024));
      return send(res, 200, { ok: true });
    } }
  // ---- scheduled work (Vercel Cron / external cron): reports, AI scan, dispatcher, integrations ----
  if (url.pathname === '/api/cron/tick') {
    const secret = process.env.CRON_SECRET;
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('key') || '';
    if (!secret || given.length !== secret.length || !require('node:crypto').timingSafeEqual(Buffer.from(given), Buffer.from(secret))) throw new AppError(401, 'CRON_SECRET noto‘g‘ri');
    return send(res, 200, await runTick());
  }
  // ---- external API for company systems (X-API-Key) ----
  if (url.pathname.startsWith('/api/ext/v1/')) {
    auth.rateLimit(`ext:${ip}`, Number(process.env.EXT_RATE_LIMIT_PER_MIN || 600), 60000);
    const k = integration.authApiKey(req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), ip);
    if (!k) throw new AppError(401, 'API kalit noto‘g‘ri yoki bekor qilingan');
    const entity = url.pathname.slice('/api/ext/v1/'.length).replace(/\/$/, '');
    if (method === 'GET') {
      if (!k.scopes.includes('read')) throw new AppError(403, 'Kalitda read ruxsati yo‘q');
      const inv = require('./inventory');
      const data = { stock: () => inv.stockSummary(), locations: () => inv.inventoryRows({}),
        orders: () => db.all("SELECT o.order_no, o.external_ref, o.status, o.due_date, o.destination, c.name customer FROM orders o LEFT JOIN customers c ON c.id=o.customer_id WHERE o.status NOT IN ('DELIVERED','CANCELLED') ORDER BY o.due_date"),
        shipments: () => db.all("SELECT s.ship_no, s.status, s.planned_departure, s.departure, s.eta, s.destination, s.total_qty, s.pallet_count, s.total_weight_kg, v.code vehicle, d.full_name driver FROM shipments s LEFT JOIN vehicles v ON v.id=s.vehicle_id LEFT JOIN drivers d ON d.id=s.driver_id ORDER BY s.id DESC LIMIT 500"),
        report: () => require('./daily').morning(require('./daily').localParts().date).data }[entity];
      if (!data) throw new AppError(404, 'Endpoint topilmadi');
      return send(res, 200, data());
    }
    if (method === 'POST') {
      if (!k.scopes.includes('write')) throw new AppError(403, 'Kalitda write ruxsati yo‘q');
      const body = await readBody(req);
      return send(res, 200, integration.ingest(entity, body, { source: `API: ${k.name}`, reference: `API-${k.id}` }));
    }
    throw new AppError(405, 'Method not allowed');
  }
  const user = auth.sessionUser(token);
  if (user) { user.ip = ip; user.permissions = auth.permsOf(user.role); req._userId = user.id; }
  if (url.pathname === '/api/auth/me') { if (!user) throw new AppError(401, 'Tizimga kiring'); return send(res, 200, { user: { ...auth.publicUser({ id: user.id, username: user.username, full_name: user.fullName, role_code: user.role, section: user.section }) }, csrf: user.csrf }); }
  if (!user && url.pathname !== '/api/health') throw new AppError(401, 'Tizimga kiring');
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  if (mutating && user) {
    if (req.headers['x-csrf-token'] !== user.csrf) throw new AppError(403, 'CSRF token noto‘g‘ri — sahifani yangilang');
    const origin = req.headers.origin; if (origin && new URL(origin).host !== req.headers.host) throw new AppError(403, 'Origin ruxsat etilmagan');
  }
  if (url.pathname === '/api/auth/logout' && method === 'POST') { auth.logout(token); db.audit(user, 'LOGOUT', 'users', user.id); return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=; Max-Age=0; ${cookieOpts()}` }); }
  if (url.pathname === '/api/auth/password' && method === 'POST') {
    const b = await readBody(req, 10000); const u = db.get('SELECT * FROM users WHERE id=?', user.id);
    if (!auth.verifyPassword(String(b.oldPassword || ''), u.password_hash)) throw new AppError(400, 'Joriy parol noto‘g‘ri');
    auth.validatePasswordPolicy(b.newPassword); db.run('UPDATE users SET password_hash=? WHERE id=?', auth.hashPassword(b.newPassword), user.id);
    db.run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', user.id, user.tokenHash); db.audit(user, 'PASSWORD_CHANGE', 'users', user.id); return send(res, 200, { ok: true });
  }
  // ---- bo‘lim foydalanuvchisi: faqat o‘z bo‘limi API lari ----
  if (user && user.section && !sections.allows(user.section, method, url.pathname)) throw new AppError(403, `Bu bo‘lim sizga yopiq (${sections.SECTIONS[user.section]?.label || user.section})`);
  // ---- real-time stream ----
  if (url.pathname === '/api/events/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`retry: ${SERVERLESS ? 5000 : 3000}\n\n`);
    const last = Number(req.headers['last-event-id'] || url.searchParams.get('lastEventId') || 0);
    if (last) for (const e of db.all('SELECT * FROM system_events WHERE id>? ORDER BY id LIMIT 500', last)) if (!user.section || sections.eventAllowed(user.section, e.type)) res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify({ ...JSON.parse(e.payload || '{}'), _at: e.created_at, _replay: !SERVERLESS })}\n\n`);
    if (SERVERLESS) { if (!last) { const maxId = db.val('SELECT MAX(id) FROM system_events') || 0; res.write(`id: ${maxId}\n: sync\n\n`); } return res.end(); }
    const client = { res, user: user.id, section: user.section }; clients.add(client);
    req.on('close', () => clients.delete(client));
    return;
  }
  // ---- raw file endpoints ----
  let m;
  if ((m = /^\/api\/documents\/versions\/(\d+)\/(view|download)$/.exec(url.pathname)) && method === 'GET') {
    const v = db.get('SELECT * FROM document_versions WHERE id=?', Number(m[1])); if (!v) throw new AppError(404, 'Versiya topilmadi');
    db.audit(user, m[2] === 'view' ? 'DOC_VIEW' : 'DOC_DOWNLOAD', 'document_versions', v.id);
    if (v.file_path) {
      const f = docs.fileOf(v.id);
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
      res.writeHead(200, { 'Content-Type': f.mime || 'application/octet-stream', 'Content-Disposition': `${m[2] === 'view' && /pdf|image/.test(f.mime) ? 'inline' : 'attachment'}; filename="${f.name}"`, 'Cache-Control': 'no-store' });
      if (f.data) return res.end(f.data);
      return fs.createReadStream(f.path).pipe(res);
    }
    res.setHeader('Content-Security-Policy', "sandbox allow-modals; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    return send(res, 200, v.content || '', { 'Content-Type': 'text/html; charset=utf-8', ...(m[2] === 'download' ? { 'Content-Disposition': `attachment; filename="doc-${v.document_id}-v${v.version}.html"` } : {}) });
  }
  if (url.pathname === '/api/admin/backup' && method === 'POST') { auth.require(user, 'admin.backup'); return send(res, 200, backup(user)); }
  if (url.pathname === '/api/admin/backups' && method === 'GET') { auth.require(user, 'admin.backup'); return send(res, 200, listBackups()); }

  const hit = api.match(method, url.pathname);
  if (!hit) throw new AppError(404, 'API topilmadi');
  if (hit.route.perm) auth.require(user, hit.route.perm); // perm null = public (health check)
  const body = mutating ? await readBody(req, url.pathname === '/api/admin/transfer/import' ? 800 * 1024 * 1024 : undefined) : {};
  const query = Object.fromEntries(url.searchParams);
  const out = await db.withUser(user, () => hit.route.handler({ user, body, params: hit.params, query, ip, req, res }));
  if (out && out.__raw !== undefined) return send(res, 200, out.__raw, { 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${out.filename}"` });
  return send(res, 200, out === undefined ? { ok: true } : out);
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || !path.extname(p)) p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  // no-cache + ETag: brauzer har safar tekshiradi (304) — yangilanishdan keyin eski JS/CSS qolib ketmaydi
  const st = fs.statSync(file); const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag, 'Last-Modified': st.mtime.toUTCString() };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

function backup(user) {
  const dir = path.join(DATA, 'backups'); fs.mkdirSync(dir, { recursive: true });
  const name = `wms-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`;
  db.raw().exec(`VACUUM INTO '${path.join(dir, name).replace(/'/g, "''")}'`);
  const keep = Number(process.env.BACKUP_KEEP || 14);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(dir, f));
  db.audit(user, 'BACKUP', 'database', name);
  return { file: name, size: fs.statSync(path.join(dir, name)).size };
}
function listBackups() { const dir = path.join(DATA, 'backups'); if (!fs.existsSync(dir)) return []; return fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort().reverse().map((f) => ({ file: f, size: fs.statSync(path.join(dir, f)).size, at: fs.statSync(path.join(dir, f)).mtime })); }

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  secHeaders(res);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    return serveStatic(req, res, url);
  } catch (e) {
    const status = e instanceof AppError ? e.status : /Omborda yetarli|CHECK constraint/.test(e.message) ? 400 : 500;
    if (status === 500) {
      console.error(e);
      try { // server xatolari jurnali (Sozlamalar → Diagnostika)
        db.insert('server_errors', { method: req.method, path: url.pathname, message: String(e.message).slice(0, 1000), stack: String(e.stack || '').split('\n').slice(0, 6).join('\n').slice(0, 2000), user_id: req._userId || null, created_at: clock.iso() });
        db.run('DELETE FROM server_errors WHERE id <= (SELECT MAX(id) - 500 FROM server_errors)');
      } catch { /* baza ishlamasa ham javob qaytarilsin */ }
    }
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Serverda xatolik yuz berdi' : e.message, details: e.details });
    else res.end();
  }
}

/** One scheduler cycle — used by Vercel Cron (serverless) and safe to call anytime. */
async function runTick() {
  const out = {};
  const step = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = { error: e.message }; console.error('tick', name, e.message); } };
  await step('aiScan', () => ai.scan());
  await step('dispatcher', () => require('./dispatcher').cycle());
  await step('escalation', () => bot.supervise());
  await step('integrations', async () => { const due = db.all('SELECT id, poll_seconds, last_sync_at FROM integrations WHERE active=1').filter((i) => !i.last_sync_at || Date.now() - new Date(i.last_sync_at).getTime() >= i.poll_seconds * 1000); for (const i of due) await integration.runIntegration(i.id); return due.length; });
  await step('dailyReports', () => require('./daily').tick());
  await step('odoo', () => require('./odoo').tick());
  await step('teambots', async () => { const t = require('./teambots'); const r = await t.tick(); await t.flush(); return r; });
  return { ok: true, at: clock.iso(), ...out };
}
module.exports = { handler, runTick, SERVERLESS };
if (SERVERLESS) return; // Vercel imports the handler (api/index.js); no listen / intervals

// PORT is a TCP port, or — on hosting panels such as ISPmanager / Passenger — a unix socket path.
const PORT_RAW = String(process.env.PORT || 3000).trim();
const SOCKET = /^\d+$/.test(PORT_RAW) ? null : PORT_RAW;
const PORT = SOCKET ? null : Number(PORT_RAW);
const server = TLS ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, handler) : http.createServer(handler);
server.requestTimeout = 60000;
server.on('error', (e) => { console.error(`Server ishga tushmadi (${SOCKET || PORT}): ${e.message}`); process.exit(1); });
const onListen = () => {
  if (SOCKET) { try { fs.chmodSync(SOCKET, 0o666); } catch { /* ignore */ } }
  console.log(`Solar Factory WMS: ${SOCKET ? `unix socket ${SOCKET}` : `${TLS ? 'https' : 'http'}://${process.env.HOST || 'localhost'}:${PORT}`}  (Node ${process.version}, DB: ${path.join(DATA, process.env.DB_FILE || 'wms.db')}, AI: ${(() => { const i = ai.llmInfo(); return i.configured ? `${i.provider} (${i.model}) + database` : 'database'; })()})`);
};
if (SOCKET) { try { if (fs.existsSync(SOCKET)) fs.unlinkSync(SOCKET); } catch { /* stale socket */ } server.listen(SOCKET, onListen); }
else server.listen(PORT, process.env.HOST || '127.0.0.1', onListen);
// periodic AI scan (shortages, delays, capacity, deadlines) + daily backup
const scanMs = Number(process.env.AI_SCAN_SECONDS || 60) * 1000;
setTimeout(() => { try { ai.scan(); } catch (e) { console.error('AI scan', e.message); } }, 1500).unref();
setInterval(() => { try { ai.scan(); } catch (e) { console.error('AI scan', e.message); } }, scanMs).unref();
if (process.env.BACKUP_DAILY !== '0') setInterval(() => { try { backup(null); } catch (e) { console.error('Backup', e.message); } }, 24 * 3600 * 1000).unref();
process.on('SIGINT', () => { bot.stop(); server.close(); process.exit(0); });
process.on('SIGTERM', () => { bot.stop(); server.close(); process.exit(0); });
module.exports.server = server;
