/* Buyurtmalar, yig‘ish (picking), packing/pallet, yetishmovchilik, ta'minot zayavkalari, supplierlar, yetkazib berish */
'use strict';
const ORDER_FLOW = ['NEW', 'RESERVED', 'PICKING', 'PICKED', 'PACKED', 'LOADING', 'SHIPPED', 'DELIVERED'];
const PR_FLOW = ['REQUESTED', 'APPROVED', 'ORDERED', 'SUPPLIER_CONFIRMED', 'IN_TRANSIT', 'ARRIVED', 'QC', 'RECEIVED'];

// ================= create order ("Yangi yig‘ish") =================
A.createOrder = async (preset = {}) => {
  const prodOpts = opt.products((p) => p.category === 'FINISHED').concat(opt.products((p) => p.category !== 'FINISHED'));
  const rowHtml = (i) => `<div class="grid-form" data-item style="grid-template-columns:minmax(0,3fr) minmax(0,1fr) auto;align-items:end;margin-bottom:8px">${fieldHtml({ name: `p${i}`, label: 'Mahsulot', type: 'select', options: prodOpts, value: preset.productId })}${fieldHtml({ name: `q${i}`, label: 'Kerakli miqdor', type: 'number', min: 1 })}<button type="button" class="btn ghost" data-del aria-label="O‘chirish">${html(icon('x'))}</button></div>`;
  const head = [{ name: 'customerId', label: 'Mijoz', type: 'select', options: opt.customers() }, { name: 'customerName', label: 'yoki yangi mijoz nomi' }, { name: 'projectId', label: 'Loyiha', type: 'select', options: opt.projects() },
    { name: 'priority', label: 'Muhimlik', type: 'select', noEmpty: true, required: true, value: 'NORMAL', options: [['URGENT', 'Shoshilinch'], ['HIGH', 'Yuqori'], ['NORMAL', 'Oddiy'], ['LOW', 'Past']] },
    { name: 'dueDate', label: 'Jo‘natish muddati', type: 'datetime-local', value: isoLocal(Date.now() + 2 * 86400000) }, { name: 'destination', label: 'Yetkazish manzili' },
    { name: 'autoReserve', label: 'Mavjud stockni avtomatik rezerv qilish', type: 'checkbox', value: true, full: true }];
  let n = 1;
  const res = await modal({ title: 'Yangi yig‘ish — buyurtma', size: 'xl', submitText: 'Buyurtma yaratish',
    body: raw(`${formHtml(head, 3)}<h4 style="margin:18px 0 8px">Mahsulotlar</h4><div data-items>${rowHtml(0)}</div><button type="button" class="btn sm" data-add>${html(icon('plus'))}Qator qo‘shish</button><div data-preview style="margin-top:16px"></div>`),
    onOpen: (bg) => {
      const preview = debounce(async () => {
        const items = $$('[data-item]', bg).map((r) => ({ productId: Number($('select', r).value), qty: Number($('input', r).value) })).filter((x) => x.productId && x.qty > 0);
        const box = $('[data-preview]', bg); if (!items.length) { box.innerHTML = ''; return; }
        try {
          const a = await POST('/api/orders/preview', { items, projectId: $('[name=projectId]', bg).value || null });
          box.innerHTML = html(h`${raw(tableHtml([{ label: 'Mahsulot', render: (r) => h`<b>${r.sku}</b>` }, { label: 'Kerakli', key: 'required', num: true }, { label: 'Omborda (available)', key: 'available', num: true }, { label: 'Rezervda', key: 'reserved', num: true }, { label: 'Erkin', key: 'free', num: true }, { label: 'Loyiha rezervi', key: 'projectReserved', num: true }, { label: 'Tayyor', key: 'canReserve', num: true }, { label: 'Yetishmaydi', num: true, render: (r) => (r.shortage ? h`<b style="color:var(--crit-ink)">🔴 ${fmt.n(r.shortage)}</b>` : h`<span style="color:var(--good-ink)">✓ 0</span>`) }], a))}
            <div style="margin-top:10px">${aiCallout(a.map((x) => `${x.sku}: ${x.message}`).join('\n'), 'AI stock tekshiruvi')}</div>`);
        } catch (e) { box.innerHTML = html(h`<div class="callout crit">${e.message}</div>`); }
      }, 350);
      const items = $('[data-items]', bg);
      $('[data-add]', bg).addEventListener('click', () => { items.insertAdjacentHTML('beforeend', rowHtml(n++)); });
      items.addEventListener('click', (e) => { if (e.target.closest('[data-del]') && $$('[data-item]', bg).length > 1) { e.target.closest('[data-item]').remove(); preview(); } });
      bg.addEventListener('input', preview); bg.addEventListener('change', preview); preview();
    },
    onSubmit: async (form) => {
      const d = await readForm(form, head);
      d.items = $$('[data-item]', form).map((r) => ({ productId: Number($('select', r).value), qty: Number($('input', r).value) })).filter((x) => x.productId && x.qty > 0);
      if (!d.items.length) throw new Error('Kamida bitta mahsulot va miqdor kiriting');
      if (!d.customerId && !d.customerName) throw new Error('Mijozni tanlang yoki nomini kiriting');
      return POST('/api/orders', d);
    } });
  if (!res) return;
  await App.loadMeta();
  const short = res.analysis.filter((a) => a.shortage > 0);
  toast(`${res.orderNo} yaratildi — ${label(res.status)}`, 'ok', 'ORDER_CREATED');
  if (short.length) {
    const ok = await modal({ title: `${res.orderNo}: yetishmovchilik aniqlandi`, body: h`${aiCallout(short.map((s) => s.message).join('\n'))}<p class="t2">AI ta'minot zayavkasi loyihasini tayyorlaydi. Zayavka yuborilishidan oldin vakolatli xodim tomonidan tasdiqlanadi.</p>`, submitText: 'Ta’minot zayavkasini tayyorlash', submitClass: 'accent', onSubmit: async () => true });
    if (ok) { const d = await GET(`/api/orders/${res.id}`); for (const s of d.shortages.filter((x) => x.status === 'OPEN')) await A.aiDraft(s.id); }
  }
  go(`#/orders/${res.id}`);
};
A.aiDraft = async (shortageId) => {
  const dr = await GET(`/api/shortages/${shortageId}/draft`);
  const fields = [{ name: 'productId', label: 'Material / mahsulot', type: 'select', required: true, options: opt.products(), value: dr.productId, full: true }, { name: 'supplierId', label: 'Supplier', type: 'select', required: true, options: opt.suppliers(), value: dr.supplierId },
    { name: 'qty', label: 'Miqdor', type: 'number', required: true, value: dr.qty }, { name: 'requiredDate', label: 'Kerakli sana', type: 'date', required: true, value: dr.requiredDate },
    { name: 'priority', label: 'Muhimlik', type: 'select', required: true, noEmpty: true, value: dr.priority, options: [['URGENT', 'Shoshilinch'], ['HIGH', 'Yuqori'], ['NORMAL', 'Oddiy'], ['LOW', 'Past']] },
    { name: 'warehouseId', label: 'Ombor', type: 'select', options: opt.warehouses(), value: dr.warehouseId }, { name: 'productionOrder', label: 'Production Order' }, { name: 'reason', label: 'Sabab', required: true, value: dr.reason, full: true }];
  const r = await formModal({ title: 'AI ta’minot zayavkasi (loyiha)', size: 'wide', fields, submitText: 'Zayavka yaratish (tasdiqlashga yuborish)', intro: h`<div style="margin-bottom:14px">${aiCallout(dr.aiText)}</div>`,
    onSubmit: (d) => POST('/api/purchase-requests', { ...d, shortageId, orderId: dr.orderId, aiGenerated: true }) });
  if (r) { toast(`${r.prNo} yaratildi (REQUESTED) — tasdiqlash kutilmoqda`, 'ok', 'SUPPLIER_REQUEST_CREATED'); App.refresh(); }
  return r;
};

// ================= Orders =================
App.page('/orders', { title: 'Buyurtmalar', live: ['ORDER_CREATED', 'ORDER_STATUS', 'ORDER_RESERVED', 'SHORTAGE_DETECTED', 'SHORTAGE_RESOLVED', 'PICKING_COMPLETED'], async render({ el, query }) {
  const rows = await GET(`/api/orders?limit=500${query.all ? '' : '&open=1'}`);
  el.innerHTML = html(h`${pageHead('Buyurtmalar', 'Mijoz / loyiha buyurtmalari · stock check · rezerv · shortage', btn('Yangi yig‘ish', { cls: 'primary', ico: 'plus', attrs: 'data-a', perm: 'orders.manage' }))}
    <div class="tabs"><a href="#/orders" class="${query.all ? '' : 'active'}">Ochiq</a><a href="#/orders?all=1" class="${query.all ? 'active' : ''}">Hammasi</a></div>${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows, onRow: (r) => go(`#/orders/${r.id}`), columns: [
    { key: 'order_no', label: 'Buyurtma', render: (r) => h`<b>${r.order_no}</b><div class="small muted">${fmt.d(r.created_at)}</div>` }, { key: 'customer', label: 'Mijoz / loyiha', render: (r) => h`${r.customer}${r.project_code ? h`<div class="small muted">${r.project_code}</div>` : ''}` },
    { key: 'priority', label: 'Muhimlik', render: (r) => badge(r.priority) }, { key: 'due_date', label: 'Muddat', render: (r) => h`${fmt.dt(r.due_date)}${r.due_date && new Date(r.due_date) < Date.now() && !['SHIPPED', 'DELIVERED', 'CANCELLED'].includes(r.status) ? h` <span class="badge crit">kechikkan</span>` : ''}` },
    { key: 'qty', label: 'Miqdor', num: true }, { key: 'reserved', label: 'Rezerv', num: true }, { key: 'picked', label: 'Yig‘ildi', render: (r) => coverage(r.picked, r.qty) },
    { key: 'shortage', label: 'Yetishmaydi', num: true, render: (r) => (r.shortage ? h`<b style="color:var(--crit-ink)">🔴 ${fmt.n(r.shortage)}</b>` : '—') }, { key: 'status', label: 'Holat', render: (r) => badge(r.status) }] });
  $('[data-a]', el)?.addEventListener('click', () => A.createOrder());
} });
App.page('/orders/:id', { title: 'Buyurtma', live: true, async render({ el, params }) {
  const d = await GET(`/api/orders/${params.id}`); const o = d.order;
  const openPick = d.picking.find((t) => ['PENDING', 'IN_PROGRESS'].includes(t.status));
  const toPack = d.items.some((i) => i.picked_qty > i.packed_qty);
  const readyPallets = d.pallets.filter((p) => p.status === 'PACKED' && !p.shipment_id);
  const closed = ['SHIPPED', 'DELIVERED', 'CANCELLED'].includes(o.status);
  const flowIdx = o.status === 'PARTIALLY_RESERVED' ? 'NEW' : o.status;
  el.innerHTML = html(h`${pageHead(h`${o.order_no} ${badge(o.status)}`, `${o.customer}${o.project_code ? ` · ${o.project_code} ${o.project_name}` : ''} · muddat ${fmt.dt(o.due_date)} · ${o.destination || ''}`,
    h`${!closed ? btn('Rezervni yangilash', { ico: 'lock', attrs: 'data-a="res"', perm: 'stock.reserve' }) : ''}${!closed && !openPick && d.items.some((i) => i.reserved > 0) ? btn('Picking yaratish', { cls: 'primary', ico: 'pick', attrs: 'data-a="pick"', perm: 'picking' }) : ''}${openPick ? h`<a class="btn primary" href="#/picking/${openPick.id}">${icon('pick')}Picking ${openPick.task_no}</a>` : ''}
    ${toPack ? btn('Pallet yaratish', { cls: 'accent', ico: 'pack', attrs: 'data-a="pal"', perm: 'packing' }) : ''}${!closed ? btn('Transport hisoblash', { ico: 'truck', attrs: 'data-a="calc"' }) : ''}${readyPallets.length ? btn('Shipment yaratish', { cls: 'primary', ico: 'send', attrs: 'data-a="ship"', perm: 'shipments.manage' }) : ''}${!closed && !d.items.some((i) => i.picked_qty > 0) ? btn('Bekor qilish', { cls: 'danger', attrs: 'data-a="cancel"', perm: 'orders.manage' }) : ''}`,
    h`<a href="#/orders">Buyurtmalar</a> / ${o.order_no}`)}
  ${card('', stepper(ORDER_FLOW, flowIdx, { bad: o.status === 'CANCELLED' }))}
  <div style="height:16px"></div>
  ${card('Mahsulotlar va ta’minlanganlik', raw(tableHtml([{ label: 'Mahsulot', render: (r) => h`<a href="#/products/${r.product_id}"><b>${r.sku}</b></a><div class="small muted">${r.name}</div>` }, { label: 'Kerak', key: 'qty', num: true }, { label: 'Rezerv', key: 'reserved', num: true },
    { label: 'Yetishmaydi', num: true, render: (r) => (r.need ? h`<b style="color:var(--crit-ink)">🔴 ${fmt.n(r.need)}</b>` : '✓') }, { label: 'Yig‘ildi', render: (r) => coverage(r.picked_qty, r.qty) }, { label: 'Qadoqlandi', render: (r) => coverage(r.packed_qty, r.qty) }, { label: 'Jo‘natildi', render: (r) => coverage(r.shipped_qty, r.qty) }], d.items)), { flush: true })}
  ${d.shortages.filter((s) => ['OPEN', 'REQUESTED'].includes(s.status)).length ? h`<div style="margin-top:16px">${card('Yetishmovchilik', raw(tableHtml([{ label: '№', key: 'shortage_no' }, { label: 'Kerak', key: 'required_qty', num: true }, { label: 'Yetishmaydi', num: true, render: (s) => h`<b style="color:var(--crit-ink)">${fmt.n(s.shortage_qty)}</b>` }, { label: 'Holat', render: (s) => badge(s.status) }, { label: 'Zayavka', render: (s) => (s.pr_no ? h`<a href="#/purchase?open=${s.purchase_request_id}">${s.pr_no}</a> ${badge(s.pr_status)}` : '—') }, { label: '', render: (s) => (s.status === 'OPEN' && can('procurement.request') ? h`<button class="btn sm accent" data-draft="${s.id}">${icon('ai')}AI zayavka</button>` : '') }], d.shortages.filter((s) => ['OPEN', 'REQUESTED'].includes(s.status)))), { flush: true })}</div>` : ''}
  <div class="grid g2" style="margin-top:16px">
    ${card('Picking topshiriqlari', raw(tableHtml([{ label: 'Topshiriq', render: (t) => h`<a href="#/picking/${t.id}">${t.task_no}</a>` }, { label: 'Ijrochi', key: 'assignee' }, { label: 'Holat', render: (t) => badge(t.status) }, { label: 'Deadline', render: (t) => fmt.dt(t.deadline) }], d.picking)), { flush: true })}
    ${card('Palletlar', raw(tableHtml([{ label: 'Pallet', render: (p) => h`<a href="#/qr?code=${p.pallet_no}">${p.pallet_no}</a>` }, { label: 'Soni', key: 'qty', num: true }, { label: 'Brutto', render: (p) => fmt.kg(p.gross_weight_kg) }, { label: 'Joy', render: (p) => h`<span class="mono small">${p.location || '—'}</span>` }, { label: 'Holat', render: (p) => badge(p.status) }], d.pallets)), { flush: true, sub: d.pallets.length ? `jami ${fmt.kg(d.pallets.filter((p) => p.status !== 'UNPACKED').reduce((a, p) => a + p.gross_weight_kg, 0))}` : '' })}
    ${card('Jo‘natmalar', raw(tableHtml([{ label: 'Jo‘natma', render: (s) => h`<a href="#/shipments/${s.ship_no}">${s.ship_no}</a>` }, { label: 'Transport', key: 'vehicle' }, { label: 'Holat', render: (s) => badge(s.status) }, { label: 'ETA', render: (s) => fmt.dt(s.eta) }], d.shipments)), { flush: true })}
    ${card('Tarix', timeline(d.history.map((x) => ({ title: `${x.from_status ? `${label(x.from_status)} → ` : ''}${label(x.to_status)}`, sub: x.note, at: x.created_at, by: x.user }))))}
  </div>`);
  el.addEventListener('click', async (e) => {
    const dr = e.target.closest('[data-draft]'); if (dr) return A.aiDraft(Number(dr.dataset.draft));
    const a = e.target.closest('[data-a]'); if (!a) return;
    const k = a.dataset.a;
    if (k === 'res') act(a, () => POST(`/api/orders/${o.id}/reserve`), (r) => `Holat: ${label(r.status)}`).then(App.refresh);
    if (k === 'pick') A.createPick(o.id);
    if (k === 'pal') A.createPallets(o.id);
    if (k === 'calc') A.transportCalc({ orderId: o.id });
    if (k === 'ship') A.createShipment(o.id);
    if (k === 'cancel') { const r = await formModal({ title: `${o.order_no} ni bekor qilish`, fields: [{ name: 'reason', label: 'Sabab', required: true, full: true }], submitText: 'Bekor qilish', onSubmit: (x) => POST(`/api/orders/${o.id}/cancel`, x) }); if (r) { toast('Buyurtma bekor qilindi, rezervlar bo‘shatildi', 'ok'); App.refresh(); } }
  });
} });

// ================= Picking =================
A.createPick = async (orderId) => {
  const orders = (await GET('/api/orders?open=1')).filter((o) => o.reserved > 0);
  const sug = await GET('/api/tasks/suggest');
  const r = await formModal({ title: '+ Picking topshirig‘i', intro: h`<div class="callout ai" style="margin-bottom:12px">${icon('ai')}<div>AI optimal ijrochi: <b>${sug.worker?.full_name || '—'}</b>. Lokatsiyalar FIFO (partiya sanasi) bo‘yicha tanlanadi, marshrut eng yaqin qo‘shni usulida tuziladi.</div></div>`,
    fields: [{ name: 'orderId', label: 'Buyurtma (rezervli)', type: 'select', required: true, options: orders.map((o) => [o.id, `${o.order_no} — ${o.customer} · rezerv ${fmt.n(o.reserved)}`]), value: orderId, full: true }, { name: 'assignedTo', label: 'Omborchi', type: 'select', options: opt.users(['STOREKEEPER', 'MANAGER']), value: sug.worker?.id }, { name: 'deadline', label: 'Deadline', type: 'datetime-local', value: isoLocal(Date.now() + 4 * 3600000) }],
    onSubmit: (d) => POST('/api/picking', d) });
  if (r) { toast(`${r.taskNo}: marshrut ${r.route.join(' → ')} (${r.saved > 0 ? `${r.saved} m tejaldi` : 'optimal'})`, 'ok', 'Picking yaratildi'); go(`#/picking/${r.id}`); }
};
App.page('/picking', { title: 'Yig‘ish (Picking)', live: ['TASK_CREATED', 'PICKING_STARTED', 'PICKING_COMPLETED', 'TASK_ASSIGNED'], async render({ el }) {
  const rows = await GET('/api/picking');
  el.innerHTML = html(h`${pageHead('Yig‘ish (Picking)', 'Order → lokatsiya → QR scan → ✅ / ❌ → Packing zone', btn('+ Picking', { cls: 'primary', ico: 'pick', attrs: 'data-a', perm: 'picking' }))}${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows, onRow: (r) => go(`#/picking/${r.id}`), rowClass: (r) => (r.status !== 'COMPLETED' && r.deadline && new Date(r.deadline) < Date.now() ? 'hl' : ''), columns: [
    { key: 'task_no', label: 'Topshiriq', render: (r) => h`<b>${r.task_no}</b>` }, { key: 'order_no', label: 'Buyurtma' }, { key: 'assignee', label: 'Omborchi' }, { key: 'picked', label: 'Jarayon', render: (r) => coverage(r.picked || 0, r.qty) },
    { key: 'errors', label: 'Xato skan', num: true }, { key: 'status', label: 'Holat', render: (r) => badge(r.status) }, { key: 'deadline', label: 'Deadline', render: (r) => fmt.dt(r.deadline) }] });
  $('[data-a]', el)?.addEventListener('click', () => A.createPick());
} });
App.page('/picking/:id', { title: 'Picking', live: false, async render({ el, params }) {
  const d = await GET(`/api/picking/${params.id}`); const t = d.task;
  const cur = d.lines.find((l) => l.picked_qty < l.qty);
  const done = t.status === 'COMPLETED';
  const scanned = App._scanned = App._scanned && App._scanned.task === t.id && App._scanned.line === cur?.id ? App._scanned : { task: t.id, line: cur?.id, serials: [] };
  el.innerHTML = html(h`${pageHead(h`${t.task_no} ${badge(t.status)}`, `Buyurtma ${t.order_no} · omborchi ${t.assignee || '—'} · deadline ${fmt.dt(t.deadline)} · skan: ${t.scans}, xato: ${t.errors}`, h`${t.status === 'PENDING' ? btn('Boshlash', { cls: 'primary', attrs: 'data-a="start"', perm: 'picking' }) : ''}${!done ? btn('Yakunlash', { attrs: 'data-a="complete"', perm: 'picking' }) : ''}<a class="btn" href="#/orders/${t.order_id}">Buyurtma</a>`, h`<a href="#/picking">Picking</a> / ${t.task_no}`)}
  ${card('AI optimal marshrut', h`<div class="route">${raw('<span>DOCK</span>')}${d.lines.map((l) => h`<b class="muted">→</b><span class="${l.picked_qty >= l.qty ? 'done' : l === cur ? 'cur' : ''}">${l.location}</span>`)}</div><div class="small muted" style="margin-top:8px">Masofa: ${t.route.distance ?? '—'} m (ketma-ket yurishda ${t.route.naiveDistance ?? '—'} m)</div>`)}
  <div class="grid g-main" style="margin-top:16px">
    ${done ? card('Yig‘ish yakunlandi', h`<div class="callout good">${icon('check')}<div><b>✅ Picking completed</b> — ${fmt.dt(t.completed_at)}. Mahsulot Packing zonasiga o‘tkazildi.</div></div><div style="margin-top:12px"><a class="btn accent" href="#/packing">${icon('pack')}Packing / pallet</a></div>`)
    : cur ? card(`Joriy qator #${cur.seq}`, h`<div class="grid g2">${dl([['Order', t.order_no], ['Product', h`<b>${cur.sku}</b> — ${cur.name}`], ['Quantity', h`<b style="font-size:18px">${fmt.n(cur.qty - cur.picked_qty)}</b> ${cur.unit}`], ['Location', h`<b class="mono" style="font-size:16px">${cur.location}</b>`], ['Partiya', cur.batch_no]])}<div>
        <form data-scan><label class="small t2">QR / barcode / serialni skaner qiling</label><div style="display:flex;gap:6px;margin-top:4px"><input class="input scan" name="code" autocomplete="off" placeholder="Lokatsiya, SKU yoki serial" ${can('picking') ? '' : 'disabled'}><button type="button" class="btn" data-cam aria-label="Kamera">${icon('camera')}</button></div></form>
        <div data-res>${scanned.serials.length ? h`<div class="small" style="margin-top:8px">Skanerlangan serial: <b>${scanned.serials.length}</b></div>` : ''}</div></div></div>
        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;align-items:end">${raw(fieldHtml({ name: 'pq', label: 'Yig‘ilgan miqdor', type: 'number', value: scanned.serials.length || cur.qty - cur.picked_qty, min: 0 }))}${btn('✅ Yig‘ildi', { cls: 'good lg', attrs: `data-pick="${cur.id}"`, perm: 'picking' })}</div>`) : card('', raw('<div class="empty">Qator yo‘q</div>'))}
    ${card('Yig‘ish qatorlari', raw(tableHtml([{ label: '#', key: 'seq' }, { label: 'Lokatsiya', render: (l) => h`<span class="mono">${l.location}</span>` }, { label: 'SKU', key: 'sku' }, { label: 'Jarayon', render: (l) => coverage(l.picked_qty, l.qty) }], d.lines)), { flush: true })}
  </div>`);
  const inp = $('[data-scan] input', el); if (inp && !('ontouchstart' in window)) inp.focus();
  const doScan = async (code) => {
    const box = $('[data-res]', el);
    try {
      if (t.status === 'PENDING') await POST(`/api/picking/${t.id}/start`);
      const r = await POST(`/api/picking/${t.id}/scan`, { code, lineId: cur.id });
      if (r.ok && r.serial && !scanned.serials.includes(r.serial)) { scanned.serials.push(r.serial); const pq = $('[name=pq]', el); if (pq) pq.value = scanned.serials.length; }
      box.innerHTML = html(h`<div class="scan-res ${r.ok ? 'ok' : 'bad'}">${r.message}</div>${scanned.serials.length ? h`<div class="small" style="margin-top:8px">Skanerlangan serial: <b>${scanned.serials.length}</b></div>` : ''}`);
      if (navigator.vibrate && !r.ok) navigator.vibrate(200);
    } catch (e) { box.innerHTML = html(h`<div class="scan-res bad">${e.message}</div>`); }
    if (inp) { inp.value = ''; inp.focus(); }
  };
  $('[data-scan]', el)?.addEventListener('submit', (e) => { e.preventDefault(); const c = inp.value.trim(); if (c) doScan(c); });
  $('[data-cam]', el)?.addEventListener('click', () => openScanner(doScan));
  el.addEventListener('click', async (e) => {
    const p = e.target.closest('[data-pick]');
    if (p) { const qty = Number($('[name=pq]', el).value); const serials = scanned.serials.length === qty ? scanned.serials : undefined; const r = await act(p, () => POST(`/api/picking/lines/${p.dataset.pick}/pick`, { qty, serials })).catch(() => null); if (r) { App._scanned = null; toast(`${qty} yig‘ildi${r.completed ? ' — ✅ Picking completed' : ''}`, 'ok'); App.refresh(); } }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'start') act(e.target.closest('[data-a]'), () => POST(`/api/picking/${t.id}/start`), 'Boshlandi (PICKING_STARTED)').then(App.refresh);
    if (a === 'complete') { const partial = d.lines.some((l) => l.picked_qty < l.qty); if (partial && !(await confirmBox('Qisman yakunlash', 'Barcha qatorlar yig‘ilmagan. Qolgan rezerv saqlanib qoladi. Davom etasizmi?'))) return; act(e.target.closest('[data-a]'), () => POST(`/api/picking/${t.id}/complete`, { partial }), 'Picking completed').then(App.refresh); }
  });
} });

// ================= Packing / pallets =================
A.createPallets = async (orderId) => {
  const orders = (await GET('/api/orders?open=1')).filter((o) => o.picked > o.packed);
  const r = await formModal({ title: '+ Pallet yig‘ish', fields: [{ name: 'orderId', label: 'Buyurtma', type: 'select', required: true, options: orders.map((o) => [o.id, `${o.order_no} — yig‘ilgan ${fmt.n(o.picked)}, qadoqlangan ${fmt.n(o.packed)}`]), value: orderId, full: true }, { name: 'perPallet', label: 'Palletdagi soni', type: 'number', hint: 'Bo‘sh — mahsulot standartidan (masalan 31)' }, { name: 'qty', label: 'Qadoqlanadigan miqdor', type: 'number', hint: 'Bo‘sh — yig‘ilganning barchasi' },
    { type: 'html', name: 'x', full: true, html: '<div class="callout">Gross Weight = soni × panel og‘irligi + pallet og‘irligi + qadoq og‘irligi — avtomatik hisoblanadi.</div>' }],
  onSubmit: (d) => POST('/api/pallets', d) });
  if (r) {
    await modal({ title: `${r.pallets.length} ta pallet yaratildi`, size: 'wide', body: h`${raw(tableHtml([{ label: 'Pallet', render: (p) => h`<b>${p.palletNo}</b>` }, { label: 'Soni', key: 'qty', num: true }, { label: 'Net', render: (p) => fmt.kg(p.net_weight_kg) }, { label: '+ Pallet', render: (p) => fmt.kg(p.pallet_weight_kg) }, { label: '+ Qadoq', render: (p) => fmt.kg(p.packaging_weight_kg) }, { label: '= Gross', render: (p) => h`<b>${fmt.kg(p.gross_weight_kg)}</b>` }, { label: 'O‘lcham', render: (p) => `${p.length_mm}×${p.width_mm}×${p.height_mm}` }, { label: 'Hajm', render: (p) => fmt.m3(p.volume_m3) }], r.pallets))}<p><b>Jami brutto: ${fmt.kg(r.totalGross)}</b></p>`,
      footer: h`<button class="btn" data-print>${icon('print')}Yorliqlarni chop etish</button>`, onOpen: (bg) => $('[data-print]', bg).addEventListener('click', () => A.printLabels(r.pallets.map((p) => p.palletNo))) });
    App.refresh();
  }
};
A.printLabels = async (nos) => {
  let out = '';
  for (const no of nos) { const d = await GET(`/api/trace/pallet/${encodeURIComponent(no)}`); out += `<div class="qr-label">${await qrSvg(no, 130)}<div><h2 style="margin:0 0 4px">${esc(no)}</h2><div><b>${esc(d.product?.sku)}</b> — ${esc(d.product?.name)}</div><div>Buyurtma: ${esc(d.order?.order_no)}</div><div>Soni: <b>${d.pallet.qty}</b> · Brutto: <b>${d.pallet.gross_weight_kg} kg</b></div><div>${d.pallet.length_mm}×${d.pallet.width_mm}×${d.pallet.height_mm} mm</div><div style="font-size:10px">${esc(d.serials.length ? `${d.serials[0].serial} … ${d.serials[d.serials.length - 1].serial}` : '')}</div></div></div>`; }
  printHtml(out, 'Pallet yorliqlari');
};
App.page('/packing', { title: 'Packing va palletlar', live: ['PACKING_COMPLETED', 'PICKING_COMPLETED', 'STOCK_CHANGED', 'LOADING_COMPLETED'], async render({ el, query }) {
  const [tasks, pallets] = await Promise.all([GET('/api/packing'), GET(`/api/pallets${query.all ? '' : '?status=PACKED'}`)]);
  const open = tasks.filter((t) => t.status !== 'COMPLETED');
  el.innerHTML = html(h`${pageHead('Packing va palletlar', 'Picking → Packing Zone → Pallet (gross weight) → Dispatch Zone', btn('+ Pallet', { cls: 'primary', ico: 'pack', attrs: 'data-a', perm: 'packing' }))}
  ${card('Packing topshiriqlari', raw(tableHtml([{ label: 'Topshiriq', key: 'task_no' }, { label: 'Buyurtma', render: (t) => h`<a href="#/orders/${t.order_id}">${t.order_no}</a>` }, { label: 'Qadoqlash kerak', key: 'to_pack', num: true }, { label: 'Ijrochi', key: 'assignee' }, { label: 'Holat', render: (t) => badge(t.status) }, { label: 'Deadline', render: (t) => fmt.dt(t.deadline) }, { label: '', render: (t) => (can('packing') ? h`<button class="btn sm accent" data-pk="${t.order_id}" data-t="${t.id}">Pallet yig‘ish</button>` : '') }], open, 'Ochiq packing topshirig‘i yo‘q')), { flush: true })}
  <div class="tabs" style="margin-top:18px"><a href="#/packing" class="${query.all ? '' : 'active'}">Jo‘natishga tayyor</a><a href="#/packing?all=1" class="${query.all ? 'active' : ''}">Barcha palletlar</a></div>
  ${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows: pallets, onRow: (p) => go(`#/qr?code=${p.pallet_no}`), columns: [
    { key: 'pallet_no', label: 'Pallet', render: (p) => h`<b>${p.pallet_no}</b>` }, { key: 'order_no', label: 'Buyurtma' }, { key: 'sku', label: 'SKU' }, { key: 'qty', label: 'Soni', num: true },
    { key: 'gross_weight_kg', label: 'Brutto', num: true, render: (p) => fmt.kg(p.gross_weight_kg) }, { key: 'volume_m3', label: 'Hajm', num: true, render: (p) => fmt.m3(p.volume_m3) }, { key: 'location', label: 'Joy', render: (p) => h`<span class="mono small">${p.location || '—'}</span>${p.zone_type === 'DISPATCH' ? h` <span class="badge good">Dispatch</span>` : ''}` },
    { key: 'status', label: 'Holat', render: (p) => h`${badge(p.status)}${p.ship_no ? h` <a class="small" href="#/shipments/${p.ship_no}">${p.ship_no}</a>` : ''}` },
    { label: '', sort: false, render: (p) => h`<div style="display:flex;gap:6px;justify-content:flex-end"><button class="btn sm" data-lbl="${p.pallet_no}">${icon('print')}</button>${p.status === 'PACKED' && !p.shipment_id && can('packing') ? h`${p.zone_type !== 'DISPATCH' ? h`<button class="btn sm" data-dz="${p.id}">→ Dispatch</button>` : ''}<button class="btn sm danger" data-un="${p.id}">Ochish</button>` : ''}</div>` }] });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-a]')) return A.createPallets();
    const pk = e.target.closest('[data-pk]'); if (pk) { await POST(`/api/packing/${pk.dataset.t}/start`).catch(() => {}); return A.createPallets(Number(pk.dataset.pk)); }
    const l = e.target.closest('[data-lbl]'); if (l) return A.printLabels([l.dataset.lbl]);
    const dz = e.target.closest('[data-dz]'); if (dz) return act(dz, () => POST(`/api/pallets/${dz.dataset.dz}/dispatch-zone`), (r) => `Dispatch zonasiga: ${r.location}`).then(App.refresh);
    const un = e.target.closest('[data-un]'); if (un && (await confirmBox('Palletni ochish', 'Pallet ochiladi (UNPACK), mahsulot yana Packing zonasida “yig‘ilgan” holatga qaytadi.', 'Ochish', 'danger'))) act(un, () => POST(`/api/pallets/${un.dataset.un}/unpack`), 'Pallet ochildi').then(App.refresh);
  });
} });

// ================= Shortages =================
App.page('/shortages', { title: 'Yetishmovchilik', live: ['SHORTAGE_DETECTED', 'SHORTAGE_RESOLVED', 'SUPPLIER_REQUEST_CREATED', 'STOCK_CHANGED'], async render({ el, query }) {
  const rows = await GET(`/api/shortages${query.status ? `?status=${query.status}` : ''}`);
  el.innerHTML = html(h`${pageHead('Yetishmovchilik', 'Required − (rezerv + erkin stock) > 0 → SHORTAGE. AI doimiy tekshiradi.', btn('Qayta tekshirish', { ico: 'refresh', attrs: 'data-a' }))}
  <div class="tabs"><a href="#/shortages" class="${!query.status ? 'active' : ''}">Ochiq</a><a href="#/shortages?status=RESOLVED" class="${query.status === 'RESOLVED' ? 'active' : ''}">Hal qilingan</a></div>
  ${rows.length && !query.status ? h`<div style="margin-bottom:14px">${aiCallout(rows.map((s) => `🔴 ${s.name}: ${fmt.n(s.shortage_qty)} ${s.unit} yetishmaydi — ${s.order_no} (${s.customer}), muddat ${fmt.d(s.due_date)}. ${s.pr_no ? `Zayavka: ${s.pr_no} (${label(s.pr_status)})` : 'Zayavka yaratilmagan.'}`).join('\n'))}</div>` : ''}
  ${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows, columns: [
    { key: 'shortage_no', label: '№', render: (s) => h`<b>${s.shortage_no}</b>` }, { key: 'sku', label: 'Mahsulot', render: (s) => h`${s.sku}<div class="small muted">${s.name}</div>` }, { key: 'order_no', label: 'Buyurtma', render: (s) => h`<a href="#/orders/${s.order_id}">${s.order_no}</a> ${badge(s.priority)}<div class="small muted">${s.customer}</div>` },
    { key: 'required_qty', label: 'Required', num: true }, { key: 'available_qty', label: 'Available', num: true }, { key: 'reserved_qty', label: 'Reserved', num: true }, { key: 'shortage_qty', label: 'Shortage', num: true, render: (s) => h`<b style="color:var(--crit-ink)">${fmt.n(s.shortage_qty)}</b>` },
    { key: 'due_date', label: 'Muddat', render: (s) => fmt.dt(s.due_date) }, { key: 'status', label: 'Holat', render: (s) => h`${badge(s.status)}${s.pr_no ? h`<div class="small"><a href="#/purchase?open=${s.purchase_request_id}">${s.pr_no}</a></div>` : ''}` },
    { label: '', sort: false, render: (s) => (s.status === 'OPEN' && can('procurement.request') ? h`<button class="btn sm accent" data-draft="${s.id}">${icon('ai')}Zayavka</button>` : '') }] });
  el.addEventListener('click', (e) => { const d = e.target.closest('[data-draft]'); if (d) A.aiDraft(Number(d.dataset.draft)); const a = e.target.closest('[data-a]'); if (a) act(a, () => POST('/api/shortages/scan'), (r) => `Ochiq yetishmovchilik: ${r.open}`).then(App.refresh); });
} });

// ================= Purchase requests =================
A.prAction = async (pr, action) => {
  const url = `/api/purchase-requests/${pr.id}/${action}`;
  const cfg = {
    approve: { title: 'Zayavkani tasdiqlash', fields: [{ name: 'note', label: 'Izoh', full: true }], ok: 'Tasdiqlash' },
    reject: { title: 'Zayavkani rad etish', fields: [{ name: 'reason', label: 'Sabab', required: true, full: true }], ok: 'Rad etish' },
    order: { title: 'Supplierga buyurtma (PO) berish', fields: [{ name: 'expectedDate', label: 'Kutilgan sana', type: 'date', value: pr.required_date?.slice(0, 10) }], ok: 'PO yaratish' },
    confirm: { title: 'Supplier tasdiqladi', fields: [{ name: 'expectedDate', label: 'Supplier bergan yetkazish sanasi', type: 'date', required: true, value: pr.required_date?.slice(0, 10) }], ok: 'Saqlash' },
    transit: { title: 'Yuk yo‘lda', fields: [{ name: 'vehicle', label: 'Transport' }, { name: 'driver', label: 'Haydovchi' }, { name: 'expectedDate', label: 'Yangilangan ETA', type: 'date' }], ok: 'Saqlash' },
    arrive: { title: 'Yuk keldi — qabul qilish', fields: [{ name: 'qty', label: 'Kelgan miqdor', type: 'number', required: true, value: pr.qty }, { name: 'deliveryNumber', label: 'Nakladnoy №' }, { name: 'batchNo', label: 'Partiya' }, { name: 'vehicle', label: 'Transport' }], ok: 'Qabul qilish' },
    cancel: { title: 'Zayavkani bekor qilish', fields: [{ name: 'reason', label: 'Sabab', required: true, full: true }], ok: 'Bekor qilish' },
  }[action];
  const r = await formModal({ title: `${cfg.title} — ${pr.pr_no}`, fields: cfg.fields, submitText: cfg.ok, onSubmit: (d) => POST(url, d) });
  if (!r) return;
  toast(`${pr.pr_no}: ${label(r.status)}`, 'ok');
  if (action === 'arrive') { if (r.receiving?.check?.short > 0) toast(`Buyurtma bo‘yicha ${r.receiving.check.short} dona yetkazilmagan`, 'warn', 'Kam keldi'); if (can('stock.qc') && (await confirmBox('QC', `${r.receiving.rcvNo} qabul zonasida. Hozir QC o‘tkazilsinmi?`, 'QC o‘tkazish'))) await A.qc(r.receiving.id); }
  App.refresh();
};
const PR_NEXT = { REQUESTED: [['approve', 'Tasdiqlash', 'primary', 'procurement.approve'], ['reject', 'Rad etish', 'danger', 'procurement.approve']], APPROVED: [['order', 'PO berish', 'primary', 'procurement.manage']], ORDERED: [['confirm', 'Supplier tasdiqladi', 'primary', 'procurement.manage']],
  SUPPLIER_CONFIRMED: [['transit', 'Yo‘lda', '', 'procurement.manage'], ['arrive', 'Keldi', 'primary', 'stock.receive']], IN_TRANSIT: [['arrive', 'Keldi', 'primary', 'stock.receive']] };
const prButtons = (r) => h`${(PR_NEXT[r.status] || []).filter((x) => can(x[3])).map(([a, l, c]) => h`<button class="btn sm ${c}" data-pr="${r.id}" data-act="${a}">${l}</button>`)}`;
App.page('/purchase', { title: 'Ta’minot zayavkalari', live: ['SUPPLIER_REQUEST_CREATED', 'PURCHASE_REQUEST_STATUS', 'SUPPLIER_DELIVERY_ARRIVED'], async render({ el, query }) {
  const rows = await GET(`/api/purchase-requests${query.all ? '' : '?open=1'}`);
  el.innerHTML = html(h`${pageHead('Ta’minot zayavkalari', 'REQUESTED → APPROVED → ORDERED → SUPPLIER_CONFIRMED → IN_TRANSIT → ARRIVED → QC → RECEIVED', btn('+ Zayavka', { cls: 'primary', ico: 'plus', attrs: 'data-a', perm: 'procurement.request' }))}
  <div class="tabs"><a href="#/purchase" class="${query.all ? '' : 'active'}">Ochiq</a><a href="#/purchase?all=1" class="${query.all ? 'active' : ''}">Hammasi</a></div>${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows, onRow: (r) => prDetail(r.id), columns: [
    { key: 'pr_no', label: 'Zayavka', render: (r) => h`<b>${r.pr_no}</b>${r.ai_generated ? h` <span class="badge plain blue">AI</span>` : ''}<div class="small muted">${r.po_no || ''}</div>` }, { key: 'sku', label: 'Material', render: (r) => h`${r.sku}<div class="small muted">${r.name}</div>` },
    { key: 'supplier', label: 'Supplier' }, { key: 'qty', label: 'Miqdor', num: true }, { key: 'priority', label: 'Muhimlik', render: (r) => badge(r.priority) },
    { key: 'expected_date', label: 'Kutilgan', render: (r) => h`${fmt.d(r.expected_date || r.required_date)}${r.expected_date && ['SUPPLIER_CONFIRMED', 'IN_TRANSIT'].includes(r.status) && new Date(r.expected_date).getTime() + 86400000 < Date.now() ? h` <span class="badge crit">🔴 DELAY</span>` : ''}` },
    { key: 'status', label: 'Holat', render: (r) => badge(r.status) }, { label: '', sort: false, render: (r) => h`<div style="display:flex;gap:6px;justify-content:flex-end">${prButtons(r)}</div>` }] });
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-pr]'); if (b) A.prAction(rows.find((x) => x.id === Number(b.dataset.pr)), b.dataset.act); if (e.target.closest('[data-a]')) A.newPR(); });
  if (query.open) prDetail(Number(query.open));
} });
A.newPR = async () => {
  const r = await formModal({ title: '+ Ta’minot zayavkasi', size: 'wide', fields: [{ name: 'productId', label: 'Material / mahsulot', type: 'select', required: true, options: opt.products(), full: true }, { name: 'supplierId', label: 'Supplier (bo‘sh — AI eng yaxshisini tanlaydi)', type: 'select', options: opt.suppliers() }, { name: 'qty', label: 'Miqdor', type: 'number', required: true },
    { name: 'requiredDate', label: 'Kerakli sana', type: 'date' }, { name: 'priority', label: 'Muhimlik', type: 'select', noEmpty: true, value: 'NORMAL', options: [['URGENT', 'Shoshilinch'], ['HIGH', 'Yuqori'], ['NORMAL', 'Oddiy'], ['LOW', 'Past']] }, { name: 'warehouseId', label: 'Ombor', type: 'select', options: opt.warehouses() }, { name: 'productionOrder', label: 'Production Order' }, { name: 'reason', label: 'Sabab', required: true, full: true }],
  onSubmit: (d) => POST('/api/purchase-requests', d) });
  if (r) { toast(`${r.prNo} yaratildi`, 'ok'); App.refresh(); }
};
async function prDetail(id) {
  const d = await GET(`/api/purchase-requests/${id}`); const r = d.request;
  const bad = ['REJECTED', 'CANCELLED'].includes(r.status);
  await modal({ title: `Zayavka ${r.pr_no}`, size: 'wide', body: h`${stepper(PR_FLOW, bad ? 'REQUESTED' : r.status, { bad })}${bad ? h`<div class="callout crit" style="margin:8px 0">${label(r.status)}</div>` : ''}<div class="grid g2" style="margin-top:10px">${dl([['Material', `${r.sku} — ${r.name}`], ['Supplier', r.supplier], ['Miqdor', `${fmt.n(r.qty)} ${r.unit}`], ['Qabul qilingan', fmt.n(r.received_qty)], ['Kerakli sana', fmt.d(r.required_date)], ['Muhimlik', badge(r.priority)]])}${dl([['Sabab', r.reason], ['Production order', r.production_order], ['Ombor', r.warehouse_id], ['PO', d.po?.po_no], ['Yetkazish', d.deliveries.map((x) => `${x.delivery_no}: ${fmt.d(x.expected_date)} (${label(x.status)})`).join('; ')], ['AI tomonidan', r.ai_generated ? 'Ha (inson tasdiqlaydi)' : 'Yo‘q']])}</div>
    <h4>Tarix</h4>${timeline(d.history.map((x) => ({ title: label(x.to_status), sub: x.note, at: x.created_at, by: x.user })))}`,
  footer: h`${can('documents.manage') ? h`<button class="btn" data-doc>${icon('doc')}Purchase Request hujjati</button>` : ''}${!bad && !['RECEIVED', 'ARRIVED', 'QC', 'IN_TRANSIT'].includes(r.status) && can('procurement.manage') ? h`<button class="btn danger" data-cancel>Bekor qilish</button>` : ''}${prButtons(r)}`,
  onOpen: (bg, close) => {
    $('[data-doc]', bg)?.addEventListener('click', (e) => act(e.target, () => POST(`/api/purchase-requests/${id}/document`, {}), (x) => `${x.docNo} v${x.version} yaratildi`).then((x) => { close(); go(`#/documents?open=${x.id}`); }).catch(() => {}));
    $('[data-cancel]', bg)?.addEventListener('click', () => { close(); A.prAction(r, 'cancel'); });
    $$('[data-act]', bg).forEach((b) => b.addEventListener('click', () => { close(); A.prAction(r, b.dataset.act); }));
  } });
}

// ================= Suppliers =================
App.page('/suppliers', { title: 'Supplierlar', async render({ el }) {
  const rows = await GET('/api/suppliers');
  el.innerHTML = html(h`${pageHead('Supplierlar', 'Ta’minotchilar va AI supplier performance tahlili', btn('+ Supplier', { cls: 'primary', ico: 'plus', attrs: 'data-a', perm: 'suppliers.manage' }))}${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows, onRow: (s) => go(`#/suppliers/${s.id}`), columns: [
    { key: 'company', label: 'Kompaniya', render: (s) => h`<b>${s.company}</b><div class="small muted">${s.code} · ${s.country || ''}</div>` }, { key: 'contact', label: 'Kontakt', render: (s) => h`${s.contact || ''}<div class="small muted">${s.phone || ''}</div>` },
    { key: 'orders', label: 'Buyurtmalar', num: true, sortVal: (s) => s.performance?.orders, render: (s) => fmt.n(s.performance?.orders) }, { key: 'ot', label: 'Vaqtida', sortVal: (s) => s.performance?.on_time_rate, render: (s) => h`<div class="cov"><span class="num small" style="min-width:44px">${fmt.pct(s.performance?.on_time_rate)}</span>${meter(s.performance?.on_time_rate, s.performance?.on_time_rate >= 90 ? 'good' : s.performance?.on_time_rate >= 70 ? 'warn' : 'crit')}</div>` },
    { key: 'late', label: 'Kechikkan', num: true, sortVal: (s) => s.performance?.late, render: (s) => h`${fmt.n(s.performance?.late)}${s.performance?.open_late ? h` <span class="badge crit">+${s.performance.open_late} hozir</span>` : ''}` }, { key: 'q', label: 'Sifat', num: true, sortVal: (s) => s.performance?.quality_rate, render: (s) => fmt.pct(s.performance?.quality_rate) },
    { key: 'lead', label: 'O‘rt. muddat', num: true, sortVal: (s) => s.performance?.avg_lead_days, render: (s) => (s.performance?.avg_lead_days != null ? `${s.performance.avg_lead_days} kun` : '—') }, { key: 'payment_terms', label: 'To‘lov shartlari' }] });
  $('[data-a]', el)?.addEventListener('click', () => A.supplierForm());
} });
A.supplierForm = async (s) => {
  const v = s || {};
  const fields = [['company', 'Kompaniya', true], ['contact', 'Kontakt shaxs'], ['phone', 'Telefon'], ['email', 'Email'], ['country', 'Davlat'], ['address', 'Manzil'], ['payment_terms', 'To‘lov shartlari'], ['contract_no', 'Shartnoma №'], ['contract_until', 'Shartnoma muddati']].map(([name, lbl, req]) => ({ name, label: lbl, required: req, value: v[name], type: name === 'contract_until' ? 'date' : name === 'email' ? 'email' : 'text' }));
  fields.push({ name: 'notes', label: 'Izoh', type: 'textarea', full: true, value: v.notes });
  const r = await formModal({ title: s ? `Supplier — ${s.company}` : '+ Supplier', size: 'wide', fields, onSubmit: (d) => { if (d.contract_until) d.contract_until = d.contract_until.slice(0, 10); return s ? PUT(`/api/suppliers/${s.id}`, d) : POST('/api/suppliers', d); } });
  if (r) { toast('Saqlandi', 'ok'); await App.loadMeta(); App.refresh(); }
};
App.page('/suppliers/:id', { title: 'Supplier', async render({ el, params }) {
  const d = await GET(`/api/suppliers/${params.id}`); const s = d.supplier; const p = d.performance || {};
  el.innerHTML = html(h`${pageHead(s.company, `${s.code} · ${s.country || ''} · ${s.payment_terms || ''}`, h`${btn('Tahrirlash', { ico: 'gear', attrs: 'data-a="edit"', perm: 'suppliers.manage' })}${btn('Mahsulot / narx', { ico: 'plus', attrs: 'data-a="prod"', perm: 'suppliers.manage' })}`, h`<a href="#/suppliers">Supplierlar</a> / ${s.code}`)}
  <div class="kpis">${kpi({ label: 'Buyurtmalar', value: fmt.n(p.orders), ico: 'cart' })}${kpi({ label: 'Vaqtida kelgan', value: fmt.n(p.on_time), ico: 'check', tone: 'good', sub: fmt.pct(p.on_time_rate) })}${kpi({ label: 'Kechikkan', value: fmt.n(p.late), ico: 'clock', tone: p.late ? 'warn' : '', sub: `o‘rtacha ${p.avg_delay_days} kun` })}${kpi({ label: 'Brak', value: fmt.n(p.rejected_qty), ico: 'scrap', tone: p.rejected_qty ? 'crit' : '' })}${kpi({ label: 'Yetishmagan', value: fmt.n(p.short_qty), ico: 'alert' })}${kpi({ label: 'O‘rt. delivery time', value: p.avg_lead_days != null ? `${p.avg_lead_days} kun` : '—', ico: 'truck' })}${kpi({ label: 'Quality rate', value: fmt.pct(p.quality_rate), ico: 'shield', tone: p.quality_rate >= 98 ? 'good' : 'warn' })}</div>
  <div class="grid g2">${card('Ma’lumotlar', dl([['Supplier ID', s.code], ['Kontakt', s.contact], ['Telefon', s.phone], ['Email', s.email], ['Manzil', s.address], ['Davlat', s.country], ['Shartnoma', `${s.contract_no || '—'} (${fmt.d(s.contract_until)} gacha)`], ['To‘lov shartlari', s.payment_terms], ['Izoh', s.notes]]))}
  ${card('Mahsulotlar va narxlar', raw(tableHtml([{ label: 'SKU', key: 'sku' }, { label: 'Narx', render: (x) => `${fmt.n(x.price)} ${x.currency}/${x.unit}` }, { label: 'Lead time', render: (x) => `${x.lead_time_days} kun` }, { label: 'MOQ', key: 'moq', num: true }], d.products)), { flush: true })}
  ${card('Yetkazib berish tarixi', raw(tableHtml([{ label: '№', key: 'delivery_no' }, { label: 'SKU', key: 'sku' }, { label: 'Miqdor', key: 'qty', num: true }, { label: 'Qabul', key: 'received_qty', num: true }, { label: 'Rad', key: 'rejected_qty', num: true }, { label: 'Kutilgan', render: (x) => fmt.d(x.expected_date) }, { label: 'Keldi', render: (x) => h`${fmt.d(x.actual_date)}${x.actual_date && new Date(x.actual_date) > new Date(new Date(x.expected_date).getTime() + 86400000) ? h` <span class="badge warn">kech</span>` : ''}` }, { label: 'Holat', render: (x) => badge(x.status) }], d.deliveries)), { flush: true })}
  ${card('Zayavkalar', raw(tableHtml([{ label: '№', key: 'pr_no' }, { label: 'SKU', key: 'sku' }, { label: 'Miqdor', key: 'qty', num: true }, { label: 'Holat', render: (x) => badge(x.status) }, { label: 'Sana', render: (x) => fmt.d(x.created_at) }], d.requests)), { flush: true })}</div>`);
  el.addEventListener('click', async (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a === 'edit') A.supplierForm(s); if (a === 'prod') { const r = await formModal({ title: 'Mahsulot narxi', fields: [{ name: 'productId', label: 'Mahsulot', type: 'select', required: true, options: opt.products(), full: true }, { name: 'price', label: 'Narx', type: 'number', required: true }, { name: 'currency', label: 'Valyuta', value: 'USD' }, { name: 'leadTimeDays', label: 'Lead time, kun', type: 'number', required: true }, { name: 'moq', label: 'MOQ', type: 'number', value: 1 }], onSubmit: (x) => POST(`/api/suppliers/${s.id}/products`, x) }); if (r) App.refresh(); } });
} });

// ================= Supplier deliveries =================
App.page('/deliveries', { title: 'Yetkazib berish', live: ['DELIVERY_DELAYED', 'DELIVERY_UPDATED', 'SUPPLIER_DELIVERY_ARRIVED', 'PURCHASE_REQUEST_STATUS', 'AI_SCAN'], async render({ el, query }) {
  const rows = await GET(`/api/supplier-deliveries${query.all ? '' : '?open=1'}`);
  const late = rows.filter((r) => ['CONFIRMED', 'IN_TRANSIT'].includes(r.status) && r.days_late >= 1);
  el.innerHTML = html(h`${pageHead('Yetkazib berishni nazorat qilish', 'Supplier ETA · kechikish alertlari (kutilgan sanadan keyingi kun — DELIVERY DELAY)')}
  ${late.length ? h`<div class="callout crit" style="margin-bottom:14px">${icon('alert')}<div><b>🔴 DELIVERY DELAY — ${late.length} ta</b>${late.map((d) => h`<div>Supplier ${d.company} tomonidan ${fmt.n(d.qty)} ${d.unit || ''} ${d.name || ''} ${d.days_late} kun kechikmoqda (kutilgan ${fmt.d(d.expected_date)}).</div>`)}</div></div>` : ''}
  <div class="tabs"><a href="#/deliveries" class="${query.all ? '' : 'active'}">Kutilayotgan</a><a href="#/deliveries?all=1" class="${query.all ? 'active' : ''}">Hammasi</a></div>${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows, rowClass: (r) => (['CONFIRMED', 'IN_TRANSIT'].includes(r.status) && r.days_late >= 1 ? 'hl' : ''), columns: [
    { key: 'delivery_no', label: 'Yetkazish', render: (r) => h`<b>${r.delivery_no}</b><div class="small muted">${r.pr_no} · ${r.po_no || ''}</div>` }, { key: 'company', label: 'Supplier' }, { key: 'sku', label: 'Material', render: (r) => h`${r.sku}<div class="small muted">${r.name}</div>` }, { key: 'qty', label: 'Miqdor', num: true },
    { key: 'expected_date', label: 'Expected', render: (r) => h`${fmt.d(r.expected_date)}${r.original_expected_date && r.original_expected_date !== r.expected_date ? h`<div class="small muted">dastlab ${fmt.d(r.original_expected_date)}</div>` : ''}` }, { key: 'actual_date', label: 'Actual', render: (r) => fmt.d(r.actual_date) },
    { key: 'days_late', label: 'Kechikish', render: (r) => (['CONFIRMED', 'IN_TRANSIT'].includes(r.status) && r.days_late >= 1 ? h`<span class="badge crit">🔴 ${r.days_late} kun</span>` : '—') }, { key: 'status', label: 'Holat', render: (r) => badge(r.status) },
    { label: '', sort: false, render: (r) => (['CONFIRMED', 'IN_TRANSIT'].includes(r.status) && can('procurement.manage') ? h`<button class="btn sm" data-rs="${r.id}">Sanani o‘zgartirish</button>` : '') }] });
  el.addEventListener('click', async (e) => { const b = e.target.closest('[data-rs]'); if (!b) return; const r = await formModal({ title: 'Yetkazish sanasini yangilash', fields: [{ name: 'expectedDate', label: 'Yangi kutilgan sana', type: 'date', required: true }, { name: 'reason', label: 'Sabab (supplier xabari)', full: true }], onSubmit: (d) => POST(`/api/supplier-deliveries/${b.dataset.rs}/reschedule`, d) }); if (r) { await POST('/api/ai/scan'); toast('Sana yangilandi, AI qayta tekshirdi', 'ok'); App.refresh(); } });
} });
