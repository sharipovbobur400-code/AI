/* Odoo ERP: ulash kartasi (API kalitlari sahifasida), Odoo xaridlari (Ta’minot) va Odoo jo‘natmalari (Logistika) */
'use strict';

const ODOO_PO_STATE = { draft: ['RFQ', 'dark'], sent: ['RFQ yuborilgan', 'dark'], 'to approve': ['Tasdiq kutilmoqda', 'amber'], purchase: ['Buyurtma (PO)', 'blue'], done: ['Yopilgan', 'good'], cancel: ['Bekor', 'crit'] };
const ODOO_PICK_STATE = { draft: ['Qoralama', 'dark'], waiting: ['Kutilmoqda', 'amber'], confirmed: ['Tasdiqlangan', 'blue'], assigned: ['Tayyor', 'blue'], done: ['Jo‘natildi', 'good'], cancel: ['Bekor', 'crit'] };
const RECEIPT = { pending: 'kelmagan', partial: 'qisman kelgan', full: 'to‘liq kelgan' };
const stBadge = (map, s) => { const [l, c] = map[s] || [s || '—', 'dark']; return h`<span class="badge ${c}">${l}</span>`; };
const odt = (s) => (s ? fmt.dt(`${String(s).replace(' ', 'T')}Z`) : '—');
const linesHtml = (lines, doneKey) => h`<table class="t"><thead><tr><th>Mahsulot</th><th class="num">Miqdor</th><th class="num">${doneKey === 'received' ? 'Kelgan' : 'Bajarilgan'}</th><th>Birlik</th></tr></thead><tbody>${lines.map((l) => h`<tr><td>${l.product}</td><td class="num">${fmt.n(l.qty)}</td><td class="num">${fmt.n(l[doneKey])}</td><td>${l.uom || ''}</td></tr>`)}</tbody></table>`;

async function odooNotice(el) {
  const st = await GET('/api/odoo/status').catch(() => ({ configured: false }));
  if (st.configured) return h`<p class="small muted" style="margin:-6px 0 12px">🔄 Odoo ${st.version || ''} · oxirgi sinxronizatsiya: ${st.lastSyncAt ? fmt.dt(st.lastSyncAt) : 'hali bo‘lmagan'} ${st.lastStatus && st.lastStatus !== 'OK' ? h`<span class="badge amber">${st.lastStatus}</span>` : ''}</p>`;
  return h`<div class="callout warn" style="margin-bottom:14px">${icon('alert')}<div><b>Odoo ulanmagan.</b> Super admin: Sozlamalar → API kalitlari va Odoo → Odoo manzili, baza, login va API kalitni kiriting.</div></div>`;
}

App.page('/odoo-purchases', { title: 'Odoo xaridlari', live: ['INTEGRATION_SYNC'], async render({ el, query }) {
  const rows = await GET(`/api/odoo/purchases${query.late ? '?late=1' : ''}`);
  const late = rows.filter((r) => r.is_late).length;
  el.innerHTML = html(h`${pageHead('Odoo xarid buyurtmalari', 'Odoo ERP dan real vaqtga yaqin (RFQ, PO, kutilgan sana, qabul holati)', h`<a class="btn ${query.late ? 'primary' : ''}" href="#/odoo-purchases${query.late ? '' : '?late=1'}">${icon('alert')}${query.late ? 'Hammasi' : `Kechikkanlar (${late})`}</a>`)}
    ${raw(html(await odooNotice(el)))}${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows, empty: 'Odoo xarid buyurtmalari yo‘q (yoki Odoo ulanmagan)', rowClass: (r) => (r.is_late ? 'row-crit' : ''), searchKeys: ['name', 'partner', 'state', 'user_name'],
    onRow: (r) => modal({ title: `${r.name} — ${r.partner || ''}`, size: 'lg', body: h`${dl([['Holat', stBadge(ODOO_PO_STATE, r.state)], ['Qabul', RECEIPT[r.receipt_status] || '—'], ['Buyurtma sanasi', odt(r.date_order)], ['Kutilgan sana', h`${odt(r.date_planned)} ${r.is_late ? h`<span class="badge crit">kechikmoqda</span>` : ''}`], ['Mas’ul', r.user_name || '—'], ['Summa', `${fmt.n(r.amount_total)} ${r.currency || ''}`]])}<div style="margin-top:12px">${linesHtml(r.lines, 'received')}</div>` }),
    columns: [{ key: 'name', label: 'Buyurtma', render: (r) => h`<b>${r.name}</b>${r.is_late ? h` <span class="badge crit">kechikkan</span>` : ''}` }, { key: 'partner', label: 'Yetkazib beruvchi' },
      { key: 'state', label: 'Holat', render: (r) => stBadge(ODOO_PO_STATE, r.state) }, { key: 'receipt_status', label: 'Qabul', render: (r) => RECEIPT[r.receipt_status] || '—' },
      { key: 'date_planned', label: 'Kutilgan sana', render: (r) => odt(r.date_planned) }, { key: 'amount_total', label: 'Summa', num: true, render: (r) => `${fmt.n(r.amount_total)} ${r.currency || ''}` }] });
} });

App.page('/odoo-deliveries', { title: 'Odoo jo‘natmalari', live: ['INTEGRATION_SYNC'], async render({ el, query }) {
  const rows = await GET(`/api/odoo/deliveries${query.late ? '?late=1' : ''}`);
  const late = rows.filter((r) => r.is_late).length;
  el.innerHTML = html(h`${pageHead('Odoo jo‘natmalari (chiquvchi)', 'Odoo ERP dagi mijozlarga jo‘natmalar: rejalashtirilgan sana, holat, mahsulotlar', h`<a class="btn ${query.late ? 'primary' : ''}" href="#/odoo-deliveries${query.late ? '' : '?late=1'}">${icon('alert')}${query.late ? 'Hammasi' : `Kechikkanlar (${late})`}</a>`)}
    ${raw(html(await odooNotice(el)))}${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows, empty: 'Odoo jo‘natmalari yo‘q (yoki Odoo ulanmagan)', rowClass: (r) => (r.is_late ? 'row-crit' : ''), searchKeys: ['name', 'partner', 'origin', 'state'],
    onRow: (r) => modal({ title: `${r.name} — ${r.partner || ''}`, size: 'lg', body: h`${dl([['Holat', stBadge(ODOO_PICK_STATE, r.state)], ['Rejalashtirilgan', h`${odt(r.scheduled_date)} ${r.is_late ? h`<span class="badge crit">kechikmoqda</span>` : ''}`], ['Jo‘natilgan', odt(r.date_done)], ['Manba hujjat', r.origin || '—'], ['Operatsiya', r.picking_type || '—']])}<div style="margin-top:12px">${linesHtml(r.lines, 'done')}</div>` }),
    columns: [{ key: 'name', label: 'Jo‘natma', render: (r) => h`<b>${r.name}</b>${r.is_late ? h` <span class="badge crit">kechikkan</span>` : ''}` }, { key: 'partner', label: 'Mijoz' }, { key: 'origin', label: 'Buyurtma' },
      { key: 'state', label: 'Holat', render: (r) => stBadge(ODOO_PICK_STATE, r.state) }, { key: 'scheduled_date', label: 'Rejalashtirilgan', render: (r) => odt(r.scheduled_date) },
      { label: 'Mahsulotlar', sort: false, render: (r) => `${r.lines.length} ta` }] });
} });

/** API kalitlari sahifasidagi Odoo kartasi. */
App.renderOdooCard = async (box) => {
  if (!box) return;
  const d = await GET('/api/odoo');
  const c = d.config;
  const fields = [{ name: 'url', label: 'Odoo manzili', value: c.url || '', placeholder: 'https://kompaniya.odoo.com', required: true, full: true },
    { name: 'db', label: 'Baza nomi (database)', value: c.db || '', required: true }, { name: 'login', label: 'Login (email)', value: c.login || '', required: true },
    { name: 'apiKey', label: c.configured ? `API kalit (saqlangan: ${c.apiKeyMasked || '••••'} — o‘zgartirish uchun yangisini kiriting)` : 'API kalit', type: 'password', required: !c.configured, full: true },
    { name: 'intervalMin', label: 'Sinxronizatsiya oralig‘i, daqiqa', type: 'number', value: c.intervalMin || 15, min: 5 },
    { name: 'stock', label: 'Ombor (mahsulot, qoldiq)', type: 'checkbox', value: c.modules?.stock !== false }, { name: 'purchase', label: 'Ta’minot (supplier, xaridlar)', type: 'checkbox', value: c.modules?.purchase !== false },
    App.meta?.modules?.logistics ? { name: 'delivery', label: 'Logistika (jo‘natmalar)', type: 'checkbox', value: c.modules?.delivery !== false } : null].filter(Boolean);
  const stats = c.stats || {};
  box.innerHTML = html(card('🔗 Odoo ERP — API kalit bilan ulash', h`
    <p class="small t2" style="margin-top:0">Odoo'dan <b>Ombor</b> (mahsulotlar, qoldiq, minimal qoldiq), <b>Ta’minot</b> (yetkazib beruvchilar, RFQ/PO, kechikishlar) ${App.meta?.modules?.logistics ? h` va <b>Logistika</b> (chiquvchi jo‘natmalar)` : ''} ma’lumotlari avtomatik tortiladi. Odoo'ga hech narsa yozilmaydi.
    API kalit: Odoo → Sozlamalar → Foydalanuvchilar → (foydalanuvchi) → <i>Account Security</i> → <i>New API Key</i>.</p>
    ${c.configured ? h`<div class="callout" style="margin-bottom:12px">${icon(c.lastStatus === 'OK' ? 'check' : 'alert')}<div>Holat: <b>${c.lastStatus || 'hali sinxronlanmagan'}</b> · Odoo ${c.version || ''} · oxirgi: ${c.lastSyncAt ? fmt.dt(c.lastSyncAt) : '—'}
      ${c.lastError ? h`<div class="small" style="color:var(--crit-ink)">${c.lastError}</div>` : ''}
      <div class="small muted">Mahsulot: ${fmt.n(d.counts.products)} · Supplier: ${fmt.n(d.counts.suppliers)} · Xarid: ${fmt.n(d.counts.purchases)} · Jo‘natma: ${fmt.n(d.counts.deliveries)}${stats.purchase?.late ? ` · kechikkan PO: ${stats.purchase.late}` : ''}</div></div></div>` : ''}
    <form data-odoo-form>${raw(formHtml(fields))}</form>
    <div class="toolbar" style="margin-top:12px">${btn('Ulanishni tekshirish', { attrs: 'data-otest', ico: 'check' })}${btn('Saqlash', { cls: 'primary', attrs: 'data-osave' })}${c.configured ? btn('Hozir sinxronlash', { cls: 'accent', attrs: 'data-osync', ico: 'refresh' }) : ''}${c.configured ? btn('Uzish', { cls: 'danger', attrs: 'data-odel' }) : ''}</div>
    <div data-oresult class="small" style="margin-top:10px"></div>`));
  const form = $('[data-odoo-form]', box); const out = $('[data-oresult]', box);
  const payload = async () => { const v = await readForm(form, fields); return { url: v.url, db: v.db, login: v.login, apiKey: v.apiKey || undefined, intervalMin: v.intervalMin, modules: { stock: !!v.stock, purchase: !!v.purchase, delivery: App.meta?.modules?.logistics ? !!v.delivery : false } }; };
  $('[data-otest]', box).addEventListener('click', async (e) => {
    try { const r = await act(e.target.closest('button'), async () => POST('/api/odoo/test', await payload()));
      out.innerHTML = html(r.ok ? h`<span class="badge good">Ulandi</span> Odoo ${r.version || ''} · Ombor: ${r.models.stock ? '✓' : '✗ modul yo‘q'} · Ta’minot: ${r.models.purchase ? '✓' : '✗ modul yo‘q'} · Logistika: ${r.models.delivery ? '✓' : '✗ modul yo‘q'}` : h`<span class="badge crit">Xato</span> ${r.error}`);
    } catch { /* toast shown */ }
  });
  $('[data-osave]', box).addEventListener('click', async (e) => { try { await act(e.target.closest('button'), async () => PUT('/api/odoo', await payload()), 'Odoo sozlamasi saqlandi (kalit shifrlangan)'); App.renderOdooCard(box); } catch { /* toast */ } });
  $('[data-osync]', box)?.addEventListener('click', async (e) => {
    const r = await act(e.target.closest('button'), () => POST('/api/odoo/sync')).catch(() => null); if (!r) return;
    toast(r.ok ? 'Odoo ma’lumotlari yangilandi' : `Qisman: ${r.errors.join('; ')}`, r.ok ? 'ok' : 'warn'); App.renderOdooCard(box); App.updatePulse && App.updatePulse();
  });
  $('[data-odel]', box)?.addEventListener('click', async () => { if (await confirmBox('Odoo uzilsinmi?', 'Sozlama va API kalit o‘chiriladi. Tortilgan ma’lumotlar saqlanib qoladi.', 'Uzish', 'danger')) { await DEL('/api/odoo'); App.renderOdooCard(box); } });
};
