/* Transport, haydovchilar, jo‘natmalar, yuklash, loyihalar, texnik shartlar, hujjatlar, XETQ */
'use strict';
const SHIP_FLOW = ['PLANNED', 'LOADING', 'LOADED', 'DISPATCHED', 'DELIVERED'];
const XETQ_MAIN = ['DRAFT', 'INTERNAL_REVIEW', 'READY_FOR_SUBMISSION', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED'];

// ================= transport calculation =================
const calcTable = (c, selectable) => raw(tableHtml([
  { label: 'Transport', render: (v) => h`<b>${v.type}</b><div class="small muted">${v.code} · ${v.model || ''} · ${v.dims}</div>` }, { label: 'Holat', render: (v) => h`${VEH_ICON[v.status]} ${VEH_LBL[v.status]}` },
  { label: 'Og‘irlik', render: (v) => h`${v.checks.weight.ok ? '✅' : '❌'} ${fmt.pct(v.checks.weight.util)}<div class="small muted">${fmt.n(v.payload_kg)} kg</div>` }, { label: 'Hajm', render: (v) => h`${v.checks.volume.ok ? '✅' : '❌'} ${fmt.pct(v.checks.volume.util)}<div class="small muted">${v.volume_m3} m³</div>` },
  { label: 'Pallet', render: (v) => h`${v.checks.pallets.ok ? '✅' : '❌'} ${c.totals.palletCount}/${v.fitCapacity}<div class="small muted">stack ${v.stack} · ${v.orientation}</div>` }, { label: 'Balandlik', render: (v) => (v.checks.height.ok ? '✅' : '❌') }, { label: 'LDM', render: (v) => (v.ldm != null ? `${v.ldm} m` : '—') },
  { label: 'Natija', render: (v) => (v.fits ? h`${c.recommended?.vehicleId === v.vehicleId ? h`<span class="badge good">★ Tavsiya</span>` : h`<span class="badge blue">Mos</span>`}${selectable && v.status === 'AVAILABLE' ? h` <button class="btn sm primary" data-pickv="${v.vehicleId}">Tanlash</button>` : ''}` : h`<span class="small" style="color:var(--crit-ink)">${v.reasons.join('; ')}</span>`) }], c.vehicles));
A.transportCalc = async (preset = {}) => {
  const orders = await GET('/api/orders?open=1');
  const fields = [{ name: 'orderId', label: 'Buyurtma (palletlar yoki reja)', type: 'select', options: orders.map((o) => [o.id, `${o.order_no} — ${o.customer} · ${fmt.n(o.qty)} dona`]), value: preset.orderId, full: true }, { name: 'productId', label: 'yoki mahsulot', type: 'select', options: opt.products((p) => p.category === 'FINISHED') }, { name: 'qty', label: 'Miqdor', type: 'number' }];
  await modal({ title: 'Transport hisoblash', size: 'xl', submitText: 'Hisoblash', body: raw(`${formHtml(fields, 3)}<div data-out style="margin-top:16px"></div>`),
    onOpen: (bg) => { if (preset.orderId) setTimeout(() => $('[data-ok]', bg).click(), 30); },
    onSubmit: async (form, bg) => {
      const d = await readForm(form, fields);
      const body = d.orderId ? { orderId: Number(d.orderId) } : d.productId && d.qty ? { items: [{ productId: Number(d.productId), qty: d.qty }] } : null;
      if (!body) throw new Error('Buyurtma yoki mahsulot + miqdor kiriting');
      const c = await POST('/api/transport/calculate', body);
      $('[data-out]', bg).innerHTML = html(h`<div class="kpis">${kpi({ label: 'Total Weight', value: fmt.kg(c.totals.grossWeight), ico: 'box', sub: `net ${fmt.kg(c.totals.netWeight)}` })}${kpi({ label: 'Total Volume', value: fmt.m3(c.totals.volume), ico: 'layers' })}${kpi({ label: 'Pallet Count', value: c.totals.palletCount, ico: 'pack', sub: c.totals.plannedPallets ? `${c.totals.plannedPallets} tasi reja` : 'haqiqiy palletlar' })}${kpi({ label: 'Loading Space', value: c.recommended?.ldm != null ? `${c.recommended.ldm} m` : '—', ico: 'ruler', sub: `pallet ${c.palletDims.length_mm}×${c.palletDims.width_mm}×${c.palletDims.height_mm} mm` })}${kpi({ label: 'Yuklash vaqti', value: `${c.loadingEstimate.minutes} daq`, ico: 'clock', sub: c.loadingEstimate.basis })}</div>
        ${aiCallout(c.aiText)}<div style="margin-top:14px">${calcTable(c, !!body.orderId && can('shipments.manage'))}</div>`);
      $$('[data-pickv]', bg).forEach((b) => b.addEventListener('click', () => { $('[data-x]', bg).click(); A.createShipment(body.orderId, Number(b.dataset.pickv)); }));
      return false;
    } });
};
A.createShipment = async (orderId, vehicleId) => {
  const c = await POST('/api/transport/calculate', { orderId });
  const o = await GET(`/api/orders/${orderId}`);
  const ready = o.pallets.filter((p) => p.status === 'PACKED' && !p.shipment_id);
  if (!ready.length) { toast('Jo‘natishga tayyor pallet yo‘q — avval pallet yarating', 'warn'); return; }
  const vs = c.vehicles.filter((v) => v.status === 'AVAILABLE');
  const drivers = App.meta.drivers;
  const fields = [{ name: 'vehicleId', label: 'Transport', type: 'select', required: true, value: vehicleId || c.recommended?.vehicleId, options: vs.map((v) => [v.vehicleId, `${v.fits ? '✅' : '❌'} ${v.code} ${v.type} — ${fmt.n(v.payload_kg)} kg / ${v.volume_m3} m³`]), full: true },
    { name: 'driverId', label: 'Haydovchi (bo‘sh — transportga biriktirilgan)', type: 'select', options: drivers.map((d) => [d.id, `${d.full_name} · ${label(d.status)}`]) }, { name: 'assignedTo', label: 'Yuklovchi', type: 'select', options: opt.users(['STOREKEEPER', 'LOGISTICS']) },
    { name: 'plannedDeparture', label: 'Jo‘nash vaqti', type: 'datetime-local', required: true, value: isoLocal(Date.now() + 3 * 3600000) }, { name: 'destination', label: 'Manzil', required: true, value: o.order.destination }, { name: 'distanceKm', label: 'Masofa, km', type: 'number' }];
  const r = await formModal({ title: `Shipment yaratish — ${o.order.order_no}`, size: 'wide', fields, submitText: 'Shipment + yuklash topshirig‘i', intro: h`<div style="margin-bottom:12px">${aiCallout(c.aiText)}</div><p class="small t2">${ready.length} ta tayyor pallet · ${fmt.kg(ready.reduce((a, p) => a + p.gross_weight_kg, 0))}</p>`,
    onSubmit: (d) => POST('/api/shipments', { ...d, orderId, palletIds: ready.map((p) => p.id) }) });
  if (r) {
    toast(`${r.shipNo} yaratildi · yuklash ${r.loadingTask.taskNo} (~${r.loadingTask.estimatedMinutes} daq)`, 'ok', 'Shipment');
    go(`#/shipments/${r.shipNo}`);
  }
};

// ================= Transport (vehicles) =================
App.page('/transport', { title: 'Transport', live: ['VEHICLE_STATUS', 'SHIPMENT_CREATED', 'LOADING_STARTED', 'SHIPMENT_DISPATCHED', 'SHIPMENT_ARRIVED'], async render({ el }) {
  const [vs, dash] = await Promise.all([GET('/api/vehicles'), GET('/api/dashboard/warehouse')]);
  el.innerHTML = html(h`${pageHead('Transport', 'Transport bazasi · sig‘im va og‘irlik tekshiruvi · status', h`${btn('Transport hisoblash', { cls: 'accent', ico: 'ruler', attrs: 'data-a="calc"' })}${btn('+ Transport', { cls: 'primary', ico: 'plus', attrs: 'data-a="add"', perm: 'transport.manage' })}`)}
  ${dash.needTransport.length ? h`<div class="callout warn" style="margin-bottom:14px">${icon('truck')}<div><b>Transport kerak: ${dash.needTransport.length} ta buyurtma</b> — ${dash.needTransport.map((o) => h`<a href="#/orders/${o.id}">${o.order_no}</a> `)}</div></div>` : ''}
  <div class="legend" style="margin-bottom:12px">${Object.keys(VEH_ICON).map((s) => h`<span>${VEH_ICON[s]} ${VEH_LBL[s]} (${vs.filter((v) => v.status === s).length})</span>`)}</div>
  <div class="grid g3">${vs.map((v) => h`<div class="card" style="padding:14px 16px"><div style="display:flex;align-items:center;gap:8px"><b style="font-size:15px">${v.code}</b><span class="badge plain dark">${v.type}</span><span style="margin-left:auto" class="small">${VEH_ICON[v.status]} ${VEH_LBL[v.status]}</span></div>
    <div class="t2 small" style="margin:2px 0 10px">${v.model} · ${v.plate || ''} · ${v.owner || ''}</div>
    ${dl([['Kuzov (U×K×B)', `${v.length_m} × ${v.width_m} × ${v.height_m} m`], ['Hajm', `${v.volume_m3} m³`], ['Yuk ko‘tarish', `${fmt.n(v.payload_kg)} kg`], ['EUR pallet', v.pallet_capacity], ['Haydovchi', v.driver], ['Jo‘natma', v.current_shipment ? h`<a href="#/shipments/${v.current_shipment}">${v.current_shipment}</a>` : '—'], v.notes ? ['Izoh', v.notes] : null])}
    ${can('transport.manage') ? h`<div style="display:flex;gap:6px;margin-top:10px"><select class="input" data-vs="${v.id}" style="height:32px">${raw(Object.keys(VEH_ICON).map((s) => `<option value="${s}" ${s === v.status ? 'selected' : ''}>${VEH_ICON[s]} ${VEH_LBL[s]}</option>`).join(''))}</select><button class="btn sm" data-edit="${v.id}">Tahrir</button></div>` : ''}</div>`)}</div>`);
  el.addEventListener('change', async (e) => { const s = e.target.closest('[data-vs]'); if (!s) return; try { await POST(`/api/vehicles/${s.dataset.vs}/status`, { status: s.value }); toast('Status yangilandi', 'ok'); App.refresh(); } catch (err) { toast(err.message, 'err'); App.refresh(); } });
  el.addEventListener('click', (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a === 'calc') A.transportCalc(); if (a === 'add') A.vehicleForm(); const ed = e.target.closest('[data-edit]'); if (ed) A.vehicleForm(vs.find((v) => v.id === Number(ed.dataset.edit))); });
} });
A.vehicleForm = async (v) => {
  const x = v || {};
  const fields = [{ name: 'code', label: 'Vehicle ID', required: true, value: x.code }, { name: 'type', label: 'Turi', type: 'select', required: true, value: x.type, options: ['Furgon', 'Tentli yuk mashinasi', 'Bortli', 'Katta yuk mashinasi', 'Yarim tirkama', 'Konteyner tashuvchi', 'Refrijerator', 'Boshqa'] }, { name: 'model', label: 'Model', value: x.model }, { name: 'plate', label: 'Davlat raqami', value: x.plate },
    { name: 'length_m', label: 'Uzunlik, m', type: 'number', required: true, value: x.length_m }, { name: 'width_m', label: 'Kenglik, m', type: 'number', required: true, value: x.width_m }, { name: 'height_m', label: 'Balandlik, m', type: 'number', required: true, value: x.height_m }, { name: 'volume_m3', label: 'Hajm, m³', type: 'number', value: x.volume_m3 },
    { name: 'payload_kg', label: 'Yuk ko‘tarish, kg', type: 'number', required: true, value: x.payload_kg }, { name: 'pallet_capacity', label: 'Pallet sig‘imi (EUR)', type: 'number', value: x.pallet_capacity }, { name: 'owner', label: 'Egasi', value: x.owner }, { name: 'driver_id', label: 'Haydovchi', type: 'select', options: opt.drivers(), value: x.driver_id }, { name: 'notes', label: 'Izoh', full: true, value: x.notes }];
  const r = await formModal({ title: v ? `Transport ${v.code}` : '+ Transport', size: 'wide', cols: 3, fields, onSubmit: (d) => (v ? PUT(`/api/vehicles/${v.id}`, d) : POST('/api/vehicles', d)) });
  if (r) { toast('Saqlandi', 'ok'); await App.loadMeta(); App.refresh(); }
};
// ================= Shipments =================
App.page('/shipments', { title: 'Jo‘natmalar', live: ['SHIPMENT_CREATED', 'LOADING_STARTED', 'LOADING_COMPLETED', 'SHIPMENT_DISPATCHED', 'SHIPMENT_ARRIVED'], async render({ el, query }) {
  const rows = await GET(`/api/shipments${query.all ? '' : '?active=1'}`);
  el.innerHTML = html(h`${pageHead('Jo‘natmalar (Shipment)', 'PLANNED → LOADING → LOADED → DISPATCHED → DELIVERED', btn('Transport hisoblash', { ico: 'ruler', attrs: 'data-a' }))}
  <div class="tabs"><a href="#/shipments" class="${query.all ? '' : 'active'}">Faol</a><a href="#/shipments?all=1" class="${query.all ? 'active' : ''}">Hammasi</a></div>${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows, onRow: (s) => go(`#/shipments/${s.ship_no}`), rowClass: (s) => (s.status === 'DISPATCHED' && s.eta && new Date(s.eta) < Date.now() ? 'hl' : ''), columns: [
    { key: 'ship_no', label: 'Jo‘natma', render: (s) => h`<b>${s.ship_no}</b><div class="small muted">${s.order_no}</div>` }, { key: 'customer', label: 'Mijoz / manzil', render: (s) => h`${s.customer}<div class="small muted">${s.destination}</div>` },
    { key: 'vehicle', label: 'Transport', render: (s) => h`${s.vehicle} <span class="small muted">${s.plate || ''}</span><div class="small muted">${s.driver || ''}</div>` }, { key: 'pallet_count', label: 'Pallet', num: true }, { key: 'total_weight_kg', label: 'Og‘irlik', num: true, render: (s) => fmt.kg(s.total_weight_kg) },
    { key: 'planned_departure', label: 'Jo‘nash', render: (s) => fmt.dt(s.departure || s.planned_departure) }, { key: 'eta', label: 'ETA', render: (s) => h`${fmt.dt(s.eta)}${s.status === 'DISPATCHED' && s.eta && new Date(s.eta) < Date.now() ? h` <span class="badge crit">🔴 kechikmoqda</span>` : ''}` }, { key: 'status', label: 'Holat', render: (s) => badge(s.status) }] });
  $('[data-a]', el).addEventListener('click', () => A.transportCalc());
} });
A.viewDoc = async (docId) => { const d = await GET(`/api/documents/${docId}`); const v = d.versions.find((x) => x.status === 'CURRENT') || d.versions[0]; window.open(`/api/documents/versions/${v.id}/view`, '_blank', 'noopener'); };
App.page('/shipments/:no', { title: 'Jo‘natma', live: false, async render({ el, params }) {
  const t0 = await GET(`/api/trace/shipment/${encodeURIComponent(params.no)}`);
  const d = await GET(`/api/shipments/${t0.shipment.id}`); const s = d.shipment; const lt = d.loading; const as = d.assignment || {};
  const late = s.status === 'DISPATCHED' && s.eta && new Date(s.eta) < Date.now();
  App.onLive(['LOADING_STARTED', 'LOADING_COMPLETED', 'SHIPMENT_DISPATCHED', 'SHIPMENT_ARRIVED', 'STOCK_CHANGED'], debounce(() => { if (!$('#modal-root').children.length && document.activeElement?.name !== 'pcode') App.refresh(); }, 800));
  el.innerHTML = html(h`${pageHead(h`${s.ship_no} ${badge(s.status)} ${late ? badge('OPEN', '🔴 kechikmoqda') : ''}`, `${d.order?.customer || ''} · ${d.order?.order_no || ''} · → ${s.destination}`,
    h`${lt?.status === 'PENDING' ? btn('Yuklashni boshlash', { cls: 'primary', ico: 'load', attrs: 'data-a="start"', perm: 'loading' }) : ''}${lt?.status === 'IN_PROGRESS' ? btn('Yuklashni yakunlash', { cls: 'good', ico: 'check', attrs: 'data-a="complete"', perm: 'loading' }) : ''}${s.status === 'LOADED' ? btn('Dispatch (jo‘natish)', { cls: 'accent', ico: 'send', attrs: 'data-a="dispatch"', perm: 'shipments.manage' }) : ''}${s.status === 'DISPATCHED' ? btn('Yetib keldi', { cls: 'primary', ico: 'check', attrs: 'data-a="arrive"', perm: 'shipments.manage' }) : ''}${['PLANNED', 'LOADING', 'LOADED'].includes(s.status) ? btn('Bekor qilish', { cls: 'danger', attrs: 'data-a="cancel"', perm: 'shipments.manage' }) : ''}${btn('Pallet yorliqlari', { ico: 'print', attrs: 'data-a="labels"' })}`,
    h`<a href="#/shipments">Jo‘natmalar</a> / ${s.ship_no}`)}
  ${card('', stepper(SHIP_FLOW, s.status, { bad: s.status === 'CANCELLED' }))}
  <div class="kpis" style="margin-top:16px">${kpi({ label: 'Umumiy og‘irlik', value: fmt.kg(s.total_weight_kg), ico: 'box', sub: `band ${fmt.pct(as.weight_util)}` })}${kpi({ label: 'Hajm', value: fmt.m3(s.total_volume_m3), ico: 'layers', sub: `band ${fmt.pct(as.volume_util)}` })}${kpi({ label: 'Pallet', value: s.pallet_count, ico: 'pack', sub: `band ${fmt.pct(as.pallet_util)}` })}${kpi({ label: 'Mahsulot', value: fmt.n(s.total_qty), ico: 'box', sub: `${d.serials.length} serial` })}${kpi({ label: 'Yuklash', value: lt ? `${lt.actual_minutes ?? '…'} / ${lt.estimated_minutes} daq` : '—', ico: 'clock', sub: 'haqiqiy / taxmin', tone: lt?.actual_minutes > lt?.estimated_minutes * 1.5 ? 'crit' : '' })}</div>
  <div class="grid g-main">
    <div class="grid" style="align-content:start">
    ${lt?.status === 'IN_PROGRESS' ? card('Palletni yuklash — skan', h`<form data-ls style="display:flex;gap:8px"><input class="input scan" name="pcode" placeholder="PAL-2026-…" autocomplete="off"><button class="btn primary lg">Yuklash</button></form><div data-lres></div>`) : ''}
    ${card('Yuklash rejasi (loading sequence)', raw(tableHtml([{ label: '#', render: (x) => x.seq }, { label: 'Pallet', render: (x) => h`<a href="#/qr?code=${x.palletNo}">${x.palletNo}</a>${x.fragile ? ' 🔸' : ''}` }, { label: 'Joylashuv', key: 'position' }, { label: 'Brutto', render: (x) => fmt.kg(x.weight) }, { label: 'Yuklandi', render: (x) => (d.pallets.find((p) => p.pallet_no === x.palletNo)?.status === 'LOADED' || ['DISPATCHED', 'DELIVERED'].includes(s.status) ? '✅' : '⬜') }], lt?.sequence || [])) + (lt?.warnings?.length ? `<div style="padding:12px 16px">${lt.warnings.map((w) => `<div class="small" style="margin:3px 0">${esc(w)}</div>`).join('')}</div>` : ''), { flush: true, sub: 'Og‘ir yuk pastda, nozik — himoyalangan joyda' })}
    ${lt?.delay?.analysis ? aiCallout(lt.delay.analysis, 'AI Root Cause') : ''}
    ${card('Hujjatlar', raw(tableHtml([{ label: 'Hujjat', render: (x) => h`<b>${x.doc_no}</b> ${x.title}` }, { label: 'Versiya', render: (x) => `v${x.current_version}` }, { label: 'Holat', render: (x) => badge(x.status) }, { label: '', render: (x) => h`<button class="btn sm" data-vd="${x.id}">${icon('eye')}Ko‘rish</button>` }], d.documents, 'Hujjatlar yuklash yakunlanganda avtomatik yaratiladi')), { flush: true, actions: s.status !== 'PLANNED' && can('documents.manage') ? btn('Qayta generatsiya', { cls: 'sm', ico: 'refresh', attrs: 'data-a="docs"' }) : '' })}
    </div>
    <div class="grid" style="align-content:start">
    ${card('Transport va haydovchi', dl([['Transport', h`<b>${d.vehicle?.code}</b> ${d.vehicle?.type} ${d.vehicle?.model}`], ['Davlat raqami', d.vehicle?.plate], ['Sig‘im', `${fmt.n(d.vehicle?.payload_kg)} kg · ${d.vehicle?.volume_m3} m³`], ['Haydovchi', `${d.driver?.full_name} (${d.driver?.phone || ''})`], ['Yuklovchi', lt?.assignee], ['Yuklash joyi', 'Dispatch Zone (WH-06)']]))}
    ${card('Vaqtlar', dl([['Rejalashtirilgan jo‘nash', fmt.dt(s.planned_departure)], ['Loading start', fmt.dt(s.loading_start)], ['Loading end', fmt.dt(s.loading_end)], ['Departure', fmt.dt(s.departure)], ['ETA', h`${fmt.dt(s.eta)} ${late ? badge('OPEN', 'kechikdi') : ''}`], ['Actual arrival', fmt.dt(s.actual_arrival)], ['Masofa', s.distance_km ? `${s.distance_km} km` : '—']]))}
    ${card('Traceability', h`<div class="chain">${[['Jo‘natma', s.ship_no], ['Transport', d.vehicle?.code], ['Haydovchi', d.driver?.full_name], ['Pallet', `${d.pallets.length} ta`], ['Mahsulot', `${fmt.n(s.total_qty)} dona`], ['Serial', `${d.serials.length} ta`], ['Mijoz/loyiha', `${d.order?.customer || ''}${d.order?.project ? ` / ${d.order.project}` : ''}`]].map(([a, b], i) => h`${i ? h`<span class="arrow">${icon('arrow')}</span>` : ''}<div class="node ok"><b>${a}</b>${b}</div>`)}</div>${d.serials.length ? h`<details style="margin-top:10px"><summary class="small">Serial raqamlar (${d.serials.length})</summary><div class="mono small" style="max-height:160px;overflow:auto">${d.serials.map((x) => h`<a href="#/qr?code=${x}">${x}</a> `)}</div></details>` : ''}`)}
    ${card('Tarix', timeline(d.history.map((x) => ({ title: label(x.to_status), sub: x.note, at: x.created_at, by: x.user }))))}
    </div>
  </div>`);
  const inp = $('[data-ls] input', el); if (inp && !('ontouchstart' in window)) inp.focus();
  $('[data-ls]', el)?.addEventListener('submit', async (e) => { e.preventDefault(); const code = inp.value.trim(); if (!code) return; try { const r = await POST(`/api/loading/${lt.id}/scan`, { code }); $('[data-lres]', el).innerHTML = html(h`<div class="scan-res ${r.ok ? 'ok' : 'bad'}">${r.message}</div>`); if (r.ok) setTimeout(App.refresh, 900); } catch (err) { $('[data-lres]', el).innerHTML = html(h`<div class="scan-res bad">${err.message}</div>`); } inp.value = ''; inp.focus(); });
  el.addEventListener('click', async (e) => {
    const vd = e.target.closest('[data-vd]'); if (vd) return A.viewDoc(vd.dataset.vd);
    const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a;
    if (a === 'start') act(b, () => POST(`/api/loading/${lt.id}/start`), (r) => `LOADING_STARTED${r.warnings.length ? ` — ⚠ ${r.warnings.join('; ')}` : ''}`).then(App.refresh);
    if (a === 'complete') { const left = d.pallets.filter((p) => p.status !== 'LOADED').length; if (left && !(await confirmBox('Yuklashni yakunlash', `${left} ta pallet skan qilinmagan. Barchasini yuklangan deb belgilaymi?`, 'Ha, barchasi yuklandi'))) return; act(b, () => POST(`/api/loading/${lt.id}/complete`, { loadAll: true }), (r) => `Yuklandi (${r.minutes} daq). ${r.documents.length} ta hujjat yaratildi`).then(App.refresh); }
    if (a === 'dispatch') { const r = await formModal({ title: `Dispatch — ${s.ship_no}`, intro: h`<p class="t2">Jo‘natilganda inventardan chiqariladi (SHIP), serial raqamlar SHIPPED holatiga o‘tadi.</p>`, fields: [{ name: 'eta', label: 'ETA (bo‘sh — masofadan hisoblanadi)', type: 'datetime-local' }], submitText: 'Jo‘natish', submitClass: 'accent', onSubmit: (x) => POST(`/api/shipments/${s.id}/dispatch`, x) }); if (r) { toast(`SHIPMENT_DISPATCHED · ETA ${fmt.dt(r.eta)}`, 'ok'); App.refresh(); } }
    if (a === 'arrive') act(b, () => POST(`/api/shipments/${s.id}/arrive`), 'Yetkazildi (SHIPMENT_ARRIVED)').then(App.refresh);
    if (a === 'cancel') { const r = await formModal({ title: 'Jo‘natmani bekor qilish', fields: [{ name: 'reason', label: 'Sabab', required: true, full: true }], submitText: 'Bekor qilish', submitClass: 'danger', onSubmit: (x) => POST(`/api/shipments/${s.id}/cancel`, x) }); if (r) App.refresh(); }
    if (a === 'docs') act(b, () => POST(`/api/shipments/${s.id}/documents`), 'Hujjatlar yangi versiyada').then(App.refresh);
    if (a === 'labels') A.printLabels(d.pallets.map((p) => p.pallet_no));
  });
} });
App.page('/loading', { title: 'Yuklash', live: ['SHIPMENT_CREATED', 'LOADING_STARTED', 'LOADING_COMPLETED'], async render({ el }) {
  const rows = await GET('/api/loading');
  el.innerHTML = html(h`${pageHead('Yuklash topshiriqlari', 'Loading sequence · vaqt me’yori · kechikish sabablari')}${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows, onRow: (r) => go(`#/shipments/${r.ship_no}`), columns: [{ key: 'task_no', label: 'Topshiriq', render: (r) => h`<b>${r.task_no}</b>` }, { key: 'ship_no', label: 'Jo‘natma' }, { key: 'vehicle', label: 'Transport' }, { key: 'pallet_count', label: 'Pallet', num: true }, { key: 'assignee', label: 'Yuklovchi' },
    { key: 'estimated_minutes', label: 'Me’yor', num: true, render: (r) => `${r.estimated_minutes} daq` }, { key: 'actual_minutes', label: 'Haqiqiy', num: true, render: (r) => (r.actual_minutes ? h`<b style="color:${r.actual_minutes > r.estimated_minutes * 1.5 ? 'var(--crit-ink)' : 'inherit'}">${r.actual_minutes} daq</b>` : '—') },
    { key: 'deadline', label: 'Deadline', render: (r) => fmt.dt(r.deadline) }, { key: 'status', label: 'Holat', render: (r) => badge(r.status) }] });
} });

// ================= Projects / TS / Documents / XETQ =================
App.page('/projects', { title: 'Loyihalar', async render({ el }) {
  const rows = await GET('/api/projects');
  el.innerHTML = html(h`${pageHead('Loyihalar', App.meta?.modules?.logistics ? 'Project → TS → Drawings → BOM → Quality → Test → Packing → Logistics → Approval' : 'Project → TS → Drawings → BOM → Production → Quality → Test → Packing → Approval', btn('+ Loyiha', { cls: 'primary', ico: 'plus', attrs: 'data-a', perm: 'projects.manage' }))}${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows, onRow: (r) => go(`#/projects/${r.id}`), columns: [{ key: 'code', label: 'Kod', render: (r) => h`<b>${r.code}</b>` }, { key: 'name', label: 'Nomi' }, { key: 'customer', label: 'Mijoz' }, { key: 'capacity_mw', label: 'MW', num: true }, { key: 'orders', label: 'Buyurtma', num: true }, { key: 'ts', label: 'TS', num: true }, { key: 'documents', label: 'Hujjat', num: true }, { key: 'requires_xetq', label: 'XETQ', render: (r) => (r.requires_xetq ? h`${badge(r.xetq_status || 'DRAFT')}` : raw('<span class="muted">talab qilinmaydi</span>')) }] });
  $('[data-a]', el)?.addEventListener('click', async () => { const r = await formModal({ title: '+ Loyiha', fields: [{ name: 'code', label: 'Kod', required: true }, { name: 'name', label: 'Nomi', required: true }, { name: 'customerId', label: 'Mijoz', type: 'select', options: opt.customers() }, { name: 'customerName', label: 'yoki yangi mijoz' }, { name: 'capacityMw', label: 'Quvvat, MW', type: 'number' }, { name: 'location', label: 'Joylashuv' }, { name: 'requiresXetq', label: 'Jo‘natish uchun XETQ kelishuvi talab qilinadi', type: 'checkbox', full: true }], onSubmit: (d) => POST('/api/projects', d) }); if (r) { await App.loadMeta(); App.refresh(); } });
} });
App.page('/projects/:id', { title: 'Loyiha', async render({ el, params }) {
  const d = await GET(`/api/projects/${params.id}`); const p = d.project;
  const has = (t) => d.documents.filter((x) => x.doc_type === t);
  const ts = d.ts.filter((t) => t.status !== 'ARCHIVED').slice(-1)[0];
  const chain = [['Project', p.code, true], ['Technical Specification', ts ? `${ts.ts_no} v${ts.version} (${label(ts.status)})` : 'yo‘q', !!ts], ['Drawings', has('DRAWING').length, has('DRAWING').length], ['BOM', has('BOM').length, has('BOM').length], ['Quality Requirements', ts?.quality_requirements ? 'TS da' : has('QUALITY_DOC').length, ts?.quality_requirements || has('QUALITY_DOC').length], ['Test Protocol', has('TEST_PROTOCOL').length + has('TEST_RESULTS').length, has('TEST_PROTOCOL').length + has('TEST_RESULTS').length], ['Packing Specification', has('PACKING_SPEC').length || (ts?.packaging_spec ? 'TS da' : 0), has('PACKING_SPEC').length || ts?.packaging_spec], ['Logistics Specification', has('LOGISTICS_SPEC').length, has('LOGISTICS_SPEC').length], ['Approval', d.xetq[0] ? label(d.xetq[0].status) : '—', d.xetq.some((x) => x.status === 'APPROVED')]];
  el.innerHTML = html(h`${pageHead(`${p.code} — ${p.name}`, `${p.customer || ''} · ${p.capacity_mw || '—'} MW · ${p.location || ''}${p.requires_xetq ? ' · XETQ majburiy' : ''}`, '', h`<a href="#/projects">Loyihalar</a> / ${p.code}`)}
  ${card('Loyiha hujjatlari zanjiri', h`<div class="chain">${chain.map(([a, b, ok], i) => h`${i ? h`<span class="arrow">${icon('arrow')}</span>` : ''}<div class="node ${ok ? 'ok' : 'miss'}"><b>${a}</b>${ok ? '✓ ' : '○ '}${b}</div>`)}</div>`)}
  <div class="grid g2" style="margin-top:16px">
    ${card('Texnik shartlar', raw(tableHtml([{ label: 'TS', render: (t) => h`<a href="#/ts?open=${t.id}">${t.ts_no} v${t.version}</a>` }, { label: 'Nomi', key: 'title' }, { label: 'Holat', render: (t) => badge(t.status) }], d.ts)), { flush: true })}
    ${card('Hujjatlar', raw(tableHtml([{ label: 'Hujjat', render: (x) => h`<a href="#/documents?open=${x.id}">${x.doc_no}</a> ${x.title}` }, { label: 'Turi', key: 'doc_type' }, { label: 'v', key: 'current_version' }, { label: 'Holat', render: (x) => badge(x.status) }], d.documents)), { flush: true })}
    ${card('XETQ topshiruvlari', raw(tableHtml([{ label: '№', render: (x) => h`<a href="#/xetq/${x.id}">${x.sub_no}</a>` }, { label: 'Nomi', key: 'title' }, { label: 'v', key: 'version' }, { label: 'Holat', render: (x) => badge(x.status) }], d.xetq)), { flush: true })}
    ${card('Buyurtmalar va loyiha rezervi', raw(tableHtml([{ label: 'Buyurtma', render: (x) => h`<a href="#/orders/${x.id}">${x.order_no}</a>` }, { label: 'Holat', render: (x) => badge(x.status) }, { label: 'Muddat', render: (x) => fmt.d(x.due_date) }], d.orders) + (d.reservations.length ? `<div style="padding:10px 16px" class="small">Loyiha rezervi: ${d.reservations.map((r) => `${esc(r.sku)} — ${fmt.n(r.qty - r.picked_qty)}`).join(', ')}</div>` : '')), { flush: true })}
  </div>`);
} });

A.tsForm = async (base, revise) => {
  const v = base || {};
  const F = [['title', 'Nomi', 'text', true], ['model', 'Model'], ['power', 'Quvvat'], ['dimensions', 'O‘lchamlar'], ['weight', 'Og‘irlik'], ['electrical_spec', 'Elektr spetsifikatsiyasi', 'textarea'], ['material_spec', 'Material spetsifikatsiyasi', 'textarea'], ['packaging_spec', 'Qadoqlash spetsifikatsiyasi', 'textarea'], ['quality_requirements', 'Sifat talablari', 'textarea'], ['standards', 'Qo‘llaniladigan standartlar', 'textarea']];
  const fields = [...(revise ? [{ name: 'revisionNote', label: 'O‘zgarish izohi (revision)', required: true, full: true }, { name: 'major', label: 'Katta versiya (2.0)', type: 'checkbox' }] : [{ name: 'projectId', label: 'Loyiha', type: 'select', options: opt.projects() }, { name: 'productId', label: 'Mahsulot', type: 'select', options: opt.products((p) => p.category === 'FINISHED') }]),
    ...F.map(([name, lbl, type, req]) => ({ name, label: lbl, type: type || 'text', required: req, value: v[name], full: type === 'textarea', rows: 2 }))];
  const r = await formModal({ title: revise ? `Yangi revision — ${base.ts_no} (hozir v${base.version})` : '+ Texnik shart', size: 'wide', fields, onSubmit: (d) => (revise ? POST(`/api/technical-specifications/${base.id}/revise`, d) : POST('/api/technical-specifications', d)) });
  if (r) { toast(`Saqlandi: v${r.version}`, 'ok'); App.refresh(); }
};
App.page('/ts', { title: 'Texnik shartlar', async render({ el, query }) {
  const rows = await GET('/api/technical-specifications');
  const latest = rows.filter((r) => r.is_latest);
  el.innerHTML = html(h`${pageHead('Texnik shartlar', 'Versiyalash: 1.0 → 1.1 → 2.0 · eski versiyalar o‘chirilmaydi — ARCHIVED', btn('+ Texnik shart', { cls: 'primary', ico: 'plus', attrs: 'data-a', perm: 'xetq.manage' }))}${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows: latest, onRow: (r) => tsDetail(r.id), columns: [{ key: 'ts_no', label: 'TS ID', render: (r) => h`<b>${r.ts_no}</b>` }, { key: 'version', label: 'Versiya', render: (r) => `v${r.version}` }, { key: 'title', label: 'Nomi' }, { key: 'project_code', label: 'Loyiha' }, { key: 'sku', label: 'Mahsulot' }, { key: 'power', label: 'Quvvat' }, { key: 'status', label: 'Holat', render: (r) => badge(r.status) }, { key: 'approved_by_name', label: 'Tasdiqladi' }] });
  $('[data-a]', el)?.addEventListener('click', () => A.tsForm());
  if (query.open) tsDetail(Number(query.open));
} });
async function tsDetail(id) {
  const d = await GET(`/api/technical-specifications/${id}`); const t = d.ts;
  const next = { DRAFT: [['IN_REVIEW', 'Ko‘rib chiqishga']], IN_REVIEW: [['APPROVED', 'Tasdiqlash'], ['DRAFT', 'Qaytarish']] }[t.status] || [];
  await modal({ title: `${t.ts_no} v${t.version} — ${t.title}`, size: 'wide', body: h`<div style="margin-bottom:12px">${badge(t.status)}</div>${dl([['Model', t.model], ['Power', t.power], ['Dimensions', t.dimensions], ['Weight', t.weight], ['Electrical specification', t.electrical_spec], ['Material specification', t.material_spec], ['Packaging specification', t.packaging_spec], ['Quality requirements', t.quality_requirements], ['Applicable standards', t.standards], ['Revision', t.revision_note], ['Approval', t.approved_at ? fmt.dt(t.approved_at) : '—']])}
    <h4>Versiyalar</h4>${raw(tableHtml([{ label: 'Versiya', render: (v) => h`<a href="#/ts?open=${v.id}">v${v.version}</a>` }, { label: 'Holat', render: (v) => badge(v.status) }, { label: 'Izoh', key: 'revision_note' }, { label: 'Sana', render: (v) => fmt.d(v.created_at) }], d.versions))}`,
  footer: h`${can('xetq.manage') && ['APPROVED', 'ARCHIVED'].includes(t.status) ? h`<button class="btn" data-rev>Yangi revision</button>` : ''}${next.filter(() => can(t.status === 'IN_REVIEW' ? 'documents.approve' : 'xetq.manage')).map(([s, l]) => h`<button class="btn ${s === 'APPROVED' ? 'good' : 'primary'}" data-st="${s}">${l}</button>`)}`,
  onOpen: (bg, close) => { $('[data-rev]', bg)?.addEventListener('click', () => { close(); A.tsForm(t, true); }); $$('[data-st]', bg).forEach((b) => b.addEventListener('click', () => act(b, () => POST(`/api/technical-specifications/${id}/status`, { status: b.dataset.st }), `Holat: ${label(b.dataset.st)}`).then(() => { close(); App.refresh(); }))); } });
}

App.page('/documents', { title: 'Hujjatlar', live: ['DOCUMENT_CREATED', 'DOCUMENT_APPROVED'], async render({ el, query }) {
  const rows = await GET(`/api/documents${query.type ? `?type=${query.type}` : ''}`);
  el.innerHTML = html(h`${pageHead('Hujjatlar (Document Control)', 'Versiya · muallif · tasdiqlovchi · SHA-256 butunlik nazorati', btn('+ Hujjat', { cls: 'primary', ico: 'plus', attrs: 'data-a', perm: 'documents.manage' }))}
  <div class="toolbar"><select class="input" data-type><option value="">Barcha turlar</option>${raw(Object.entries(App.meta.docTypes).map(([k, v]) => `<option value="${k}" ${query.type === k ? 'selected' : ''}>${esc(v)}</option>`).join(''))}</select></div>${card('', raw('<div data-t></div>'), { flush: true })}`);
  $('[data-type]', el).addEventListener('change', (e) => go(`#/documents${e.target.value ? `?type=${e.target.value}` : ''}`));
  dataTable($('[data-t]', el), { rows, onRow: (r) => docDetail(r.id), columns: [{ key: 'doc_no', label: 'Hujjat ID', render: (r) => h`<b>${r.doc_no}</b>` }, { key: 'title', label: 'Nomi' }, { key: 'doc_type', label: 'Turi', render: (r) => App.meta.docTypes[r.doc_type] || r.doc_type }, { key: 'current_version', label: 'Versiya', render: (r) => `v${r.current_version}` },
    { key: 'author', label: 'Muallif' }, { key: 'approver', label: 'Tasdiqlovchi' }, { key: 'status', label: 'Holat', render: (r) => badge(r.status) }, { key: 'sha256', label: 'Hash', render: (r) => h`<span class="mono small" title="${r.sha256}">${(r.sha256 || '').slice(0, 10)}…</span>` }, { key: 'updated_at', label: 'O‘zgartirildi', render: (r) => fmt.dt(r.updated_at) }] });
  $('[data-a]', el)?.addEventListener('click', () => A.newDoc());
  if (query.open) docDetail(Number(query.open));
} });
A.newDoc = async (preset = {}) => {
  const fields = [{ name: 'docType', label: 'Turi', type: 'select', required: true, options: Object.entries(App.meta.docTypes), value: preset.docType }, { name: 'title', label: 'Nomi', required: true }, { name: 'projectId', label: 'Loyiha', type: 'select', options: opt.projects(), value: preset.projectId },
    { name: 'file', label: 'Fayl (PDF, rasm, DOCX, XLSX, CSV, TXT, DWG; ≤10 MB — virus tekshiriladi)', type: 'file', accept: '.pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx,.csv,.txt,.dwg' }, { name: 'content', label: 'yoki matn mazmuni', type: 'textarea', full: true, rows: 5 }];
  const r = await formModal({ title: '+ Hujjat', size: 'wide', fields, onSubmit: (d) => { if (!d.file && !d.content) throw new Error('Fayl yuklang yoki matn kiriting'); if (d.content) d.content = `<div style="font-family:Arial;white-space:pre-wrap">${esc(d.content)}</div>`; return POST('/api/documents', d); } });
  if (r) { toast(`${r.docNo} v${r.version} yaratildi`, 'ok'); App.refresh(); }
  return r;
};
async function docDetail(id) {
  const d = await GET(`/api/documents/${id}`); const doc = d.document;
  const next = { DRAFT: ['IN_REVIEW', 'ARCHIVED'], IN_REVIEW: ['APPROVED', 'DRAFT'], APPROVED: ['ARCHIVED', 'DRAFT'], ISSUED: ['ARCHIVED'] }[doc.status] || [];
  await modal({ title: `${doc.doc_no} — ${doc.title}`, size: 'wide', body: h`${dl([['Document ID', doc.doc_no], ['Turi', App.meta.docTypes[doc.doc_type]], ['Versiya', `v${doc.current_version}`], ['Holat', badge(doc.status)], ['Muallif', doc.author], ['Yaratilgan', fmt.dt(doc.created_at)], ['O‘zgartirilgan', fmt.dt(doc.updated_at)], ['Tasdiqlovchi', doc.approver], ['Tasdiq sanasi', fmt.dt(doc.approved_at)]])}
    <h4>Versiyalar (eski versiyalar arxivda saqlanadi)</h4>${raw(tableHtml([{ label: 'v', render: (v) => h`<b>${v.version}</b>` }, { label: 'Holat', render: (v) => badge(v.status) }, { label: 'Fayl', render: (v) => v.file_name || 'HTML' }, { label: 'SHA-256', render: (v) => h`<span class="mono small" title="${v.sha256}">${v.sha256.slice(0, 12)}…</span> <span data-vr="${v.id}"></span>` }, { label: 'Izoh', key: 'change_note' }, { label: 'Sana', render: (v) => fmt.dt(v.created_at) },
      { label: '', render: (v) => h`<div style="display:flex;gap:4px"><a class="btn sm" href="/api/documents/versions/${v.id}/view" target="_blank" rel="noopener">${icon('eye')}</a><a class="btn sm" href="/api/documents/versions/${v.id}/download">${icon('download')}</a><button type="button" class="btn sm" data-verify="${v.id}">${icon('shield')}Tekshirish</button></div>` }], d.versions))}
    <h4>Tarix</h4>${timeline(d.history.map((x) => ({ title: `${label(x.from_status)} → ${label(x.to_status)}`, at: x.created_at, by: x.user })))}`,
  footer: h`${can('documents.manage') && !doc.ref_type ? h`<button class="btn" data-nv>Yangi versiya</button>` : ''}${can('documents.manage') ? next.filter((s) => s !== 'APPROVED' || can('documents.approve')).map((s) => h`<button class="btn ${s === 'APPROVED' ? 'good' : ''}" data-st="${s}">${label(s)}</button>`) : ''}`,
  onOpen: (bg, close) => {
    $$('[data-verify]', bg).forEach((b) => b.addEventListener('click', async () => { const r = await GET(`/api/documents/versions/${b.dataset.verify}/verify`); $(`[data-vr="${b.dataset.verify}"]`, bg).innerHTML = r.valid ? '<span class="badge good">butun</span>' : '<span class="badge crit">o‘zgargan!</span>'; }));
    $$('[data-st]', bg).forEach((b) => b.addEventListener('click', () => act(b, () => POST(`/api/documents/${id}/status`, { status: b.dataset.st }), `Holat: ${label(b.dataset.st)}`).then(() => { close(); App.refresh(); })));
    $('[data-nv]', bg)?.addEventListener('click', async () => { close(); const r = await formModal({ title: `Yangi versiya — ${doc.doc_no}`, fields: [{ name: 'changeNote', label: 'O‘zgarish izohi', required: true, full: true }, { name: 'major', label: 'Katta versiya (x.0)', type: 'checkbox' }, { name: 'file', label: 'Fayl', type: 'file', full: true, accept: '.pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx,.csv,.txt,.dwg' }, { name: 'content', label: 'yoki matn', type: 'textarea', full: true }], onSubmit: (x) => { if (!x.file && !x.content) throw new Error('Fayl yoki matn kerak'); if (x.content) x.content = `<div style="font-family:Arial;white-space:pre-wrap">${esc(x.content)}</div>`; return POST(`/api/documents/${id}/versions`, x); } }); if (r) { toast(`v${r.version} saqlandi, oldingisi ARCHIVED`, 'ok'); App.refresh(); } });
  } });
}

App.page('/xetq', { title: 'XETQ', live: ['DOCUMENT_SUBMITTED', 'DOCUMENT_APPROVED', 'XETQ_STATUS'], async render({ el }) {
  const rows = await GET('/api/xetq');
  const cnt = (s) => rows.filter((r) => r.status === s).length;
  el.innerHTML = html(h`${pageHead('XETQ kelishuvi', 'DRAFT → INTERNAL_REVIEW → READY_FOR_SUBMISSION → SUBMITTED → UNDER_REVIEW → REVISION_REQUIRED / APPROVED', btn('+ XETQ topshiruvi', { cls: 'primary', ico: 'plus', attrs: 'data-a', perm: 'xetq.manage' }))}
  <div class="kpis">${[...XETQ_MAIN.slice(0, 5), 'REVISION_REQUIRED', 'APPROVED'].map((s) => kpi({ label: label(s), value: cnt(s), ico: s === 'APPROVED' ? 'check' : s === 'REVISION_REQUIRED' ? 'alert' : 'doc', tone: s === 'REVISION_REQUIRED' && cnt(s) ? 'crit' : s === 'APPROVED' ? 'good' : '' }))}</div>
  ${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows, onRow: (r) => go(`#/xetq/${r.id}`), columns: [{ key: 'sub_no', label: '№', render: (r) => h`<b>${r.sub_no}</b>` }, { key: 'title', label: 'Nomi' }, { key: 'project_code', label: 'Loyiha' }, { key: 'ts_no', label: 'Texnik shart', render: (r) => (r.ts_no ? h`${r.ts_no} v${r.ts_version} ${badge(r.ts_status)}` : '—') }, { key: 'version', label: 'Versiya', render: (r) => `v${r.version}` }, { key: 'responsible', label: 'Mas’ul' }, { key: 'status', label: 'Holat', render: (r) => badge(r.status) }, { key: 'updated_at', label: 'Yangilandi', render: (r) => fmt.dt(r.updated_at) }] });
  $('[data-a]', el)?.addEventListener('click', async () => {
    const [ts, docs] = await Promise.all([GET('/api/technical-specifications'), GET('/api/documents')]);
    const r = await formModal({ title: '+ XETQ topshiruvi (hujjat paketi)', size: 'wide', fields: [{ name: 'title', label: 'Nomi', required: true, full: true }, { name: 'projectId', label: 'Loyiha', type: 'select', required: true, options: opt.projects() }, { name: 'productId', label: 'Mahsulot', type: 'select', options: opt.products((p) => p.category === 'FINISHED') }, { name: 'qty', label: 'Miqdor', type: 'number' },
      { name: 'tsId', label: 'Texnik shart', type: 'select', options: ts.filter((t) => t.status !== 'ARCHIVED').map((t) => [t.id, `${t.ts_no} v${t.version} — ${label(t.status)}`]) }, { name: 'responsibleId', label: 'Mas’ul xodim', type: 'select', options: opt.users() },
      { name: 'packingSpec', label: 'Packing specification', full: true }, { name: 'logisticsInfo', label: 'Logistics information', full: true },
      { type: 'html', name: 'docs', full: true, html: `<div class="field"><label>Biriktiriladigan hujjatlar (drawing, datasheet, certificate, test results, quality…)</label><div style="max-height:200px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px">${docs.filter((x) => !x.ref_type).map((x) => `<label class="check" style="display:flex;margin:3px 0"><input type="checkbox" data-doc="${x.id}"> ${esc(x.doc_no)} — ${esc(x.title)} <span class="muted small">(${esc(x.doc_type)}, ${esc(label(x.status))})</span></label>`).join('')}</div></div>` }],
    onSubmit: (d, form) => POST('/api/xetq', { ...d, documentIds: $$('[data-doc]:checked', form).map((c) => Number(c.dataset.doc)) }) });
    if (r) go(`#/xetq/${r.id}`);
  });
} });
App.page('/xetq/:id', { title: 'XETQ topshiruvi', live: ['DOCUMENT_SUBMITTED', 'DOCUMENT_APPROVED', 'XETQ_STATUS'], async render({ el, params }) {
  const d = await GET(`/api/xetq/${params.id}`); const s = d.submission;
  const editable = ['DRAFT', 'INTERNAL_REVIEW', 'REVISION_REQUIRED'].includes(s.status);
  const NEXT_LBL = { INTERNAL_REVIEW: 'Ichki tekshiruvga', READY_FOR_SUBMISSION: 'Topshirishga tayyor', SUBMITTED: 'XETQ ga topshirish', UNDER_REVIEW: 'XETQ ko‘rib chiqmoqda', REVISION_REQUIRED: 'Tuzatish talab qilindi', APPROVED: 'Kelishildi (APPROVED)', DRAFT: 'Qoralamaga qaytarish' };
  const permFor = (st) => (['UNDER_REVIEW', 'REVISION_REQUIRED', 'APPROVED'].includes(st) ? 'xetq.review' : 'xetq.manage');
  const lastRev = [...d.reviews].reverse().find((r) => r.to_status === 'REVISION_REQUIRED');
  el.innerHTML = html(h`${pageHead(h`${s.sub_no} ${badge(s.status)} <span class="badge plain dark">v${s.version}</span>`, `${s.title} · ${s.project_code} · mas’ul ${s.responsible || '—'}`, h`${d.next.filter((st) => can(permFor(st))).map((st) => h`<button class="btn ${st === 'APPROVED' ? 'good' : st === 'REVISION_REQUIRED' || st === 'DRAFT' ? 'danger' : 'primary'}" data-to="${st}">${NEXT_LBL[st]}</button>`)}`, h`<a href="#/xetq">XETQ</a> / ${s.sub_no}`)}
  ${card('', stepper(XETQ_MAIN, s.status === 'REVISION_REQUIRED' ? 'UNDER_REVIEW' : s.status, { bad: s.status === 'REVISION_REQUIRED' }))}
  ${s.status === 'REVISION_REQUIRED' && lastRev ? h`<div class="callout crit" style="margin-top:14px">${icon('alert')}<div><b>REVISION_REQUIRED</b><div>Nima tuzatish kerak: ${lastRev.required_changes}</div><div>Kim tuzatadi: ${lastRev.fix_owner} · Deadline: ${fmt.d(lastRev.deadline)}${new Date(lastRev.deadline) < Date.now() ? ' 🔴 muddati o‘tgan' : ''}</div><div>Izoh: ${lastRev.comment || '—'}${lastRev.reviewer ? ` (${lastRev.reviewer})` : ''}</div></div></div>` : ''}
  <div class="grid g2" style="margin-top:16px">
    ${card('Paket tarkibi (checklist)', h`${d.checklist.map((c) => h`<div style="display:flex;gap:8px;padding:4px 0">${c.ok ? '✅' : c.required ? '❌' : '⚪'} <span>${c.item}${c.required ? h` <span class="small muted">(majburiy)</span>` : ''}</span></div>`)}`)}
    ${card('Ma’lumotlar', dl([['Project', `${s.project_code} — ${s.project_name}`], ['Product / Quantity', `${s.product_id ? App.meta.products.find((p) => p.id === s.product_id)?.sku : '—'} · ${fmt.n(s.qty)}`], ['Technical specification', d.ts ? h`<a href="#/ts?open=${d.ts.id}">${d.ts.ts_no} v${d.ts.version}</a> ${badge(d.ts.status)}` : '—'], ['Packing specification', s.packing_spec], ['Logistics information', s.logistics_info], ['Responsible employee', s.responsible], ['Topshirildi', fmt.dt(s.submitted_at)], ['Kelishildi', fmt.dt(s.approved_at)]]), { actions: editable && can('xetq.manage') ? btn('Tahrirlash', { cls: 'sm', attrs: 'data-edit' }) : '' })}
    ${card('Biriktirilgan hujjatlar', raw(tableHtml([{ label: 'Hujjat', render: (x) => h`<a href="#/documents?open=${x.id}">${x.doc_no}</a> ${x.title}` }, { label: 'Turi', key: 'doc_type' }, { label: 'v', key: 'current_version' }, { label: 'Holat', render: (x) => badge(x.status) }, { label: 'SHA-256', render: (x) => h`<span class="mono small">${(x.sha256 || '').slice(0, 10)}…</span>` }], d.documents)), { flush: true, actions: editable && can('documents.manage') ? btn('+ Hujjat yuklash', { cls: 'sm', attrs: 'data-up' }) : '' })}
    ${card('Kelishuv tarixi', timeline(d.reviews.map((r) => ({ title: `${label(r.from_status)} → ${label(r.to_status)}${r.new_version ? ` (v${r.new_version})` : ''}`, sub: [r.comment, r.required_changes ? `Tuzatish: ${r.required_changes}` : '', r.fix_owner ? `Kim: ${r.fix_owner}, muddat ${fmt.d(r.deadline)}` : '', r.reviewer].filter(Boolean).join(' · '), at: r.created_at, by: r.by_name }))))}
  </div>`);
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-to]');
    if (t) {
      const st = t.dataset.to; let fields = [{ name: 'comment', label: 'Izoh', full: true, type: 'textarea', rows: 2 }];
      if (st === 'REVISION_REQUIRED') fields = [{ name: 'comment', label: 'XETQ izohi', required: true, full: true }, { name: 'requiredChanges', label: 'Nima tuzatish kerak', required: true, type: 'textarea', full: true }, { name: 'fixOwnerId', label: 'Kim tuzatadi', type: 'select', required: true, options: opt.users() }, { name: 'deadline', label: 'Deadline', type: 'date', required: true }, { name: 'reviewer', label: 'XETQ eksperti' }];
      if (s.status === 'REVISION_REQUIRED' && st === 'INTERNAL_REVIEW') fields.unshift({ name: 'newVersion', label: 'Yangi versiya', required: true, value: (() => { const [a, b] = s.version.split('.').map(Number); return `${a}.${b + 1}`; })() });
      if (st === 'UNDER_REVIEW' || st === 'APPROVED') fields.push({ name: 'reviewer', label: 'XETQ eksperti / qaror raqami' });
      const r = await formModal({ title: NEXT_LBL[st], fields, submitText: 'Tasdiqlash', onSubmit: (x) => POST(`/api/xetq/${s.id}/transition`, { ...x, status: st }) });
      if (r) { toast(`Holat: ${r.status}${st === 'SUBMITTED' ? ' — Technical Document Package generatsiya qilindi' : ''}`, 'ok'); App.refresh(); }
    }
    if (e.target.closest('[data-up]')) { const r = await A.newDoc({ projectId: s.project_id }); if (r) { await PUT(`/api/xetq/${s.id}`, { documentIds: [...JSON.parse(s.document_ids || '[]'), r.id] }); App.refresh(); } }
    if (e.target.closest('[data-edit]')) {
      const [ts, docs] = await Promise.all([GET('/api/technical-specifications'), GET('/api/documents')]); const cur = JSON.parse(s.document_ids || '[]');
      const r = await formModal({ title: `Tahrirlash — ${s.sub_no}`, size: 'wide', fields: [{ name: 'tsId', label: 'Texnik shart', type: 'select', value: s.ts_id, options: ts.filter((x) => x.status !== 'ARCHIVED' || x.id === s.ts_id).map((x) => [x.id, `${x.ts_no} v${x.version} — ${label(x.status)}`]) }, { name: 'qty', label: 'Miqdor', type: 'number', value: s.qty }, { name: 'packingSpec', label: 'Packing specification', full: true, value: s.packing_spec }, { name: 'logisticsInfo', label: 'Logistics information', full: true, value: s.logistics_info },
        { type: 'html', name: 'docs', full: true, html: `<div class="field"><label>Hujjatlar</label><div style="max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px">${docs.filter((x) => !x.ref_type || cur.includes(x.id)).map((x) => `<label class="check" style="display:flex;margin:3px 0"><input type="checkbox" data-doc="${x.id}" ${cur.includes(x.id) ? 'checked' : ''}> ${esc(x.doc_no)} — ${esc(x.title)} <span class="muted small">(${esc(x.doc_type)})</span></label>`).join('')}</div></div>` }],
      onSubmit: (x, form) => PUT(`/api/xetq/${s.id}`, { ...x, documentIds: $$('[data-doc]:checked', form).map((c) => Number(c.dataset.doc)) }) });
      if (r) App.refresh();
    }
  });
} });
