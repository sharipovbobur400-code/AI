'use strict';
// Yuklanadigan fayllar tekshiruvi: faqat ruxsat etilgan turlar (kengaytma + fayl ichidagi haqiqiy format mos bo‘lishi shart),
// dastur/skript fayllari, makrosli Office va faol mazmunli PDF rad etiladi, keyin antivirus (Windows Defender / ClamAV) skaneri.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { bad } = require('./core');

const TYPES = {
  pdf: { mime: 'application/pdf', label: 'PDF' },
  png: { mime: 'image/png', label: 'PNG rasm' },
  jpg: { mime: 'image/jpeg', label: 'JPEG rasm' },
  jpeg: { mime: 'image/jpeg', label: 'JPEG rasm' },
  webp: { mime: 'image/webp', label: 'WEBP rasm' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word (.docx)' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel (.xlsx)' },
  csv: { mime: 'text/csv', label: 'CSV' },
  txt: { mime: 'text/plain', label: 'Matn' },
  dwg: { mime: 'image/vnd.dwg', label: 'AutoCAD (.dwg)' },
};
const ALLOWED_LIST = Object.keys(TYPES).map((e) => `.${e}`).join(', ');
// file names inside an Office document that can run code
const RISKY_ENTRY = /(^|\/)vbaProject\.bin$|\.(exe|dll|scr|com|bat|cmd|ps1|vbs|vbe|js|jse|wsf|hta|msi|jar|lnk|sh|bin)$|activeX\//i;

const startsWith = (buf, bytes) => bytes.every((b, i) => buf[i] === b);
function isExecutable(buf) {
  return startsWith(buf, [0x4d, 0x5a]) // Windows EXE/DLL
    || startsWith(buf, [0x7f, 0x45, 0x4c, 0x46]) // Linux ELF
    || [[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xcf, 0xfa, 0xed, 0xfe], [0xce, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]].some((m) => startsWith(buf, m)) // macOS
    || startsWith(buf, [0x23, 0x21]) // #! script
    || startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0]); // old OLE Office (.doc/.xls) — may carry macros
}

/** Names of the entries of a ZIP container (central directory). Returns null if the archive is malformed. */
function zipEntries(buf) {
  const min = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const nameLen = buf.readUInt16LE(p + 28); const extra = buf.readUInt16LE(p + 30); const comment = buf.readUInt16LE(p + 32);
    names.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extra + comment;
  }
  return names;
}

function looksLikeText(buf) {
  if (buf.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; }
}

/** Content checks for one file. Returns { ext, mime, label } or throws a 400 error explaining why it was refused. */
function inspect(buf, fileName) {
  const name = String(fileName || '');
  const ext = path.extname(name).slice(1).toLowerCase();
  const t = TYPES[ext];
  if (!t) throw bad(`“${name}” qabul qilinmadi: bu turdagi fayl ruxsat etilmagan. Ruxsat: ${ALLOWED_LIST}`);
  if (!buf.length) throw bad(`“${name}” bo‘sh fayl`);
  if (/\.(exe|dll|scr|bat|cmd|ps1|vbs|js|jar|msi|sh|hta|lnk|com)\./i.test(name)) throw bad(`“${name}” qabul qilinmadi: ikki kengaytmali nom (yashirin dastur bo‘lishi mumkin)`);
  if (isExecutable(buf)) throw bad(`“${name}” qabul qilinmadi: fayl ichida dastur yoki skript bor (kengaytmasi ${ext} bo‘lsa ham)`);
  const fail = (why) => { throw bad(`“${name}” qabul qilinmadi: ${why}`); };
  switch (ext) {
    case 'pdf': {
      if (!startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) fail('haqiqiy PDF emas');
      const s = buf.toString('latin1');
      if (/\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA)\b/.test(s)) fail('PDF ichida avtomatik ishlaydigan kod yoki ichki fayl bor');
      break;
    }
    case 'png': if (!startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) fail('haqiqiy PNG emas'); break;
    case 'jpg': case 'jpeg': if (!startsWith(buf, [0xff, 0xd8, 0xff])) fail('haqiqiy JPEG emas'); break;
    case 'webp': if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') fail('haqiqiy WEBP emas'); break;
    case 'dwg': if (!/^AC10\d\d/.test(buf.toString('latin1', 0, 6))) fail('haqiqiy DWG emas'); break;
    case 'docx': case 'xlsx': {
      if (!startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) fail(`haqiqiy ${t.label} emas`);
      const entries = zipEntries(buf); if (!entries) fail('fayl buzilgan');
      if (!entries.includes('[Content_Types].xml') || !entries.some((e) => e.startsWith(ext === 'docx' ? 'word/' : 'xl/'))) fail(`haqiqiy ${t.label} emas`);
      const risky = entries.find((e) => RISKY_ENTRY.test(e));
      if (risky) fail(`ichida makros yoki dastur bor (${risky}) — makrossiz saqlab qayta yuklang`);
      break;
    }
    case 'csv': case 'txt': if (!looksLikeText(buf)) fail('matn fayli emas'); break;
    default: break;
  }
  return { ext, mime: t.mime, label: t.label };
}

// ---------------- antivirus ----------------
let scannerCache;
function findScanner() {
  if (scannerCache !== undefined) return scannerCache;
  scannerCache = null;
  if (process.platform === 'win32') {
    const cands = [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Windows Defender', 'MpCmdRun.exe')];
    const plat = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows Defender', 'Platform');
    try { for (const d of fs.readdirSync(plat).sort().reverse()) cands.unshift(path.join(plat, d, 'MpCmdRun.exe')); } catch { /* no platform dir */ }
    const exe = cands.find((c) => fs.existsSync(c));
    if (exe) scannerCache = { name: 'Windows Defender', run: (f) => { const r = spawnSync(exe, ['-Scan', '-ScanType', '3', '-File', f, '-DisableRemediation'], { timeout: 120000, windowsHide: true }); return r.status === 0 ? 'clean' : r.status === 2 ? 'infected' : 'error'; } };
  } else {
    for (const bin of ['clamdscan', 'clamscan']) {
      const v = spawnSync(bin, ['--version'], { timeout: 10000 });
      if (v.status === 0) { scannerCache = { name: bin === 'clamdscan' ? 'ClamAV (clamd)' : 'ClamAV', run: (f) => { const r = spawnSync(bin, ['--no-summary', f], { timeout: 120000 }); return r.status === 0 ? 'clean' : r.status === 1 ? 'infected' : 'error'; } }; break; }
    }
  }
  return scannerCache;
}
const avMode = () => (process.env.ANTIVIRUS || 'auto').toLowerCase(); // auto | required | off

/** Scan with the OS antivirus. Returns scanner name, or null when skipped; throws when a threat is found. */
function avScan(buf, name) {
  if (avMode() === 'off') return null;
  const sc = findScanner();
  if (!sc) { if (avMode() === 'required') throw bad('Antivirus topilmadi (ANTIVIRUS=required) — fayl qabul qilinmadi'); return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-scan-'));
  const f = path.join(dir, `upload-${crypto.randomBytes(6).toString('hex')}${path.extname(String(name || '')).toLowerCase()}`);
  try {
    fs.writeFileSync(f, buf);
    // real-time protection may remove a detected file right after it is written
    if (!fs.existsSync(f) || fs.statSync(f).size !== buf.length) throw bad(`“${name}” qabul qilinmadi: ${sc.name} faylni zararli deb topdi`);
    const r = sc.run(f);
    if (r === 'infected' || !fs.existsSync(f)) throw bad(`“${name}” qabul qilinmadi: ${sc.name} faylda virus topdi`);
    if (r === 'error' && avMode() === 'required') throw bad(`“${name}”: antivirus skanerlashda xato — fayl qabul qilinmadi`);
    return sc.name;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Full check used for every upload and import. */
function check(buf, name) {
  const info = inspect(buf, name);
  return { ...info, scanner: avScan(buf, name) };
}
function scannerInfo() { const sc = avMode() === 'off' ? null : findScanner(); return { mode: avMode(), scanner: sc?.name || null }; }

module.exports = { check, inspect, avScan, scannerInfo, TYPES, ALLOWED_LIST };
