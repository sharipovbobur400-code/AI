/* Ombor sahifalari: dashboardlar, kirim/QC, chiqim, mahsulotlar, lokatsiyalar, rezerv, inventarizatsiya, brak, QR, traceability */
'use strict';
const A = App.actions = App.actions || {};

// ================= shared actions =================
A.receive = async (preset = {}) => {
  const fields = [
    { name: 'source', label: 'Manba', type: 'select', required: true, noEmpty: true, value: preset.source || 'SUPPLIER', options: [['SUPPLIER', 'Supplier (ta’minotchi)'], ['OTHER', 'Boshqa / boshlang‘ich qoldiq'], ['RETURN', 'Mijozdan qaytarish']] },
    { name: 'supplierId', label: 'Supplier', type: 'select', options: opt.suppliers(), value: preset.supplierId },
    { name: 'productId', label: 'Mahsulot', type: 'select', required: true, options: opt.products(), value: preset.productId, full: true },
    { name: 'qty', label: 'Qabul qilingan miqdor', type: 'number', required: true, min: 0 },
    { name: 'qtyExpected', label: 'Buyurtma bo‘yicha (PO) miqdor', type: 'number', min: 0, hint: 'Kiritilsa, kam kelgan miqdor avtomatik aniqlanadi' },
    { name: 'batchNo', label: 'Partiya (batch)', placeholder: 'Bo‘sh qolsa avtomatik' },
    { name: 'deliveryNumber', label: 'Yetkazish (nakladnoy) raqami' },
    { name: 'vehicle', label: 'Transport (davlat raqami)' }, { name: 'driver', label: 'Haydovchi' },
    { name: 'date', label: 'Sana', type: 'datetime-local', value: isoLocal() }, { name: 'weightKg', label: 'Og‘irlik, kg', type: 'number', min: 0 },
    { name: 'serials', label: 'Serial raqamlar (ixtiyoriy, har biri yangi qatorda)', type: 'textarea', full: true, hint: 'Serial kuzatiladigan mahsulot uchun bo‘sh qolsa, tizim avtomatik yaratadi' },
    { name: 'document', label: 'Hujjat (nakladnoy, sertifikat)', type: 'file', full: true, accept: '.pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx,.csv,.txt,.dwg' },
    { name: 'notes', label: 'Izoh', type: 'textarea', full: true, rows: 2 },
  ];
  const r = await formModal({ title: '+ Kirim — yukni qabul qilish', size: 'wide', fields, submitText: 'Qabul qilish', onSubmit: async (d) => {
    if (d.source === 'SUPPLIER' && !d.supplierId) throw new Error('Supplier tanlang');
    d.serials = d.serials ? d.serials.split(/\s+/).filter(Boolean) : undefined;
    const doc = d.document; delete d.document;
    const res = await POST('/api/receiving', d);
    if (doc) await POST('/api/documents', { docType: 'OTHER', title: `Kirim hujjati ${res.rcvNo}`, refType: 'receiving', refId: res.id, file: doc }).catch((e) => toast(e.message, 'err'));
    return res;
  } });
  if (r) {
    toast(`${r.rcvNo} qabul qilindi — status RECEIVING (QC kutilmoqda)`, 'ok', 'Kirim');
    if (r.check && r.check.short > 0) modal({ title: 'Kirimni avtomatik tekshirish', body: h`${dl([['Ordered', fmt.n(r.check.ordered)], ['Received', fmt.n(r.check.received)], ['Short', h`<b style="color:var(--crit-ink)">${fmt.n(r.check.short)}</b>`]])}<div style="margin-top:12px">${aiCallout(`Buyurtma bo‘yicha ${fmt.n(r.check.short)} dona mahsulot yetkazilmagan.`)}</div>` });
    App.refresh();
  }
};
A.production = async () => {
  const fields = [
    { name: 'productId', label: 'Mahsulot', type: 'select', required: true, options: opt.products((p) => ['FINISHED', 'WIP'].includes(p.category)), full: true },
    { name: 'productionOrder', label: 'Ishlab chiqarish buyurtmasi', required: true, placeholder: 'PRD-550W-0412' }, { name: 'batchNo', label: 'Partiya', placeholder: 'Avtomatik' },
    { name: 'total', label: 'Jami ishlab chiqarildi', type: 'number', required: true, min: 1 }, { name: 'good', label: 'Good (yaroqli)', type: 'number', required: true, min: 0 },
    { name: 'rework', label: 'Rework', type: 'number', value: 0, min: 0 }, { name: 'reject', label: 'Reject (brak)', type: 'number', value: 0, min: 0 },
    { type: 'html', name: 'x', full: true, html: '<div class="callout" data-sum>Good + Rework + Reject = Jami bo‘lishi shart. Omborga faqat GOOD qabul qilinadi; rework → REWORK zonasi, reject → SCRAP/REJECT.</div>' },
  ];
  const r = await formModal({ title: 'Ishlab chiqarishdan qabul qilish', size: 'wide', fields, submitText: 'Qabul qilish',
    onOpen: (bg) => { const upd = () => { const v = (n) => Number($(`[name=${n}]`, bg).value || 0); const t = v('total'); const s = v('good') + v('rework') + v('reject'); const c = $('[data-sum]', bg); c.className = `callout ${t && s === t ? 'good' : t ? 'crit' : ''}`; c.textContent = t ? `${v('good')} + ${v('rework')} + ${v('reject')} = ${s} ${s === t ? '✓ mos' : `≠ ${t} — ma’lumot mos emas`}` : c.textContent; }; $$('input', bg).forEach((i) => i.addEventListener('input', upd)); },
    onSubmit: (d) => POST('/api/receiving/production', d) });
  if (r) { toast(`Good ${r.good} → qabul zonasi (QC); rework ${r.rework}; reject ${r.reject}`, 'ok', 'Ishlab chiqarish'); App.refresh(); }
};
A.qc = async (rcvId) => {
  const d = await GET(`/api/receiving/${rcvId}`); const r = d.receiving;
  const fields = [{ name: 'passed', label: 'QC PASS → Mavjud', type: 'number', value: r.qty_received, min: 0 }, { name: 'failed', label: 'QC FAIL → Brak', type: 'number', value: 0, min: 0 }, { name: 'rework', label: 'Rework zonasi', type: 'number', value: 0, min: 0 },
    { name: 'notes', label: 'Izoh / nuqson tavsifi', type: 'textarea', full: true, rows: 2 }];
  const res = await formModal({ title: `QC — ${r.rcv_no}`, fields, cols: 3, submitText: 'QC natijasini saqlash', intro: h`<div style="margin-bottom:14px">${dl([['Mahsulot', `${r.sku} — ${r.name}`], ['Partiya', r.batch_no], ['Qabul qilingan', `${fmt.n(r.qty_received)} ${r.unit}`], ['Manba', label(r.source)], ['Joylashtirish taklifi', d.putaway.map((p) => `${p.code} (${fmt.n(p.qty)})${p.overflow ? ' ⚠' : ''}`).join(', ')]])}</div>`,
    onSubmit: (x) => POST(`/api/receiving/${rcvId}/qc`, x) });
  if (res) { toast(`${res.qcNo}: ${res.result}. ${res.placements.map((p) => `${p.code}: ${p.qty}`).join(', ')}`, res.result === 'PASS' ? 'ok' : 'warn', 'QC'); App.refresh(); }
};
A.issue = async (preset = {}) => {
  const fields = [{ name: 'productId', label: 'Mahsulot', type: 'select', required: true, options: opt.products(), value: preset.productId, full: true },
    { name: 'qty', label: 'Miqdor', type: 'number', required: true, min: 0 }, { name: 'reference', label: 'Hujjat / talabnoma raqami', placeholder: 'Avtomatik' },
    { name: 'reason', label: 'Sabab', type: 'select', required: true, options: ['Ishlab chiqarishga berildi', 'Qadoqlashga berildi', 'Namuna / test uchun', 'Ichki ehtiyoj', 'Boshqa'] },
    { type: 'html', name: 'x', full: true, html: '<div class="callout" data-avail>Mahsulotni tanlang — erkin qoldiq ko‘rsatiladi</div>' }];
  const r = await formModal({ title: '+ Chiqim — ombordan chiqarish', fields, submitText: 'Chiqarish',
    onOpen: (bg) => { const sel = $('[name=productId]', bg); const show = async () => { if (!sel.value) return; const p = await GET(`/api/products/${sel.value}`); $('[data-avail]', bg).innerHTML = `Mavjud: <b>${fmt.n(p.stock.available)}</b> · Rezerv: <b>${fmt.n(p.stock.reserved)}</b> · Erkin (chiqarish mumkin): <b>${fmt.n(p.stock.free)}</b> ${esc(p.product.unit)}`; }; sel.addEventListener('change', show); show(); },
    onSubmit: (d) => POST('/api/inventory/issue', d) });
  if (r) { toast(`Chiqim ${r.reference} bajarildi`, 'ok'); App.refresh(); }
};
A.transfer = async (preset = {}) => {
  const locs = await GET('/api/locations');
  const lo = locs.map((l) => [l.id, `${l.code} · ${l.zone_name}${l.skus ? ` · ${l.skus}` : ''}`]);
  const fields = [{ name: 'productId', label: 'Mahsulot', type: 'select', required: true, options: opt.products(), value: preset.productId, full: true },
    { name: 'fromLocationId', label: 'Qayerdan', type: 'select', required: true, options: lo, value: preset.fromLocationId }, { name: 'toLocationId', label: 'Qayerga', type: 'select', required: true, options: lo },
    { name: 'qty', label: 'Miqdor', type: 'number', required: true, min: 0 }, { name: 'status', label: 'Holat', type: 'select', noEmpty: true, required: true, options: [['AVAILABLE', 'Mavjud'], ['REWORK', 'Rework'], ['SCRAP', 'Brak'], ['PACKED', 'Qadoqlangan']], value: preset.status || 'AVAILABLE' },
    { name: 'reason', label: 'Sabab', full: true, placeholder: 'Masalan: omborlararo transfer, joyni optimallashtirish' }];
  const r = await formModal({ title: 'Ko‘chirish (transfer)', size: 'wide', fields, submitText: 'Ko‘chirish', onSubmit: (d) => POST('/api/inventory/transfer', d) });
  if (r) { toast(`Transfer ${r.reference} bajarildi (TRANSFER −/+)`, 'ok'); App.refresh(); }
};
A.reserve = async (preset = {}) => {
  const orders = await GET('/api/orders?open=1');
  const fields = [{ name: 'productId', label: 'Mahsulot', type: 'select', required: true, options: opt.products(), value: preset.productId, full: true }, { name: 'qty', label: 'Miqdor', type: 'number', required: true, min: 0 },
    { name: 'orderId', label: 'Buyurtma', type: 'select', options: orders.map((o) => [o.id, `${o.order_no} — ${o.customer}`]), value: preset.orderId }, { name: 'projectId', label: 'yoki Loyiha (oldindan rezerv)', type: 'select', options: opt.projects() },
    { name: 'note', label: 'Izoh', full: true }, { type: 'html', name: 'x', full: true, html: '<div class="callout" data-avail>Mahsulotni tanlang</div>' }];
  const r = await formModal({ title: '+ Rezerv', size: 'wide', fields, submitText: 'Rezerv qilish',
    onOpen: (bg) => { const sel = $('[name=productId]', bg); const show = async () => { if (!sel.value) return; const p = await GET(`/api/products/${sel.value}`); $('[data-avail]', bg).innerHTML = `Available: <b>${fmt.n(p.stock.available)}</b> · Reserved: <b>${fmt.n(p.stock.reserved)}</b> · Free: <b>${fmt.n(p.stock.free)}</b>`; }; sel.addEventListener('change', show); show(); },
    onSubmit: (d) => { if (!d.orderId && !d.projectId) throw new Error('Buyurtma yoki loyihani tanlang'); return POST('/api/inventory/reservations', d); } });
  if (r) { toast(`${r.resNo} rezerv qilindi. Free: ${fmt.n(r.stock?.free)}`, 'ok'); App.refresh(); }
};
A.productForm = async (p) => {
  const v = p || { unit: 'dona', units_per_pallet: 1, max_stack: 1, pallet_weight_kg: 25 };
  const fields = [
    { name: 'sku', label: 'SKU', required: true, value: v.sku }, { name: 'name', label: 'Nomi', required: true, value: v.name }, { name: 'model', label: 'Model', value: v.model },
    { name: 'category', label: 'Kategoriya', type: 'select', required: true, options: opt.enumOf(CAT), value: v.category }, { name: 'manufacturer', label: 'Ishlab chiqaruvchi', value: v.manufacturer }, { name: 'unit', label: 'Birlik', value: v.unit },
    { name: 'power_w', label: 'Quvvat (W)', type: 'number', value: v.power_w }, { name: 'length_mm', label: 'Uzunlik, mm', type: 'number', value: v.length_mm }, { name: 'width_mm', label: 'Kenglik, mm', type: 'number', value: v.width_mm },
    { name: 'height_mm', label: 'Qalinlik / balandlik, mm', type: 'number', value: v.height_mm }, { name: 'net_weight_kg', label: 'Net og‘irlik, kg', type: 'number', value: v.net_weight_kg }, { name: 'gross_weight_kg', label: 'Gross og‘irlik, kg', type: 'number', value: v.gross_weight_kg },
    { name: 'units_per_pallet', label: 'Palletdagi soni', type: 'number', value: v.units_per_pallet }, { name: 'pallet_weight_kg', label: 'Pallet og‘irligi, kg', type: 'number', value: v.pallet_weight_kg }, { name: 'packaging_weight_kg', label: 'Qadoq og‘irligi (pallet), kg', type: 'number', value: v.packaging_weight_kg },
    { name: 'pallet_length_mm', label: 'Pallet uzunligi, mm', type: 'number', value: v.pallet_length_mm }, { name: 'pallet_width_mm', label: 'Pallet kengligi, mm', type: 'number', value: v.pallet_width_mm }, { name: 'pallet_height_mm', label: 'To‘liq pallet balandligi, mm', type: 'number', value: v.pallet_height_mm },
    { name: 'packaging_type', label: 'Qadoq turi', value: v.packaging_type }, { name: 'max_stack', label: 'Maks. stack (qavat)', type: 'number', value: v.max_stack }, { name: 'orientation', label: 'Joylashuv', type: 'select', options: [['VERTICAL', 'Vertikal'], ['HORIZONTAL', 'Gorizontal']], value: v.orientation },
    { name: 'barcode', label: 'Barcode', value: v.barcode }, { name: 'min_stock', label: 'Minimal zaxira', type: 'number', value: v.min_stock }, { name: 'lead_time_days', label: 'Yetkazish muddati, kun', type: 'number', value: v.lead_time_days },
    { name: 'default_supplier_id', label: 'Asosiy supplier', type: 'select', options: opt.suppliers(), value: v.default_supplier_id }, { name: 'packing_standard', label: 'Qadoqlash standarti', value: v.packing_standard, full: true },
    { name: 'electrical_spec', label: 'Elektr parametrlari', value: v.electrical_spec, full: true },
    { name: 'track_serial', label: 'Serial raqam bo‘yicha kuzatish', type: 'checkbox', value: !!v.track_serial }, { name: 'fragile', label: 'Nozik mahsulot', type: 'checkbox', value: !!v.fragile },
  ];
  const r = await formModal({ title: p ? `Mahsulotni tahrirlash — ${p.sku}` : '+ Mahsulot', size: 'xl', cols: 3, fields, onSubmit: (d) => (p ? PUT(`/api/products/${p.id}`, d) : POST('/api/products', d)) });
  if (r) { toast('Mahsulot saqlandi', 'ok'); await App.loadMeta(); App.refresh(); }
};

// ================= Ombor Dashboard =================
App.page('/dashboard', { title: 'Ombor Dashboard', live: true, async render({ el }) {
  const d = await GET('/api/dashboard/warehouse'); const k = d.kpi;
  const prev = App._prevKpi || {}; App._prevKpi = k;
  const delta = (key) => (prev[key] != null && prev[key] !== k[key] ? h`<span class="delta ${k[key] > prev[key] ? 'up' : 'down'}">${k[key] > prev[key] ? '▲' : '▼'} ${fmt.n(Math.abs(k[key] - prev[key]))}</span>` : '');
  const tiles = [
    ['total', 'Jami mahsulot', fmt.n(k.total), 'box', '', '#/stock', 'barcha holatlar (brakdan tashqari)'], ['available', 'Mavjud', fmt.n(k.available), 'check', 'good', '#/stock', `erkin: ${fmt.n(k.free)}`],
    ['reserved', 'Rezerv qilingan', fmt.n(k.reserved), 'lock', 'blue', '#/reservations'], ['shortage', 'Yetishmayotgan', fmt.n(k.shortage), 'alert', k.shortage ? 'crit' : 'good', '#/shortages'],
    ['rework', 'Rework', fmt.n(k.rework), 'rework', k.rework ? 'warn' : '', '#/quality', 'qayta ishlashda'], ['scrap', 'Brak', fmt.n(k.scrap), 'scrap', '', '#/quality'],
    ['readyToShip', 'Jo‘natishga tayyor', fmt.n(k.readyToShip), 'pack', 'good', '#/packing', `${k.readyPallets} pallet`], ['incomingToday', 'Bugun keladigan yuk', fmt.n(k.incomingToday), 'in', 'blue', '#/deliveries', `qabulda: ${fmt.n(k.receiving)}`],
    ['lateIncoming', 'Kechikayotgan yuk', fmt.n(k.lateIncoming), 'clock', k.lateIncoming ? 'crit' : 'good', '#/deliveries'], ['shipToday', 'Bugun jo‘natiladigan', fmt.n(k.shipToday), 'truck', 'blue', '#/shipments'],
    ['needTransport', 'Transport kerak', fmt.n(k.needTransport), 'truck', k.needTransport ? 'warn' : '', '#/transport'], ['alerts', 'AI ogohlantirishlar', fmt.n(k.alerts), 'ai', k.alerts ? 'crit' : 'good', '#/ai'],
  ];
  if (!App.meta?.modules?.logistics) { for (const k of ['shipToday', 'needTransport']) tiles.splice(tiles.findIndex((t) => t[0] === k), 1); const r = tiles.find((t) => t[0] === 'readyToShip'); if (r) r[1] = 'Qadoqlangan (tayyor)'; }
  const changed = tiles.filter((t) => prev[t[0]] != null && prev[t[0]] !== k[t[0]]).map((t) => t[0]);
  el.innerHTML = html(h`${pageHead('Ombor Dashboard', `Real vaqt · oxirgi yangilanish ${fmt.t(new Date())}`, h`${btn('Kirim', { cls: 'primary', ico: 'in', attrs: 'data-a="rcv"', perm: 'stock.receive' })}${btn('Ishlab chiqarishdan', { ico: 'factory', attrs: 'data-a="prod"', perm: 'stock.receive' })}${btn('Chiqim', { ico: 'out', attrs: 'data-a="iss"', perm: 'stock.issue' })}${btn('QR Scan', { ico: 'qr', attrs: 'data-a="scan"' })}`)}
  <div class="kpis">${tiles.map(([key, l, v, ico, tone, href, sub]) => kpi({ label: h`${l}${delta(key)}`, value: v, ico, tone, href, sub, key }))}</div>
  <div class="grid g-main" style="margin-bottom:16px">
    ${card('Tayyor mahsulot qoldig‘i', raw('<div data-fg></div>'), { sub: 'Available · Reserved · Free', flush: true, actions: btn('Rezerv', { cls: 'sm', ico: 'lock', attrs: 'data-a="res"', perm: 'stock.reserve' }) })}
    ${card('AI ogohlantirishlar', h`<div class="alert-list">${d.alerts.length ? d.alerts.slice(0, 7).map(alertRow) : raw('<div class="empty">Hozircha ogohlantirish yo‘q</div>')}</div>`, { flush: true, actions: h`<a class="btn sm ghost" href="#/ai">Barchasi</a>` })}
  </div>
  <div class="grid g2" style="margin-bottom:16px">
    ${card('Tayyor mahsulot harakati (14 kun)', raw('<div data-chart></div>'), { sub: 'dona / kun' })}
    ${card('Ombor sig‘imi', barList(d.capacity.map((c) => ({ label: `${c.id} · ${c.name}`, value: c.pct, text: `${fmt.pct(c.pct)} · ${c.usedPallets}/${c.positions} pallet`, tone: c.pct >= 95 ? 'crit' : c.pct >= 85 ? 'warn' : 'none' })), { max: 100 }), { sub: 'band pallet pozitsiyalari', actions: h`<a class="btn sm ghost" href="#/warehouses">Omborlar</a>` })}
  </div>
  <div class="grid g3">
    ${card('Bugun keladigan / kechikayotgan yuk', raw(tableHtml([{ label: 'Supplier', render: (r) => h`${r.company}<div class="small muted">${r.name || ''}</div>` }, { label: 'Miqdor', key: 'qty', num: true }, { label: 'Kutilgan', render: (r) => h`${fmt.d(r.expected_date)} ${r.late ? badge('OPEN', 'Kechikmoqda') : ''}` }], [...d.lateIncoming.map((x) => ({ ...x, late: 1 })), ...d.incomingToday], 'Bugun kutilayotgan yuk yo‘q')), { flush: true })}
    ${!App.meta?.modules?.logistics ? '' : card('Bugun jo‘natiladigan', raw(tableHtml([{ label: 'Jo‘natma', render: (r) => h`<a href="#/shipments/${r.ship_no}">${r.ship_no}</a>` }, { label: 'Holat', render: (r) => badge(r.status) }, { label: 'Jo‘nash', render: (r) => fmt.t(r.planned_departure) }], d.shipToday, 'Bugun jo‘natma rejalashtirilmagan')), { flush: true })}
    ${card('Oxirgi tranzaksiyalar', raw(tableHtml([{ label: 'Tur', render: (r) => h`<span class="badge plain dark">${TXN[r.type] || r.type}</span>` }, { label: 'SKU', key: 'sku' }, { label: 'Miqdor', key: 'qty', num: true }, { label: 'Vaqt', render: (r) => h`<span class="small muted">${fmt.rel(r.created_at)}</span>` }], d.recent)), { flush: true, actions: h`<a class="btn sm ghost" href="#/transactions">Jurnal</a>` })}
  </div>`);
  changed.forEach((c) => $(`[data-kpi="${c}"]`, el)?.classList.add('changed'));
  dataTable($('[data-fg]', el), { search: false, pageSize: 10, rows: d.finished, onRow: (r) => go(`#/products/${r.product_id}`), columns: [
    { key: 'sku', label: 'SKU', render: (r) => h`<b>${r.sku}</b><div class="small muted">${r.name}</div>` }, { key: 'available', label: 'Available', num: true }, { key: 'reserved', label: 'Reserved', num: true },
    { key: 'free', label: 'Free', num: true, render: (r) => h`<b style="color:${r.free <= 0 ? 'var(--crit-ink)' : 'inherit'}">${fmt.n(r.free)}</b>` }, { key: 'receiving', label: 'Qabulda', num: true }, { key: 'packed', label: 'Qadoqlangan', num: true },
    { key: 'shortage', label: 'Yetishmovchilik', num: true, render: (r) => (r.shortage ? h`<span style="color:var(--crit-ink);font-weight:600">🔴 ${fmt.n(r.shortage)}</span>` : '—') }] });
  const days = []; for (let i = 13; i >= 0; i--) { const dd = new Date(Date.now() - i * 86400000); days.push(dd.toISOString().slice(0, 10)); }
  const byDay = Object.fromEntries(d.movement.map((m) => [m.d, m]));
  lineChart($('[data-chart]', el), { labels: days.map((x) => x.slice(8, 10) + '.' + x.slice(5, 7)), series: [{ name: 'Kirim', color: 'var(--s1)', values: days.map((x) => byDay[x]?.inq || 0) }, { name: 'Jo‘natish / chiqim', color: 'var(--s2)', values: days.map((x) => byDay[x]?.outq || 0) }] });
  el.addEventListener('click', (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return; ({ rcv: A.receive, prod: A.production, iss: A.issue, res: A.reserve, scan: () => openScanner((c) => go(`#/qr?code=${encodeURIComponent(c)}`)) })[a]?.(); });
} });
function alertRow(a) {
  const ref = { order: `#/orders/${a.ref_id}`, shortage: '#/shortages', delivery: '#/deliveries', shipment: `#/shipments/${a.ref_id}`, warehouse: '#/warehouses', product: `#/products/${a.ref_id}`, receiving: '#/receiving', xetq: `#/xetq/${a.ref_id}`, picking: `#/picking/${a.ref_id}`, zone: '#/counts' }[a.ref_type];
  return h`<div class="alert ${a.severity}"><div class="ai-ico">${icon(a.severity === 'INFO' ? 'ai' : 'alert')}</div><div><div class="a-title">${ref ? h`<a href="${ref}" style="color:inherit">${a.title}</a>` : a.title}</div><div class="a-msg">${a.message}</div></div><div class="a-time">${fmt.rel(a.updated_at || a.created_at)}</div></div>`;
}
App.alertRow = alertRow;

// ================= Director =================
App.page('/director', { title: 'Direktor paneli', live: true, async render({ el }) {
  const d = await GET('/api/dashboard/director');
  const T = (lbl, v, s, tone, href) => h`<a class="dtile ${tone}" href="${href}"><div class="dl">${lbl}</div><div class="dv num">${v}</div><div class="ds">${s}</div></a>`;
  el.innerHTML = html(h`${pageHead('Direktor paneli', 'Barcha modullar bitta oynada — real vaqt')}
  <div class="dtiles">
    ${T('Ombor', fmt.pct(d.warehouse.pct), `${d.warehouse.usedPallets} / ${d.warehouse.positions} pallet pozitsiya · panel erkin ${fmt.n(d.stock.free)}`, d.warehouse.pct >= 85 ? 'warn' : 'good', '#/warehouses')}
    ${T('Ta’minot', `${d.supply.shortages} ta shortage`, `${fmt.n(d.supply.shortageQty)} dona yetishmaydi · ${d.supply.awaitingApproval} zayavka tasdiq kutmoqda`, d.supply.shortages ? 'crit' : 'good', '#/shortages')}
    ${T('Supplier', `${d.supplier.delays} ta kechikish`, `${d.supplier.inTransit} ta yetkazish yo‘lda`, d.supplier.delays ? 'crit' : 'good', '#/deliveries')}
    ${T('Yig‘ish', `${fmt.n(d.picking.picked)} / ${fmt.n(d.picking.required)}`, `${d.picking.openTasks} ta ochiq picking topshirig‘i`, 'blue', '#/picking')}
    ${!App.meta?.modules?.logistics ? '' : T('Logistika', `${d.logistics.active} ta shipment`, `yo‘lda ${d.logistics.inTransit} · yuklanmoqda ${d.logistics.loading}${d.logistics.late ? ` · 🔴 kechikmoqda ${d.logistics.late}` : ''}`, d.logistics.late ? 'warn' : 'blue', '#/shipments')}
    ${!App.meta?.modules?.logistics ? '' : T('Transport', `${d.transport.available} ta available`, d.transport.byStatus.map((s) => `${VEH_ICON[s.status]} ${s.n}`).join('  '), d.transport.available ? 'good' : 'warn', '#/transport')}
    ${T('XETQ', `${d.xetq.inReview} ta hujjat reviewda`, `tuzatish kerak: ${d.xetq.revision} · tasdiqlangan: ${d.xetq.approved}`, d.xetq.revision ? 'warn' : 'blue', '#/xetq')}
    ${T('AI', `${d.ai.alerts} ta alert`, `shundan kritik: ${d.ai.critical}`, d.ai.critical ? 'crit' : 'good', '#/ai')}
  </div>
  <div class="grid g-main">
    ${card('AI Direktorga savol bering', h`<div class="chips" style="margin-bottom:10px">${['Omborda nima yetishmayapti?', 'Qaysi supplier kechikyapti?', 'Omborda nechta panel bor?', 'Bugun nima ishlab chiqarish kerak?', ...(App.meta?.modules?.logistics ? ['Ertangi jo‘natmaga yetadimi?', 'Qaysi shipment yo‘lda?'] : []), 'XETQ kelishuvi qaysi bosqichda?', 'AI qanday xavflarni ko‘rmoqda?'].map((q) => h`<button class="chip" data-q="${q}">${q}</button>`)}</div>
      <form data-ask style="display:flex;gap:8px"><input class="input" name="q" placeholder="Savolingizni yozing…" aria-label="Savol"><button class="btn primary">${icon('send')}So‘rash</button></form><div data-answer style="margin-top:12px"></div>`)}
    ${card('Kritik xavflar', h`<div class="alert-list">${d.ai.top.length ? d.ai.top.map(alertRow) : raw('<div class="empty">Xavf aniqlanmadi</div>')}</div>`, { flush: true })}
  </div>
  <div class="grid g2" style="margin-top:16px">
    ${card('Ombor sig‘imi', barList(d.warehouse.capacity.map((c) => ({ label: `${c.id} · ${c.name}`, value: c.pct, text: fmt.pct(c.pct), tone: c.pct >= 95 ? 'crit' : c.pct >= 85 ? 'warn' : 'none' })), { max: 100 }))}
    ${card('Buyurtmalar holati', barList(d.orders.map((o) => ({ label: label(o.status), value: o.n, text: `${o.n} ta` }))))}
  </div>`);
  const ask = async (q) => { const box = $('[data-answer]', el); box.innerHTML = '<div class="sk sk-line"></div><div class="sk sk-line" style="width:70%"></div>'; try { const r = await POST('/api/ai/ask', { question: q }); box.innerHTML = html(h`<div class="callout ai">${icon('ai')}<div><b>${q}</b><div class="ai-text" style="margin-top:6px">${r.answer}</div><div class="small muted" style="margin-top:6px">Manba: ${r.source === 'database' ? 'real vaqtdagi database ma’lumotlari' : 'database + LLM'}</div></div></div>`); } catch (e) { box.innerHTML = html(h`<div class="callout crit">${e.message}</div>`); } };
  $$('[data-q]', el).forEach((b) => b.addEventListener('click', () => ask(b.dataset.q)));
  $('[data-ask]', el).addEventListener('submit', (e) => { e.preventDefault(); const q = e.target.q.value.trim(); if (q) ask(q); });
} });

// ================= Tasks =================
App.page('/tasks', { title: 'Topshiriqlar', live: ['TASK_CREATED', 'TASK_ASSIGNED', 'PICKING_STARTED', 'PICKING_COMPLETED', 'PACKING_COMPLETED', 'LOADING_STARTED', 'LOADING_COMPLETED', 'MATERIAL_RECEIVED'], async render({ el, query }) {
  const all = query.all === '1' && can('tasks.assign');
  const tasks = await GET(`/api/tasks${all ? '?all=1' : ''}`);
  const KIND = { picking: ['Picking', 'pick'], packing: ['Packing', 'pack'], loading: ['Yuklash', 'load'], qc: ['QC', 'shield'] };
  el.innerHTML = html(h`${pageHead(all ? 'Barcha topshiriqlar' : 'Bugungi topshiriqlar', 'Pending → In Progress → Completed', can('tasks.assign') ? h`<a class="btn ${all ? '' : 'primary'}" href="#/tasks">Mening</a><a class="btn ${all ? 'primary' : ''}" href="#/tasks?all=1">Hammasi</a>` : '')}
    ${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows: tasks, empty: 'Hozircha topshiriq yo‘q', rowClass: (r) => (r.overdue ? 'hl' : ''), columns: [
    { key: 'kind', label: 'Turi', render: (r) => h`<span class="badge plain blue">${icon(KIND[r.kind][1])} ${KIND[r.kind][0]}</span>` }, { key: 'task_no', label: 'Topshiriq', render: (r) => h`<b>${r.task_no}</b>` }, { key: 'ref', label: 'Asos' },
    { key: 'qty', label: 'Miqdor', num: true }, { key: 'status', label: 'Holat', render: (r) => badge(r.status) }, { key: 'assignee', label: 'Ijrochi', render: (r) => r.assignee || h`<span class="muted">—</span>` },
    { key: 'deadline', label: 'Deadline', render: (r) => h`${fmt.dt(r.deadline)} ${r.overdue ? h`<span class="badge crit">🔴 kechikdi</span>` : ''}` },
    { label: '', sort: false, render: (r) => h`<div style="display:flex;gap:6px;justify-content:flex-end">${can('tasks.assign') && r.kind !== 'qc' ? h`<button class="btn sm" data-assign="${r.kind}:${r.id}">Biriktirish</button>` : ''}<button class="btn sm primary" data-open="${r.kind}:${r.id}:${r.ref}">Ochish</button></div>` }] });
  el.addEventListener('click', async (e) => {
    const o = e.target.closest('[data-open]'); if (o) { const [k, id, ref] = o.dataset.open.split(':'); if (k === 'picking') go(`#/picking/${id}`); else if (k === 'packing') go('#/packing'); else if (k === 'loading') { const lt = (await GET('/api/loading')).find((x) => x.id === Number(id)); go(`#/shipments/${lt.ship_no}`); } else A.qc(id); }
    const a = e.target.closest('[data-assign]'); if (a) { const [kind, id] = a.dataset.assign.split(':'); const sug = await GET('/api/tasks/suggest'); const r = await formModal({ title: 'Topshiriqni biriktirish', intro: h`<div class="callout ai" style="margin-bottom:12px">${icon('ai')}<div>Tavsiya etilgan ijrochi: <b>${sug.worker?.full_name || '—'}</b> (eng kam ochiq topshiriq, eng past xato darajasi)</div></div>`, fields: [{ name: 'userId', label: 'Xodim', type: 'select', required: true, options: opt.users(['STOREKEEPER', 'MANAGER', 'LOGISTICS']), value: sug.worker?.id, full: true }], onSubmit: (d) => POST('/api/tasks/assign', { kind, id: Number(id), userId: Number(d.userId) }) }); if (r) { toast('Biriktirildi', 'ok'); App.refresh(); } }
  });
} });

// ================= Kirim =================
App.page('/receiving', { title: 'Kirim', live: ['MATERIAL_RECEIVED', 'STOCK_CHANGED', 'QC_FAILED'], async render({ el, query }) {
  const rows = await GET(`/api/receiving?limit=500${query.source ? `&source=${query.source}` : ''}`);
  const pending = rows.filter((r) => r.status === 'RECEIVING');
  el.innerHTML = html(h`${pageHead(query.source === 'RETURN' ? 'Qaytarilgan mahsulot' : 'Kirim', 'Qabul → RECEIVING → QC → APPROVED / Brak', h`${btn(query.source === 'RETURN' ? '+ Qaytarish' : '+ Kirim', { cls: 'primary', ico: 'in', attrs: 'data-a="rcv"', perm: 'stock.receive' })}${query.source !== 'RETURN' ? btn('Ishlab chiqarishdan', { ico: 'factory', attrs: 'data-a="prod"', perm: 'stock.receive' }) : ''}`)}
    ${pending.length ? h`<div class="callout warn" style="margin-bottom:14px">${icon('clock')}<div><b>${pending.length} ta kirim QC kutmoqda</b> — ${pending.slice(0, 4).map((p) => `${p.rcv_no} (${p.sku}, ${fmt.n(p.qty_received)})`).join(', ')}</div></div>` : ''}
    <div class="tabs"><a href="#/receiving" class="${!query.source ? 'active' : ''}">Hammasi</a><a href="#/receiving?source=SUPPLIER" class="${query.source === 'SUPPLIER' ? 'active' : ''}">Supplier</a><a href="#/receiving?source=PRODUCTION" class="${query.source === 'PRODUCTION' ? 'active' : ''}">Ishlab chiqarish</a><a href="#/receiving?source=RETURN" class="${query.source === 'RETURN' ? 'active' : ''}">Qaytarilgan</a></div>
    ${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows, onRow: (r) => rcvDetail(r.id), columns: [
    { key: 'rcv_no', label: 'Kirim №', render: (r) => h`<b>${r.rcv_no}</b><div class="small muted">${fmt.dt(r.received_date || r.created_at)}</div>` }, { key: 'source', label: 'Manba', render: (r) => badge(r.source) },
    { key: 'sku', label: 'Mahsulot', render: (r) => h`${r.sku}<div class="small muted">${r.supplier || r.production_order || ''}</div>` }, { key: 'batch_no', label: 'Partiya', render: (r) => h`<span class="mono">${r.batch_no || '—'}</span>` },
    { key: 'qty_expected', label: 'Kutilgan', num: true }, { key: 'qty_received', label: 'Qabul', num: true, render: (r) => h`${fmt.n(r.qty_received)}${r.qty_expected && r.qty_received < r.qty_expected ? h` <span class="badge crit">−${fmt.n(r.qty_expected - r.qty_received)}</span>` : ''}` },
    { key: 'status', label: 'Holat', render: (r) => badge(r.status) }, { label: '', sort: false, render: (r) => (r.status === 'RECEIVING' && can('stock.qc') ? h`<button class="btn sm accent" data-qc="${r.id}">QC</button>` : '') }] });
  el.addEventListener('click', (e) => { const q = e.target.closest('[data-qc]'); if (q) return A.qc(q.dataset.qc); const a = e.target.closest('[data-a]')?.dataset.a; if (a === 'rcv') A.receive(query.source === 'RETURN' ? { source: 'RETURN' } : {}); if (a === 'prod') A.production(); });
} });
async function rcvDetail(id) {
  const d = await GET(`/api/receiving/${id}`); const r = d.receiving;
  await modal({ title: `Kirim ${r.rcv_no}`, size: 'wide', body: h`<div class="grid g2">${dl([['Holat', badge(r.status)], ['Manba', label(r.source)], ['Mahsulot', `${r.sku} — ${r.name}`], ['Partiya', r.batch_no], ['Supplier', r.supplier], ['PO / Delivery', `${r.po_id || '—'} / ${r.delivery_number || '—'}`], ['Transport / haydovchi', `${r.vehicle || '—'} / ${r.driver || '—'}`]])}
    ${dl([['Kutilgan', fmt.n(r.qty_expected)], ['Qabul qilingan', fmt.n(r.qty_received)], ['Og‘irlik', fmt.kg(r.weight_kg)], ['Ishlab chiqarish', r.production_order ? `${r.production_order}: jami ${fmt.n(r.production_total)}, rework ${r.rework_qty}, reject ${r.reject_qty}` : '—'], ['QC muddati', fmt.dt(r.deadline)], ['Izoh', r.notes]])}</div>
    <h4>QC natijalari</h4>${raw(tableHtml([{ label: 'QC №', key: 'qc_no' }, { label: 'Natija', render: (q) => badge(q.result) }, { label: 'O‘tdi', key: 'passed_qty', num: true }, { label: 'Yiqildi', key: 'failed_qty', num: true }, { label: 'Rework', key: 'rework_qty', num: true }, { label: 'Izoh', key: 'notes' }], d.qc, 'QC hali o‘tkazilmagan'))}
    ${d.serials.length ? h`<h4>Serial raqamlar (${d.serials.length})</h4><div class="mono small" style="max-height:120px;overflow:auto">${d.serials.map((s) => s.serial).join(', ')}</div>` : ''}
    <h4>Hujjatlar</h4>${d.documents.length ? d.documents.map((x) => h`<div><a href="#/documents?open=${x.id}">${x.doc_no}</a> ${x.doc_type} v${x.current_version}</div>`) : raw('<div class="muted small">Hujjat yo‘q</div>')}`,
  footer: h`${can('documents.manage') ? h`<button class="btn" data-g="RECEIVING_REPORT">${icon('doc')}Receiving Report</button><button class="btn" data-g="QC_REPORT">${icon('doc')}QC Report</button>` : ''}${r.status === 'RECEIVING' && can('stock.qc') ? h`<button class="btn accent" data-qcx>QC o‘tkazish</button>` : ''}`,
  onOpen: (bg, close) => { $$('[data-g]', bg).forEach((b) => b.addEventListener('click', () => act(b, () => POST('/api/documents/generate', { type: b.dataset.g, refType: 'receiving', refId: id }), (x) => `${x.docNo} v${x.version} yaratildi`))); $('[data-qcx]', bg)?.addEventListener('click', () => { close(); A.qc(id); }); } });
}

// ================= Chiqim / Ko‘chirish / Tranzaksiyalar =================
const txnPage = (path, title, sub, type, action, perm, ico) => App.page(path, { title, live: ['STOCK_CHANGED'], async render({ el }) {
  const rows = await GET(`/api/inventory/transactions?limit=500${type ? `&type=${type}` : ''}`);
  el.innerHTML = html(h`${pageHead(title, sub, action ? btn(action[0], { cls: 'primary', ico, attrs: 'data-a', perm }) : '')}${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows, pageSize: 30, columns: [
    { key: 'txn_no', label: 'Tranzaksiya', render: (r) => h`<span class="mono">${r.txn_no}</span>` }, { key: 'type', label: 'Turi', render: (r) => h`<span class="badge plain dark">${TXN[r.type] || r.type}</span>` },
    { key: 'sku', label: 'Mahsulot', render: (r) => h`${r.sku}${r.batch_no ? h`<div class="small muted mono">${r.batch_no}</div>` : ''}` },
    { key: 'qty', label: 'Miqdor', num: true, render: (r) => h`<b>${['ISSUE', 'SHIP', 'SCRAP'].includes(r.type) || (r.type === 'ADJUSTMENT' && r.from_loc) ? '−' : ['RECEIVE', 'RETURN'].includes(r.type) || (r.type === 'ADJUSTMENT' && r.to_loc) ? '+' : ''}${fmt.n(r.qty)}</b> <span class="muted small">${r.unit}</span>${r.serial_count ? h`<div class="small muted">${r.serial_count} serial</div>` : ''}` },
    { key: 'from_loc', label: 'Qayerdan', render: (r) => h`<span class="mono small">${r.from_loc || '—'}</span>${r.from_status ? h`<div class="small muted">${label(r.from_status)}</div>` : ''}` }, { key: 'to_loc', label: 'Qayerga', render: (r) => h`<span class="mono small">${r.to_loc || '—'}</span>${r.to_status ? h`<div class="small muted">${label(r.to_status)}</div>` : ''}` },
    { key: 'user', label: 'Foydalanuvchi' }, { key: 'reference', label: 'Asos', render: (r) => h`${r.reference || ''}<div class="small muted">${r.reason || ''}</div>` }, { key: 'created_at', label: 'Vaqt', render: (r) => fmt.dt(r.created_at) }] });
  $('[data-a]', el)?.addEventListener('click', () => (type === 'TRANSFER' ? A.transfer() : A.issue()));
} });
txnPage('/issue', 'Chiqim', 'Erkin (rezerv qilinmagan) qoldiqdan chiqarish · manfiy qoldiqqa ruxsat berilmaydi', 'ISSUE', ['+ Chiqim'], 'stock.issue', 'out');
txnPage('/transfer', 'Ko‘chirish', 'Lokatsiyalar va omborlar orasida transfer (TRANSFER −/+)', 'TRANSFER', ['+ Ko‘chirish'], 'stock.transfer', 'swap');
txnPage('/transactions', 'Inventory tranzaksiyalar jurnali', 'Har bir stock o‘zgarishi — o‘chirib bo‘lmaydigan tranzaksiya', null, null);

// ================= Mahsulotlar =================
App.page('/products', { title: 'Mahsulotlar', live: ['STOCK_CHANGED', 'PRODUCT_CHANGED'], async render({ el, query }) {
  const rows = await GET(`/api/products${query.cat ? `?category=${query.cat}` : ''}`);
  const tabs = [['', 'Hammasi'], ['FINISHED', 'Tayyor mahsulot'], ['RAW', 'Xomashyo'], ['WIP', 'Yarim tayyor'], ['MATERIAL', 'Materiallar'], ['PACKAGING', 'Qadoq']];
  el.innerHTML = html(h`${pageHead(query.cat ? CAT[query.cat] : 'Mahsulotlar', 'Mahsulot kartochkalari, o‘lcham, og‘irlik, pallet parametrlari va real vaqt qoldig‘i', btn('+ Mahsulot', { cls: 'primary', ico: 'plus', attrs: 'data-a', perm: 'products.manage' }))}
    <div class="tabs">${tabs.map(([c, l]) => h`<a href="#/products${c ? `?cat=${c}` : ''}" class="${(query.cat || '') === c ? 'active' : ''}">${l}</a>`)}</div>${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows, onRow: (r) => go(`#/products/${r.id}`), searchKeys: ['sku', 'name', 'model', 'barcode'], columns: [
    { key: 'sku', label: 'SKU', render: (r) => h`<b>${r.sku}</b><div class="small muted">${r.name}</div>` }, { key: 'category', label: 'Kategoriya', render: (r) => CAT[r.category] }, { key: 'model', label: 'Model' },
    { key: 'available', label: 'Available', num: true, sortVal: (r) => r.stock?.available, render: (r) => fmt.n(r.stock?.available) }, { key: 'reserved', label: 'Reserved', num: true, sortVal: (r) => r.stock?.reserved, render: (r) => fmt.n(r.stock?.reserved) },
    { key: 'free', label: 'Free', num: true, sortVal: (r) => r.stock?.free, render: (r) => h`<b style="color:${r.stock?.low ? 'var(--crit-ink)' : 'inherit'}">${fmt.n(r.stock?.free)}</b> <span class="muted small">${r.unit}</span>` },
    { key: 'min_stock', label: 'Min', num: true }, { key: 'units_per_pallet', label: 'Pallet', num: true }, { key: 'track_serial', label: 'Serial', render: (r) => (r.track_serial ? '✓' : '') }] });
  $('[data-a]', el)?.addEventListener('click', () => A.productForm());
} });
App.page('/products/:id', { title: 'Mahsulot kartochkasi', live: ['STOCK_CHANGED', 'PRODUCT_CHANGED'], async render({ el, params }) {
  const d = await GET(`/api/products/${params.id}`); const p = d.product; const s = d.stock;
  el.innerHTML = html(h`${pageHead(`${p.sku} — ${p.name}`, `${CAT[p.category]} · ${p.model || ''}`, h`${btn('Tahrirlash', { ico: 'gear', attrs: 'data-a="edit"', perm: 'products.manage' })}${btn('Rezerv', { ico: 'lock', attrs: 'data-a="res"', perm: 'stock.reserve' })}${btn('Ko‘chirish', { ico: 'swap', attrs: 'data-a="trf"', perm: 'stock.transfer' })}${btn('Chiqim', { ico: 'out', attrs: 'data-a="iss"', perm: 'stock.issue' })}`, h`<a href="#/products">Mahsulotlar</a> / ${p.sku}`)}
  <div class="kpis">${kpi({ label: 'Available', value: fmt.n(s.available), ico: 'check', tone: 'good' })}${kpi({ label: 'Reserved', value: fmt.n(s.reserved), ico: 'lock', tone: 'blue' })}${kpi({ label: 'Free', value: fmt.n(s.free), ico: 'box', tone: s.low ? 'crit' : '' , sub: `min ${fmt.n(p.min_stock)}` })}${kpi({ label: 'Qabulda (QC)', value: fmt.n(s.receiving), ico: 'in' })}${kpi({ label: 'Rework / Brak', value: `${fmt.n(s.rework)} / ${fmt.n(s.scrap)}`, ico: 'rework', tone: s.rework ? 'warn' : '' })}${kpi({ label: 'Yo‘lda (supplier)', value: fmt.n(s.inbound), ico: 'truck' })}${kpi({ label: 'Yetishmovchilik', value: fmt.n(s.shortage), ico: 'alert', tone: s.shortage ? 'crit' : 'good' })}${kpi({ label: 'Qadoqlangan / Yuklangan', value: `${fmt.n(s.packed)} / ${fmt.n(s.loaded)}`, ico: 'pack' })}</div>
  <div class="grid g-main">
    ${card('Mahsulot kartochkasi', h`<div class="grid g2">${dl([['Product ID', p.id], ['SKU', p.sku], ['Nomi', p.name], ['Model', p.model], ['Kategoriya', CAT[p.category]], ['Ishlab chiqaruvchi', p.manufacturer], ['Quvvat', p.power_w ? `${p.power_w} W` : null], ['Elektr', p.electrical_spec], ['Birlik', p.unit], ['Status', badge(p.status)], ['Barcode', p.barcode], ['Serial kuzatuv', p.track_serial ? 'Ha' : 'Yo‘q']])}
      ${dl([['O‘lcham (U×K×Q)', p.length_mm ? `${p.length_mm} × ${p.width_mm} × ${p.height_mm} mm` : null], ['Hajm', fmt.m3(p.volume_m3)], ['Net / Gross', `${fmt.kg(p.net_weight_kg)} / ${fmt.kg(p.gross_weight_kg)}`], ['Palletda', `${p.units_per_pallet} ${p.unit}`], ['Pallet o‘lchami', `${p.pallet_length_mm} × ${p.pallet_width_mm} × ${p.pallet_height_mm} mm`], ['Pallet / qadoq og‘irligi', `${fmt.kg(p.pallet_weight_kg)} / ${fmt.kg(p.packaging_weight_kg)}`], ['To‘liq pallet brutto', fmt.kg(p.units_per_pallet * p.net_weight_kg + p.pallet_weight_kg + p.packaging_weight_kg)], ['Qadoq turi', p.packaging_type], ['Stack / joylashuv', `${p.max_stack} qavat · ${p.orientation === 'VERTICAL' ? 'vertikal' : p.orientation === 'HORIZONTAL' ? 'gorizontal' : '—'}`], ['Qadoqlash standarti', p.packing_standard], ['Nozik', p.fragile ? 'Ha' : 'Yo‘q'], ['Yetkazish muddati', `${p.lead_time_days} kun`]])}</div>`)}
    ${card('QR / Barcode', raw('<div data-codes style="display:flex;flex-direction:column;align-items:center;gap:10px"></div>'), { actions: btn('Yorliq', { cls: 'sm', ico: 'print', attrs: 'data-a="print"' }) })}
  </div>
  <div class="grid g2" style="margin-top:16px">
    ${card('Ombor joylashuvi', raw(tableHtml([{ label: 'Lokatsiya', render: (r) => h`<a class="mono" href="#/qr?code=${encodeURIComponent(r.location)}">${r.location}</a><div class="small muted">${r.zone}</div>` }, { label: 'Partiya', render: (r) => h`<span class="mono small">${r.batch_no || '—'}</span>` }, { label: 'Holat', render: (r) => badge(r.status) }, { label: 'Miqdor', key: 'qty', num: true }], d.locations, 'Omborda qoldiq yo‘q')), { flush: true })}
    ${card('Oxirgi harakatlar', raw(tableHtml([{ label: 'Tur', render: (r) => TXN[r.type] || r.type }, { label: 'Miqdor', key: 'qty', num: true }, { label: 'Yo‘nalish', render: (r) => h`<span class="mono small">${r.from_loc || '—'} → ${r.to_loc || '—'}</span>` }, { label: 'Asos', key: 'reference' }, { label: 'Vaqt', render: (r) => fmt.dt(r.created_at) }], d.transactions.slice(0, 15))), { flush: true })}
    ${card('Partiyalar', raw(tableHtml([{ label: 'Partiya', render: (r) => h`<a class="mono" href="#/qr?code=${encodeURIComponent(r.batch_no)}">${r.batch_no}</a>` }, { label: 'Manba', render: (r) => label(r.source) }, { label: 'Sana', render: (r) => fmt.d(r.mfg_date) }, { label: 'Miqdor', key: 'qty', num: true }], d.batches.slice(0, 12))), { flush: true })}
    ${card('Supplierlar', raw(tableHtml([{ label: 'Supplier', key: 'company' }, { label: 'Narx', render: (r) => `${fmt.n(r.price)} ${r.currency}` }, { label: 'Muddat', render: (r) => `${r.lead_time_days} kun` }, { label: 'MOQ', key: 'moq', num: true }], d.suppliers)) + (d.serials.length ? `<div style="padding:12px 16px" class="small">Serial holatlari: ${d.serials.map((x) => `${esc(label(x.status))}: <b>${x.n}</b>`).join(' · ')}</div>` : ''), { flush: true })}
  </div>`);
  const codes = $('[data-codes]', el); codes.innerHTML = `${await qrSvg(p.sku, 150)}${p.barcode ? await barcodeSvg(p.barcode) : ''}`;
  el.addEventListener('click', async (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a === 'edit') A.productForm(p); if (a === 'res') A.reserve({ productId: p.id }); if (a === 'trf') A.transfer({ productId: p.id }); if (a === 'iss') A.issue({ productId: p.id }); if (a === 'print') printHtml(`<div class="qr-label">${await qrSvg(p.sku, 130)}<div><h2 style="margin:0">${esc(p.sku)}</h2><div>${esc(p.name)}</div><div>${p.barcode ? await barcodeSvg(p.barcode) : ''}</div></div></div>`, p.sku); });
} });

// ================= Qoldiq (stock rows) =================
App.page('/stock', { title: 'Qoldiq', live: ['STOCK_CHANGED'], async render({ el, query }) {
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v)).toString();
  const rows = await GET(`/api/inventory/rows?${qs}`);
  el.innerHTML = html(h`${pageHead('Qoldiq — lokatsiya bo‘yicha', 'WH → Zona → Rack → Shelf → Position aniqligida', btn('Ko‘chirish', { ico: 'swap', attrs: 'data-a', perm: 'stock.transfer' }))}
  <div class="toolbar"><select class="input" data-f="warehouseId"><option value="">Barcha omborlar</option>${raw(opt.warehouses().map(([v, l]) => `<option value="${esc(v)}" ${query.warehouseId === v ? 'selected' : ''}>${esc(l)}</option>`).join(''))}</select>
  <select class="input" data-f="status"><option value="">Barcha holatlar</option>${raw(['AVAILABLE', 'RECEIVING', 'REWORK', 'SCRAP', 'PICKED', 'PACKED', 'LOADED'].map((s) => `<option value="${s}" ${query.status === s ? 'selected' : ''}>${esc(label(s))}</option>`).join(''))}</select></div>
  ${card('', raw('<div data-t></div>'), { flush: true })}`);
  $$('[data-f]', el).forEach((s) => s.addEventListener('change', () => { const q = { ...query, [s.dataset.f]: s.value }; go(`#/stock?${new URLSearchParams(Object.entries(q).filter(([, v]) => v))}`); }));
  dataTable($('[data-t]', el), { rows, pageSize: 40, columns: [
    { key: 'location', label: 'Lokatsiya', render: (r) => h`<a class="mono" href="#/qr?code=${encodeURIComponent(r.location)}">${r.location}</a>` }, { key: 'warehouse_id', label: 'Ombor' }, { key: 'zone', label: 'Zona' },
    { key: 'sku', label: 'Mahsulot', render: (r) => h`<a href="#/products/${r.product_id}">${r.sku}</a><div class="small muted">${r.name}</div>` }, { key: 'batch_no', label: 'Partiya', render: (r) => h`<span class="mono small">${r.batch_no || '—'}</span>` },
    { key: 'status', label: 'Holat', render: (r) => badge(r.status) }, { key: 'qty', label: 'Miqdor', num: true, render: (r) => h`<b>${fmt.n(r.qty)}</b> <span class="muted small">${r.unit}</span>` }, { key: 'updated_at', label: 'Yangilandi', render: (r) => h`<span class="small muted">${fmt.rel(r.updated_at)}</span>` }] });
  $('[data-a]', el)?.addEventListener('click', () => A.transfer());
} });

// ================= Omborlar / lokatsiyalar =================
App.page('/warehouses', { title: 'Omborlar va lokatsiyalar', live: ['STOCK_CHANGED'], async render({ el, query }) {
  const whs = await GET('/api/warehouses'); const wid = query.wh || whs[0]?.id;
  const locs = wid ? await GET(`/api/locations?warehouseId=${wid}`) : [];
  const w = whs.find((x) => x.id === wid);
  el.innerHTML = html(h`${pageHead('Omborlar va lokatsiyalar', 'Multi-warehouse · zona · rack · shelf · position', h`${btn('+ Ombor', { ico: 'plus', attrs: 'data-a="wh"', perm: 'warehouse.manage' })}${btn('+ Zona', { attrs: 'data-a="zone"', perm: 'warehouse.manage' })}${btn('+ Lokatsiyalar', { attrs: 'data-a="loc"', perm: 'warehouse.manage' })}`)}
  <div class="grid g3" style="margin-bottom:16px">${whs.map((x) => h`<a class="card" href="#/warehouses?wh=${x.id}" style="padding:14px 16px;text-decoration:none;color:inherit;${x.id === wid ? 'border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)' : ''}"><div style="display:flex;justify-content:space-between;align-items:center"><b>${x.id}</b><span class="badge plain dark">${x.type}</span></div><div class="t2" style="margin:2px 0 10px">${x.name}</div>${meter(x.capacity?.pct)}<div class="small muted" style="margin-top:6px">Capacity: <b>${fmt.pct(x.capacity?.pct)}</b> · ${x.capacity?.usedPallets}/${x.capacity?.positions} pallet · ${x.length_m}×${x.width_m}×${x.height_m} m · max ${fmt.n(x.max_load_kg)} kg</div></a>`)}</div>
  ${w ? card(`${w.id} — ${w.name}`, h`${w.zones.map((z) => { const zl = locs.filter((l) => l.zone_id === z.id); return h`<div style="margin-bottom:14px"><div style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><b>${z.name}</b><span class="badge plain dark">${z.zone_type}</span><span class="small muted">${zl.length} lokatsiya · ${zl.filter((l) => l.qty > 0).length} band</span></div><div class="wmap">${zl.map((l) => { const f = l.max_pallets ? l.pallets / l.max_pallets : 0; return h`<div class="wcell ${l.qty > 0 ? (f >= 1 ? 'f3' : f >= 0.5 ? 'f2' : 'f1') : ''}" data-loc="${l.code}" title="${l.code}\n${l.skus || 'bo‘sh'} · ${fmt.n(l.qty)} · ${l.pallets}/${l.max_pallets} pallet"><b>${l.rack ? `${l.rack}-${l.shelf}-${l.position}` : l.code.split('-').pop()}</b>${l.qty > 0 ? fmt.n(l.qty) : '·'}</div>`; })}</div></div>`; })}
    <div class="legend"><span><i style="background:var(--surface-2);border:1px solid var(--border)"></i>Bo‘sh</span><span><i style="background:color-mix(in srgb,var(--s1) 25%,var(--surface))"></i>&lt;50%</span><span><i style="background:color-mix(in srgb,var(--s1) 55%,var(--surface))"></i>50–99%</span><span><i style="background:var(--s1)"></i>To‘liq</span></div>`, { sub: 'Lokatsiyani bosing — ichidagi mahsulot' }) : ''}`);
  el.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-loc]'); if (c) return go(`#/qr?code=${encodeURIComponent(c.dataset.loc)}`);
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'wh') { const r = await formModal({ title: '+ Ombor', fields: [{ name: 'id', label: 'Kod (WH-07)', required: true }, { name: 'name', label: 'Nomi', required: true }, { name: 'type', label: 'Turi', type: 'select', options: ['RAW', 'WIP', 'FINISHED', 'PACKAGING', 'SCRAP', 'DISPATCH', 'GENERAL'], required: true }, { name: 'address', label: 'Manzil' }, { name: 'length_m', label: 'Uzunlik, m', type: 'number', required: true }, { name: 'width_m', label: 'Kenglik, m', type: 'number', required: true }, { name: 'height_m', label: 'Balandlik, m', type: 'number', required: true }, { name: 'usable_volume_m3', label: 'Foydali hajm, m³', type: 'number' }, { name: 'pallet_positions', label: 'Pallet pozitsiyalari', type: 'number', required: true }, { name: 'max_load_kg', label: 'Maks. yuk, kg', type: 'number' }], onSubmit: (d) => POST('/api/warehouses', d) }); if (r) { await App.loadMeta(); App.refresh(); } }
    if (a === 'zone') { const r = await formModal({ title: '+ Zona', fields: [{ name: 'warehouseId', label: 'Ombor', type: 'select', required: true, options: opt.warehouses(), value: wid }, { name: 'code', label: 'Kod', required: true }, { name: 'name', label: 'Nomi', required: true }, { name: 'zoneType', label: 'Zona turi', type: 'select', required: true, options: [['RECEIVING', 'Receiving Zone'], ['QC', 'QC Zone'], ['RAW', 'Raw Material Zone'], ['WIP', 'WIP Zone'], ['FINISHED', 'Finished Goods Zone'], ['PACKING', 'Packing Zone'], ['DISPATCH', 'Dispatch Zone'], ['RETURN', 'Return Zone'], ['SCRAP', 'Scrap Zone'], ['REWORK', 'Rework Zone']] }], onSubmit: (d) => POST('/api/zones', d) }); if (r) { await App.loadMeta(); App.refresh(); } }
    if (a === 'loc') { const r = await formModal({ title: '+ Lokatsiyalar (rack generatori)', fields: [{ name: 'zoneId', label: 'Zona', type: 'select', required: true, options: opt.zones(wid), full: true }, { name: 'rackStart', label: 'Boshlang‘ich rack №', type: 'number', value: 1 }, { name: 'racks', label: 'Rack soni', type: 'number', required: true, value: 2 }, { name: 'shelves', label: 'Qavat (shelf)', type: 'number', required: true, value: 3 }, { name: 'positions', label: 'Pozitsiya', type: 'number', required: true, value: 4 }, { name: 'maxPallets', label: 'Pozitsiyadagi maks. pallet', type: 'number', value: 1 }, { name: 'maxWeightKg', label: 'Maks. og‘irlik, kg', type: 'number', value: 1500 }], onSubmit: (d) => POST('/api/locations', d) }); if (r) { toast(`${r.created} ta lokatsiya yaratildi`, 'ok'); App.refresh(); } }
  });
} });

// ================= Rezerv =================
App.page('/reservations', { title: 'Rezerv', live: ['ORDER_RESERVED', 'STOCK_CHANGED'], async render({ el, query }) {
  const rows = await GET(`/api/inventory/reservations${query.all ? '' : '?status=ACTIVE'}`);
  const st = await GET('/api/inventory?category=FINISHED');
  el.innerHTML = html(h`${pageHead('Rezerv', 'Stock → Reserved → Available (free). Rezerv tranzaksiya sifatida yoziladi.', btn('+ Rezerv', { cls: 'primary', ico: 'lock', attrs: 'data-a', perm: 'stock.reserve' }))}
  <div class="kpis">${st.map((s) => kpi({ label: s.sku, value: fmt.n(s.free), sub: `Stock ${fmt.n(s.available)} · Reserved ${fmt.n(s.reserved)}`, ico: 'lock', tone: s.free <= 0 ? 'crit' : 'blue', href: `#/products/${s.product_id}` }))}</div>
  <div class="tabs"><a href="#/reservations" class="${query.all ? '' : 'active'}">Faol</a><a href="#/reservations?all=1" class="${query.all ? 'active' : ''}">Hammasi</a></div>
  ${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows, columns: [
    { key: 'res_no', label: 'Rezerv №', render: (r) => h`<span class="mono">${r.res_no}</span>` }, { key: 'sku', label: 'Mahsulot' }, { key: 'order_no', label: 'Buyurtma / loyiha', render: (r) => (r.order_no ? h`<a href="#/orders/${r.order_id}">${r.order_no}</a>` : r.project_code ? h`<span class="badge plain blue">Loyiha ${r.project_code}</span>` : '—') },
    { key: 'qty', label: 'Rezerv', num: true }, { key: 'picked_qty', label: 'Yig‘ildi', num: true }, { key: 'remaining', label: 'Qoldiq', num: true, render: (r) => h`<b>${fmt.n(r.remaining)}</b>` }, { key: 'status', label: 'Holat', render: (r) => badge(r.status) },
    { key: 'created_by_name', label: 'Kim' }, { key: 'created_at', label: 'Sana', render: (r) => fmt.dt(r.created_at) },
    { label: '', sort: false, render: (r) => (r.status === 'ACTIVE' && can('stock.reserve') ? h`<button class="btn sm danger" data-rel="${r.id}">Bo‘shatish</button>` : '') }] });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-a]')) A.reserve();
    const b = e.target.closest('[data-rel]'); if (b) { const r = rows.find((x) => x.id === Number(b.dataset.rel)); const res = await formModal({ title: `Rezervni bo‘shatish — ${r.res_no}`, fields: [{ name: 'qty', label: `Miqdor (maks ${r.remaining})`, type: 'number', value: r.remaining, required: true }, { name: 'reason', label: 'Sabab', required: true, full: true }], onSubmit: (d) => POST(`/api/inventory/reservations/${r.id}/release`, d) }); if (res) { toast(`${res.released} bo‘shatildi (RELEASE)`, 'ok'); App.refresh(); } }
  });
} });

// ================= Inventarizatsiya =================
App.page('/counts', { title: 'Inventarizatsiya', live: false, async render({ el }) {
  const [rows, ins] = await Promise.all([GET('/api/inventory/counts'), GET('/api/ai/insights')]);
  el.innerHTML = html(h`${pageHead('Inventarizatsiya', 'System vs Physical → Difference → ADJUSTMENT (sabab majburiy)', btn('+ Inventarizatsiya', { cls: 'primary', ico: 'clip', attrs: 'data-a', perm: 'stock.count' }))}
  ${ins.cycleCount.length ? h`<div style="margin-bottom:14px">${aiCallout(ins.cycleCount.map((z) => `${z.warehouse_id} ${z.name} (${z.zone_id}) inventarizatsiyasini tekshirish tavsiya qilinadi: oxirgi 14 kunda ${z.moves} ta harakat, ${z.last_count ? `oxirgi hisob ${fmt.d(z.last_count)}` : 'hali hisoblanmagan'}.`).join('\n'), 'AI Cycle Count tavsiyasi')}</div>` : ''}
  ${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows, onRow: (r) => countDetail(r.id), columns: [{ key: 'count_no', label: 'Hisob №', render: (r) => h`<b>${r.count_no}</b>` }, { key: 'warehouse_id', label: 'Ombor' }, { key: 'zone_id', label: 'Zona' }, { key: 'lines', label: 'Qatorlar', num: true }, { key: 'diffs', label: 'Farqlar', num: true }, { key: 'status', label: 'Holat', render: (r) => badge(r.status) }, { key: 'reason', label: 'Sabab' }, { key: 'created_at', label: 'Sana', render: (r) => fmt.dt(r.created_at) }] });
  $('[data-a]', el)?.addEventListener('click', async () => { const r = await formModal({ title: '+ Inventarizatsiya', fields: [{ name: 'warehouseId', label: 'Ombor', type: 'select', required: true, options: opt.warehouses() }, { name: 'zoneId', label: 'Zona (ixtiyoriy)', type: 'select', options: opt.zones() }], onSubmit: (d) => POST('/api/inventory/counts', d) }); if (r) { toast(`${r.countNo}: ${r.lines} qator`, 'ok'); countDetail(r.id); App.refresh(); } });
} });
async function countDetail(id) {
  const d = await GET(`/api/inventory/counts/${id}`); const open = d.count.status === 'OPEN';
  const body = h`<div class="table-wrap"><table class="t"><thead><tr><th>Lokatsiya</th><th>Mahsulot</th><th>Holat</th><th class="num">System</th><th class="num">Physical</th><th class="num">Difference</th></tr></thead><tbody>${d.lines.map((l) => h`<tr><td class="mono small">${l.location}</td><td>${l.sku}<div class="small muted">${l.batch_no || ''}</div></td><td>${badge(l.status)}</td><td class="num">${fmt.n(l.system_qty)}</td><td class="num">${open ? h`<input class="input" style="width:110px;height:32px;text-align:right" type="number" step="any" min="0" data-line="${l.id}" data-sys="${l.system_qty}" value="${l.physical_qty ?? ''}">` : fmt.n(l.physical_qty)}</td><td class="num" data-diff="${l.id}">${l.physical_qty != null ? fmt.n(l.physical_qty - l.system_qty) : '—'}</td></tr>`)}</tbody></table></div>
    ${open ? raw(`<div style="margin-top:14px">${fieldHtml({ name: 'reason', label: 'Farq sababi (farq bo‘lsa majburiy)', type: 'textarea', rows: 2 })}</div>`) : dl([['Sabab', d.count.reason], ['O‘tkazildi', fmt.dt(d.count.posted_at)]])}`;
  const res = await modal({ title: `Inventarizatsiya ${d.count.count_no}`, size: 'wide', body, submitText: open && can('stock.count.post') ? 'Saqlash va o‘tkazish (ADJUSTMENT)' : undefined,
    footer: open ? h`<button class="btn" data-save type="button">Faqat saqlash</button><button class="btn" data-fill type="button">System = Physical</button>` : '',
    onOpen: (bg) => {
      const upd = (i) => { const c = $(`[data-diff="${i.dataset.line}"]`, bg); const df = i.value === '' ? null : Number(i.value) - Number(i.dataset.sys); c.innerHTML = df == null ? '—' : `<b style="color:${df < 0 ? 'var(--crit-ink)' : df > 0 ? 'var(--good-ink)' : 'inherit'}">${df > 0 ? '+' : ''}${esc(fmt.n(df))}</b>`; };
      $$('[data-line]', bg).forEach((i) => { i.dataset.noSubmit = '1'; i.addEventListener('input', () => upd(i)); upd(i); });
      $('[data-fill]', bg)?.addEventListener('click', () => $$('[data-line]', bg).forEach((i) => { if (i.value === '') { i.value = i.dataset.sys; upd(i); } }));
      $('[data-save]', bg)?.addEventListener('click', (e) => act(e.target, () => POST(`/api/inventory/counts/${id}/lines`, { lines: $$('[data-line]', bg).filter((i) => i.value !== '').map((i) => ({ id: Number(i.dataset.line), physicalQty: Number(i.value) })) }), 'Saqlandi'));
    },
    onSubmit: open && can('stock.count.post') ? async (form) => { const lines = $$('[data-line]', form).filter((i) => i.value !== '').map((i) => ({ id: Number(i.dataset.line), physicalQty: Number(i.value) })); if (lines.length) await POST(`/api/inventory/counts/${id}/lines`, { lines }); return POST(`/api/inventory/counts/${id}/post`, { reason: $('[name=reason]', form).value }); } : undefined });
  if (res && res.adjustments != null) { toast(`${res.adjustments} ta ADJUSTMENT · aniqlik ${res.accuracy}%`, 'ok'); App.refresh(); }
}

// ================= Brak / rework =================
App.page('/quality', { title: 'Brak va rework', live: ['STOCK_CHANGED', 'QC_FAILED'], async render({ el }) {
  const rows = (await GET('/api/inventory/rows')).filter((r) => ['REWORK', 'SCRAP'].includes(r.status));
  const sum = (s) => rows.filter((r) => r.status === s).reduce((a, r) => a + r.qty, 0);
  el.innerHTML = html(h`${pageHead('Brak va rework', 'QC FAIL / Reject → Scrap zonasi · Rework → Rework zonasi → qayta QC')}
  <div class="kpis">${kpi({ label: 'Rework', value: fmt.n(sum('REWORK')), ico: 'rework', tone: 'warn' })}${kpi({ label: 'Brak (scrap)', value: fmt.n(sum('SCRAP')), ico: 'scrap', tone: 'crit' })}</div>
  ${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows, columns: [{ key: 'location', label: 'Lokatsiya', render: (r) => h`<span class="mono small">${r.location}</span>` }, { key: 'sku', label: 'Mahsulot', render: (r) => h`${r.sku}<div class="small muted">${r.name}</div>` }, { key: 'batch_no', label: 'Partiya', render: (r) => h`<span class="mono small">${r.batch_no || '—'}</span>` }, { key: 'status', label: 'Holat', render: (r) => badge(r.status) }, { key: 'qty', label: 'Miqdor', num: true },
    { label: 'Amallar', sort: false, render: (r) => (can('stock.disposition') ? h`<div style="display:flex;gap:6px;flex-wrap:wrap">${r.status !== 'SCRAP' ? h`<button class="btn sm" data-d="REQC" data-r="${r.id}">Qayta QC</button>` : ''}${r.status === 'SCRAP' ? h`<button class="btn sm" data-d="REWORK" data-r="${r.id}">Rework</button>` : ''}${r.status !== 'SCRAP' ? h`<button class="btn sm danger" data-d="SCRAP" data-r="${r.id}">Scrap</button>` : h`<button class="btn sm danger" data-d="DISPOSE" data-r="${r.id}">Hisobdan chiqarish</button>`}</div>` : '') }] });
  el.addEventListener('click', async (e) => { const b = e.target.closest('[data-d]'); if (!b) return; const r = rows.find((x) => x.id === Number(b.dataset.r)); const names = { REQC: 'Qayta QC ga yuborish', REWORK: 'Rework zonasiga', SCRAP: 'Brak (scrap) zonasiga', DISPOSE: 'Hisobdan chiqarish (utilizatsiya)' };
    const res = await formModal({ title: `${names[b.dataset.d]} — ${r.sku}`, fields: [{ name: 'qty', label: `Miqdor (maks ${r.qty})`, type: 'number', value: r.qty, required: true }, { name: 'reason', label: 'Sabab / dalolatnoma', required: true, full: true }], onSubmit: (d) => POST('/api/inventory/disposition', { ...d, productId: r.product_id, locationId: r.location_id, fromStatus: r.status, action: b.dataset.d }) });
    if (res) { toast(`${res.reference} bajarildi`, 'ok'); App.refresh(); } });
} });

// ================= QR / Barcode =================
App.page('/qr', { title: 'QR / Barcode', async render({ el, query }) {
  el.innerHTML = html(h`${pageHead('QR / Barcode', `Product · Batch · Serial · Pallet · Location · Order${App.meta?.modules?.logistics ? ' · Shipment' : ''}`)}
  ${card('', h`<form data-f style="display:flex;gap:8px;flex-wrap:wrap"><input class="input scan" name="code" value="${query.code || ''}" placeholder="Kodni skaner qiling yoki kiriting" style="flex:1;min-width:240px" autofocus><button class="btn primary lg">${icon('search')}Ochish</button><button type="button" class="btn lg" data-cam>${icon('camera')}Kamera</button></form>`)}
  <div data-res style="margin-top:16px"></div>`);
  const f = $('[data-f]', el); f.addEventListener('submit', (e) => { e.preventDefault(); const c = f.code.value.trim(); if (c) go(`#/qr?code=${encodeURIComponent(c)}`); });
  $('[data-cam]', el).addEventListener('click', () => openScanner((c) => go(`#/qr?code=${encodeURIComponent(c)}`)));
  if (!query.code) return;
  const box = $('[data-res]', el);
  try { const r = await GET(`/api/qr/${encodeURIComponent(query.code)}`); box.innerHTML = html(await renderResolved(r, query.code)); }
  catch (e) { box.innerHTML = html(h`<div class="callout crit">${icon('alert')}<div><b>❌ Topilmadi</b><div>${e.message}</div></div></div>`); }
} });
async function renderResolved(r, code) {
  const qr = raw(await qrSvg(code, 140));
  const d = r.data;
  const head = (t, s) => h`<div style="display:flex;gap:16px;align-items:center;margin-bottom:14px"><div style="background:#fff;padding:6px;border-radius:8px;border:1px solid var(--border)">${qr}</div><div><span class="badge blue">${t}</span><h2 style="margin:6px 0 2px">${code}</h2><div class="t2">${s}</div></div></div>`;
  if (r.kind === 'serial') return traceView(d, head);
  if (r.kind === 'pallet') return card('', h`${head('Pallet', `${d.product?.sku} · ${d.pallet.qty} dona · ${fmt.kg(d.pallet.gross_weight_kg)}`)}${dl([['Buyurtma', d.order ? h`${d.order.order_no} ${badge(d.order.status)}` : '—'], ['Holat', badge(d.pallet.status)], ['Joy', d.location], ['Jo‘natma', d.shipment ? h`<a href="#/shipments/${d.shipment.ship_no}">${d.shipment.ship_no}</a> → ${d.shipment.destination}` : '—'], ['O‘lcham', `${d.pallet.length_mm}×${d.pallet.width_mm}×${d.pallet.height_mm} mm · ${fmt.m3(d.pallet.volume_m3)}`], ['Og‘irlik', `net ${fmt.kg(d.pallet.net_weight_kg)} + pallet ${fmt.kg(d.pallet.pallet_weight_kg)} + qadoq ${fmt.kg(d.pallet.packaging_weight_kg)} = ${fmt.kg(d.pallet.gross_weight_kg)}`]])}<h4>Ichidagi mahsulotlar (${d.serials.length})</h4><div class="mono small" style="max-height:180px;overflow:auto">${d.serials.map((s) => h`<a href="#/qr?code=${s.serial}">${s.serial}</a> `)}</div>`);
  if (r.kind === 'shipment') return h`${card('', h`${head('Jo‘natma', `${d.order?.customer || ''} · ${d.shipment.destination}`)}<a class="btn primary" href="#/shipments/${d.shipment.ship_no}">Jo‘natmani ochish</a>`)}`;
  if (r.kind === 'order') return card('', h`${head('Buyurtma', badge(d.order.status))}${raw(tableHtml([{ label: 'SKU', key: 'sku' }, { label: 'Miqdor', key: 'qty', num: true }, { label: 'Yig‘ildi', key: 'picked_qty', num: true }, { label: 'Jo‘natildi', key: 'shipped_qty', num: true }], d.items))}<a class="btn primary" href="#/orders/${d.order.id}">Buyurtmani ochish</a>`);
  if (r.kind === 'location') return card('', h`${head('Lokatsiya', `${d.location.warehouse_id} · ${d.location.zone_name} · maks ${d.location.max_pallets} pallet`)}${raw(tableHtml([{ label: 'Mahsulot', key: 'sku' }, { label: 'Partiya', key: 'batch_no' }, { label: 'Holat', render: (x) => badge(x.status) }, { label: 'Miqdor', key: 'qty', num: true }], d.stock, 'Lokatsiya bo‘sh'))}`);
  if (r.kind === 'batch') return card('', h`${head('Partiya', `${d.product.sku} · ${fmt.d(d.batch.mfg_date)} · ${d.serials} serial`)}${raw(tableHtml([{ label: 'Lokatsiya', key: 'code' }, { label: 'Holat', render: (x) => badge(x.status) }, { label: 'Miqdor', key: 'qty', num: true }], d.stock))}`);
  if (r.kind === 'product') return card('', h`${head('Mahsulot', d.product.name)}${dl([['Available', fmt.n(d.stock.available)], ['Reserved', fmt.n(d.stock.reserved)], ['Free', fmt.n(d.stock.free)]])}<div style="margin-top:12px"><a class="btn primary" href="#/products/${d.product.id}">Kartochkani ochish</a></div>`);
  return card('', h`${head(r.kind, '')}<pre class="mono small">${JSON.stringify(d, null, 2)}</pre>`);
}
function traceView(d, head) {
  return h`${card('', h`${head ? head('Serial', `${d.product.sku} — ${d.product.name}`) : ''}<div class="grid g2">${dl([['Serial', h`<span class="mono">${d.serial}</span>`], ['Holat', badge(d.status)], ['Joriy joy', d.location], ['Mahsulot', `${d.product.sku} (${d.product.power_w || ''} W)`], ['Partiya', d.batch?.batch_no]])}${dl([['Buyurtma', d.order ? h`<a href="#/orders/${d.order.id}">${d.order.order_no}</a>` : '—'], ['Mijoz / loyiha', d.order ? `${d.order.customer || ''}${d.order.project_code ? ` / ${d.order.project_code}` : ''}` : '—'], ['Pallet', d.pallet ? h`<a href="#/qr?code=${d.pallet.pallet_no}">${d.pallet.pallet_no}</a>` : '—'], ['Jo‘natma', d.shipment ? h`<a href="#/shipments/${d.shipment.ship_no}">${d.shipment.ship_no}</a>` : '—'], ['Transport / haydovchi', d.shipment ? `${d.shipment.vehicle_type} ${d.shipment.plate} / ${d.shipment.driver}` : '—']])}</div>`)}
  <div class="grid g2" style="margin-top:16px">${card('To‘liq traceability zanjiri', h`<div class="chain">${d.chain.map((c, i) => h`${i ? h`<span class="arrow">${icon('arrow')}</span>` : ''}<div class="node ok"><b>${c.step}</b>${c.ref}<div class="small muted">${c.detail || ''}</div><div class="small muted">${fmt.dt(c.at)}</div></div>`)}</div>`)}
  ${card('Harakatlar tarixi', raw(tableHtml([{ label: 'Tur', render: (r) => TXN[r.type] || r.type }, { label: 'Yo‘nalish', render: (r) => h`<span class="mono small">${r.from_loc || '—'} → ${r.to_loc || '—'}</span>` }, { label: 'Asos', key: 'reference' }, { label: 'Kim', key: 'user' }, { label: 'Vaqt', render: (r) => fmt.dt(r.created_at) }], d.history)), { flush: true })}</div>`;
}
App.page('/trace', { title: 'Traceability', async render({ el, query }) {
  el.innerHTML = html(h`${pageHead('Traceability', App.meta?.modules?.logistics ? 'Shipment → Vehicle → Driver → Pallets → Products → Serial Numbers → Customer/Project' : 'Serial raqam → Partiya → Pallet → Buyurtma → Mijoz / Loyiha')}
  ${card('', h`<form data-f style="display:flex;gap:8px;flex-wrap:wrap"><select class="input" name="kind" style="width:160px"><option value="serial">Serial raqam</option><option value="pallet" ${query.kind === 'pallet' ? 'selected' : ''}>Pallet</option>${App.meta?.modules?.logistics ? raw(`<option value="shipment" ${query.kind === 'shipment' ? 'selected' : ''}>Jo‘natma</option>`) : ''}</select><input class="input scan" name="q" value="${query.q || ''}" placeholder="SP550WM-2609-000123 / PAL-2026-0001" style="flex:1;min-width:240px"><button class="btn primary lg">${icon('trace')}Kuzatish</button></form>`)}<div data-res style="margin-top:16px"></div>`);
  $('[data-f]', el).addEventListener('submit', (e) => { e.preventDefault(); go(`#/trace?kind=${e.target.kind.value}&q=${encodeURIComponent(e.target.q.value.trim())}`); });
  if (!query.q) { const rep = await GET('/api/reports/traceability'); $('[data-res]', el).innerHTML = html(card('Oxirgi serial raqamlar', raw('<div data-t></div>'), { flush: true })); dataTable($('[data-t]', el), { rows: rep.rows, onRow: (r) => go(`#/trace?kind=serial&q=${r.serial}`), columns: rep.columns.map((c) => ({ key: c, label: c, render: c === 'status' ? (r) => badge(r.status) : undefined })) }); return; }
  const box = $('[data-res]', el);
  try {
    if ((query.kind || 'serial') === 'serial') box.innerHTML = html(traceView(await GET(`/api/trace/serial/${encodeURIComponent(query.q)}`)));
    else if (query.kind === 'pallet') box.innerHTML = html(await renderResolved({ kind: 'pallet', data: await GET(`/api/trace/pallet/${encodeURIComponent(query.q)}`) }, query.q));
    else go(`#/shipments/${encodeURIComponent(query.q)}`);
  } catch (e) { box.innerHTML = html(h`<div class="callout crit">${icon('alert')}${e.message}</div>`); }
} });
