/* AI ombor boshqaruvi, hisobotlar, KPI, foydalanuvchilar, rollar, shablonlar, audit, sozlamalar */
'use strict';

// ================= AI =================
App.page('/ai', { title: 'AI Ombor boshqaruvi', live: ['AI_ALERT', 'AI_ALERT_ACK', 'AI_SCAN'], async render({ el, query }) {
  const tab = query.tab || 'alerts';
  el.innerHTML = html(h`${pageHead('AI Ombor boshqaruvi', 'Stock · demand · rezerv · ishlab chiqarish · kirim · supplier · dispatch · sig‘im — doimiy tahlil (faqat database ma’lumotlari asosida)', h`${btn('AI tahlil', { cls: 'accent', ico: 'ai', attrs: 'data-scan' })}${btn('AI bilan suhbat', { ico: 'send', attrs: 'data-chat' })}`)}
  <div class="tabs">${[['alerts', 'Alertlar'], ['forecast', 'Buyurtma prognozi'], ['insights', 'Sig‘im va optimizatsiya'], ['suppliers', 'Supplier performance']].map(([k, l]) => h`<a href="#/ai?tab=${k}" class="${tab === k ? 'active' : ''}">${l}</a>`)}</div><div data-body></div>`);
  $('[data-scan]', el).addEventListener('click', (e) => act(e.target.closest('button'), () => POST('/api/ai/scan'), (r) => `AI tahlil yakunlandi: ${r.raised} ta signal`).then(App.refresh));
  $('[data-chat]', el).addEventListener('click', () => App.openChat());
  const body = $('[data-body]', el);
  if (tab === 'alerts') {
    const rows = await GET(`/api/ai/alerts${query.status ? `?status=${query.status}` : ''}`);
    const by = (s) => rows.filter((r) => r.severity === s).length;
    body.innerHTML = html(h`<div class="kpis">${kpi({ label: '🔴 CRITICAL', value: by('CRITICAL'), ico: 'alert', tone: by('CRITICAL') ? 'crit' : 'good' })}${kpi({ label: '🟠 WARNING', value: by('WARNING'), ico: 'alert', tone: by('WARNING') ? 'warn' : 'good' })}${kpi({ label: '🔵 Tavsiyalar', value: by('INFO'), ico: 'ai', tone: 'blue' })}</div>
      <div class="toolbar"><a class="btn sm ${!query.status ? 'primary' : ''}" href="#/ai?tab=alerts">Ochiq</a><a class="btn sm ${query.status === 'ACK' ? 'primary' : ''}" href="#/ai?tab=alerts&status=ACK">Ko‘rilgan</a><a class="btn sm ${query.status === 'RESOLVED' ? 'primary' : ''}" href="#/ai?tab=alerts&status=RESOLVED">Hal qilingan</a></div>
      ${card('', h`<div class="alert-list">${rows.length ? rows.map((a) => h`<div class="alert ${a.severity}" style="grid-template-columns:28px 1fr auto auto"><div class="ai-ico">${icon(a.severity === 'INFO' ? 'ai' : 'alert')}</div><div><div class="a-title">${sevBadge(a.severity)} · ${a.title}</div><div class="a-msg">${a.message}</div><div class="a-time">${a.type} · ${fmt.dt(a.created_at)}</div></div><div>${badge(a.status)}</div><div>${a.status === 'OPEN' ? h`<button class="btn sm" data-ack="${a.id}">Ko‘rildi</button>` : ''}</div></div>`) : raw('<div class="empty">Ogohlantirish yo‘q</div>')}</div>`, { flush: true })}`);
    body.addEventListener('click', (e) => { const b = e.target.closest('[data-ack]'); if (b) act(b, () => POST(`/api/ai/alerts/${b.dataset.ack}/ack`)).then(App.refresh); });
  } else if (tab === 'forecast') {
    const days = Number(query.days) || 7; const f = await GET(`/api/ai/forecast?days=${days}`);
    body.innerHTML = html(h`<div class="toolbar">${[7, 14, 30].map((d) => h`<a class="btn sm ${days === d ? 'primary' : ''}" href="#/ai?tab=forecast&days=${d}">${d} kun</a>`)}</div>
      <div class="callout warn" style="margin-bottom:14px">${icon('shield')}<div>${f.note}</div></div>
      ${f.items.filter((i) => i.gap > 0).length ? h`<div style="margin-bottom:14px">${aiCallout(f.items.filter((i) => i.text).slice(0, 6).map((i) => `${i.sku}: ${i.text}`).join('\n'), 'AI buyurtma prognozi')}</div>` : ''}
      ${card('', raw('<div data-t></div>'), { flush: true })}`);
    dataTable($('[data-t]', body), { rows: f.items, columns: [{ key: 'sku', label: 'Mahsulot', render: (r) => h`<b>${r.sku}</b><div class="small muted">${r.name}</div>` }, { key: 'avgDaily', label: 'O‘rt. sarf/kun', num: true }, { key: 'ordersDue', label: `Buyurtmalar (${days} kun)`, num: true }, { key: 'demand', label: 'Talab', num: true }, { key: 'available', label: 'Mavjud', num: true }, { key: 'inbound', label: 'Kutilayotgan kirim', num: true }, { key: 'production', label: 'Ishlab chiqarish (prognoz)', num: true }, { key: 'gap', label: 'Tavsiya: kerak', num: true, render: (r) => (r.gap ? h`<b style="color:var(--crit-ink)">${fmt.n(r.gap)}</b>` : '✓') }, { label: '', sort: false, render: (r) => (r.gap && can('procurement.request') ? h`<button class="btn sm" data-pr="${r.product_id}" data-q="${r.gap}">Zayavka</button>` : '') }] });
    body.addEventListener('click', async (e) => { const b = e.target.closest('[data-pr]'); if (!b) return; const r = await formModal({ title: 'Prognoz asosida zayavka (tasdiqlash talab qilinadi)', fields: [{ name: 'productId', label: 'Mahsulot', type: 'select', required: true, value: b.dataset.pr, options: opt.products(), full: true }, { name: 'qty', label: 'Miqdor', type: 'number', required: true, value: b.dataset.q }, { name: 'priority', label: 'Muhimlik', type: 'select', noEmpty: true, value: 'NORMAL', options: [['HIGH', 'Yuqori'], ['NORMAL', 'Oddiy']] }, { name: 'reason', label: 'Sabab', required: true, full: true, value: `AI ${days} kunlik prognoz tavsiyasi` }], onSubmit: (d) => POST('/api/purchase-requests', { ...d, aiGenerated: true }) }); if (r) toast(`${r.prNo} tasdiqlashga yuborildi`, 'ok'); });
  } else if (tab === 'insights') {
    const ins = await GET('/api/ai/insights');
    body.innerHTML = html(h`<div class="grid g2">${card('Ombor sig‘imi', raw(tableHtml([{ label: 'Ombor', render: (c) => h`<b>${c.id}</b> ${c.name}<div class="small muted">${c.dims}</div>` }, { label: 'Capacity', render: (c) => h`<div class="cov"><span class="num small" style="min-width:48px">${fmt.pct(c.pct)}</span>${meter(c.pct)}</div>` }, { label: 'Pallet', render: (c) => `${c.usedPallets}/${c.positions}` }, { label: 'Og‘irlik', render: (c) => (c.weightPct != null ? fmt.pct(c.weightPct) : '—') }, { label: 'Hajm', render: (c) => (c.volumePct != null ? fmt.pct(c.volumePct) : '—') }], ins.capacity)), { flush: true })}
      <div class="grid" style="align-content:start">${aiCallout(ins.space.length ? ins.space.map((s) => s.text).join('\n') : 'Joydan foydalanish samarali — qo‘shimcha tavsiya yo‘q.', 'AI Space Optimization')}${aiCallout(ins.cycleCount.length ? ins.cycleCount.map((z) => `${z.warehouse_id} ${z.name}: oxirgi 14 kunda ${z.moves} ta harakat — inventarizatsiya tavsiya qilinadi.`).join('\n') : 'Cycle count bo‘yicha tavsiya yo‘q.', 'AI Cycle Count')}</div></div>`);
  } else {
    const ins = await GET('/api/ai/insights');
    body.innerHTML = html(card('', raw('<div data-t></div>'), { flush: true }));
    dataTable($('[data-t]', body), { rows: ins.suppliers, onRow: (s) => go(`#/suppliers/${s.supplier_id}`), columns: [{ key: 'company', label: 'Supplier', render: (s) => h`<b>${s.company}</b><div class="small muted">${s.country}</div>` }, { key: 'orders', label: 'Buyurtma', num: true }, { key: 'on_time', label: 'Vaqtida', num: true }, { key: 'late', label: 'Kechikkan', num: true }, { key: 'open_late', label: 'Hozir kechikmoqda', num: true }, { key: 'short_qty', label: 'Yetishmagan', num: true }, { key: 'rejected_qty', label: 'Brak', num: true }, { key: 'avg_lead_days', label: 'O‘rt. delivery time', num: true }, { key: 'on_time_rate', label: 'On-time %', num: true }, { key: 'quality_rate', label: 'Quality %', num: true }] });
  }
} });

App.openChat = function openChat() {
  if ($('.drawer')) return;
  const d = document.createElement('div'); d.className = 'drawer'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'AI Direktor');
  d.innerHTML = `<div class="modal-h"><span class="avatar" style="background:linear-gradient(135deg,#f5a524,#e8590c)">AI</span><div><b>AI Direktor</b><div class="small muted">${App.meta.llm ? 'Database + LLM' : 'Real vaqtdagi database tahlili'}</div></div><button class="icon-btn x" data-x aria-label="Yopish">${html(icon('x'))}</button></div>
  <div class="chat" data-chat><div class="msg ai">Salom! Men ombor, ta'minot, ishlab chiqarish va XETQ ma'lumotlarini real vaqtda tahlil qilaman. Savol bering.</div><div class="chips">${['Omborda nima yetishmayapti?', 'Qaysi supplier kechikyapti?', 'Ertangi jo‘natmaga yetadimi?', 'Qaysi mashina kerak?', 'Omborda nechta panel bor?', 'Qaysi panel qayerda?', 'Qancha pallet tayyor?', 'Qaysi shipment yo‘lda?', 'Qaysi hujjat qayta ishlashga qaytarilgan?', 'Texnik shart qaysi versiyada?', 'AI qanday xavflarni ko‘rmoqda?'].map((q) => `<button class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div></div>
  <form class="chat-in"><input class="input" name="q" placeholder="Savol yozing…" autocomplete="off" aria-label="Savol"><button class="btn primary" aria-label="Yuborish">${html(icon('send'))}</button></form>`;
  document.body.appendChild(d);
  const chat = $('[data-chat]', d);
  const ask = async (q) => {
    chat.insertAdjacentHTML('beforeend', `<div class="msg me">${esc(q)}</div><div class="msg ai" data-pending><span class="sk sk-line" style="display:block;width:180px"></span></div>`); chat.scrollTop = chat.scrollHeight;
    try { const r = await POST('/api/ai/ask', { question: q }); $('[data-pending]', chat).outerHTML = `<div class="msg ai">${esc(r.answer)}<span class="src">Manba: ${r.source === 'database' ? 'database (real vaqt)' : 'database + LLM'} · ${new Date().toLocaleTimeString('ru-RU')}</span></div>`; }
    catch (e) { $('[data-pending]', chat).outerHTML = `<div class="msg ai" style="color:var(--crit-ink)">${esc(e.message)}</div>`; }
    chat.scrollTop = chat.scrollHeight;
  };
  d.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) d.remove(); const c = e.target.closest('[data-q]'); if (c) ask(c.dataset.q); });
  $('form', d).addEventListener('submit', (e) => { e.preventDefault(); const q = e.target.q.value.trim(); if (q) { e.target.q.value = ''; ask(q); } });
  setTimeout(() => $('input', d).focus(), 50);
};

// ================= Reports =================
App.page('/reports', { title: 'Hisobotlar', async render({ el, query }) {
  const list = App.meta.reports; const type = query.type;
  el.innerHTML = html(h`${pageHead('Hisobotlar', App.meta?.modules?.logistics ? 'Kunlik / haftalik / oylik, stock, shortage, supplier, logistika, picking, yuklash, aniqlik, sig‘im, traceability, XETQ' : 'Kunlik / haftalik / oylik, stock, shortage, supplier, picking, aniqlik, sig‘im, traceability, XETQ')}
  <div class="grid" style="grid-template-columns:260px minmax(0,1fr)">
    ${card('', h`<nav class="menu" style="margin:-4px -16px -16px">${Object.entries(list).map(([k, v]) => h`<a href="#/reports?type=${k}" style="${type === k ? 'background:var(--surface-3);font-weight:600' : ''}">${icon('chart')}${v}</a>`)}</nav>`)}
    <div data-r>${type ? '' : card('', raw('<div class="empty">Chapdan hisobot turini tanlang</div>'))}</div></div>`);
  if (!type) return;
  const qs = new URLSearchParams(Object.entries({ from: query.from, to: query.to }).filter(([, v]) => v)).toString();
  const r = await GET(`/api/reports/${type}?${qs}`);
  const box = $('[data-r]', el);
  box.innerHTML = html(card(r.title, h`<div class="toolbar" style="padding:0"><label class="small t2">Dan</label><input class="input" type="date" data-from value="${query.from || r.from.slice(0, 10)}"><label class="small t2">Gacha</label><input class="input" type="date" data-to value="${query.to || isoDate(new Date(new Date(r.to).getTime() - 86400000))}"><button class="btn sm" data-apply>Qo‘llash</button>
    <a class="btn sm" href="/api/reports/${type}.csv?${qs}" download>${icon('download')}CSV / Excel</a><button class="btn sm" data-print>${icon('print')}Chop etish</button></div>
    ${Object.keys(r.summary).length ? h`<div class="kpis" style="margin-top:12px">${Object.entries(r.summary).map(([k, v]) => kpi({ label: k.replace(/_/g, ' '), value: fmt.n(v), ico: 'chart' }))}</div>` : ''}<div data-t style="margin:0 -16px -16px"></div>`, { sub: `Yaratildi: ${fmt.dt(r.generatedAt)}` }));
  dataTable($('[data-t]', box), { rows: r.rows, pageSize: 50, columns: r.columns.map((c) => ({ key: c, label: c.replace(/_/g, ' '), num: typeof r.rows[0]?.[c] === 'number', render: /status/.test(c) ? (x) => badge(x[c]) : /(_at|date|departure|eta|arrival|expected|actual)$/.test(c) ? (x) => (String(x[c] || '').length > 10 ? fmt.dt(x[c]) : x[c] || '—') : undefined })) });
  $('[data-apply]', box).addEventListener('click', () => go(`#/reports?type=${type}&from=${$('[data-from]', box).value}&to=${$('[data-to]', box).value}`));
  $('[data-print]', box).addEventListener('click', () => printHtml(`<h2>${esc(r.title)}</h2><p>${esc(fmt.d(r.from))} — ${esc(fmt.d(r.to))}</p>${tableHtml(r.columns.map((c) => ({ key: c, label: c })), r.rows)}`, r.title));
} });

App.page('/kpi', { title: 'Xodimlar KPI', async render({ el, query }) {
  const days = Number(query.days) || 30; const rows = await GET(`/api/kpi/workers?days=${days}`);
  el.innerHTML = html(h`${pageHead('Ishchi KPI', App.meta?.modules?.logistics ? 'Picked orders · picked quantity · errors · processing time · inventory accuracy · loading time' : 'Picked orders · picked quantity · errors · processing time · inventory accuracy', h`${[7, 30, 90].map((d) => h`<a class="btn ${days === d ? 'primary' : ''}" href="#/kpi?days=${d}">${d} kun</a>`)}`)}${card('', raw('<div data-t></div>'), { flush: true })}`);
  const logi = App.meta?.modules?.logistics;
  dataTable($('[data-t]', el), { rows: logi ? rows : rows.filter((r) => r.name !== 'AI dispetcher' && !/logist/i.test(r.role || '')), search: false, columns: [{ key: 'name', label: 'Xodim', render: (r) => h`<b>${r.name}</b><div class="small muted">${r.role}</div>` }, { key: 'pickedOrders', label: 'Picked orders', num: true }, { key: 'pickedQty', label: 'Picked qty', num: true }, { key: 'errors', label: 'Xatolar', num: true }, { key: 'errorRate', label: 'Xato %', num: true },
    { key: 'avgPickMinutes', label: 'O‘rt. picking, daq', num: true }, ...(logi ? [{ key: 'loadings', label: 'Yuklashlar', num: true }, { key: 'avgLoadMinutes', label: 'O‘rt. yuklash, daq', num: true }] : []), { key: 'inventoryAccuracy', label: 'Inventar aniqligi %', num: true }, { key: 'openTasks', label: 'Ochiq topshiriq', num: true }] });
} });

// ================= Admin =================
App.page('/templates', { title: 'Hujjat shablonlari', async render({ el, query }) {
  const list = await GET('/api/doc-templates'); const code = query.code || list[0]?.code;
  const t = code ? await GET(`/api/doc-templates/${code}`) : null;
  el.innerHTML = html(h`${pageHead('Hujjat shablonlari', `${App.meta?.modules?.logistics ? 'Packing List, Delivery Note, Loading Sheet…' : 'Packing List, Kirim hisoboti, QC hisoboti…'} —` + ' tashkilot talablariga mos administrator tomonidan sozlanadi. {{o‘zgaruvchi}} va {{#each ro‘yxat}} … {{/each}}')}
  <div class="grid" style="grid-template-columns:260px minmax(0,1fr)">${card('', h`<nav class="menu" style="margin:-4px -16px -16px">${list.map((x) => h`<a href="#/templates?code=${x.code}" style="${x.code === code ? 'background:var(--surface-3);font-weight:600' : ''}">${icon('doc')}${x.name}</a>`)}</nav>`)}
  ${t ? card(t.name, h`<textarea class="input mono" data-html style="min-height:420px;font-size:12px" ${can('admin.templates') ? '' : 'readonly'} aria-label="Shablon HTML">${t.html}</textarea><div style="display:flex;gap:8px;margin-top:10px">${btn('Saqlash', { cls: 'primary', attrs: 'data-save', perm: 'admin.templates' })}<span class="small muted" style="align-self:center">Oxirgi o‘zgarish: ${fmt.dt(t.updated_at)} · skript va event-handlerlar taqiqlangan</span></div>`) : ''}</div>`);
  $('[data-save]', el)?.addEventListener('click', (e) => act(e.target.closest('button'), () => PUT(`/api/doc-templates/${code}`, { html: $('[data-html]', el).value }), 'Shablon saqlandi — keyingi generatsiyalarda qo‘llanadi'));
} });
App.page('/audit', { title: 'Audit log', async render({ el, query }) {
  const rows = await GET(`/api/audit?limit=1000${query.q ? `&q=${encodeURIComponent(query.q)}` : ''}`);
  el.innerHTML = html(h`${pageHead('Audit log', 'Kim stockni o‘zgartirdi, kirim yaratdi, picking qildi, rezerv qildi, zayavka yubordi, ishlab chiqarishni boshqardi, hujjatni o‘zgartirdi — o‘chirib bo‘lmaydi')}${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows, pageSize: 50, columns: [{ key: 'created_at', label: 'Vaqt', render: (a) => fmt.dt(a.created_at) }, { key: 'username', label: 'Foydalanuvchi', render: (a) => h`<b>${a.username}</b>` }, { key: 'action', label: 'Amal', render: (a) => h`<span class="badge plain dark">${a.action}</span>` }, { key: 'entity', label: 'Obyekt', render: (a) => h`${a.entity || ''} <span class="mono small">${a.entity_id || ''}</span>` }, { key: 'details', label: 'Tafsilot', render: (a) => h`<span class="mono small" style="word-break:break-all">${(a.details || '').slice(0, 160)}</span>` }, { key: 'ip', label: 'IP', render: (a) => h`<span class="small muted">${a.ip || ''}</span>` }] });
} });
App.page('/settings', { title: 'Sozlamalar', async render({ el }) {
  const [s, backups, av] = await Promise.all([GET('/api/settings'), can('admin.backup') ? GET('/api/admin/backups') : Promise.resolve([]), GET('/api/admin/filecheck').catch(() => ({}))]);
  const superA = App.user.role === 'SUPERADMIN';
  const fields = [{ name: 'company_name', label: 'Korxona nomi', value: s.company_name, full: true }, { name: 'company_address', label: 'Manzil', value: s.company_address, full: true }, { name: 'qc_deadline_hours', label: 'QC deadline, soat', type: 'number', value: s.qc_deadline_hours }, { name: 'pick_deadline_hours', label: 'Picking deadline, soat', type: 'number', value: s.pick_deadline_hours }, { name: 'pack_deadline_hours', label: 'Packing deadline, soat', type: 'number', value: s.pack_deadline_hours }, ...(App.meta?.modules?.logistics ? [{ name: 'loading_setup_min', label: 'Yuklash tayyorgarligi, daq', type: 'number', value: s.loading_setup_min }, { name: 'loading_min_per_pallet', label: 'Yuklash me’yori, daq/pallet', type: 'number', value: s.loading_min_per_pallet }] : []), { name: 'avg_speed_kmh', label: 'O‘rtacha tezlik (ETA), km/soat', type: 'number', value: s.avg_speed_kmh }, { name: 'report_morning_hour', label: 'Ertalabki AI hisobot soati', type: 'number', value: s.report_morning_hour ?? 8, min: 0, max: 23 }, { name: 'report_evening_hour', label: 'Kechki AI hisobot soati', type: 'number', value: s.report_evening_hour ?? 22, min: 0, max: 23 }];
  const mode = superA ? await GET('/api/admin/mode').catch(() => null) : null;
  const tile = (href, ic, title, sub, show = true) => (show ? h`<a class="card set-tile" href="#${href}">${icon(ic)}<div><b>${title}</b><span>${sub}</span></div></a>` : '');
  el.innerHTML = html(h`${pageHead('Sozlamalar', 'Korxona parametrlari, me’yorlar, zaxira nusxalar, xavfsizlik')}
  <div class="set-tiles">${tile('/apikeys', 'lock', 'API kalitlari va Odoo', 'AI kaliti, Odoo ERP, kompaniya API, integratsiyalar', can('admin.apikeys'))}${tile('/teambots', 'ai', 'Telegram botlar (4 ta)', 'Ta’minot, Ombor, Ishlab chiqarish, Xulosa — AI, ovoz, 24/7', can('admin.apikeys'))}${tile('/telegram', 'send', 'Telegram bot', 'Bildirishnoma boti, ulangan chatlar')}${tile('/users', 'users', 'Adminlar va foydalanuvchilar', 'Admin qo‘shish, bo‘lim loginlari (Ombor, Ta’minot, Ishlab chiqarish)')}</div>
  ${superA ? card('🧩 Modullar', h`<label class="check"><input type="checkbox" data-mod-log ${App.meta?.modules?.logistics ? raw('checked') : ''}> <b>Logistika</b> — jo‘natma, transport, yuklash, haydovchilar, AI dispetcher, jo‘natma hisobotlari</label><p class="small muted" style="margin:8px 0 0">O‘chiq bo‘lsa — saytda umuman ko‘rinmaydi va orqa fonda ishlamaydi. Buyurtmalar Ombor bo‘limida qoladi.</p>`, { cls: 'mb' }) : ''}
  ${mode && mode.demo ? h`<div class="card" style="margin-bottom:16px;border-color:var(--warn)"><div class="card-b" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap"><div style="flex:1;min-width:260px"><b>⚠️ Tizimda demo (namunaviy) ma’lumotlar bor</b><div class="small t2">${fmt.n(mode.counts.products)} mahsulot, ${fmt.n(mode.counts.orders)} buyurtma${App.meta?.modules?.logistics ? `, ${fmt.n(mode.counts.shipments)} jo‘natma` : ''}, demo loginlar: ${(App.meta?.modules?.logistics ? mode.demoUsers : mode.demoUsers.filter((u) => u !== 'logist')).join(', ')}. Real rejimga o‘tilganda ular o‘chiriladi; super admin, adminlar, bo‘lim loginlari, API/Odoo/Telegram kalitlari saqlanadi. Oldin avtomatik zaxira olinadi.</div></div>${btn('Real rejimga o‘tish', { cls: 'danger', attrs: 'data-goreal', ico: 'refresh' })}</div></div>` : ''}
  <div class="grid g2">${card('Korxona va me’yorlar', h`<form data-f>${raw(formHtml(fields))}<div style="margin-top:14px">${btn('Saqlash', { cls: 'primary', attrs: 'data-save', perm: 'admin.settings' })}</div></form>`)}
  <div class="grid" style="align-content:start">${card('Ma’lumotlar bazasi zaxirasi', h`<p class="small t2" style="margin-top:0">Avtomatik kunlik backup (SQLite VACUUM INTO) + qo‘lda.</p>${btn('Hozir backup olish', { ico: 'download', attrs: 'data-bk', perm: 'admin.backup' })}${raw(tableHtml([{ label: 'Fayl', render: (b) => h`<span class="mono small">${b.file}</span>` }, { label: 'Hajm', render: (b) => `${(b.size / 1048576).toFixed(2)} MB` }, { label: 'Sana', render: (b) => fmt.dt(b.at) }], backups.slice(0, 8), 'Backup yo‘q'))}`)}
  ${card('Xavfsizlik', h`<ul class="small t2" style="margin:0;padding-left:18px;line-height:1.8"><li>Parollar scrypt bilan xeshlangan, 5 xato urinishda 15 daq blok</li><li>HttpOnly + SameSite=Strict sessiya, CSRF token, Origin tekshiruvi</li><li>RBAC — har bir API amal ruxsat bilan tekshiriladi</li><li>Rate limiting, xavfsiz sarlavhalar (CSP, HSTS, X-Frame-Options)</li><li>AI, Telegram va integratsiya kalitlari serverda AES-256-GCM bilan shifrlangan — brauzerga qaytarilmaydi</li><li>Adminlar va API kalitlari faqat super admin tomonidan boshqariladi</li><li>Inventar tranzaksiyalari va audit log o‘zgartirilmaydi/o‘chirilmaydi (DB trigger)</li><li>Fayllar: faqat ${av.allowed || 'PDF, rasm, DOCX, XLSX, CSV, TXT, DWG'}; ichki format tekshiriladi, dastur/makros/PDF-skript rad etiladi</li><li>Antivirus: <b>${av.scanner ? `${av.scanner} — har bir fayl skanerlanadi` : av.mode === 'off' ? 'o‘chirilgan (ANTIVIRUS=off)' : 'topilmadi — faqat format tekshiruvi'}</b></li></ul>`)}
  ${superA ? card('Boshqa kompyuterga ko‘chirish', h`<p class="small t2" style="margin-top:0">Barcha ma’lumotlar (ombor, buyurtmalar, foydalanuvchilar, hujjat fayllari, API kalitlari) bitta <b>.sfwms</b> faylga yig‘iladi va siz bergan parol bilan shifrlanadi. Yangi noutbukda dasturni ishga tushiring → super admin → shu yerda “Import”.</p><div class="toolbar">${btn('Eksport (.sfwms yuklab olish)', { cls: 'primary', ico: 'download', attrs: 'data-exp' })}${btn('Import (boshqa kompyuterdan)', { ico: 'in', attrs: 'data-imp' })}</div><p class="small muted" style="margin-bottom:0">Import oldidan paket tekshiriladi: parol, butunlik, baza tuzilmasi va har bir fayl antivirus orqali. Joriy ma’lumotlarning zaxira nusxasi avtomatik olinadi.</p>`) : ''}
  ${card('Parolni o‘zgartirish', h`${btn('Parolni o‘zgartirish', { ico: 'lock', attrs: 'data-pw' })}`)}</div></div>`);
  $('[data-save]', el)?.addEventListener('click', async (e) => { try { const d = await readForm($('[data-f]', el), fields); await act(e.target.closest('button'), () => PUT('/api/settings', d), 'Sozlamalar saqlandi'); } catch (err) { toast(err.message, 'err'); } });
  $('[data-bk]', el)?.addEventListener('click', (e) => act(e.target.closest('button'), () => POST('/api/admin/backup'), (r) => `Backup: ${r.file}`).then(App.refresh));
  $('[data-pw]', el).addEventListener('click', () => App.changePassword());
  if (can('admin.users')) {
    const box = document.createElement('div'); box.style.marginTop = '16px'; el.appendChild(box);
    const drawDiag = async () => {
      const d = await GET('/api/diagnostics').catch((e) => ({ error: e.message }));
      if (d.error) { box.innerHTML = html(card('Diagnostika', h`<div class="muted">${d.error}</div>`)); return; }
      const errs = [...d.clientErrors.map((x) => ({ ...x, src: 'brauzer' })), ...d.serverErrors.map((x) => ({ ...x, src: 'server', page: x.path, api: `${x.method} ${x.path}`, status: 500, username: '' }))].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 40);
      box.innerHTML = html(card('🩺 Diagnostika', h`${dl([['Server', `Node ${d.node} · ${d.platform}${d.serverless ? ' · Vercel (serverless)' : ''} · ishlayapti ${Math.round(d.uptimeSec / 60)} daq · ${d.memoryMb} MB`], ['Baza', `${d.sqlite} · ${d.dbSize ? `${(d.dbSize / 1048576).toFixed(2)} MB` : '—'} · tekshiruv: ${d.integrity}`], ['AI', d.ai.configured ? `${d.ai.provider} · ${d.ai.model}${d.ai.lastError ? ` · oxirgi xato: ${d.ai.lastError}` : ''}` : 'kalit yo‘q (bazaga asoslangan tahlil ishlaydi)'], ['Odoo', d.odoo ? `${d.odoo.status || 'sinxronlanmagan'} · ${d.odoo.lastSyncAt ? fmt.dt(d.odoo.lastSyncAt) : '—'}${d.odoo.error ? ` · ${d.odoo.error}` : ''}` : 'ulanmagan']])}
        <h4 style="margin:14px 0 6px">So‘nggi xatolar (${errs.length})</h4>${raw(tableHtml([{ label: 'Vaqt', render: (x) => fmt.dt(x.created_at) }, { label: 'Manba', render: (x) => x.src }, { label: 'Foydalanuvchi', render: (x) => x.username || '—' }, { label: 'Sahifa / API', render: (x) => h`<span class="mono small">${x.page || ''}${x.api ? h`<br>${x.api}` : ''}</span>` }, { label: 'Xato', render: (x) => h`${x.status != null ? h`<span class="badge crit">${x.status}</span> ` : ''}${x.message}` }], errs, 'Xato qayd etilmagan ✅'))}
        <div class="toolbar" style="margin-top:10px">${btn('Yangilash', { attrs: 'data-dref', ico: 'refresh' })}${errs.length ? btn('Jurnalni tozalash', { attrs: 'data-dclr' }) : ''}</div>`, { sub: 'Sahifa yuklanmasa, sababi shu yerda ko‘rinadi' }));
      $('[data-dref]', box).addEventListener('click', drawDiag);
      $('[data-dclr]', box)?.addEventListener('click', async () => { await DEL('/api/diagnostics/errors'); drawDiag(); });
    };
    drawDiag();
  }
  $('[data-mod-log]', el)?.addEventListener('change', async (e) => { try { await PUT('/api/settings', { module_logistics: e.target.checked }); toast(e.target.checked ? 'Logistika yoqildi' : 'Logistika yashirildi', 'ok'); setTimeout(() => location.reload(), 700); } catch (err) { e.target.checked = !e.target.checked; toast(err.message, 'err'); } });
  $('[data-goreal]', el)?.addEventListener('click', async () => {
    const r = await formModal({ title: 'Real rejimga o‘tish', submitText: 'Real rejimga o‘tish', intro: h`<div class="callout warn" style="margin-bottom:12px">${icon('alert')}<div>Barcha demo ma’lumotlar (mahsulotlar, buyurtmalar, demo loginlar…) o‘chiriladi. Zaxira nusxa <span class="mono">data/backups/pre-real-*.db</span> ga saqlanadi. Odoo ulangan bo‘lsa, real ma’lumot darhol tortiladi. Keyin qayta kirasiz.</div></div>`,
      fields: [{ name: 'confirm', label: 'Tasdiqlash uchun REAL deb yozing', required: true, full: true }], onSubmit: (d) => POST('/api/admin/go-real', d) });
    if (r) { toast(`Real rejim yoqildi. Zaxira: ${r.backup}`, 'ok'); setTimeout(() => location.reload(), 1800); }
  });
  $('[data-exp]', el)?.addEventListener('click', () => App.transferExport());
  $('[data-imp]', el)?.addEventListener('click', () => App.transferImport());
} });
App.changePassword = async () => { const r = await formModal({ title: 'Parolni o‘zgartirish', fields: [{ name: 'oldPassword', label: 'Joriy parol', type: 'password', required: true, full: true }, { name: 'newPassword', label: 'Yangi parol (≥8, harf va raqam)', type: 'password', required: true, full: true }], onSubmit: (d) => POST('/api/auth/password', d) }); if (r) toast('Parol o‘zgartirildi. Boshqa sessiyalar yopildi.', 'ok'); };

// ---------- boshqa kompyuterga ko‘chirish ----------
App.transferExport = async () => {
  await formModal({ title: 'Eksport — ko‘chirish paketi', submitText: 'Yuklab olish',
    intro: h`<div class="callout" style="margin-bottom:12px">${icon('lock')}<div>Paket shu parol bilan shifrlanadi. Parolni eslab qoling — yangi kompyuterda import uchun kerak. Faylni faqat o‘zingizga tegishli fleshka/diskda saqlang.</div></div>`,
    fields: [{ name: 'password', label: 'Paket paroli (kamida 8 belgi)', type: 'password', required: true, full: true }, { name: 'password2', label: 'Parolni takrorlang', type: 'password', required: true, full: true }],
    onSubmit: async (d) => {
      if (d.password !== d.password2) throw new Error('Parollar mos emas');
      const res = await fetch('/api/admin/transfer/export', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': App.csrf || '' }, body: JSON.stringify({ password: d.password }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `Xatolik (${res.status})`); }
      const blob = await res.blob(); const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'solar-wms.sfwms';
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast(`${name} tayyor (${(blob.size / 1048576).toFixed(2)} MB)`, 'ok'); return true;
    } });
};
App.transferImport = async () => {
  let payload = null;
  const check = await formModal({ title: 'Import — boshqa kompyuterdan', submitText: 'Tekshirish',
    intro: h`<div class="callout warn" style="margin-bottom:12px">${icon('alert')}<div>Import joriy kompyuterdagi <b>barcha</b> ma’lumotlarni paketdagilar bilan almashtiradi (oldin avtomatik zaxira olinadi). Keyin eski kompyuterdagi login/parol bilan kirasiz.</div></div>`,
    fields: [{ name: 'file', label: 'Paket fayli (.sfwms)', type: 'file', accept: '.sfwms', required: true, full: true }, { name: 'password', label: 'Paket paroli', type: 'password', required: true, full: true }],
    onSubmit: async (d) => { if (!d.file) throw new Error('Faylni tanlang'); payload = { file: { base64: d.file.base64 }, password: d.password }; return POST('/api/admin/transfer/import', { ...payload, dryRun: true }); } });
  if (!check) return;
  const rows = Object.values(check.counts || {}).map((c) => h`<tr><td>${c.label}</td><td class="num">${fmt.n(c.n)}</td></tr>`);
  const ok = await modal({ title: 'Paket tekshirildi ✓', submitText: 'Import qilish', submitClass: 'danger',
    body: h`<p style="margin-top:0">Manba: <b>${check.source || '—'}</b> · eksport: ${fmt.dt(check.exportedAt)} (${check.exportedBy || '—'})</p>
      <table class="t"><tbody>${rows}</tbody></table>
      <p class="small">🛡 ${fmt.n(check.filesScanned)} ta fayl tekshirildi — ${check.antivirus ? `${check.antivirus} bilan skanerlandi` : 'format tekshiruvi (antivirus topilmadi)'}, xavfli fayl yo‘q.${check.secrets?.length ? ` Kalitlar: ${check.secrets.join(', ')}.` : ''}${check.missingFiles?.length ? ` ⚠️ Eski kompyuterda topilmagan fayllar: ${check.missingFiles.length}.` : ''}</p>`,
    onSubmit: () => POST('/api/admin/transfer/import', payload) });
  if (!ok) return;
  toast(`Import tugadi. Zaxira: ${ok.safetyBackup}. Endi eski kompyuterdagi login/parol bilan kiring.`, 'ok');
  setTimeout(() => location.reload(), 2500);
};
