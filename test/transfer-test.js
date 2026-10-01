'use strict';
// TRANSFER + FILE SAFETY test: two independent installations ("old laptop" A and "new laptop" B).
// Uploads are type/content checked (and antivirus-scanned when available); A exports an encrypted package, B imports it.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const A_SA = { login: 'Old Laptop Admin', password: 'OldPass#2026' }; // test-only credentials
const B_SA = { login: 'New Laptop Admin', password: 'NewPass#2026' };
const PKG_PW = 'Transfer#Pw-2026';
const procs = [];
function start(sa, tag) {
  const port = 6200 + Math.floor(Math.random() * 500) + (tag === 'B' ? 500 : 0);
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), `wms-transfer-${tag}-`));
  const p = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'server.js')], { env: { ...process.env, WMS_NO_DOTENV: '1', PORT: String(port), DATA_DIR: DATA, SEED: 'real', SUPERADMIN_LOGIN: tag === 'B' ? '' : sa.login, SUPERADMIN_NAME: sa.login, SUPERADMIN_PASSWORD: tag === 'B' ? '' : sa.password,
    TELEGRAM_BOT_TOKEN: '', ANTHROPIC_API_KEY: '', AI_API_KEY: '', GEMINI_API_KEY: '', BOT_MORNING_HOUR: '99', BOT_EVENING_HOUR: '99', BACKUP_DAILY: '0', AI_SCAN_SECONDS: '3600', DISPATCH_CYCLE_SECONDS: '3600' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout.on('data', (d) => { log += d; }); p.stderr.on('data', (d) => { log += d; });
  procs.push(p); return { base: `http://127.0.0.1:${port}`, DATA, log: () => log };
}
class Client {
  constructor(base) { this.base = base; }
  async login(u, pw) { const r = await fetch(`${this.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: pw }) }); if (!r.ok) throw new Error(`login ${u}: ${r.status}`); this.cookie = r.headers.get('set-cookie').split(';')[0]; const j = await r.json(); this.csrf = j.csrf; return this; }
  async fetch(method, url, body) { return fetch(this.base + url, { method, headers: { cookie: this.cookie, 'content-type': 'application/json', 'x-csrf-token': this.csrf }, body: body ? JSON.stringify(body) : undefined }); }
  async req(method, url, body) { const r = await this.fetch(method, url, body); const d = await r.json().catch(() => ({})); return { status: r.status, data: d }; }
  async ok(method, url, body) { const r = await this.req(method, url, body); if (r.status >= 400) throw new Error(`${method} ${url}: ${r.status} ${r.data.error}`); return r.data; }
}
// ---- sample files ----
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj\n2 0 obj <</Type /Pages /Kids [] /Count 0>> endobj\ntrailer <</Root 1 0 R>>\n%%EOF\n', 'latin1');
function zip(entries) { // minimal stored ZIP
  const locals = []; const central = []; let off = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text); const n = Buffer.from(name); const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data); central.push(ch, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const DOCX = zip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', '<w:document/>']]);
const DOCX_MACRO = zip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', '<w:document/>'], ['word/vbaProject.bin', 'macro']]);
const FAKE_EXE = Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(200, 0x90)]);
const PDF_ACTIVE = Buffer.from('%PDF-1.4\n1 0 obj <</Type /Catalog /OpenAction 2 0 R>> endobj\n2 0 obj <</S /JavaScript /JS (app.alert(1))>> endobj\n%%EOF\n', 'latin1');
const upload = (c, name, buf) => c.req('POST', '/api/documents', { docType: 'OTHER', title: `Test ${name}`, file: { name, mime: 'application/octet-stream', base64: buf.toString('base64') } });

// ---- package helpers (same format as server/transfer.js) — used to build a tampered package ----
const MAGIC = Buffer.from('SFWMSTR1', 'latin1'); const KDF = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
function unpack(buf, pw) { const key = crypto.scryptSync(pw, buf.subarray(8, 24), 32, KDF); const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(24, 36)); d.setAAD(MAGIC); d.setAuthTag(buf.subarray(36, 52)); return JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(buf.subarray(52)), d.final()]))); }
function pack(obj, pw) { const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', crypto.scryptSync(pw, salt, 32, KDF), iv); c.setAAD(MAGIC); const enc = Buffer.concat([c.update(zlib.gzipSync(Buffer.from(JSON.stringify(obj)))), c.final()]); return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), enc]); }
function tamperDb(pkgBuf, fn) {
  const p = unpack(pkgBuf, PKG_PW); const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wms-tamper-')), 'x.db');
  fs.writeFileSync(f, Buffer.from(p.db, 'base64')); const x = new DatabaseSync(f); fn(x); x.close();
  p.db = fs.readFileSync(f).toString('base64'); return pack(p, PKG_PW);
}

const results = [];
async function test(n, title, fn) { try { const d = await fn(); results.push(true); console.log(`  ✅ TRANSFER ${n}: ${title} — ${d}`); } catch (e) { results.push(false); console.log(`  ❌ TRANSFER ${n}: ${title} — ${e.message}`); } }
const assert = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  const A = start(A_SA, 'A'); const B = start(B_SA, 'B');
  for (const s of [A, B]) for (let i = 0; i < 200; i++) { try { if ((await fetch(`${s.base}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  // yangi noutbuk: .env da asosiy admin yo‘q — birinchi ochilishda saytda yaratiladi
  await fetch(`${B.base}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fullName: B_SA.login, login: B_SA.login, password: B_SA.password }) });
  console.log('\nSolar Factory WMS — KO‘CHIRISH VA FAYL XAVFSIZLIGI TESTI\n');
  const a = await new Client(A.base).login(A_SA.login, A_SA.password);
  let pkg; let pngDocId;

  await test(1, 'Ruxsat etilgan fayllar qabul qilinadi (tekshiruv + antivirus)', async () => {
    const av = await a.ok('GET', '/api/admin/filecheck');
    const r1 = await upload(a, 'photo.png', PNG); const r2 = await upload(a, 'spec.pdf', PDF); const r3 = await upload(a, 'hisobot.docx', DOCX);
    assert(r1.status === 200 && r2.status === 200 && r3.status === 200, `${r1.status} ${r1.data.error} / ${r2.status} ${r2.data.error} / ${r3.status} ${r3.data.error}`);
    pngDocId = r1.data.id;
    return `PNG, PDF, DOCX qabul qilindi; antivirus: ${av.scanner || `yo‘q (${av.mode})`}`;
  });
  await test(2, 'Xavfli fayllar rad etiladi', async () => {
    const cases = [['invoice.pdf', FAKE_EXE, 'PDF nomli dastur'], ['setup.exe', FAKE_EXE, '.exe'], ['foto.jpg.exe', FAKE_EXE, 'ikki kengaytma'], ['act.pdf', PDF_ACTIVE, 'PDF ichida skript'],
      ['makros.docx', DOCX_MACRO, 'makrosli Word'], ['rasm.png', PDF, 'PNG emas'], ['run.sh.txt', Buffer.from('#!/bin/sh\necho hi\n'), 'skript'], ['data.csv', Buffer.from([0x41, 0, 0x42]), 'matn emas']];
    const out = [];
    for (const [name, buf, what] of cases) { const r = await upload(a, name, buf); assert(r.status === 400, `${what} (${name}) qabul qilindi: ${r.status}`); out.push(what); }
    const docs = await a.ok('GET', '/api/documents');
    assert(docs.length === 3, `bazada ${docs.length} hujjat (3 bo‘lishi kerak)`);
    return `${out.length}/${cases.length} rad etildi: ${out.join(', ')}`;
  });
  await test(3, 'Eksport: parol bilan shifrlangan .sfwms paket', async () => {
    await a.ok('PUT', '/api/keys/AI_API_KEY', { value: 'AQ.TRANSFER-TEST-KEY-000000000000-9876' });
    await a.ok('POST', '/api/products', { sku: 'TR-550', name: 'Transfer test panel', category: 'FINISHED', model: 'TR', power_w: 550, length_mm: 2278, width_mm: 1134, height_mm: 35, net_weight_kg: 28, gross_weight_kg: 29, units_per_pallet: 31, pallet_weight_kg: 25, pallet_length_mm: 2300, pallet_width_mm: 1150, pallet_height_mm: 1300, packaging_weight_kg: 15, max_stack: 2, orientation: 'VERTICAL', track_serial: false, min_stock: 0, lead_time_days: 3 });
    const short = await a.req('POST', '/api/admin/transfer/export', { password: '123' }); assert(short.status === 400, 'qisqa parol qabul qilindi');
    const r = await a.fetch('POST', '/api/admin/transfer/export', { password: PKG_PW });
    assert(r.ok, `export ${r.status}`); pkg = Buffer.from(await r.arrayBuffer());
    const plain = pkg.toString('latin1');
    assert(pkg.subarray(0, 8).toString() === 'SFWMSTR1' && !plain.includes('TRANSFER-TEST-KEY') && !plain.includes('SQLite format'), 'paket ochiq holda');
    return `${(pkg.length / 1024).toFixed(1)} KB, ichida ochiq matn yo‘q; qisqa parol → 400`;
  });
  const b = await new Client(B.base).login(B_SA.login, B_SA.password);
  await test(4, 'Import: noto‘g‘ri parol va buzilgan fayl rad etiladi', async () => {
    const w = await b.req('POST', '/api/admin/transfer/import', { file: { base64: pkg.toString('base64') }, password: 'Wrong#Pass-000' });
    const bent = Buffer.from(pkg); bent[bent.length - 10] ^= 0xff;
    const t = await b.req('POST', '/api/admin/transfer/import', { file: { base64: bent.toString('base64') }, password: PKG_PW });
    const junk = await b.req('POST', '/api/admin/transfer/import', { file: { base64: FAKE_EXE.toString('base64') }, password: PKG_PW });
    assert(w.status === 400 && t.status === 400 && junk.status === 400, `${w.status}/${t.status}/${junk.status}`);
    return `noto‘g‘ri parol → “${w.data.error}”; o‘zgartirilgan bayt → 400; paket bo‘lmagan fayl → 400`;
  });
  await test(5, 'Import: paket ichidagi yashirin virusli fayl va begona trigger rad etiladi', async () => {
    const evil = tamperDb(pkg, (x) => { x.prepare("UPDATE document_versions SET file_name='invoice.pdf', file_data=? WHERE file_name='photo.png'").run(FAKE_EXE); });
    const r1 = await b.req('POST', '/api/admin/transfer/import', { file: { base64: evil.toString('base64') }, password: PKG_PW, dryRun: true });
    const trig = tamperDb(pkg, (x) => { x.exec("CREATE TRIGGER evil_t AFTER INSERT ON products BEGIN DELETE FROM orders; END;"); });
    const r2 = await b.req('POST', '/api/admin/transfer/import', { file: { base64: trig.toString('base64') }, password: PKG_PW, dryRun: true });
    assert(r1.status === 400 && /Xavfli/.test(r1.data.error) && r2.status === 400 && /Begona/.test(r2.data.error), `${r1.status} ${r1.data.error} | ${r2.status} ${r2.data.error}`);
    const still = await b.ok('GET', '/api/products'); assert(still.length === 0, 'B bazasi o‘zgardi');
    return 'dasturli “invoice.pdf” → rad; begona trigger → rad; B bazasi o‘zgarmadi';
  });
  await test(6, 'Import: tekshiruv (dry run) → to‘liq ko‘chirish', async () => {
    const dry = await b.ok('POST', '/api/admin/transfer/import', { file: { base64: pkg.toString('base64') }, password: PKG_PW, dryRun: true });
    assert(dry.dryRun && dry.counts.products.n === 1 && dry.filesScanned === 3, JSON.stringify(dry).slice(0, 300));
    const imp = await b.ok('POST', '/api/admin/transfer/import', { file: { base64: pkg.toString('base64') }, password: PKG_PW });
    assert(imp.ok && imp.safetyBackup && fs.existsSync(path.join(B.DATA, 'backups', imp.safetyBackup)), 'zaxira yo‘q');
    const old = await b.req('GET', '/api/products'); assert(old.status === 401, `eski sessiya: ${old.status}`);
    return `${dry.counts.products.n} mahsulot, ${dry.counts.documents.n} hujjat, ${dry.filesScanned} fayl skanerlandi; zaxira ${imp.safetyBackup}; eski sessiyalar yopildi`;
  });
  await test(7, 'Yangi noutbukda: eski login, ma’lumot, fayllar va kalitlar ishlaydi', async () => {
    const nb = await new Client(B.base).login(A_SA.login, A_SA.password);
    const prods = await nb.ok('GET', '/api/products'); assert(prods.some((p) => p.sku === 'TR-550'), 'mahsulot yo‘q');
    const doc = await nb.ok('GET', `/api/documents/${pngDocId}`); const v = doc.versions[0];
    const file = Buffer.from(await (await nb.fetch('GET', `/api/documents/versions/${v.id}/download`)).arrayBuffer());
    assert(file.equals(PNG), 'fayl mos emas');
    const ver = await nb.ok('GET', `/api/documents/versions/${v.id}/verify`); assert(ver.ok !== false && (ver.valid ?? ver.ok ?? true), `sha: ${JSON.stringify(ver)}`);
    const keys = await nb.ok('GET', '/api/keys'); const s = keys.secrets.find((k) => k.name === 'AI_API_KEY');
    assert(s.configured && s.masked === 'AQ.TRA…9876', `kalit: ${s.masked}`);
    const newAdmin = await fetch(`${B.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: B_SA.login, password: B_SA.password }) });
    return `login ✓, TR-550 ✓, PNG fayl bayt-bayt bir xil + SHA-256 ✓, AI kaliti qayta shifrlandi (${s.masked}); B ning eski admini: ${newAdmin.status}`;
  });

  procs.forEach((p) => p.kill());
  const ok = results.filter(Boolean).length;
  console.log(`\nNATIJA: ${ok}/${results.length} ko‘chirish/fayl testi o‘tdi\n`);
  if (ok !== results.length) console.log(`--- A ---\n${A.log().slice(-2500)}\n--- B ---\n${B.log().slice(-2500)}`);
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.error(e); procs.forEach((p) => p.kill()); process.exit(1); });
