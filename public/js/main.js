/* Layout, navigation, login, global search, notifications, theme, boot */
'use strict';
// Menyu: asosiy bo‘limlar (Ombor, Ta’minot, Ishlab chiqarish, Sozlamalar) — bosilganda faqat o‘sha bo‘lim ochiladi. [href, nom, ikonka, badge, ruxsat]
const NAV = [
  ['Boshqaruv', [['/director', 'Direktor paneli', 'crown'], ['/tasks', 'Topshiriqlar', 'task']]],
  ['Ombor', [['/dashboard', 'Ombor Dashboard', 'dash'], ['/receiving', 'Kirim', 'in'], ['/issue', 'Chiqim', 'out'], ['/products', 'Mahsulotlar', 'box'], ['/products?cat=FINISHED', 'Tayyor mahsulot', 'sun'], ['/products?cat=RAW', 'Xomashyo', 'layers'],
    ['/products?cat=MATERIAL', 'Materiallar', 'layers'], ['/stock', 'Qoldiq (lokatsiya)', 'map'], ['/warehouses', 'Omborlar va zonalar', 'warehouse'],
    ['/reservations', 'Rezerv', 'lock'], ['/transfer', 'Ko‘chirish', 'swap'], ['/counts', 'Inventarizatsiya', 'clip'], ['/receiving?source=RETURN', 'Qaytarilgan mahsulot', 'undo'],
    ['/orders', 'Buyurtmalar', 'cart', 'orders'], ['/picking', 'Yig‘ish (Picking)', 'pick'], ['/packing', 'Packing / Pallet', 'pack'], ['/qr', 'QR / Barcode', 'qr'], ['/trace', 'Traceability', 'trace'], ['/transactions', 'Tranzaksiyalar', 'doc']]],
  ['Ta’minot', [['/shortages', 'Yetishmovchilik', 'alert', 'short'], ['/purchase', 'Ta’minot zayavkalari', 'clip', 'pr'], ['/odoo-purchases', 'Odoo xaridlari', 'in'],
    ['/suppliers', 'Supplierlar', 'factory'], ['/deliveries', 'Yetkazib berish', 'in', 'late']]],
  ['Ishlab chiqarish', [['/production', 'Ishlab chiqarish paneli', 'factory'], ['/production-orders', 'Ishlab chiqarish buyurtmalari', 'clip'], ['/bom', 'Mahsulot tarkibi (BOM)', 'layers'],
    ['/mrp', 'Material ehtiyoji', 'alert'], ['/receiving?source=PRODUCTION', 'Ishlab chiqarishdan kirim', 'in'], ['/products?cat=WIP', 'Yarim tayyor mahsulot', 'layers'], ['/quality', 'Brak va rework', 'scrap']]],
  ['XETQ va hujjatlar', [['/xetq', 'XETQ kelishuvi', 'shield', 'xetq'], ['/projects', 'Loyihalar', 'project'], ['/ts', 'Texnik shartlar', 'ruler'], ['/documents', 'Hujjatlar', 'file']]],
  ['AI va hisobot', [['/ai', 'AI Ombor boshqaruvi', 'ai', 'ai'], ['/daily', 'Kunlik AI hisobotlari', 'clock'], ['/reports', 'Hisobotlar', 'chart'], ['/kpi', 'Xodimlar KPI', 'kpi']]],
  ['Sozlamalar', [['/apikeys', 'API kalitlari va Odoo', 'lock', null, 'admin.apikeys'], ['/teambots', 'Telegram botlar (4 ta)', 'ai', null, 'admin.apikeys'], ['/telegram', 'Telegram bot (bildirishnoma)', 'send'], ['/users', 'Adminlar va foydalanuvchilar', 'users'],
    ['/settings', 'Umumiy sozlamalar', 'gear'], ['/templates', 'Hujjat shablonlari', 'doc'], ['/audit', 'Audit log', 'audit', null, 'audit.view']]],
];
const LOGISTICS_NAV = ['Logistika (jo‘natish)', [['/odoo-deliveries', 'Odoo jo‘natmalari', 'send'], ['/transport', 'Transport', 'truck'], ['/shipments', 'Jo‘natmalar', 'send'],
    ['/loading', 'Yuklash', 'load'], ['/drivers', 'Haydovchilar', 'users'], ['/dispatch', 'AI dispetcher', 'ai']]];
const LOGISTICS_PATHS = ['/transport', '/shipments', '/loading', '/drivers', '/dispatch', '/odoo-deliveries', '/daily'];
const navGroups = () => (App.meta?.modules?.logistics ? [...NAV.slice(0, 4), LOGISTICS_NAV, ...NAV.slice(4)] : NAV)
  .map(([g, items]) => [g, App.meta?.modules?.logistics ? items : items.filter((i) => !LOGISTICS_PATHS.includes(i[0].split('?')[0]))]);
App.logisticsHidden = (path) => !App.meta?.modules?.logistics && LOGISTICS_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
const MAIN_SECTIONS = ['Ombor', 'Ta’minot', 'Ishlab chiqarish', 'Sozlamalar'];

App.loadMeta = async () => { App.meta = await GET('/api/meta'); return App.meta; };
// bo‘lim foydalanuvchisi (Ombor / Ta’minot / Ishlab chiqarish): faqat admin belgilagan bo‘lim sahifalari
App.section = null;
App.sectionAllows = (path) => !App.section || App.section.pages.some((p) => path === p || path.startsWith(`${p}/`));
App.homePath = () => (App.section ? App.section.pages[0] : ['DIRECTOR', 'SUPERADMIN', 'ADMIN'].includes(App.user.role) ? '/director' : App.user.role === 'STOREKEEPER' ? '/tasks' : '/dashboard');

App.openNavGroup = (g) => { $$('.nav-group').forEach((x) => { const open = x === g; x.classList.toggle('collapsed', !open); $('button', x)?.setAttribute('aria-expanded', String(open)); }); };
App.setActiveNav = (path) => {
  const full = location.hash.replace(/^#/, '') || '/dashboard';
  const items = $$('.nav-item'); items.forEach((a) => a.classList.remove('active'));
  const hrefOf = (a) => a.getAttribute('href').slice(1);
  const best = items.find((a) => hrefOf(a) === full)
    || items.filter((a) => !hrefOf(a).includes('?') && (path === hrefOf(a) || path.startsWith(`${hrefOf(a)}/`))).sort((a, b) => hrefOf(b).length - hrefOf(a).length)[0];
  if (best) { best.classList.add('active'); const g = best.closest('.nav-group'); if (g && g.classList.contains('collapsed')) App.openNavGroup(g); }
  $$('.mobile-nav a').forEach((a) => a.classList.toggle('active', path.startsWith(a.getAttribute('href').slice(1))));
  $('.layout')?.classList.remove('nav-open');
};

function layoutHtml() {
  const u = App.user;
  return `<div class="layout">
  <aside class="sidebar" aria-label="Asosiy menyu">
    <div class="brand"><div class="brand-mark">SF</div><div><b>SOLAR FACTORY AI</b><span>${App.section ? `Bo‘lim: ${esc(App.section.label)}` : 'Ombor · Ta’minot · Ishlab chiqarish'}</span></div></div>
    <div class="ai-pulse" data-pulse role="status" aria-live="polite"><div class="ap-h"><span>🤖 AI tahlil</span><span class="ap-live" title="Har daqiqada va har bir o‘zgarishda yangilanadi"><i></i>jonli</span></div><div class="ap-body"><div class="ap-head">Tahlil qilinmoqda…</div></div></div>
    <nav class="nav">${navGroups().filter(([, items]) => items.some((i) => (!i[4] || can(i[4])) && App.sectionAllows(i[0].split('?')[0]))).map(([g, items], gi) => `<div class="nav-group collapsed ${MAIN_SECTIONS.includes(g) ? 'main' : ''}" data-g="${gi}"><button type="button" aria-expanded="false">${esc(g)}<span class="chev">${html(icon('chev'))}</span></button><div class="nav-items">${items.filter((i) => (!i[4] || can(i[4])) && App.sectionAllows(i[0].split('?')[0])).map(([href, l, ic, badgeKey]) => `<a class="nav-item" href="#${href}">${html(icon(ic))}<span>${esc(l)}</span>${badgeKey ? `<span class="nav-badge" data-nb="${badgeKey}" hidden></span>` : ''}</a>`).join('')}</div></div>`).join('')}</nav>
    <div class="side-foot"><span>v1.0 · ${esc(App.meta.company)}</span></div>
  </aside>
  <div class="main">
    <header class="topbar">
      <button class="icon-btn menu-btn" data-menu aria-label="Menyu">${html(icon('menu'))}</button>
      <div class="search"${App.section ? ' style="visibility:hidden"' : ''}>${html(icon('search'))}<input id="gsearch" type="search" placeholder="Global qidiruv: SKU, serial, buyurtma, pallet, jo‘natma, supplier…" autocomplete="off" aria-label="Global qidiruv"><kbd>/</kbd><div class="search-results" hidden></div></div>
      <div class="top-actions">
        <span class="live" id="live" title="Real-time ulanish (SSE)"><i></i><span>Ulanmoqda…</span></span>
        <button class="icon-btn" data-scan ${App.section && App.section.key !== 'OMBOR' ? 'hidden' : ''} title="QR skan" aria-label="QR skan">${html(icon('qr'))}</button>
        <button class="icon-btn" data-ai ${App.section ? 'hidden' : ''} title="AI Direktor" aria-label="AI">${html(icon('ai'))}</button>
        <button class="icon-btn" data-bell ${App.section ? 'hidden' : ''} title="Bildirishnomalar" aria-label="Bildirishnomalar">${html(icon('bell'))}<span class="dot" hidden></span></button>
        <button class="icon-btn" data-theme title="Tema" aria-label="Tema">${html(icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon'))}</button>
        <div class="user-chip" data-user tabindex="0" role="button" aria-label="Foydalanuvchi menyusi"><span class="avatar">${esc(u.fullName.split(' ').map((x) => x[0]).join('').slice(0, 2))}</span><div><b>${esc(u.fullName)}</b><span>${esc(u.roleName || u.role)}</span></div></div>
      </div>
    </header>
    <main class="content" id="content"></main>
  </div>
  <nav class="mobile-nav" aria-label="Mobil navigatsiya">${App.section ? navGroups().flatMap(([, items]) => items).filter((i) => !i[0].includes('?') && App.sectionAllows(i[0]) && (!i[4] || can(i[4]))).slice(0, 4).map(([href, l, ic]) => `<a href="#${href}">${html(icon(ic))}${esc(l.split(' ')[0])}</a>`).join('') : `<a href="#/dashboard">${html(icon('dash'))}Dashboard</a><a href="#/tasks">${html(icon('task'))}Topshiriq</a><a href="#/qr">${html(icon('qr'))}Skan</a><a href="#/orders">${html(icon('cart'))}Buyurtma</a>`}<a href="#" data-menu>${html(icon('menu'))}Menyu</a></nav>
</div>`;
}

App.updatePulse = debounce(async () => {
  const box = $('[data-pulse] .ap-body'); if (!box) return;
  try {
    const p = await GET('/api/ai/pulse');
    box.innerHTML = html(h`<a class="ap-head ${p.level}" href="#${App.section ? App.section.pages[0] : '/ai'}">${p.headline}</a>
      <div class="ap-metrics ${p.metrics.length === 4 ? 'four' : ''}">${p.metrics.map((m) => h`<a href="#${m.href}" class="ap-m ${m.bad && m.value ? 'bad' : ''}"><b>${fmt.n(m.value)}</b><span>${m.label}</span></a>`)}</div>
      ${p.alerts.length ? h`<div class="ap-alerts">${p.alerts.slice(0, 3).map((a) => h`<div class="ap-a ${a.severity === 'CRITICAL' ? 'crit' : 'warn'}" title="${a.message || ''}">${a.severity === 'CRITICAL' ? '🔴' : '🟠'} ${a.title}</div>`)}</div>` : ''}
      <div class="ap-foot">${p.odoo ? h`Odoo: ${p.odoo.status === 'OK' ? '🟢' : p.odoo.status ? '🟠' : '⚪'} ${p.odoo.lastSyncAt ? fmt.rel(p.odoo.lastSyncAt) : 'sinxronlanmagan'} · ` : ''}yangilandi ${new Date(p.at).toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' })}</div>`);
  } catch { box.innerHTML = '<div class="ap-head">AI tahlil vaqtincha mavjud emas</div>'; }
}, 1500);
App.updateBell = debounce(async () => {
  if (App.section) return;
  try {
    const [alerts, d] = await Promise.all([GET('/api/ai/alerts'), GET('/api/dashboard/director')]);
    const n = alerts.filter((a) => a.severity !== 'INFO').length; const dot = $('[data-bell] .dot'); if (dot) { dot.hidden = !n; dot.textContent = n > 99 ? '99+' : n; }
    const set = (k, v, amber) => { const b = $(`[data-nb="${k}"]`); if (b) { b.hidden = !v; b.textContent = v; b.classList.toggle('amber', !!amber); } };
    set('short', d.supply.shortages); set('late', d.supplier.delays); set('ai', d.ai.critical); set('pr', d.supply.awaitingApproval, true); set('xetq', d.xetq.revision);
    set('orders', (d.orders.find((o) => o.status === 'PARTIALLY_RESERVED')?.n || 0) + (d.orders.find((o) => o.status === 'NEW')?.n || 0), true);
  } catch {}
}, 800);

function wireLayout() {
  $('.nav').addEventListener('click', (e) => {
    const b = e.target.closest('.nav-group > button'); if (!b) return;
    const g = b.parentElement; const opening = g.classList.contains('collapsed');
    App.openNavGroup(opening ? g : null);
    // asosiy bo‘lim sarlavhasi bosilsa — o‘sha bo‘limning birinchi sahifasiga o‘tiladi
    if (opening && g.classList.contains('main')) { const first = $('.nav-item', g); const inside = $$('.nav-item', g).some((a) => a.classList.contains('active')); if (first && !inside) location.hash = first.getAttribute('href'); }
  });
  $$('[data-menu]').forEach((m) => m.addEventListener('click', (e) => { e.preventDefault(); $('.layout').classList.toggle('nav-open'); }));
  $('.layout').addEventListener('click', (e) => { if (e.target === $('.layout') && $('.layout').classList.contains('nav-open')) $('.layout').classList.remove('nav-open'); });
  document.addEventListener('click', (e) => { if ($('.layout.nav-open') && !e.target.closest('.sidebar') && !e.target.closest('[data-menu]')) $('.layout').classList.remove('nav-open'); });
  $('[data-scan]').addEventListener('click', () => openScanner((c) => go(`#/qr?code=${encodeURIComponent(c)}`)));
  $('[data-ai]').addEventListener('click', () => App.openChat());
  $('[data-theme]').addEventListener('click', () => { const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); const next = cur === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem('wms.theme', next); } catch {} $('[data-theme]').innerHTML = html(icon(next === 'dark' ? 'sun' : 'moon')); if (App.current) App.refresh(); });
  // dropdowns
  const closeDd = () => $$('.dropdown').forEach((d) => d.remove());
  document.addEventListener('click', (e) => { if (!e.target.closest('.dropdown') && !e.target.closest('[data-bell]') && !e.target.closest('[data-user]')) closeDd(); });
  $('[data-bell]').addEventListener('click', async () => {
    if ($('.dropdown')) return closeDd();
    const alerts = await GET('/api/ai/alerts');
    const dd = document.createElement('div'); dd.className = 'dropdown';
    dd.innerHTML = `<header>Bildirishnomalar <a href="#/ai" class="small">Barchasi</a></header><div class="list alert-list">${alerts.filter((a) => a.severity !== 'INFO').slice(0, 12).map((a) => html(App.alertRow(a))).join('') || '<div class="empty">Yangi bildirishnoma yo‘q</div>'}</div>`;
    $('.topbar').appendChild(dd); dd.addEventListener('click', (e) => { if (e.target.closest('a')) closeDd(); });
  });
  const userMenu = () => {
    if ($('.dropdown')) return closeDd();
    const dd = document.createElement('div'); dd.className = 'dropdown'; dd.style.width = '260px';
    dd.innerHTML = `<header>${esc(App.user.fullName)}<span class="small muted">${esc(App.user.username)}</span></header><div class="menu"><a href="#/tasks">${html(icon('task'))}Mening topshiriqlarim</a><a href="#/telegram">${html(icon('send'))}Telegram bot</a><button data-pw>${html(icon('lock'))}Parolni o‘zgartirish</button><button data-out>${html(icon('logout'))}Chiqish</button></div>`;
    $('.topbar').appendChild(dd);
    $('[data-pw]', dd).addEventListener('click', () => { closeDd(); App.changePassword(); });
    $('[data-out]', dd).addEventListener('click', async () => { await POST('/api/auth/logout').catch(() => {}); App.live.es?.close(); App.user = null; App.showLogin(); });
  };
  $('[data-user]').addEventListener('click', userMenu); $('[data-user]').addEventListener('keydown', (e) => { if (e.key === 'Enter') userMenu(); });
  // global search
  const inp = $('#gsearch'); const box = $('.search-results');
  const KIND = { product: ['Mahsulot', (r) => `#/products/${r.id}`], order: ['Buyurtma', (r) => `#/orders/${r.id}`], serial: ['Serial', (r) => `#/trace?kind=serial&q=${encodeURIComponent(r.code)}`], pallet: ['Pallet', (r) => `#/qr?code=${encodeURIComponent(r.code)}`], shipment: ['Jo‘natma', (r) => `#/shipments/${r.code}`], purchase_request: ['Zayavka', (r) => `#/purchase?open=${r.id}`], supplier: ['Supplier', (r) => `#/suppliers/${r.id}`], location: ['Lokatsiya', (r) => `#/qr?code=${encodeURIComponent(r.code)}`], document: ['Hujjat', (r) => `#/documents?open=${r.id}`], xetq: ['XETQ', (r) => `#/xetq/${r.id}`], vehicle: ['Transport', () => '#/transport'] };
  let sel = -1;
  const run = debounce(async () => {
    const q = inp.value.trim(); if (q.length < 2) { box.hidden = true; return; }
    const res = (await GET(`/api/search?q=${encodeURIComponent(q)}`).catch(() => [])).filter((r) => App.meta?.modules?.logistics || r.kind !== 'shipment');
    sel = -1;
    box.innerHTML = res.length ? res.map((r) => `<a href="${esc(KIND[r.kind][1](r))}"><span class="badge plain dark" style="min-width:76px;justify-content:center">${esc(KIND[r.kind][0])}</span><div><b>${esc(r.label)}</b><div class="small muted">${esc(r.sub || '')}</div></div></a>`).join('') : '<div class="empty">Hech narsa topilmadi</div>';
    box.hidden = false;
  }, 200);
  inp.addEventListener('input', run);
  inp.addEventListener('keydown', (e) => { const items = $$('a', box); if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, Math.min(items.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1))); items.forEach((a, i) => a.classList.toggle('sel', i === sel)); } if (e.key === 'Enter') { const a = items[Math.max(0, sel)]; if (a) { location.hash = a.getAttribute('href'); box.hidden = true; inp.blur(); } } if (e.key === 'Escape') { box.hidden = true; inp.blur(); } });
  box.addEventListener('click', () => { box.hidden = true; inp.value = ''; });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) box.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === '/' && !e.target.closest('input,textarea,select') && !$('#modal-root').children.length) { e.preventDefault(); inp.focus(); } });
}

App.showLogin = function showLogin() {
  App.live.es?.close();
  $('#app').innerHTML = `<div class="login"><div class="login-art"><div><div class="brand" style="padding:0;border:0"><div class="brand-mark">SF</div><div><b>SOLAR FACTORY AI</b><span>Warehouse Management System</span></div></div></div>
    <div><h1>Ishlab chiqarishdan logistikagacha — bitta real-time tizim</h1><p style="max-width:460px;color:#aebccd">Kirim → QC → saqlash → rezerv → yetishmovchilik → ta’minot → picking → pallet → transport → yuklash → hujjatlar → XETQ → jo‘natish → traceability.</p></div>
    <svg class="panels" viewBox="0 0 460 300" aria-hidden="true"><g transform="skewX(-18)">${Array.from({ length: 12 }, (_, i) => `<rect x="${140 + (i % 4) * 78}" y="${40 + Math.floor(i / 4) * 78}" width="70" height="70" rx="4" fill="#1c5cab" stroke="#3987e5" stroke-width="2"/><path d="M${140 + (i % 4) * 78} ${75 + Math.floor(i / 4) * 78}h70M${175 + (i % 4) * 78} ${40 + Math.floor(i / 4) * 78}v70" stroke="#3987e5"/>`).join('')}</g><circle cx="80" cy="60" r="34" fill="#f5a524"/></svg>
    <div class="small" style="color:#7d8898">© ${new Date().getFullYear()} Solar Factory · Xavfsiz ulanish · RBAC · Audit</div></div>
    <div class="login-form"><form novalidate><div><h2>Tizimga kirish</h2><p class="muted" style="margin:4px 0 0">Korporativ hisobingiz bilan kiring</p></div><div class="form-err" hidden></div>
      <div class="field"><label for="lu">Login</label><input class="input" id="lu" name="username" autocomplete="username" required autofocus></div>
      <div class="field"><label for="lp">Parol</label><input class="input" id="lp" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn primary lg" type="submit">Kirish</button>
    </form></div></div>`;
  const f = $('.login-form form');
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); const btnEl = $('button[type=submit]', f); const err = $('.form-err', f); err.hidden = true; btnEl.classList.add('loading');
    try { const r = await api('POST', '/api/auth/login', { username: f.username.value, password: f.password.value }, { noAuthRedirect: true }); App.user = r.user; App.csrf = r.csrf; await start(); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; } finally { btnEl.classList.remove('loading'); }
  });
};

async function start() {
  await App.loadMeta();
  App.section = null;
  if (App.user.section) { const r = await GET('/api/sections'); App.section = { key: App.user.section, ...r.sections[App.user.section] }; }
  $('#app').innerHTML = layoutHtml();
  wireLayout();
  App.connectLive();
  App.updateBell();
  App.updatePulse();
  clearInterval(App._pulseTimer); App._pulseTimer = setInterval(() => App.updatePulse(), 60000);
  if (!location.hash || location.hash === '#/') location.hash = `#${App.homePath()}`;
  App.render();
}

App.showSetup = function showSetup() {
  $('#app').innerHTML = `<div class="login"><div class="login-art"><div><div class="brand" style="padding:0;border:0"><div class="brand-mark">SF</div><div><b>SOLAR FACTORY AI</b><span>Birinchi sozlash</span></div></div></div>
    <div><h1>Tizimni ishga tushirish</h1><p style="max-width:460px;color:#aebccd">Super admin hisobini yarating. Keyin adminlar va xodimlarni qo‘shasiz, API kalitlari bo‘limida AI, Telegram va kompaniya tizimi kalitlarini kiritasiz.</p></div><div></div></div>
    <div class="login-form"><form novalidate><div><h2>Super admin yaratish</h2><p class="muted" style="margin:4px 0 0">Bu hisob tizimning to‘liq egasi bo‘ladi</p></div><div class="form-err" hidden></div>
      <div class="field"><label for="sf">F.I.Sh.</label><input class="input" id="sf" name="fullName" required></div>
      <div class="field"><label for="sl">Login</label><input class="input" id="sl" name="login" autocomplete="username" required></div>
      <div class="field"><label for="sp">Parol (kamida 8 belgi)</label><input class="input" id="sp" name="password" type="password" autocomplete="new-password" required></div>
      <div class="field"><label for="sp2">Parolni takrorlang</label><input class="input" id="sp2" name="password2" type="password" autocomplete="new-password" required></div>
      <button class="btn primary lg" type="submit">Yaratish va kirish</button></form></div></div>`;
  const f = $('.login-form form');
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); const err = $('.form-err', f); err.hidden = true; const b = $('button[type=submit]', f); b.classList.add('loading');
    try {
      if (f.password.value !== f.password2.value) throw new Error('Parollar mos emas');
      await api('POST', '/api/setup', { fullName: f.fullName.value, login: f.login.value, password: f.password.value }, { noAuthRedirect: true });
      const r = await api('POST', '/api/auth/login', { username: f.login.value, password: f.password.value }, { noAuthRedirect: true }); App.user = r.user; App.csrf = r.csrf; location.hash = '#/apikeys'; await start();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; } finally { b.classList.remove('loading'); }
  });
};

(async function boot() {
  try { const t = localStorage.getItem('wms.theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
  window.addEventListener('hashchange', () => App.user && App.render());
  try { const r = await api('GET', '/api/auth/me', null, { noAuthRedirect: true }); App.user = r.user; App.csrf = r.csrf; await start(); }
  catch { const st = await api('GET', '/api/setup/status', null, { noAuthRedirect: true }).catch(() => ({})); if (st.needsSetup) App.showSetup(); else App.showLogin(); }
})();
