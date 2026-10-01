/* Solar Factory WMS — UI core: helpers, API client, components, charts, router, real-time. */
'use strict';
const App = window.App = { pages: [], meta: null, user: null, csrf: null, live: { handlers: [], es: null }, cleanup: [] };

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const raw = (s) => ({ __html: String(s ?? '') });
function h(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) {
      const v = vals[i];
      if (v == null || v === false) return;
      if (Array.isArray(v)) out += v.map((x) => (x && x.__html !== undefined ? x.__html : typeof x === 'string' ? x : esc(x))).join('');
      else if (v && v.__html !== undefined) out += v.__html;
      else out += esc(v);
    }
  });
  return raw(out);
}
const html = (x) => (x && x.__html !== undefined ? x.__html : String(x ?? ''));
const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const fmt = { n: (v, d) => (v == null || v === '' ? '—' : d != null ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: 0 }).format(v) : nf.format(v)).replace(/ /g, ' '),
  d: (v) => (v ? new Date(v).toLocaleDateString('ru-RU') : '—'), dt: (v) => (v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'),
  t: (v) => (v ? new Date(v).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—'),
  rel: (v) => { if (!v) return '—'; const s = (Date.now() - new Date(v)) / 1000; const a = Math.abs(s); const f = a < 60 ? 'hozir' : a < 3600 ? `${Math.round(a / 60)} daq` : a < 86400 ? `${Math.round(a / 3600)} soat` : `${Math.round(a / 86400)} kun`; return a < 60 ? f : s > 0 ? `${f} oldin` : `${f} dan so‘ng`; },
  kg: (v) => (v == null ? '—' : `${nf.format(Math.round(v * 10) / 10)} kg`.replace(/ /g, ' ')), m3: (v) => (v == null ? '—' : `${nf.format(Math.round(v * 100) / 100)} m³`.replace(/ /g, ' ')),
  pct: (v) => (v == null ? '—' : `${nf.format(v)}%`) };
const isoDate = (d) => { const x = d ? new Date(d) : new Date(); return new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const isoLocal = (d) => { const x = d ? new Date(d) : new Date(); return new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const can = (p) => !!App.user && (App.user.permissions || []).includes(p);
const go = (hash) => { location.hash = hash; };

// ---------- icons (24px stroke) ----------
const ICONS = {
  dash: 'M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z', crown: 'M3 7l4 4 5-7 5 7 4-4-2 12H5z', task: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9',
  in: 'M12 3v12m0 0l-5-5m5 5l5-5M4 21h16', out: 'M12 21V9m0 0l-5 5m5-5l5 5M4 3h16', box: 'M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8', layers: 'M12 2l10 6-10 6L2 8l10-6zM2 16l10 6 10-6M2 12l10 6 10-6',
  map: 'M9 3l-6 3v15l6-3 6 3 6-3V3l-6 3-6-3zM9 3v15M15 6v15', lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4', swap: 'M7 7h13l-4-4M17 17H4l4 4', clip: 'M9 3h6v4H9zM5 5h4M15 5h4v16H5V5', alert: 'M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3', qr: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM18 18h3v3h-3zM14 20h2M20 14v2', trace: 'M4 6h16M4 12h10M4 18h6M18 14l3 3-3 3',
  cart: 'M3 3h2l2.4 12h11l2-8H6M9 20a1 1 0 1 0 0 .1M18 20a1 1 0 1 0 0 .1', pick: 'M12 2l3 7h7l-5.5 4 2 7-6.5-4.5L5.5 20l2-7L2 9h7z', pack: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10M7.5 5l9 4',
  minus: 'M20 12H4M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z', doc: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h6', truck: 'M1 5h13v11H1zM14 9h4l4 4v3h-8zM5.5 19a1.5 1.5 0 1 0 0-.1M17.5 19a1.5 1.5 0 1 0 0-.1',
  factory: 'M2 21V9l6 4V9l6 4V5h4l2 16zM2 21h20', users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  load: 'M4 17h16M6 17V9l6-4 6 4v8M10 17v-4h4v4', send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z', file: 'M4 4h10l6 6v10H4zM14 4v6h6', ruler: 'M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2', check: 'M20 6L9 17l-5-5',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', ai: 'M12 2l2.2 5.8L20 10l-5.8 2.2L12 18l-2.2-5.8L4 10l5.8-2.2zM19 16l1 2.5 2.5 1-2.5 1L19 23l-1-2.5-2.5-1 2.5-1z', chart: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  kpi: 'M12 20V10M18 20V4M6 20v-4', gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  audit: 'M9 12l2 2 4-4M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z', search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35', bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0', menu: 'M3 12h18M3 6h18M3 18h18',
  x: 'M18 6L6 18M6 6l12 12', plus: 'M12 5v14M5 12h14', sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4', moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9', refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15', print: 'M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3', camera: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  chev: 'M6 9l6 6 6-6', arrow: 'M5 12h14M13 6l6 6-6 6', inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z', clock: 'M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20zM12 6v6l4 2',
  scrap: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6', rework: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z', project: 'M3 3h18v18H3zM3 9h18M9 21V9', warehouse: 'M3 21V8l9-5 9 5v13M7 21v-8h10v8M7 17h10',
};
const icon = (n, cls = '') => raw(`<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[n] || ICONS.box}"/></svg>`);

// ---------- labels & badges ----------
const LBL = {
  NEW: ['Yangi', 'blue'], PARTIALLY_RESERVED: ['Qisman rezerv', 'warn'], RESERVED: ['Rezervlangan', 'blue'], PICKING: ['Yig‘ilmoqda', 'warn'], PICKED: ['Yig‘ildi', 'blue'], PACKED: ['Qadoqlandi', 'good'],
  LOADING: ['Yuklanmoqda', 'warn'], SHIPPED: ['Jo‘natildi', 'good'], DELIVERED: ['Yetkazildi', 'good'], CANCELLED: ['Bekor qilingan', 'dark'],
  RECEIVING: ['Qabulda (QC kutilmoqda)', 'warn'], APPROVED: ['Tasdiqlangan', 'good'], PARTIAL: ['Qisman', 'warn'],
  AVAILABLE: ['Mavjud', 'good'], REWORK: ['Rework', 'serious'], SCRAP: ['Brak', 'crit'], LOADED: ['Yuklangan', 'blue'], UNPACKED: ['Ochilgan', 'dark'],
  PENDING: ['Kutilmoqda', 'dark'], IN_PROGRESS: ['Jarayonda', 'warn'], COMPLETED: ['Bajarildi', 'good'],
  OPEN: ['Ochiq', 'crit'], REQUESTED: ['So‘ralgan', 'warn'], RESOLVED: ['Hal qilindi', 'good'], ACK: ['Ko‘rildi', 'dark'],
  ORDERED: ['Buyurtma berildi', 'blue'], SUPPLIER_CONFIRMED: ['Supplier tasdiqladi', 'blue'], IN_TRANSIT: ['Yo‘lda', 'warn'], ARRIVED: ['Keldi', 'blue'], QC: ['QC', 'warn'], RECEIVED: ['Qabul qilindi', 'good'], REJECTED: ['Rad etildi', 'crit'],
  CONFIRMED: ['Tasdiqlangan', 'blue'],
  MAINTENANCE: ['Ta’mirda', 'crit'], UNAVAILABLE: ['Mavjud emas', 'dark'], ASSIGNED: ['Biriktirilgan', 'warn'], ON_TRIP: ['Reysda', 'warn'], OFF: ['Dam olishda', 'dark'],
  PLANNED: ['Rejalashtirilgan', 'dark'], DISPATCHED: ['Yo‘lda', 'warn'],
  DRAFT: ['Qoralama', 'dark'], IN_REVIEW: ['Ko‘rib chiqilmoqda', 'warn'], ARCHIVED: ['Arxiv', 'dark'], ISSUED: ['Chiqarilgan', 'blue'],
  INTERNAL_REVIEW: ['Ichki tekshiruv', 'warn'], READY_FOR_SUBMISSION: ['Topshirishga tayyor', 'blue'], SUBMITTED: ['Topshirildi', 'blue'], UNDER_REVIEW: ['XETQ ko‘rmoqda', 'warn'], REVISION_REQUIRED: ['Tuzatish talab qilinadi', 'crit'],
  POSTED: ['O‘tkazildi', 'good'], ACTIVE: ['Faol', 'good'], CONSUMED: ['Ishlatildi', 'dark'], RELEASED: ['Bo‘shatildi', 'dark'],
  IN_STOCK: ['Omborda', 'good'], ISSUED_OUT: ['Chiqarildi', 'dark'], DISPOSED: ['Utilizatsiya', 'dark'], ADJUSTED_OUT: ['Tuzatish (-)', 'dark'],
  URGENT: ['Shoshilinch', 'crit'], HIGH: ['Yuqori', 'serious'], NORMAL: ['Oddiy', 'dark'], LOW: ['Past', 'dark'],
  CRITICAL: ['Kritik', 'crit'], WARNING: ['Ogohlantirish', 'warn'], INFO: ['Tavsiya', 'blue'], PASS: ['PASS', 'good'], FAIL: ['FAIL', 'crit'],
  SUPPLIER: ['Supplier', 'dark'], PRODUCTION: ['Ishlab chiqarish', 'blue'], RETURN: ['Qaytarish', 'serious'], OTHER: ['Boshqa', 'dark'],
};
const TXN = { RECEIVE: 'Kirim', ISSUE: 'Chiqim', TRANSFER: 'Ko‘chirish', RESERVE: 'Rezerv', RELEASE: 'Rezerv bo‘shatish', ADJUSTMENT: 'Tuzatish', RETURN: 'Qaytarish', REJECT: 'Brak (reject)', SCRAP: 'Scrap', REWORK: 'Rework', PACK: 'Qadoqlash', UNPACK: 'Ochish', SHIP: 'Jo‘natish' };
const CAT = { FINISHED: 'Tayyor mahsulot', RAW: 'Xomashyo', WIP: 'Yarim tayyor', MATERIAL: 'Material', PACKAGING: 'Qadoq' };
const label = (s) => (LBL[s] ? LBL[s][0] : s ?? '—');
const badge = (s, text) => (s ? h`<span class="badge ${(LBL[s] || [])[1] || ''}">${text || label(s)}</span>` : raw('<span class="muted">—</span>'));
const sevBadge = (s) => h`<span class="sev ${s}">${s === 'CRITICAL' ? '🔴' : s === 'WARNING' ? '🟠' : '🔵'} ${s}</span>`;
const VEH_ICON = { AVAILABLE: '🟢', RESERVED: '🟡', LOADING: '🔵', IN_TRANSIT: '🟠', MAINTENANCE: '🔴', UNAVAILABLE: '⚫' };
const VEH_LBL = { AVAILABLE: 'Available', RESERVED: 'Reserved', LOADING: 'Loading', IN_TRANSIT: 'In Transit', MAINTENANCE: 'Maintenance', UNAVAILABLE: 'Unavailable' };

// ---------- API ----------
// Vaqtinchalik xatolar (tarmoq uzilishi, 429, 502/503/504, server qayta ishga tushmoqda) — GET so‘rovlar avtomatik qayta yuboriladi.
const RETRY_STATUS = [0, 408, 429, 500, 502, 503, 504];
async function api(method, path, body, opts = {}) {
  const attempts = method === 'GET' ? (opts.retries ?? 3) : 1;
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    let res;
    try {
      res = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-CSRF-Token': App.csrf || '' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch (netErr) {
      lastErr = Object.assign(new Error(navigator.onLine === false ? 'Internet aloqasi yo‘q' : 'Server bilan aloqa yo‘q (tarmoq yoki server ishlamayapti)'), { status: 0, api: path, detail: netErr.message });
      if (i < attempts) { await new Promise((r) => setTimeout(r, 700 * i)); continue; }
      throw lastErr;
    }
    if (res.status === 401 && !opts.noAuthRedirect) { App.user = null; App.showLogin(); throw Object.assign(new Error('Sessiya tugadi — qayta kiring'), { status: 401, api: path }); }
    const text = await res.text();
    let data = text;
    if ((res.headers.get('content-type') || '').includes('json') || /^\s*[{[]/.test(text)) { try { data = text ? JSON.parse(text) : null; } catch { data = text; } }
    if (res.ok) return data;
    const plain = typeof data === 'string' ? data.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    lastErr = Object.assign(new Error((data && data.error) || plain || `Server javob bermadi (HTTP ${res.status})`), { status: res.status, api: path, details: data && data.details });
    if (i < attempts && RETRY_STATUS.includes(res.status)) { await new Promise((r) => setTimeout(r, 700 * i)); continue; }
    throw lastErr;
  }
  throw lastErr;
}
/** Sahifa yuklanmasa — xato serverga (Diagnostika) yoziladi. */
App.reportError = (e, page) => {
  try {
    if (!App.user || [400, 401, 404, 409, 422].includes(e.status)) return;
    fetch('/api/client-errors', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': App.csrf || '' },
      body: JSON.stringify({ page, api: e.api || null, status: e.status ?? null, message: String(e.message || e).slice(0, 500), stack: String(e.stack || '').split('\n').slice(0, 4).join(' | ').slice(0, 800) }) }).catch(() => {});
  } catch { /* ignore */ }
};
const GET = (p) => api('GET', p); const POST = (p, b) => api('POST', p, b || {}); const PUT = (p, b) => api('PUT', p, b || {});

// ---------- toasts ----------
function toast(msg, type = 'info', title) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<div>${title ? `<b>${esc(title)}</b>` : ''}${esc(msg)}</div>`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, type === 'err' ? 7000 : 4200);
}
async function act(btn, fn, okMsg) {
  if (btn) btn.classList.add('loading');
  try { const r = await fn(); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'ok'); return r; }
  catch (e) { toast(e.message, 'err', 'Xatolik'); throw e; }
  finally { if (btn) btn.classList.remove('loading'); }
}

// ---------- forms ----------
function fieldHtml(f) {
  const id = `f_${f.name}_${Math.random().toString(36).slice(2, 7)}`;
  const req = f.required ? raw('<span class="req"> *</span>') : '';
  const val = f.value ?? '';
  let input;
  const attrs = `name="${esc(f.name)}" id="${id}" ${f.required ? 'required' : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} ${f.readonly ? 'readonly' : ''} ${f.autofocus ? 'autofocus' : ''}`;
  if (f.type === 'select') {
    const opts = (f.options || []).map((o) => (Array.isArray(o) ? o : [o, o]));
    input = `<select class="input" ${attrs}>${f.required && f.noEmpty ? '' : `<option value="">${esc(f.emptyText || '— tanlang —')}</option>`}${opts.map(([v, l, extra]) => `<option value="${esc(v)}" ${String(v) === String(val) ? 'selected' : ''} ${extra || ''}>${esc(l)}</option>`).join('')}</select>`;
  } else if (f.type === 'textarea') input = `<textarea class="input" ${attrs} rows="${f.rows || 3}">${esc(val)}</textarea>`;
  else if (f.type === 'checkbox') return `<div class="field ${f.full ? 'full' : ''}"><label class="check"><input type="checkbox" name="${esc(f.name)}" ${val ? 'checked' : ''}> ${esc(f.label)}</label>${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}</div>`;
  else if (f.type === 'file') input = `<input class="input" type="file" ${attrs} ${f.accept ? `accept="${esc(f.accept)}"` : ''} style="padding-top:7px">`;
  else if (f.type === 'html') return `<div class="field ${f.full ? 'full' : ''}">${f.html}</div>`;
  else input = `<input class="input" type="${f.type || 'text'}" ${attrs} value="${esc(val)}" ${f.step ? `step="${f.step}"` : f.type === 'number' ? 'step="any"' : ''} ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} ${f.list ? `list="${f.list}"` : ''}>`;
  return `<div class="field ${f.full ? 'full' : ''}"><label for="${id}">${esc(f.label)}${html(req)}</label>${input}${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}</div>`;
}
const formHtml = (fields, cols = 2) => `<div class="grid-form ${cols === 3 ? 'cols-3' : ''}">${fields.filter(Boolean).map(fieldHtml).join('')}</div>`;
async function readForm(root, fields) {
  const out = {};
  for (const f of fields.filter(Boolean)) {
    if (f.type === 'html') continue;
    const el = root.querySelector(`[name="${f.name}"]`); if (!el) continue;
    if (f.type === 'checkbox') out[f.name] = el.checked;
    else if (f.type === 'file') { const file = el.files[0]; if (file) out[f.name] = { name: file.name, mime: file.type || 'application/octet-stream', base64: await fileToB64(file) }; }
    else if (f.type === 'number') out[f.name] = el.value === '' ? null : Number(el.value);
    else if (f.type === 'date' || f.type === 'datetime-local') out[f.name] = el.value ? new Date(el.value).toISOString() : null;
    else out[f.name] = el.value.trim() === '' ? null : el.value.trim();
    if (f.required && (out[f.name] == null || out[f.name] === '')) { el.classList.add('invalid'); el.focus(); throw new Error(`"${f.label}" majburiy maydon`); }
    el.classList.remove('invalid');
  }
  return out;
}
const fileToB64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
const opt = {
  products: (f) => (App.meta.products || []).filter(f || (() => true)).map((p) => [p.id, `${p.sku} — ${p.name}`]),
  suppliers: () => App.meta.suppliers.map((s) => [s.id, s.company]),
  projects: () => App.meta.projects.map((p) => [p.id, `${p.code} — ${p.name}`]),
  customers: () => App.meta.customers.map((c) => [c.id, c.name]),
  users: (roles) => App.meta.users.filter((u) => !roles || roles.includes(u.role_code)).map((u) => [u.id, `${u.full_name} (${u.role_code})`]),
  warehouses: () => App.meta.warehouses.map((w) => [w.id, `${w.id} — ${w.name}`]),
  zones: (wh) => App.meta.zones.filter((z) => !wh || z.warehouse_id === wh).map((z) => [z.id, `${z.id} — ${z.name}`]),
  drivers: () => App.meta.drivers.map((d) => [d.id, `${d.full_name}${d.status !== 'AVAILABLE' ? ` (${label(d.status)})` : ''}`]),
  enumOf: (o) => Object.entries(o).map(([k, v]) => [k, v]),
};

// ---------- modal ----------
function modal({ title, body, size, submitText, submitClass = 'primary', onSubmit, onOpen, cancelText = 'Bekor qilish', footer }) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal ${size || ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-h"><h2>${esc(title)}</h2><button class="icon-btn x" data-x aria-label="Yopish">${html(icon('x'))}</button></div>
      <form class="modal-b" novalidate><div class="form-err" hidden></div>${html(body)}</form>
      ${footer !== false ? `<div class="modal-f">${footer ? html(footer) : ''}<button type="button" class="btn" data-x>${esc(onSubmit ? cancelText : 'Yopish')}</button>${onSubmit ? `<button type="button" class="btn ${submitClass}" data-ok>${esc(submitText || 'Saqlash')}</button>` : ''}</div>` : ''}</div>`;
    $('#modal-root').appendChild(bg);
    const form = $('form', bg); const err = $('.form-err', bg);
    const close = (v) => { bg.remove(); document.removeEventListener('keydown', onKey); resolve(v); App.flushLive(); };
    const onKey = (e) => { if (e.key === 'Escape' && $('#modal-root').lastElementChild === bg) close(null); };
    document.addEventListener('keydown', onKey);
    $$('[data-x]', bg).forEach((b) => b.addEventListener('click', () => close(null)));
    bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(null); });
    const submit = async () => {
      const btn = $('[data-ok]', bg); if (!btn || btn.classList.contains('loading')) return;
      err.hidden = true; btn.classList.add('loading');
      try { const r = await onSubmit(form, bg); if (r !== false) close(r ?? true); }
      catch (e) { err.textContent = e.message; err.hidden = false; err.scrollIntoView({ block: 'nearest' }); }
      finally { btn.classList.remove('loading'); }
    };
    if (onSubmit) { $('[data-ok]', bg).addEventListener('click', submit); form.addEventListener('submit', (e) => { e.preventDefault(); submit(); }); form.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'file' && !e.target.dataset.noSubmit) { e.preventDefault(); submit(); } }); }
    else form.addEventListener('submit', (e) => e.preventDefault());
    const first = $('input:not([type=hidden]):not([readonly]),select,textarea', form); if (first && !('ontouchstart' in window)) setTimeout(() => first.focus(), 30);
    if (onOpen) onOpen(bg, close);
  });
}
const confirmBox = (title, text, okText = 'Tasdiqlash', cls = 'primary') => modal({ title, body: h`<p style="margin:0">${text}</p>`, submitText: okText, submitClass: cls, onSubmit: async () => true });
async function formModal({ title, fields, submitText, onSubmit, size, intro, onOpen, cols }) {
  return modal({ title, size, submitText, onOpen, body: raw(`${intro ? html(intro) : ''}${formHtml(fields, cols)}`), onSubmit: async (form) => onSubmit(await readForm(form, fields), form) });
}

// ---------- data table ----------
function dataTable(container, { columns, rows, onRow, empty = 'Hozircha ma’lumot mavjud emas.', search = true, pageSize = 25, rowClass, toolbar, searchKeys, initialSort }) {
  const st = { q: '', sort: initialSort || null, dir: initialSort?.startsWith('-') ? -1 : 1, page: 0 };
  if (st.sort?.startsWith('-')) st.sort = st.sort.slice(1);
  container.innerHTML = `${search || toolbar ? `<div class="toolbar" style="padding:12px 12px 0">${search ? `<input class="input grow" type="search" placeholder="Qidirish…" aria-label="Jadvalda qidirish">` : ''}${toolbar ? html(toolbar) : ''}<span class="muted small" data-count style="margin-left:auto"></span></div>` : ''}<div class="table-wrap"></div><div class="pager" hidden></div>`;
  const wrap = $('.table-wrap', container); const pager = $('.pager', container);
  const text = (r) => (searchKeys ? searchKeys.map((k) => r[k]) : Object.values(r)).map((v) => (v == null ? '' : typeof v === 'object' ? '' : String(v))).join(' ').toLowerCase();
  const draw = () => {
    let list = rows;
    if (st.q) { const q = st.q.toLowerCase(); list = list.filter((r) => text(r).includes(q)); }
    if (st.sort) { const col = columns.find((c) => c.key === st.sort); const key = col?.sortVal || ((r) => r[st.sort]); list = [...list].sort((a, b) => { const x = key(a); const y = key(b); return (x == null ? 1 : y == null ? -1 : typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * st.dir; }); }
    const total = list.length; const pages = Math.max(1, Math.ceil(total / pageSize)); st.page = Math.min(st.page, pages - 1);
    const pageRows = list.slice(st.page * pageSize, st.page * pageSize + pageSize);
    const cnt = $('[data-count]', container); if (cnt) cnt.textContent = `${total} ta yozuv`;
    if (!total) { wrap.innerHTML = `<div class="empty">${html(icon('inbox'))}${esc(empty)}</div>`; pager.hidden = true; return; }
    wrap.innerHTML = `<table class="t"><thead><tr>${columns.map((c) => `<th class="${c.num ? 'num' : ''} ${c.sort !== false && c.key ? 'sortable' : ''}" data-k="${esc(c.key || '')}" ${c.width ? `style="width:${c.width}"` : ''}>${esc(c.label)}${st.sort === c.key ? (st.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead><tbody>${pageRows.map((r, i) => `<tr class="${onRow ? 'click' : ''} ${rowClass ? rowClass(r) || '' : ''}" data-i="${i}">${columns.map((c) => `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.render ? html(c.render(r)) : c.num ? esc(fmt.n(r[c.key])) : esc(r[c.key] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    $$('th.sortable', wrap).forEach((th) => th.addEventListener('click', () => { const k = th.dataset.k; if (st.sort === k) st.dir *= -1; else { st.sort = k; st.dir = 1; } draw(); }));
    if (onRow) $$('tbody tr', wrap).forEach((tr) => tr.addEventListener('click', (e) => { if (e.target.closest('button,a,input,select')) return; onRow(pageRows[Number(tr.dataset.i)], e); }));
    pager.hidden = pages <= 1;
    pager.innerHTML = `<span>${st.page * pageSize + 1}–${Math.min(total, (st.page + 1) * pageSize)} / ${total}</span><button class="btn sm" data-p="-1" ${st.page ? '' : 'disabled'}>‹</button><button class="btn sm" data-p="1" ${st.page < pages - 1 ? '' : 'disabled'}>›</button>`;
    $$('[data-p]', pager).forEach((b) => b.addEventListener('click', () => { st.page += Number(b.dataset.p); draw(); }));
  };
  const inp = $('input[type=search]', container); if (inp) inp.addEventListener('input', debounce(() => { st.q = inp.value; st.page = 0; draw(); }, 150));
  draw();
  return { update(newRows) { rows = newRows; draw(); }, el: container };
}
// static (non-interactive) table HTML for small lists inside cards/modals
function tableHtml(columns, rows, empty = 'Hozircha ma’lumot mavjud emas.') {
  if (!rows || !rows.length) return `<div class="empty">${html(icon('inbox'))}${esc(empty)}</div>`;
  return `<div class="table-wrap"><table class="t"><thead><tr>${columns.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${columns.map((c) => `<td class="${c.num ? 'num' : ''}">${c.render ? html(c.render(r)) : c.num ? esc(fmt.n(r[c.key])) : esc(r[c.key] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// ---------- small components ----------
const kpi = ({ label: l, value, sub, ico = 'box', tone = '', href, key }) => h`<${href ? 'a' : 'div'} class="kpi ${tone}" ${href ? raw(`href="${esc(href)}"`) : ''} ${key ? raw(`data-kpi="${esc(key)}"`) : ''}><div class="k-ico">${icon(ico)}</div><div class="k-label">${l}</div><div class="k-val num">${value}</div>${sub ? h`<div class="k-sub">${sub}</div>` : ''}</${href ? 'a' : 'div'}>`;
const card = (title, body, { sub, actions, flush, id, cls = '' } = {}) => h`<section class="card ${cls}" ${id ? raw(`id="${esc(id)}"`) : ''}>${title ? h`<div class="card-h"><h3>${title}</h3>${sub ? h`<span class="sub">${sub}</span>` : ''}${actions ? h`<div class="actions">${actions}</div>` : ''}</div>` : ''}<div class="card-b ${flush ? 'flush' : ''}">${body}</div></section>`;
const pageHead = (title, sub, actions, crumbs) => h`<div class="page-head"><div>${crumbs ? h`<div class="crumbs">${crumbs}</div>` : ''}<h1>${title}</h1>${sub ? h`<p>${sub}</p>` : ''}</div>${actions ? h`<div class="actions">${actions}</div>` : ''}</div>`;
const btn = (text, { cls = '', ico, attrs = '', perm } = {}) => (perm && !can(perm) ? raw('') : h`<button type="button" class="btn ${cls}" ${raw(attrs)}>${ico ? icon(ico) : ''}${text}</button>`);
const meter = (pct, tone) => { const p = Math.max(0, Math.min(100, pct || 0)); const t = tone || (p >= 95 ? 'crit' : p >= 85 ? 'warn' : 'good'); return h`<div class="bar ${t}" role="meter" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><i style="width:${p}%"></i></div>`; };
const dl = (pairs) => h`<dl class="dl">${pairs.filter(Boolean).map(([k, v]) => h`<dt>${k}</dt><dd>${v == null || v === '' ? '—' : v}</dd>`)}</dl>`;
function stepper(flow, current, { bad } = {}) {
  const idx = flow.indexOf(current);
  return h`<div class="stepper">${flow.map((s, i) => h`<div class="step ${i < idx ? 'done' : i === idx ? (bad ? 'bad cur' : 'cur') : ''}"><i></i>${label(s)}</div>`)}</div>`;
}
const timeline = (items) => (items.length ? h`<ul class="timeline">${items.map((i) => h`<li><div class="tl-t">${i.title}</div>${i.sub ? h`<div class="tl-s">${i.sub}</div>` : ''}<div class="tl-d">${i.at ? fmt.dt(i.at) : ''}${i.by ? ` · ${i.by}` : ''}</div></li>`)}</ul>` : raw('<div class="muted small">Tarix yo‘q</div>'));
const skeleton = () => raw(`<div class="sk" style="height:26px;width:280px;margin-bottom:18px"></div><div class="sk-kpis">${'<div class="sk"></div>'.repeat(6)}</div><div class="sk sk-block"></div>`);
const errState = (msg, e) => h`<div class="err-state card">${icon('alert')}<h3>Ma’lumotni yuklab bo‘lmadi</h3><p class="muted">${msg}</p>${e && (e.api || e.status != null) ? h`<p class="small mono muted" style="margin-top:-6px">${e.api || ''}${e.status != null ? ` · HTTP ${e.status}` : ''}</p>` : ''}<button class="btn" data-retry>${icon('refresh')}Qayta urinish</button><p class="small muted" data-autoretry style="margin-top:8px"></p></div>`;
const aiCallout = (text, title = 'AI tahlili') => h`<div class="callout ai">${icon('ai')}<div><b>${title}</b><div class="ai-text">${text}</div></div></div>`;
const coverage = (done, total, tone) => h`<div class="cov"><span class="num small" style="min-width:74px">${fmt.n(done)} / ${fmt.n(total)}</span>${meter(total ? (done / total) * 100 : 0, tone || (done >= total ? 'good' : ''))}</div>`;

// ---------- charts (SVG, hover tooltip) ----------
function tip() { let t = $('.tip'); if (!t) { t = document.createElement('div'); t.className = 'tip'; t.hidden = true; document.body.appendChild(t); } return t; }
function lineChart(el, { labels, series, height = 220, unit = '' }) {
  const W = Math.max(320, el.clientWidth || 600); const H = height; const P = { l: 44, r: 12, t: 12, b: 26 };
  const max = Math.max(1, ...series.flatMap((s) => s.values)); const nice = Math.pow(10, Math.floor(Math.log10(max))); const top = Math.ceil(max / nice) * nice;
  const x = (i) => P.l + (labels.length <= 1 ? 0 : (i * (W - P.l - P.r)) / (labels.length - 1)); const y = (v) => H - P.b - (v / top) * (H - P.t - P.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  const every = Math.ceil(labels.length / Math.max(2, Math.floor(W / 70)));
  el.innerHTML = `<div class="legend" style="margin-bottom:8px">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>
  <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(', '))}">
    ${ticks.map((t) => `<line class="grid-l" x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${P.l - 6}" y="${y(t) + 4}" text-anchor="end">${esc(fmt.n(t))}</text>`).join('')}
    <line class="axis-l" x1="${P.l}" x2="${W - P.r}" y1="${H - P.b}" y2="${H - P.b}"/>
    ${labels.map((l, i) => (i % every === 0 || i === labels.length - 1 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>` : '')).join('')}
    ${series.map((s) => `<path d="${s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('')}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join('')}
    <line class="xh" x1="0" x2="0" y1="${P.t}" y2="${H - P.b}" stroke="var(--axis)" stroke-dasharray="3 3" visibility="hidden"/>
    ${series.map((s, si) => `<circle class="dot${si}" r="4.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>`).join('')}
    <rect x="${P.l}" y="${P.t}" width="${W - P.l - P.r}" height="${H - P.t - P.b}" fill="transparent" class="hit"/>
  </svg>`;
  const svg = $('svg', el); const t = tip(); const xh = $('.xh', svg);
  const move = (ev) => {
    const r = svg.getBoundingClientRect(); const px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(labels.length - 1, Math.round(((px - P.l) / (W - P.l - P.r)) * (labels.length - 1))));
    xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.setAttribute('visibility', 'visible');
    series.forEach((s, si) => { const c = $(`.dot${si}`, svg); c.setAttribute('cx', x(i)); c.setAttribute('cy', y(s.values[i])); c.setAttribute('visibility', 'visible'); });
    t.hidden = false; t.innerHTML = `<b>${esc(labels[i])}</b>${series.map((s) => `<div><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color};margin-right:6px"></i>${esc(s.name)}: <b style="display:inline">${esc(fmt.n(s.values[i]))}${unit}</b></div>`).join('')}`;
    t.style.left = `${Math.min(window.innerWidth - 200, ev.clientX + 14)}px`; t.style.top = `${ev.clientY + 14}px`;
  };
  const hit = $('.hit', svg); hit.addEventListener('pointermove', move); hit.addEventListener('pointerleave', () => { t.hidden = true; xh.setAttribute('visibility', 'hidden'); $$('circle', svg).forEach((c) => c.setAttribute('visibility', 'hidden')); });
}
function barList(items, { unit = '', max } = {}) { // horizontal single-series magnitude bars with direct labels
  const m = max || Math.max(1, ...items.map((i) => i.value));
  return h`<div style="display:flex;flex-direction:column;gap:10px">${items.map((i) => h`<div title="${i.label}: ${fmt.n(i.value)}${unit}"><div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px"><span>${i.label}</span><span class="num t2">${i.text || `${fmt.n(i.value)}${unit}`}</span></div>${meter((i.value / m) * 100, i.tone || 'none')}</div>`)}</div>`;
}

// ---------- lazy libs: QR / barcode / camera scan ----------
const libs = {};
function loadScript(src) { if (!libs[src]) libs[src] = new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.crossOrigin = 'anonymous'; s.onload = res; s.onerror = () => rej(new Error('Kutubxona yuklanmadi (internet?)')); document.head.appendChild(s); }); return libs[src]; }
async function qrSvg(text, size = 160) {
  try { await loadScript('https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js'); const q = window.qrcode(0, 'M'); q.addData(String(text)); q.make(); const n = q.getModuleCount(); const c = size / n; let p = ''; for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) p += `M${(k * c).toFixed(2)},${(r * c).toFixed(2)}h${c.toFixed(2)}v${c.toFixed(2)}h-${c.toFixed(2)}z`; return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR ${esc(text)}"><rect width="100%" height="100%" fill="#fff"/><path d="${p}" fill="#000"/></svg>`; }
  catch { return `<div class="mono small">${esc(text)}</div>`; }
}
async function barcodeSvg(text) {
  try { await loadScript('https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js'); const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); window.JsBarcode(s, String(text), { format: 'CODE128', height: 48, width: 1.6, fontSize: 12, margin: 4 }); return s.outerHTML; }
  catch { return `<div class="mono">${esc(text)}</div>`; }
}
async function openScanner(onCode, title = 'QR / Barcode skanerlash') {
  let stop = () => {};
  const res = await modal({ title, body: raw(`<div class="field"><label>Kodni kiriting yoki skaner qiling (USB skaner ham ishlaydi)</label><input class="input scan" data-code placeholder="Masalan: SP550WM-2609-000123 yoki PAL-2026-0001"></div>
    <div style="margin-top:10px;display:flex;gap:8px"><button type="button" class="btn" data-cam>${html(icon('camera'))}Kamera orqali</button></div><div class="scan-video" id="scan-video" hidden></div><video id="scan-v" playsinline muted hidden style="width:100%;border-radius:12px;margin-top:10px"></video>`),
  submitText: 'Qidirish',
  onOpen: (bg, close) => {
    const inp = $('[data-code]', bg); setTimeout(() => inp.focus(), 50);
    $('[data-cam]', bg).addEventListener('click', async () => {
      try {
        if ('BarcodeDetector' in window) {
          const det = new window.BarcodeDetector(); const v = $('#scan-v', bg); v.hidden = false;
          const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); v.srcObject = stream; await v.play();
          let live = true; stop = () => { live = false; stream.getTracks().forEach((t) => t.stop()); };
          const loop = async () => { if (!live) return; try { const r = await det.detect(v); if (r[0]) { stop(); close(r[0].rawValue); return; } } catch {} requestAnimationFrame(loop); }; loop();
        } else {
          await loadScript('https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js');
          const box = $('#scan-video', bg); box.hidden = false;
          const sc = new window.Html5Qrcode('scan-video'); stop = () => sc.stop().catch(() => {});
          await sc.start({ facingMode: 'environment' }, { fps: 10, qrbox: 240 }, (txt) => { stop(); close(txt); });
        }
      } catch (e) { toast(`Kamera ishlamadi: ${e.message}`, 'err'); }
    });
  },
  onSubmit: async (form) => { const v = $('[data-code]', form).value.trim(); if (!v) throw new Error('Kod kiriting'); return v; } });
  stop();
  if (typeof res === 'string' && res) onCode(res);
}
function printHtml(inner, title = 'Chop etish') {
  const w = window.open('', '_blank', 'width=900,height=700'); if (!w) { toast('Brauzer oynani blokladi', 'err'); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font-family:Arial,sans-serif;padding:24px;color:#000}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:5px 7px;text-align:left;font-size:12px}th{background:#eee}.qr-label{border:2px solid #000;border-radius:8px;padding:14px;display:grid;grid-template-columns:auto 1fr;gap:14px;align-items:center;margin-bottom:14px;page-break-inside:avoid}</style></head><body>${inner}</body></html>`);
  w.document.close(); setTimeout(() => { w.focus(); w.print(); }, 350);
}

// ---------- router ----------
App.page = (pattern, def) => { const keys = []; const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`); App.pages.push({ pattern, re, keys, ...def }); };
App.current = null;
App.render = async function render(opts = {}) {
  const hash = location.hash.replace(/^#/, '') || '/dashboard';
  const [path, qs] = hash.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  if (App.user && (!App.sectionAllows(path) || App.logisticsHidden?.(path))) { location.hash = `#${App.homePath()}`; return; }
  const pg = App.pages.find((p) => p.re.test(path));
  let content = $('#content'); if (!content) return;
  // fresh node per render: drops listeners bound by the previous render (visible DOM is kept via deep clone)
  const fresh = content.cloneNode(true); content.replaceWith(fresh); content = fresh;
  if (!pg) { content.innerHTML = html(errState('Sahifa topilmadi')); return; }
  const params = {}; const m = pg.re.exec(path); pg.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
  const same = App.current && App.current.path === path && JSON.stringify(App.current.query) === JSON.stringify(query);
  if (!same) { App.cleanup.forEach((f) => f()); App.cleanup = []; App.live.handlers = []; }
  App.current = { path, query, params, pg };
  document.title = `${pg.title || 'WMS'} · Solar Factory WMS`;
  App.setActiveNav(path);
  const scroll = window.scrollY;
  if (!opts.silent) { content.innerHTML = html(skeleton()); window.scrollTo(0, 0); }
  try {
    const token = (App._rt = (App._rt || 0) + 1);
    const out = await pg.render({ params, query, el: content, silent: !!opts.silent });
    if (token !== App._rt) return;
    if (out !== undefined) content.innerHTML = html(out);
    if (pg.after) await pg.after({ params, query, el: content });
    if (opts.silent) window.scrollTo(0, scroll);
  } catch (e) {
    if (e.status === 401) return;
    console.error(`[${path}]`, e);
    App.reportError(e, hash);
    content.innerHTML = html(errState(e.message, e));
    $('[data-retry]', content)?.addEventListener('click', () => App.render());
    // avtomatik qayta urinish: 5, 10, 20, 40, 60 s (shu sahifada qolinsa)
    const key = hash; App._fails = App._fails?.key === key ? { key, n: App._fails.n + 1 } : { key, n: 1 };
    if (App._fails.n <= 6 && e.status !== 403) {
      let left = Math.min(60, 5 * 2 ** (App._fails.n - 1)); const box = $('[data-autoretry]', content);
      const tick = setInterval(() => {
        if (!box.isConnected) return clearInterval(tick);
        left -= 1; box.textContent = `Avtomatik qayta urinish: ${left} s`;
        if (left <= 0) { clearInterval(tick); if ((location.hash.replace(/^#/, '') || '/dashboard') === key) App.render({ silent: true }); }
      }, 1000);
      box.textContent = `Avtomatik qayta urinish: ${left} s`;
    }
    return;
  }
  if (App._fails?.key === hash) App._fails = null;
};
App.refresh = () => App.render({ silent: true });

// ---------- real-time (SSE) ----------
let pendingLive = false;
App.onLive = (types, fn) => App.live.handlers.push({ types, fn });
App.flushLive = () => { if (pendingLive && !$('#modal-root').children.length) { pendingLive = false; App.refresh(); } };
const liveRefresh = debounce(() => { if ($('#modal-root').children.length || document.activeElement?.matches?.('input,textarea,select')) { pendingLive = true; return; } App.refresh(); }, 700);
App.connectLive = function connectLive() {
  if (App.live.es) App.live.es.close();
  const es = new EventSource('/api/events/stream'); App.live.es = es;
  const ind = () => $('#live');
  es.onopen = () => { ind()?.classList.add('on'); ind() && (ind().querySelector('span').textContent = 'Real-time'); };
  es.onerror = () => { if (es.readyState !== 2) return; ind()?.classList.remove('on'); ind() && (ind().querySelector('span').textContent = 'Qayta ulanmoqda…'); };
  const TYPES = ['STOCK_CHANGED', 'ORDER_CREATED', 'ORDER_RESERVED', 'ORDER_STATUS', 'SHORTAGE_DETECTED', 'SHORTAGE_RESOLVED', 'SUPPLIER_REQUEST_CREATED', 'PURCHASE_REQUEST_STATUS', 'DELIVERY_DELAYED', 'DELIVERY_UPDATED', 'SUPPLIER_DELIVERY_ARRIVED',
    'MATERIAL_RECEIVED', 'QC_FAILED', 'PICKING_STARTED', 'PICKING_COMPLETED', 'PACKING_STARTED', 'PACKING_COMPLETED', 'LOADING_STARTED', 'LOADING_COMPLETED', 'SHIPMENT_CREATED', 'SHIPMENT_DISPATCHED', 'SHIPMENT_ARRIVED',
    'DOCUMENT_SUBMITTED', 'DOCUMENT_APPROVED', 'DOCUMENT_CREATED', 'XETQ_STATUS', 'AI_ALERT', 'AI_ALERT_ACK', 'AI_SCAN', 'TASK_CREATED', 'TASK_ASSIGNED', 'VEHICLE_STATUS', 'PRODUCT_CHANGED', 'BOT_LINKED', 'DISPATCH_PLANNED', 'DISPATCH_DRIVER_ACCEPTED', 'DISPATCH_DECLINED', 'DISPATCH_NO_TRANSPORT', 'DISPATCH_DONE', 'DAILY_REPORT', 'INTEGRATION_SYNC', 'PRODUCTION_CREATED', 'PRODUCTION_STATUS', 'PRODUCTION_OUTPUT', 'PRODUCTION_BOM'];
  const NOTIFY = { SHORTAGE_DETECTED: (d) => [`${d.sku}: ${d.shortage} dona yetishmaydi (${d.orderNo})`, 'warn', 'SHORTAGE'], DELIVERY_DELAYED: (d) => [d.message, 'err', 'DELIVERY DELAY'], SHIPMENT_DISPATCHED: (d) => [`${d.shipNo} yo‘lga chiqdi`, 'ok', 'Jo‘natildi'],
    SHIPMENT_ARRIVED: (d) => [`${d.shipNo} manzilga yetdi`, 'ok'], SUPPLIER_DELIVERY_ARRIVED: (d) => [`Supplier yuki keldi: ${d.qty}`, 'info', 'Kirim'], QC_FAILED: (d) => [`${d.sku}: ${d.failed} QC dan o‘tmadi`, 'warn', 'QC'],
    DOCUMENT_SUBMITTED: (d) => [`${d.subNo} XETQ ga topshirildi`, 'info'], LOADING_COMPLETED: (d) => [`${d.shipNo} yuklandi (${d.minutes} daq)`, 'ok'],
    DISPATCH_PLANNED: (d) => [`${d.orderNo}: transport tanlandi (${d.shipNo})${d.telegram ? ', haydovchiga yozildi' : ''}`, 'info', 'AI dispetcher'], DISPATCH_NO_TRANSPORT: (d) => [`${d.orderNo}: ${d.reason}`, 'err', 'AI dispetcher'], DISPATCH_DONE: () => ['Yuk ombordan chiqdi', 'ok', 'AI dispetcher'],
    BOT_LINKED: (d) => (d.userId === App.user?.id ? ['Telegram bot hisobingizga ulandi', 'ok', 'Telegram'] : null),
    AI_ALERT: (d) => (d.severity === 'CRITICAL' ? [d.message, 'err', `🔴 ${d.title}`] : null), TASK_CREATED: (d) => (d.assignedTo === App.user?.id ? [`Yangi topshiriq: ${d.taskNo}`, 'info', 'Topshiriq'] : null) };
  for (const t of TYPES) es.addEventListener(t, (ev) => {
    let d = {}; try { d = JSON.parse(ev.data); } catch {}
    if (d._replay) return;
    const i = ind(); if (i) { i.classList.add('flash'); setTimeout(() => i.classList.remove('flash'), 600); }
    const n = NOTIFY[t] && NOTIFY[t](d); if (n && d._at && Date.now() - new Date(d._at) < 60000) toast(n[0], n[1], n[2]);
    if (t === 'AI_ALERT' || t === 'AI_ALERT_ACK' || t === 'AI_SCAN') App.updateBell && App.updateBell();
    App.updatePulse && App.updatePulse();
    const custom = App.live.handlers.filter((hd) => !hd.types || hd.types.includes(t));
    if (custom.length) custom.forEach((hd) => hd.fn(t, d));
    else if (App.current?.pg.live && (App.current.pg.live === true || App.current.pg.live.includes(t))) liveRefresh();
  });
};

Object.assign(window, { $, $$, esc, raw, h, html, fmt, isoDate, isoLocal, debounce, can, go, icon, label, badge, sevBadge, LBL, TXN, CAT, VEH_ICON, VEH_LBL, api, GET, POST, PUT, toast, act,
  fieldHtml, formHtml, readForm, opt, modal, confirmBox, formModal, dataTable, tableHtml, kpi, card, pageHead, btn, meter, dl, stepper, timeline, skeleton, errState, aiCallout, coverage,
  lineChart, barList, qrSvg, barcodeSvg, openScanner, printHtml, loadScript });
