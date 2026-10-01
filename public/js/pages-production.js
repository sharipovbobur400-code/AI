/* Ishlab chiqarish: panel, buyurtmalar (reja → material berish → jarayon → natija), mahsulot tarkibi (BOM), material ehtiyoji (MRP) */
'use strict';

const PST = { PLANNED: ['Rejada', 'dark'], RELEASED: ['Material berildi', 'blue'], IN_PROGRESS: ['Jarayonda', 'warn'], DONE: ['Bajarildi', 'good'], CANCELLED: ['Bekor qilingan', 'dark'] };
const pBadge = (s) => { const [l, c] = PST[s] || [s, 'dark']; return h`<span class="badge ${c}">${l}</span>`; };
const PRI = { URGENT: ['Shoshilinch', 'crit'], HIGH: ['Yuqori', 'warn'], NORMAL: ['Oddiy', 'dark'], LOW: ['Past', 'dark'] };
const priBadge = (p) => { const [l, c] = PRI[p] || [p, 'dark']; return h`<span class="badge plain ${c}">${l}</span>`; };
const progress = (o) => { const pct = Math.min(100, Math.round(((o.good_qty || 0) / (o.qty || 1)) * 100)); return h`<div class="cov"><div class="bar ${pct >= 100 ? 'good' : o.late ? 'crit' : ''}"><i style="width:${pct}%"></i></div><span class="small num">${fmt.n(o.good_qty)} / ${fmt.n(o.qty)}</span></div>`; };
const producible = () => (App.meta.products || []).filter((p) => ['FINISHED', 'WIP'].includes(p.category));
const components = () => (App.meta.products || []).filter((p) => ['RAW', 'MATERIAL', 'PACKAGING', 'WIP'].includes(p.category));
const PROD_LIVE = ['PRODUCTION_CREATED', 'PRODUCTION_STATUS', 'PRODUCTION_OUTPUT', 'PRODUCTION_BOM', 'MATERIAL_RECEIVED', 'STOCK_CHANGED', 'ORDER_CREATED'];

/** Yangi ishlab chiqarish buyurtmasi (taklifdan yoki qo‘lda). */
App.newProductionOrder = async (preset = {}) => {
  const r = await formModal({ title: '🏭 Yangi ishlab chiqarish buyurtmasi', submitText: 'Yaratish',
    intro: h`<div class="callout ai" style="margin-bottom:12px">${icon('ai')}<div>Materiallar mahsulot tarkibi (BOM) bo‘yicha avtomatik hisoblanadi. Keyingi qadam — “Materiallarni berish” (ombordan chiqim).</div></div>`,
    fields: [{ name: 'productId', label: 'Mahsulot', type: 'select', required: true, full: true, value: preset.productId, options: producible().map((p) => [p.id, `${p.sku} — ${p.name}`]) },
      { name: 'qty', label: 'Miqdor', type: 'number', required: true, value: preset.qty, min: 1 }, { name: 'priority', label: 'Muhimlik', type: 'select', value: preset.priority || 'NORMAL', options: Object.entries(PRI).map(([k, v]) => [k, v[0]]) },
      { name: 'plannedStart', label: 'Boshlanish', type: 'datetime-local' }, { name: 'plannedEnd', label: 'Tugash (muddat)', type: 'datetime-local', value: preset.due ? String(preset.due).slice(0, 16) : '' },
      { name: 'line', label: 'Liniya / sex', placeholder: 'masalan: 1-liniya' }, { name: 'notes', label: 'Izoh', full: true }],
    onSubmit: (d) => POST('/api/production/orders', { ...d, plannedStart: d.plannedStart || undefined, plannedEnd: d.plannedEnd || undefined }) });
  if (r) { toast(`${r.poNo} yaratildi${r.warning ? ` — ${r.warning}` : ` (${r.materials} ta material)`}`, r.warning ? 'warn' : 'ok'); App.refresh(); App.openProductionOrder(r.id); }
};

/** Buyurtma kartasi: materiallar, natijalar, amallar. */
App.openProductionOrder = async (id) => {
  const d = await GET(`/api/production/orders/${id}`); const o = d.order;
  const actions = [];
  if (['PLANNED', 'RELEASED', 'IN_PROGRESS'].includes(o.status) && d.materials.some((m) => m.remaining > 0) && can('production.manage')) actions.push(btn('Materiallarni berish', { cls: 'primary', ico: 'out', attrs: 'data-rel' }));
  if (['PLANNED', 'RELEASED'].includes(o.status) && can('production.report')) actions.push(btn('Boshlash', { ico: 'arrow', attrs: 'data-start' }));
  if (['PLANNED', 'RELEASED', 'IN_PROGRESS'].includes(o.status) && can('production.report')) actions.push(btn('Natija kiritish', { cls: 'accent', ico: 'in', attrs: 'data-rep' }));
  if (['RELEASED', 'IN_PROGRESS'].includes(o.status) && can('production.manage')) actions.push(btn('Yakunlash', { cls: 'good', ico: 'check', attrs: 'data-done' }));
  if (['PLANNED', 'RELEASED'].includes(o.status) && can('production.manage')) actions.push(btn('Bekor qilish', { cls: 'danger', attrs: 'data-cancel' }));
  const short = d.materials.filter((m) => m.shortfall > 0);
  modal({ title: `${o.po_no} — ${o.name}`, size: 'wide', footer: h`${actions}`,
    body: h`<div class="stepper" style="margin-bottom:14px">${['PLANNED', 'RELEASED', 'IN_PROGRESS', 'DONE'].map((s, i, arr) => { const cur = arr.indexOf(o.status); return h`<div class="step ${o.status === 'CANCELLED' ? '' : i < cur ? 'done' : i === cur ? 'cur' : ''}"><i></i>${PST[s][0]}</div>`; })}</div>
      <div class="grid g2">${card('', dl([['Holat', h`${pBadge(o.status)} ${o.late ? h`<span class="badge crit">muddati o‘tgan</span>` : ''}`], ['Mahsulot', h`<b>${o.sku}</b> — ${o.name}`], ['Bajarilishi', progress(o)],
        ['Yaroqli / rework / brak', `${fmt.n(o.good_qty)} / ${fmt.n(o.rework_qty)} / ${fmt.n(o.reject_qty)} ${o.unit}`], ['Muddat', `${fmt.dt(o.planned_start)} → ${fmt.dt(o.planned_end)}`], ['Liniya', o.line], ['Muhimlik', priBadge(o.priority)], ['Mijoz buyurtmasi', o.sales_order], ['Izoh', o.notes]]))}
      ${card(`Materiallar (${d.materials.length})`, d.materials.length ? raw(tableHtml([{ label: 'Material', render: (m) => h`<b>${m.sku}</b><div class="small muted">${m.name}</div>` },
        { label: 'Kerak', render: (m) => `${fmt.n(m.required_qty)} ${m.unit}` }, { label: 'Berildi', render: (m) => fmt.n(m.issued_qty) }, { label: 'Omborda', render: (m) => fmt.n(m.free) },
        { label: '', render: (m) => (m.remaining <= 0 ? h`<span class="badge good">berildi</span>` : m.shortfall > 0 ? h`<span class="badge crit">−${fmt.n(m.shortfall)}</span>` : h`<span class="badge blue">tayyor</span>`) }], d.materials)) : h`<div class="callout warn">${icon('alert')}<div>Mahsulot tarkibi (BOM) kiritilmagan. <a href="#/bom?product=${o.product_id}">Tarkibni kiriting</a></div></div>`, { flush: !!d.materials.length })}</div>
      ${short.length ? h`<div class="callout crit" style="margin-top:12px">${icon('alert')}<div>${short.length} ta material yetishmaydi: ${short.map((m) => `${m.sku} (${fmt.n(m.shortfall)} ${m.unit})`).join(', ')}. <a href="#/mrp">Material ehtiyoji → Ta’minotga zayavka</a></div></div>` : ''}
      ${d.outputs.length ? h`<h4 style="margin:16px 0 6px">Natijalar</h4>${raw(tableHtml([{ label: 'Vaqt', render: (x) => fmt.dt(x.created_at) }, { label: 'Turi', render: (x) => ({ RECEIVE: '✅ Yaroqli', REWORK: '🛠 Rework', REJECT: '🗑 Brak' }[x.type] || x.type) }, { label: 'Miqdor', render: (x) => fmt.n(x.qty) }, { label: 'Kim', render: (x) => x.full_name || '—' }], d.outputs))}` : ''}`,
    onOpen: (bg, close) => {
      const after = (msg) => (r) => { toast(typeof msg === 'function' ? msg(r) : msg, 'ok'); close(); App.refresh(); App.openProductionOrder(id); };
      $('[data-rel]', bg)?.addEventListener('click', async (e) => {
        const partial = short.length ? await confirmBox('Material yetishmaydi', `${short.length} ta material omborda yetarli emas. Borini berishni xohlaysizmi? (qolgani kelgach yana berasiz)`, 'Borini berish') : false;
        if (short.length && !partial) return;
        act(e.target.closest('button'), () => POST(`/api/production/orders/${id}/release`, { partial }), (r) => `${r.issued} ta material ombordan berildi`).then(after('Materiallar berildi')).catch(() => {});
      });
      $('[data-start]', bg)?.addEventListener('click', (e) => act(e.target.closest('button'), () => POST(`/api/production/orders/${id}/start`)).then(after('Jarayon boshlandi')).catch(() => {}));
      $('[data-done]', bg)?.addEventListener('click', async (e) => { if (await confirmBox('Yakunlash', `${o.po_no} yakunlansinmi? (${fmt.n(o.good_qty)} / ${fmt.n(o.qty)} bajarildi)`, 'Yakunlash')) act(e.target.closest('button'), () => POST(`/api/production/orders/${id}/complete`)).then(after('Buyurtma yakunlandi')).catch(() => {}); });
      $('[data-cancel]', bg)?.addEventListener('click', async () => { const r = await formModal({ title: 'Bekor qilish', fields: [{ name: 'reason', label: 'Sabab', required: true, full: true }], onSubmit: (x) => POST(`/api/production/orders/${id}/cancel`, x) }); if (r) after('Bekor qilindi')(r); });
      $('[data-rep]', bg)?.addEventListener('click', async () => {
        const left = Math.max(0, o.qty - o.good_qty);
        const r = await formModal({ title: `Natija — ${o.po_no}`, intro: h`<p class="small t2" style="margin-top:0">Yaroqli mahsulot omborga kirim qilinadi (ishlab chiqarishdan), rework va brak — tegishli zonalarga.</p>`,
          fields: [{ name: 'good', label: `Yaroqli (${o.unit})`, type: 'number', value: left, min: 0 }, { name: 'rework', label: 'Rework', type: 'number', value: 0, min: 0 }, { name: 'reject', label: 'Brak', type: 'number', value: 0, min: 0 }, { name: 'batchNo', label: 'Partiya raqami (ixtiyoriy)' }],
          onSubmit: (x) => POST(`/api/production/orders/${id}/report`, x) });
        if (r) after(`Natija qayd etildi${r.receiving ? ` · kirim ${r.receiving}` : ''}${r.status === 'DONE' ? ' · buyurtma bajarildi ✅' : ''}`)(r);
      });
    } });
};

// ---------------- panel ----------------
App.page('/production', { title: 'Ishlab chiqarish', live: PROD_LIVE, async render({ el }) {
  const d = await GET('/api/production/overview');
  const maxDay = Math.max(1, ...d.daily.map((x) => x.good || 0));
  el.innerHTML = html(h`${pageHead('Ishlab chiqarish paneli', 'Reja, jarayon, natija, materiallar — real vaqtda', h`${btn('+ Ishlab chiqarish buyurtmasi', { cls: 'primary', ico: 'plus', attrs: 'data-new', perm: 'production.manage' })}${btn('Material ehtiyoji', { ico: 'layers', attrs: 'data-go="/mrp"' })}`)}
    <div class="kpis">
      ${kpi({ label: 'Bugun ishlab chiqarildi', value: fmt.n(d.today.good), sub: `${d.today.receipts} ta natija · brak ${fmt.n(d.today.reject)}`, ico: 'factory', tone: 'good' })}
      ${kpi({ label: '7 kunda', value: fmt.n(d.week.good), sub: `nuqson: ${d.week.defectPct}%`, ico: 'chart', tone: d.week.defectPct > 5 ? 'warn' : 'blue' })}
      ${kpi({ label: 'Ochiq buyurtmalar', value: d.orders.open, sub: `jarayonda ${d.orders.byStatus.IN_PROGRESS || 0} · rejada ${d.orders.byStatus.PLANNED || 0}`, ico: 'clip', tone: 'blue', href: '#/production-orders' })}
      ${kpi({ label: 'Muddati o‘tgan', value: d.orders.late, sub: 'ochiq buyurtmalar', ico: 'clock', tone: d.orders.late ? 'crit' : 'good', href: '#/production-orders' })}
      ${kpi({ label: 'Material yetishmaydi', value: d.materials.short, sub: `kelmoqda: ${d.materials.inbound}`, ico: 'alert', tone: d.materials.short ? 'crit' : 'good', href: '#/mrp' })}
      ${kpi({ label: 'Tarkib (BOM) kiritilgan', value: `${d.bomCoverage.withBom} / ${d.bomCoverage.products}`, sub: 'tayyor va yarim tayyor mahsulot', ico: 'layers', tone: d.bomCoverage.withBom < d.bomCoverage.products ? 'warn' : 'good', href: '#/bom' })}
    </div>
    <div class="grid g-main">
      ${card('🎯 Reja: mijoz buyurtmalari uchun ishlab chiqarish kerak', d.suggestions.length ? raw(tableHtml([{ label: 'Mahsulot', render: (s) => h`<b>${s.sku}</b><div class="small muted">${s.name}</div>` },
        { label: 'Talab', render: (s) => fmt.n(s.demand) }, { label: 'Omborda', render: (s) => fmt.n(s.stock) }, { label: 'Rejada', render: (s) => fmt.n(s.planned) }, { label: 'Ishlab chiqarish', render: (s) => h`<b style="color:var(--crit-ink)">${fmt.n(s.toMake)}</b> ${s.unit}` },
        { label: 'Muddat', render: (s) => fmt.d(s.due) }, { label: '', render: (s) => (can('production.manage') ? h`<button class="btn sm primary" data-plan="${s.productId}" data-qty="${s.toMake}" data-due="${s.due || ''}">Buyurtma</button>${s.hasBom ? '' : h` <span class="badge warn" title="Tarkib kiritilmagan">BOM yo‘q</span>`}` : '') }], d.suggestions)) : h`<div class="empty">${icon('check')}Barcha mijoz buyurtmalari qoldiq va reja bilan qoplangan</div>`, { flush: !!d.suggestions.length })}
      ${card('📈 14 kunlik natija', d.daily.length ? h`<div style="display:flex;align-items:flex-end;gap:6px;height:160px;padding-top:8px">${d.daily.map((x) => h`<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px" title="${x.d}: ${fmt.n(x.good)} yaroqli, ${fmt.n(x.reject)} brak"><div style="width:100%;max-width:26px;height:${Math.max(4, Math.round((x.good / maxDay) * 120))}px;border-radius:7px 7px 3px 3px;background:var(--grad-primary, var(--primary))"></div><span class="small muted">${x.d.slice(8, 10)}</span></div>`)}</div>` : h`<div class="empty">${icon('chart')}Hali natija yo‘q</div>`)}
    </div>
    <div class="grid g2" style="margin-top:16px">
      ${card('⚙️ Faol buyurtmalar', d.active.length ? raw(tableHtml([{ label: 'Buyurtma', render: (o) => h`<a href="#" data-open="${o.id}"><b>${o.po_no}</b></a><div class="small muted">${o.name}</div>` }, { label: 'Holat', render: (o) => pBadge(o.status) }, { label: 'Bajarilishi', render: (o) => progress(o) }, { label: 'Muddat', render: (o) => h`${fmt.dt(o.planned_end)}${o.late ? h` <span class="badge crit">kechikdi</span>` : ''}` }], d.active)) : h`<div class="empty">${icon('factory')}Ochiq buyurtma yo‘q</div>`, { flush: !!d.active.length })}
      ${card('🧱 Materiallar holati', d.materials.list.length ? raw(tableHtml([{ label: 'Material', render: (m) => h`<b>${m.sku}</b><div class="small muted">${m.name}</div>` }, { label: 'Kerak', render: (m) => `${fmt.n(m.need)} ${m.unit}` }, { label: 'Omborda', render: (m) => fmt.n(m.free) }, { label: 'Holat', render: (m) => (m.status === 'SHORT' ? h`<span class="badge crit">−${fmt.n(m.shortfall)}</span>` : m.status === 'INBOUND' ? h`<span class="badge warn">kelmoqda</span>` : h`<span class="badge good">yetarli</span>`) }], d.materials.list)) : h`<div class="empty">${icon('check')}Ochiq buyurtmalar uchun material kerak emas</div>`, { flush: !!d.materials.list.length })}
    </div>
    <div class="grid g2" style="margin-top:16px">
      ${card('🏭 Oxirgi natijalar', d.recent.length ? raw(tableHtml([{ label: 'Kirim', render: (r) => h`<b>${r.rcv_no}</b><div class="small muted">${r.production_order || ''}</div>` }, { label: 'Mahsulot', render: (r) => r.name }, { label: 'Yaroqli', render: (r) => `${fmt.n(r.qty_received)} ${r.unit}` }, { label: 'Brak / rework', render: (r) => `${fmt.n(r.reject_qty || 0)} / ${fmt.n(r.rework_qty || 0)}` }, { label: 'Vaqt', render: (r) => fmt.rel(r.created_at) }], d.recent)) : h`<div class="empty">${icon('inbox')}Hali natija kiritilmagan</div>`, { flush: !!d.recent.length })}
      ${card('🔧 Yarim tayyor mahsulot (WIP)', d.wip.length ? raw(tableHtml([{ label: 'Mahsulot', render: (w) => h`<b>${w.sku}</b> — ${w.name}` }, { label: 'Qoldiq', render: (w) => `${fmt.n(w.qty)} ${w.unit}` }], d.wip)) : h`<div class="empty">${icon('layers')}Yarim tayyor mahsulot yo‘q</div>`, { flush: !!d.wip.length })}
    </div>`);
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-new]')) App.newProductionOrder();
    const g = e.target.closest('[data-go]'); if (g) location.hash = `#${g.dataset.go}`;
    const p = e.target.closest('[data-plan]'); if (p) App.newProductionOrder({ productId: Number(p.dataset.plan), qty: Math.ceil(Number(p.dataset.qty)), due: p.dataset.due, priority: 'HIGH' });
    const o = e.target.closest('[data-open]'); if (o) { e.preventDefault(); App.openProductionOrder(Number(o.dataset.open)); }
  });
} });

// ---------------- buyurtmalar ----------------
App.page('/production-orders', { title: 'Ishlab chiqarish buyurtmalari', live: PROD_LIVE, async render({ el, query }) {
  const rows = await GET(`/api/production/orders${query.all ? '?all=1' : ''}`);
  el.innerHTML = html(h`${pageHead('Ishlab chiqarish buyurtmalari', 'Reja → material berish → jarayon → natija (ombor kirimi)', btn('+ Yangi buyurtma', { cls: 'primary', ico: 'plus', attrs: 'data-new', perm: 'production.manage' }))}
    <div class="tabs"><a href="#/production-orders" class="${!query.all ? 'active' : ''}">Faol va oxirgi 7 kun</a><a href="#/production-orders?all=1" class="${query.all ? 'active' : ''}">Hammasi</a></div>
    ${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows, empty: 'Ishlab chiqarish buyurtmasi yo‘q — “+ Yangi buyurtma” yoki Ishlab chiqarish panelidagi rejadan yarating', searchKeys: ['po_no', 'sku', 'name', 'line', 'status', 'sales_order'],
    onRow: (o) => App.openProductionOrder(o.id), rowClass: (o) => (o.late ? 'hl' : ''),
    columns: [{ key: 'po_no', label: 'Buyurtma', render: (o) => h`<b>${o.po_no}</b>${o.sales_order ? h`<div class="small muted">${o.sales_order}</div>` : ''}` }, { key: 'name', label: 'Mahsulot', render: (o) => h`<b>${o.sku}</b><div class="small muted">${o.name}</div>` },
      { key: 'status', label: 'Holat', render: (o) => pBadge(o.status) }, { key: 'priority', label: 'Muhimlik', render: (o) => priBadge(o.priority) }, { label: 'Bajarilishi', sort: false, render: (o) => progress(o) },
      { key: 'planned_end', label: 'Muddat', render: (o) => h`${fmt.dt(o.planned_end)}${o.late ? h` <span class="badge crit">kechikdi</span>` : ''}` }, { key: 'line', label: 'Liniya' }, { key: 'materials', label: 'Materiallar', num: true }] });
  $('[data-new]', el)?.addEventListener('click', () => App.newProductionOrder());
} });

// ---------------- mahsulot tarkibi ----------------
App.page('/bom', { title: 'Mahsulot tarkibi (BOM)', live: ['PRODUCTION_BOM', 'PRODUCT_CHANGED'], async render({ el, query }) {
  const list = await GET('/api/production/bom');
  const sel = Number(query.product) || list[0]?.id;
  const cur = sel ? await GET(`/api/production/bom/${sel}`) : null;
  const items = cur ? cur.items.map((i) => ({ componentId: i.component_id, qtyPerUnit: i.qty_per_unit, scrapPct: i.scrap_pct || 0, note: i.note || '' })) : [];
  const comps = components().filter((c) => c.id !== sel);
  const rowHtml = (it, i) => `<tr><td><select class="input" data-f="componentId" data-i="${i}">${comps.map((c) => `<option value="${c.id}" ${c.id === Number(it.componentId) ? 'selected' : ''}>${esc(c.sku)} — ${esc(c.name)} (${esc(c.unit)})</option>`).join('')}</select></td>
    <td><input class="input num" type="number" step="any" min="0" data-f="qtyPerUnit" data-i="${i}" value="${esc(it.qtyPerUnit)}"></td><td><input class="input num" type="number" step="any" min="0" max="50" data-f="scrapPct" data-i="${i}" value="${esc(it.scrapPct)}"></td>
    <td><input class="input" data-f="note" data-i="${i}" value="${esc(it.note)}"></td><td><button class="btn sm danger" data-del="${i}" aria-label="O‘chirish">✕</button></td></tr>`;
  const editable = can('production.manage');
  el.innerHTML = html(h`${pageHead('Mahsulot tarkibi (BOM)', '1 dona tayyor mahsulot uchun qaysi materiallar qancha sarflanadi — ishlab chiqarish buyurtmasi va material ehtiyoji shu asosda hisoblanadi')}
    <div class="grid" style="grid-template-columns:minmax(220px,300px) minmax(0,1fr)">
      ${card('Mahsulotlar', raw(`<div class="list">${list.map((p) => `<a href="#/bom?product=${p.id}" class="search-row ${p.id === sel ? 'sel' : ''}" style="display:flex;justify-content:space-between;gap:8px;padding:9px 14px;border-top:1px solid var(--border);color:var(--text);text-decoration:none;${p.id === sel ? 'background:var(--primary-soft);font-weight:600' : ''}"><span><b>${esc(p.sku)}</b><br><span class="small muted">${esc(p.name)}</span></span><span class="badge ${p.components ? 'good' : 'warn'} plain">${p.components || 'yo‘q'}</span></a>`).join('') || '<div class="empty">Tayyor / yarim tayyor mahsulot yo‘q</div>'}</div>`), { flush: true })}
      ${cur ? card(`${cur.product.sku} — ${cur.product.name}`, raw(`<div class="table-wrap"><table class="t"><thead><tr><th>Komponent</th><th style="width:130px">1 dona uchun</th><th style="width:110px">Chiqindi %</th><th>Izoh</th><th></th></tr></thead><tbody data-rows>${items.map(rowHtml).join('')}</tbody></table></div>
        ${items.length ? '' : '<div class="empty" data-emptyrow>Tarkib kiritilmagan — “+ Komponent” bosing</div>'}
        ${editable ? `<div class="toolbar" style="padding:12px 14px;margin:0">${html(btn('+ Komponent', { attrs: 'data-add', ico: 'plus' }))}${html(btn('Saqlash', { cls: 'primary', attrs: 'data-save' }))}<span class="small muted">Masalan: 1 ta quyosh paneli = 1 dona shisha + 1.2 kg ramka + …</span></div>` : ''}`), { flush: true }) : card('', h`<div class="empty">${icon('layers')}Mahsulot tanlang</div>`)}
    </div>`);
  if (!cur || !editable) return;
  const body = $('[data-rows]', el);
  const sync = () => { $$('[data-f]', body).forEach((inp) => { items[Number(inp.dataset.i)][inp.dataset.f] = inp.value; }); };
  const redraw = () => { body.innerHTML = items.map(rowHtml).join(''); $('[data-emptyrow]', el)?.remove(); };
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-add]')) { sync(); if (!comps.length) return toast('Komponent bo‘ladigan mahsulot (xomashyo / material) yo‘q', 'warn'); items.push({ componentId: comps.find((c) => !items.some((i) => Number(i.componentId) === c.id))?.id || comps[0].id, qtyPerUnit: 1, scrapPct: 0, note: '' }); redraw(); }
    const d = e.target.closest('[data-del]'); if (d) { sync(); items.splice(Number(d.dataset.del), 1); redraw(); }
    const s = e.target.closest('[data-save]'); if (s) { sync(); await act(s, () => PUT(`/api/production/bom/${sel}`, { items: items.map((i) => ({ componentId: Number(i.componentId), qtyPerUnit: Number(i.qtyPerUnit), scrapPct: Number(i.scrapPct || 0), note: i.note })) }), (r) => `Tarkib saqlandi (${r.components} ta komponent)`).catch(() => {}); App.refresh(); }
  });
} });

// ---------------- material ehtiyoji ----------------
App.page('/mrp', { title: 'Material ehtiyoji', live: PROD_LIVE, async render({ el }) {
  const rows = await GET('/api/production/mrp');
  const short = rows.filter((r) => r.status === 'SHORT');
  el.innerHTML = html(h`${pageHead('Material ehtiyoji (MRP)', 'Ochiq ishlab chiqarish buyurtmalari uchun hali berilmagan materiallar va ombor qoldig‘i', short.length ? btn(`Ta’minotga zayavka (${short.length})`, { cls: 'accent', ico: 'clip', attrs: 'data-req', perm: 'production.manage' }) : '')}
    <div class="kpis">${kpi({ label: 'Materiallar', value: rows.length, ico: 'layers', tone: 'blue' })}${kpi({ label: 'Yetishmaydi', value: short.length, ico: 'alert', tone: short.length ? 'crit' : 'good' })}${kpi({ label: 'Kelmoqda', value: rows.filter((r) => r.status === 'INBOUND').length, ico: 'in', tone: 'warn' })}${kpi({ label: 'Yetarli', value: rows.filter((r) => r.status === 'OK').length, ico: 'check', tone: 'good' })}</div>
    ${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows, empty: 'Ochiq ishlab chiqarish buyurtmalari uchun material kerak emas', rowClass: (r) => (r.status === 'SHORT' ? 'hl' : ''),
    columns: [{ key: 'sku', label: 'Material', render: (r) => h`<b>${r.sku}</b><div class="small muted">${r.name}</div>` }, { key: 'need', label: 'Kerak', num: true, render: (r) => `${fmt.n(r.need)} ${r.unit}` },
      { key: 'free', label: 'Omborda (erkin)', num: true }, { key: 'inbound', label: 'Yo‘lda', num: true }, { key: 'requested', label: 'Zayavkada', num: true },
      { key: 'shortfall', label: 'Yetishmaydi', num: true, render: (r) => (r.shortfall > 0 ? h`<b style="color:var(--crit-ink)">${fmt.n(r.shortfall)}</b>` : '—') },
      { key: 'status', label: 'Holat', render: (r) => (r.status === 'SHORT' ? h`<span class="badge crit">yetishmaydi</span>` : r.status === 'INBOUND' ? h`<span class="badge warn">kelmoqda</span>` : h`<span class="badge good">yetarli</span>`) }, { key: 'orders', label: 'Buyurtmalar', num: true }] });
  $('[data-req]', el)?.addEventListener('click', async (e) => {
    if (!(await confirmBox('Ta’minotga zayavka', `${short.length} ta yetishmaydigan material uchun ta’minot zayavkasi yaratilsinmi? (asosiy supplier, muhimlik: yuqori)`, 'Yaratish'))) return;
    const r = await act(e.target.closest('button'), () => POST('/api/production/mrp/request', {})).catch(() => null); if (!r) return;
    toast(`${r.created.length} ta zayavka yaratildi${r.errors.length ? `; ${r.errors.length} ta xato: ${r.errors[0]}` : ''}`, r.errors.length ? 'warn' : 'ok'); App.refresh();
  });
} });
