'use strict';
// Vercel adapter. Each function instance keeps a local SQLite copy in /tmp and synchronises it with durable
// storage (Neon Postgres): reads check the version first; writes take a global lock, apply the change,
// then upload the new snapshot before the response is sent. Requests inside one instance run one at a time.
process.env.WMS_SERVERLESS = '1';
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/wms-data';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { createStore } = require('./snapshot-store');

const DATA = path.resolve(process.env.DATA_DIR);
const DB_FILE = path.join(DATA, process.env.DB_FILE || 'wms.db');
let store = null; let srv = null; let db = null; let localVersion = null; let booting = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- in-instance serialisation (Vercel Fluid compute may run concurrent requests in one instance) ----
let chain = Promise.resolve();
function exclusive(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }

function writeLocal(gz) {
  fs.mkdirSync(DATA, { recursive: true });
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + ext); } catch { /* none */ } }
  fs.writeFileSync(DB_FILE, zlib.gunzipSync(gz));
}
async function pull() {
  const d = await store.download(); if (!d) return false;
  if (db) db.close();
  writeLocal(d.data);
  if (db) { db.reopen(DB_FILE); require('./auth').loadPerms(); }
  localVersion = d.version;
  return true;
}
async function push() {
  const tmp = `${DB_FILE}.snap`;
  db.snapshot(tmp);
  const gz = zlib.gzipSync(fs.readFileSync(tmp), { level: 6 });
  fs.unlinkSync(tmp);
  const v = crypto.randomUUID();
  await store.upload(gz, v);
  localVersion = v;
}
async function acquire(owner) {
  const t0 = Date.now();
  while (!(await store.tryLock(owner, 40))) {
    if (Date.now() - t0 > 25000) throw new Error('Baza band — birozdan so‘ng qayta urinib ko‘ring');
    await sleep(100 + Math.random() * 150);
  }
}
/** Run fn with the global write lock on an up-to-date local DB; upload the result if anything changed. */
async function locked(fn, forcePush = false) {
  const owner = crypto.randomUUID();
  await acquire(owner);
  try {
    const v = await store.version();
    if (v !== null && v !== localVersion) await pull();
    const before = db.totalChanges();
    const result = await fn();
    if (forcePush || v === null || db.totalChanges() !== before) await push();
    return result;
  } finally { await store.unlock(owner).catch(() => {}); }
}

async function boot() {
  store = createStore();
  if (!store) throw new Error('DATABASE_URL topilmadi. Vercel → Storage → Neon (Postgres) bazasini ulang — DATABASE_URL avtomatik qo‘shiladi.');
  await store.init();
  const d = await store.download();
  if (d) { writeLocal(d.data); localVersion = d.version; }
  srv = require('./server.js');
  db = require('./db');
  const bootChanges = db.totalChanges(); // seed / super admin from env on first start
  await locked(async () => {
    require('./seed').systemUsers();
    await require('./bot').reload().catch((e) => console.error('Telegram webhook:', e.message));
  }, bootChanges > 0);
}

// ---- response capture: nothing is sent until the new snapshot is safely stored ----
function capture(res) {
  const orig = { writeHead: res.writeHead, write: res.write, end: res.end };
  const ops = []; let done; const ended = new Promise((r) => { done = r; });
  res.writeHead = (...a) => { ops.push(['writeHead', a]); return res; };
  res.write = (...a) => { ops.push(['write', a]); return true; };
  res.end = (...a) => { ops.push(['end', a]); done(); return res; };
  return {
    ended,
    discard() { Object.assign(res, orig); ops.length = 0; },
    release() {
      Object.assign(res, orig);
      for (const [m, a] of ops) { res[m](...a); if (m === 'end') return; }
      res.end();
    },
  };
}
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error('So‘rov vaqti tugadi'); })]);

async function afterWrite(pathname) {
  if (pathname.startsWith('/api/cron/')) return;
  const dsp = require('./dispatcher'); const ai = require('./ai');
  try { dsp.cycle(); } catch (e) { console.error('dispatcher', e.message); }
  try { await require('./teambots').flush(); } catch (e) { console.error('teambots', e.message); }
  const last = db.setting('last_ai_scan_at', null);
  if (!last || Date.now() - new Date(last).getTime() > 120000) { try { ai.scan(); db.setSetting('last_ai_scan_at', new Date().toISOString()); } catch (e) { console.error('ai scan', e.message); } }
}

module.exports = async function vercelHandler(req, res) {
  try { await (booting ||= exclusive(boot)); }
  catch (e) {
    booting = null; console.error('boot', e);
    res.statusCode = 500; res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end(`Server sozlanmagan: ${e.message}`);
  }
  const pathname = (req.url || '/').split('?')[0];
  if (!pathname.startsWith('/api/')) return srv.handler(req, res); // static files (normally served by Vercel CDN)
  const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method) || pathname.startsWith('/api/cron/');
  const cap = capture(res);
  try {
    await exclusive(async () => {
      if (isWrite) {
        await locked(async () => {
          await withTimeout((async () => { await srv.handler(req, res); await cap.ended; })(), 55000);
          await afterWrite(pathname);
          await require('./bot').flush();
        });
      } else {
        const v = await store.version();
        if (v !== null && v !== localVersion) await pull();
        const before = db.totalChanges();
        await withTimeout((async () => { await srv.handler(req, res); await cap.ended; })(), 55000);
        if (db.totalChanges() !== before) await locked(async () => {}, true).catch((e) => console.error('read-write sync', e.message)); // e.g. audit rows of downloads
        await require('./bot').flush();
      }
    });
  } catch (e) {
    console.error('serverless', e);
    if (isWrite) localVersion = 'stale'; // the change may not be stored — resync on the next request
    cap.discard();
    if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ error: e.message || 'Server band — qayta urinib ko‘ring' }));
  }
  cap.release();
};
module.exports.config = { maxDuration: 60 };
