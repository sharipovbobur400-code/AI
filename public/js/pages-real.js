/* Real rejim sahifalari: foydalanuvchilar va adminlar, haydovchilar (Telegram), API kalitlari va integratsiya, AI dispetcher, kunlik AI hisobotlari */
'use strict';
const DEL = (p) => api('DELETE', p);

// ================= Foydalanuvchilar va adminlar =================
App.page('/users', { title: 'Foydalanuvchilar', async render({ el }) {
  const [users, roles, secs] = await Promise.all([GET('/api/users'), GET('/api/roles'), GET('/api/sections')]);
  const SEC = secs.sections; const secOpts = Object.entries(SEC).filter(([, v]) => !v.hidden).map(([k, v]) => [k, v.label]);
  const superA = App.user.role === 'SUPERADMIN'; const canUsers = can('admin.users');
  const assignable = roles.roles.filter((r) => r.code !== 'SUPERADMIN' && (r.code !== 'ADMIN' || superA));
  const roleOpts = assignable.map((r) => [r.code, `${r.name} (${r.code})`]);
  const admins = users.filter((u) => ['SUPERADMIN', 'ADMIN'].includes(u.role_code)); const sectionUsers = users.filter((u) => u.section); const staff = users.filter((u) => !['SUPERADMIN', 'ADMIN'].includes(u.role_code) && !u.section);
  const editable = (u) => canUsers && (u.id === App.user.id || (u.role_code === 'SUPERADMIN' ? false : u.role_code === 'ADMIN' ? superA : true));
  const cols = [{ key: 'full_name', label: 'F.I.Sh.', render: (u) => h`<b>${u.full_name}</b>${u.id === App.user.id ? h` <span class="badge plain blue">siz</span>` : ''}<div class="small muted">login: ${u.username}</div>` },
    { key: 'role_name', label: 'Rol', render: (u) => h`${u.role_code === 'SUPERADMIN' ? '👑 ' : u.role_code === 'ADMIN' ? '🛡 ' : ''}${u.role_name}${u.section ? h` <span class="badge plain blue">${SEC[u.section]?.label || u.section}</span>` : ''}` }, { key: 'active', label: 'Holat', render: (u) => (u.active ? badge('ACTIVE') : badge('CANCELLED', 'Bloklangan')) },
    { key: 'last_login', label: 'Oxirgi kirish', render: (u) => fmt.dt(u.last_login) }, { key: 'created_at', label: 'Yaratilgan', render: (u) => fmt.d(u.created_at) },
    { label: '', sort: false, render: (u) => (editable(u) ? h`${u.section ? h`<button class="btn sm" data-reset="${u.id}">${icon('lock')}Yangi parol</button> ` : ''}<button class="btn sm" data-edit="${u.id}">Tahrirlash</button>` : '') }];
  el.innerHTML = html(h`${pageHead('Foydalanuvchilar va adminlar', superA ? 'Siz super adminsiz: adminlarni faqat siz qo‘sha olasiz. Adminlar xodimlarni qo‘shadi.' : 'Xodimlar hisoblari va rollar', h`${superA ? btn('+ Admin qo‘shish', { cls: 'accent', ico: 'shield', attrs: 'data-a="admin"' }) : ''}${btn('+ Bo‘lim uchun login', { cls: 'primary', ico: 'lock', attrs: 'data-a="section"', perm: 'admin.users' })}${btn('+ Xodim qo‘shish', { ico: 'plus', attrs: 'data-a="user"', perm: 'admin.users' })}`)}
    ${card('Adminlar', raw('<div data-admins></div>'), { flush: true, sub: 'Super admin va adminlar' })}
    <div style="height:16px"></div>${card('Bo‘lim hisoblari — Ombor · Ta’minot · Ishlab chiqarish', raw('<div data-sections></div>'), { flush: true, sub: 'Bu loginlar bilan kirgan xodim faqat o‘z bo‘limini ko‘radi' })}
    <div style="height:16px"></div>${card('Xodimlar', raw('<div data-staff></div>'), { flush: true })}
    <div style="margin-top:16px">${card('Ruxsatlar matritsasi', h`<div class="table-wrap"><table class="t"><thead><tr><th>Ruxsat</th>${roles.roles.map((r) => h`<th title="${r.description}">${r.code}</th>`)}</tr></thead><tbody>${roles.permissions.map((p) => h`<tr><td class="mono small">${p}</td>${roles.roles.map((r) => h`<td style="text-align:center">${roles.full.includes(r.code) ? (['admin.admins', 'admin.apikeys'].includes(p) && r.code !== 'SUPERADMIN' ? '—' : '✔') : h`<input type="checkbox" data-perm="${p}" data-role="${r.code}" ${roles.matrix[r.code].includes(p) ? raw('checked') : ''} ${canUsers ? '' : raw('disabled')} aria-label="${r.code} ${p}">`}</td>`)}</tr>`)}</tbody></table></div>`, { flush: true, sub: 'SUPERADMIN, DIRECTOR, ADMIN — to‘liq; adminlar va API kalitlari — faqat super admin' })}</div>`);
  dataTable($('[data-admins]', el), { rows: admins, search: false, columns: cols, empty: 'Admin yo‘q' });
  dataTable($('[data-sections]', el), { rows: sectionUsers, columns: cols, empty: 'Bo‘lim hisobi yo‘q — “+ Bo‘lim uchun login” tugmasini bosing' });
  dataTable($('[data-staff]', el), { rows: staff, columns: cols, empty: 'Hali xodim qo‘shilmagan — “+ Xodim qo‘shish”' });
  el.addEventListener('change', async (e) => { const c = e.target.closest('[data-perm]'); if (!c) return; try { await PUT(`/api/roles/${c.dataset.role}/permissions`, { permission: c.dataset.perm, enabled: c.checked }); toast('Ruxsat yangilandi (audit qayd etildi)', 'ok'); } catch (err) { c.checked = !c.checked; toast(err.message, 'err'); } });
  el.addEventListener('click', async (e) => {
    const showCred = (r, title) => modal({ title, body: h`<div class="callout" style="margin-bottom:12px">${icon('lock')}<div>Login va parol <b>faqat hozir</b> ko‘rsatiladi — xodimga bering. Parolni keyin “Yangi parol” orqali almashtirish mumkin.</div></div>
      <div class="grid g2" style="gap:10px"><div class="field"><label>Login</label><div class="input mono" style="display:flex;align-items:center;user-select:all">${r.login}</div></div><div class="field"><label>Parol</label><div class="input mono" style="display:flex;align-items:center;user-select:all">${r.password}</div></div></div>
      ${r.sectionLabel ? h`<p class="small t2">Bo‘lim: <b>${r.sectionLabel}</b> · ${r.level} · ${r.fullName}</p>` : ''}`,
      footer: h`<button type="button" class="btn primary" data-copy>${icon('doc')}Nusxa olish</button>`,
      onOpen: (bg) => $('[data-copy]', bg).addEventListener('click', async () => { try { await navigator.clipboard.writeText(`Login: ${r.login}
Parol: ${r.password}`); toast('Nusxa olindi', 'ok'); } catch { toast('Nusxa olib bo‘lmadi — qo‘lda belgilang', 'warn'); } }) });
    if (e.target.closest('[data-a="section"]')) {
      const r = await formModal({ title: '+ Bo‘lim uchun login', submitText: 'Login yaratish',
        intro: h`<div class="callout" style="margin-bottom:12px">${icon('shield')}<div>Tizim bo‘lim kodi bilan login (masalan <b>omb-4821</b>, <b>tam-…</b>, <b>log-…</b>) va parol yaratadi. Bu login bilan kirgan xodim <b>faqat tanlangan bo‘limni</b> ko‘radi.</div></div>`,
        fields: [{ name: 'full_name', label: 'Xodim F.I.Sh.', required: true, full: true }, { name: 'section', label: 'Bo‘lim', type: 'select', required: true, options: secOpts },
          { name: 'level', label: 'Daraja', type: 'select', required: true, options: Object.entries(secs.levels), value: 'STAFF' }],
        onSubmit: (d) => POST('/api/users/section-account', d) });
      if (r) { await showCred(r, `✅ Login yaratildi — ${r.sectionLabel}`); App.refresh(); }
      return;
    }
    const rs = e.target.closest('[data-reset]');
    if (rs) {
      const u = users.find((x) => x.id === Number(rs.dataset.reset));
      if (!(await confirmBox('Yangi parol', `${u.full_name} (${u.username}) uchun yangi parol yaratilsinmi? Eski parol va ochiq sessiyalar bekor bo‘ladi.`, 'Yaratish'))) return;
      const r = await act(rs, () => POST(`/api/users/${u.id}/reset-password`)).catch(() => null); if (r) showCred(r, `Yangi parol — ${u.full_name}`);
      return;
    }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a) {
      const isAdm = a === 'admin';
      const r = await formModal({ title: isAdm ? '+ Admin qo‘shish' : '+ Xodim qo‘shish', intro: isAdm ? h`<div class="callout" style="margin-bottom:12px">${icon('shield')}<div>Admin xodimlarni qo‘shadi, sozlamalarni boshqaradi va barcha ma’lumotni ko‘radi. API kalitlari va boshqa adminlar faqat super adminda qoladi.</div></div>` : '',
        fields: [{ name: 'username', label: 'Login (masalan: Aziz Karimov)', required: true }, { name: 'full_name', label: 'F.I.Sh.', required: true }, isAdm ? null : { name: 'role_code', label: 'Rol', type: 'select', required: true, options: roleOpts.filter(([c]) => c !== 'ADMIN') }, { name: 'password', label: 'Parol (kamida 8 belgi)', type: 'password', required: true }],
        onSubmit: (d) => POST('/api/users', { ...d, role_code: isAdm ? 'ADMIN' : d.role_code }) });
      if (r) { toast(isAdm ? 'Admin qo‘shildi' : 'Xodim qo‘shildi', 'ok'); await App.loadMeta(); App.refresh(); }
    }
    const ed = e.target.closest('[data-edit]');
    if (ed) {
      const u = users.find((x) => x.id === Number(ed.dataset.edit)); const self = u.id === App.user.id;
      const fields = [{ name: 'username', label: 'Login', value: u.username, required: true }, { name: 'full_name', label: 'F.I.Sh.', value: u.full_name, required: true },
        !self && u.role_code !== 'SUPERADMIN' ? { name: 'role_code', label: 'Rol', type: 'select', options: roleOpts, value: u.role_code, required: true } : null,
        { name: 'password', label: 'Yangi parol (ixtiyoriy)', type: 'password' }, u.section ? { name: 'section', label: 'Bo‘lim', type: 'select', options: secOpts, value: u.section, required: true } : null, !self ? { name: 'active', label: 'Faol', type: 'checkbox', value: !!u.active } : null];
      const r = await formModal({ title: `Tahrirlash — ${u.full_name}`, fields, onSubmit: (d) => { if (!d.password) delete d.password; return PUT(`/api/users/${u.id}`, d); } });
      if (r) { toast('Saqlandi', 'ok'); App.refresh(); }
    }
  });
} });

// ================= Haydovchilar =================
App.page('/drivers', { title: 'Haydovchilar', live: ['BOT_LINKED', 'SHIPMENT_DISPATCHED', 'SHIPMENT_ARRIVED'], async render({ el }) {
  const rows = await GET('/api/drivers');
  el.innerHTML = html(h`${pageHead('Haydovchilar va logistlar', 'AI dispetcher yuk uchun haydovchi tanlab, Telegram orqali bog‘lanadi — haydovchini botga ulang', btn('+ Haydovchi', { cls: 'primary', ico: 'plus', attrs: 'data-a', perm: 'transport.manage' }))}${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows, empty: 'Haydovchi yo‘q — qo‘shing yoki API integratsiyasi orqali yuklang', columns: [{ key: 'full_name', label: 'F.I.Sh.', render: (r) => h`<b>${r.full_name}</b><div class="small muted">${r.carrier || ''}</div>` }, { key: 'phone', label: 'Telefon', render: (r) => (r.phone ? h`<a href="tel:${r.phone}">${r.phone}</a>` : '—') },
    { key: 'license_no', label: 'Guvohnoma', render: (r) => `${r.license_no || '—'} ${r.license_category || ''}` }, { key: 'vehicle', label: 'Transport' }, { key: 'status', label: 'Holat', render: (r) => badge(r.status) },
    { key: 'telegram_chat_id', label: 'Telegram', render: (r) => (r.telegram_chat_id ? h`<span class="badge good">ulangan</span>` : h`<span class="badge dark">ulanmagan</span>`) },
    { label: '', sort: false, render: (r) => (can('transport.manage') ? h`<button class="btn sm" data-tg="${r.id}">${icon('send')}Telegram kodi</button>` : '') }] });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-a]')) { const r = await formModal({ title: '+ Haydovchi', fields: [{ name: 'full_name', label: 'F.I.Sh.', required: true }, { name: 'phone', label: 'Telefon', required: true }, { name: 'license_no', label: 'Guvohnoma №' }, { name: 'license_category', label: 'Toifa' }], onSubmit: (d) => POST('/api/drivers', d) }); if (r) { await App.loadMeta(); App.refresh(); } }
    const t = e.target.closest('[data-tg]');
    if (t) {
      const r = await act(t, () => POST(`/api/drivers/${t.dataset.tg}/telegram-code`)).catch(() => null); if (!r) return;
      const qr = r.deepLink ? await qrSvg(r.deepLink, 150) : '';
      modal({ title: `Telegram — ${r.driver}`, body: h`<p class="t2" style="margin-top:0">Haydovchi telefonida QR ni skanerlasin yoki havolani ochsin. Kod 24 soat amal qiladi.</p><div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">${qr ? raw(`<div style="background:#fff;padding:6px;border-radius:8px">${qr}</div>`) : ''}<div><div style="font:700 30px var(--mono);letter-spacing:.12em">${r.code}</div>${r.deepLink ? h`<a class="btn primary sm" href="${r.deepLink}" target="_blank" rel="noopener">${icon('send')}Telegramda ochish</a>` : ''}<div class="small muted" style="margin-top:6px">yoki botga: <span class="mono">/start ${r.code}</span></div></div></div>` });
    }
  });
} });

// ================= API kalitlari va integratsiya =================
const ENT_LBL = { products: 'Mahsulotlar', stock: 'Ombor qoldig‘i', drivers: 'Haydovchilar / logistlar', vehicles: 'Transport', orders: 'Buyurtmalar (jo‘natish rejasi)' };
App.page('/apikeys', { title: 'API kalitlari', live: ['INTEGRATION_SYNC'], async render({ el }) {
  const d = await GET('/api/keys');
  const sec = Object.fromEntries(d.secrets.map((s) => [s.name, s]));
  const secretCard = (name, extra) => { const s = sec[name]; return card(s.label, h`${dl([['Holat', s.configured ? h`<span class="badge good">o‘rnatilgan</span> <span class="mono small">${s.masked}</span>` : h`<span class="badge dark">yo‘q</span>`], ['Manba', s.source === 'ui' ? 'shu sahifa (shifrlangan)' : s.source === 'env' ? '.env fayl' : '—'], ['Yangilangan', fmt.dt(s.updatedAt)]])}${extra || ''}
    <form data-secret="${name}" style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><input class="input" name="value" type="password" autocomplete="off" placeholder="${s.configured ? 'Yangi kalit bilan almashtirish' : 'Kalitni kiriting'}" style="flex:1;min-width:220px"><button class="btn primary">Saqlash</button>${s.source === 'ui' ? h`<button type="button" class="btn danger" data-del="${name}">O‘chirish</button>` : ''}</form>`); };
  const ai = d.ai;
  el.innerHTML = html(h`${pageHead('API kalitlari va integratsiya', 'Faqat super admin. Kalitlar serverda shifrlangan holda saqlanadi va brauzerga qaytarilmaydi.')}
  <div data-odoo style="margin-bottom:16px"></div>
  <div class="grid g2">
    ${secretCard('AI_API_KEY', h`<div style="margin-top:10px">${dl([['Provayder / model', ai.configured ? `${ai.provider} · ${ai.model}` : '—'], ['Oxirgi muvaffaqiyat', fmt.dt(ai.lastOkAt)], ai.lastError ? ['Oxirgi xato', h`<span style="color:var(--crit-ink)">${ai.lastError}</span>`] : null])}
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn" data-aitest ${ai.configured ? '' : raw('disabled')}>${icon('ai')}Ulanishni tekshirish</button><select class="input" data-prov style="width:auto"><option value="">Provayder: avtomatik</option>${raw(['gemini', 'vertex', 'anthropic'].map((p) => `<option ${ai.provider === p ? 'selected' : ''}>${p}</option>`).join(''))}</select><input class="input" data-model placeholder="Model (masalan gemini-flash-latest)" value="${ai.model || ''}" style="width:240px"><button class="btn" data-aimeta>Saqlash</button></div><div data-aires style="margin-top:10px"></div></div>`)}
    ${secretCard('TELEGRAM_BOT_TOKEN', h`<p class="small t2" style="margin:10px 0 0">@BotFather → /newbot → token. Saqlangach bot darhol qayta ulanadi. <a href="#/telegram">Telegram bot sahifasi</a></p>`)}
  </div>
  <h3 style="margin:24px 0 8px">Kompaniya tizimidan ma’lumot tortish (pull)</h3>
  <p class="t2" style="margin:0 0 12px">Kompaniyangiz API manzili va kalitini kiriting — tizim har N soniyada ombor qoldig‘i, buyurtmalar${App.meta?.modules?.logistics ? ' (jo‘natish rejasi), transport, haydovchi/logistlar' : ', ishlab chiqarish'} va mahsulotlarni tortib oladi. Qoldiq farqi ADJUSTMENT tranzaksiyasi sifatida yoziladi.</p>
  <div class="toolbar">${btn('+ Integratsiya qo‘shish', { cls: 'primary', ico: 'plus', attrs: 'data-int' })}</div>
  <div class="grid g2">${d.integrations.length ? d.integrations.map((i) => card(h`${i.active ? '🟢' : '⚫'} ${i.name}`, h`${dl([['Manzil', h`<span class="mono small">${i.baseUrl}</span>`], ['Kalit', `${i.authType}${i.authName ? ` (${i.authName})` : ''} · ${i.keyMasked || '—'}`], ['Endpointlar', Object.entries(i.endpoints).filter(([, v]) => v).map(([k, v]) => `${ENT_LBL[k] || k}: ${v}`).join(' · ')], ['Yangilanish', `har ${i.pollSeconds} soniyada`], ['Oxirgi sinxron', h`${fmt.dt(i.lastSyncAt)} ${i.lastStatus ? badge(i.lastStatus === 'OK' ? 'ACTIVE' : i.lastStatus === 'PARTIAL' ? 'PARTIAL' : 'REJECTED', i.lastStatus) : ''}`], i.lastError ? ['Xato', h`<span class="small" style="color:var(--crit-ink)">${i.lastError}</span>`] : null])}
      ${i.runs.length ? raw(tableHtml([{ label: 'Obyekt', render: (r) => ENT_LBL[r.entity] || r.entity }, { label: 'Keldi', key: 'received', num: true }, { label: 'Yangi', key: 'created', num: true }, { label: 'Yangilandi', key: 'updated', num: true }, { label: 'Xato', key: 'errors', num: true }, { label: 'Vaqt', render: (r) => fmt.t(r.created_at) }], i.runs.slice(0, 6))) : ''}
      <div style="display:flex;gap:8px;margin-top:10px"><button class="btn sm primary" data-sync="${i.id}">${icon('refresh')}Hozir tortish</button><button class="btn sm" data-edit="${i.id}">Tahrirlash</button><button class="btn sm danger" data-rm="${i.id}">O‘chirish</button></div>`)) : card('', raw('<div class="empty">Hali integratsiya yo‘q. “+ Integratsiya qo‘shish” — kompaniya API manzili va kaliti.</div>'))}</div>
  <h3 style="margin:24px 0 8px">Kompaniya tizimi ma’lumot yuborishi uchun kalitlar (push, real vaqt)</h3>
  <div class="grid g2">${card('Kiruvchi API kalitlari', raw(tableHtml([{ label: 'Nomi', render: (k) => h`<b>${k.name}</b><div class="small muted mono">wms_${k.prefix}_…</div>` }, { label: 'Ruxsat', render: (k) => k.scopes.join(', ') }, { label: 'Oxirgi foydalanish', render: (k) => h`${fmt.rel(k.last_used_at)}<div class="small muted">${k.uses} marta · ${k.last_ip || ''}</div>` }, { label: 'Holat', render: (k) => (k.revoked_at ? badge('CANCELLED', 'bekor') : badge('ACTIVE')) }, { label: '', render: (k) => (k.revoked_at ? '' : h`<button class="btn sm danger" data-revoke="${k.id}">Bekor qilish</button>`) }], d.apiKeys, 'Kalit yo‘q')), { flush: true, actions: btn('+ Yangi kalit', { cls: 'sm primary', attrs: 'data-newkey' }) })}
  ${card('Qanday ishlatiladi', raw(`<div class="small t2" style="line-height:1.7">Sarlavha: <span class="mono">X-API-Key: wms_…</span><br><b>O‘qish (GET):</b> <span class="mono">/api/ext/v1/stock</span>, <span class="mono">/locations</span>, <span class="mono">/orders</span>${App.meta?.modules?.logistics ? ', <span class="mono">/shipments</span>' : ''}, <span class="mono">/report</span><br><b>Yozish (POST, JSON massiv yoki {"items":[…]}):</b><br><span class="mono">/api/ext/v1/stock</span> — [{"sku","qty","location?"}] (absolyut qoldiq)<br><span class="mono">/api/ext/v1/orders</span> — [{"order_no","customer","due_date","destination","items":[{"sku","qty"}]}]<br><span class="mono">/api/ext/v1/vehicles</span> — [{"code","type","plate","length_m","width_m","height_m","payload_kg","status?"}]<br><span class="mono">/api/ext/v1/drivers</span> — [{"name","phone","carrier?","license_no?"}]<br><span class="mono">/api/ext/v1/products</span> — [{"sku","name","category?","unit?"}]<pre class="mono" style="background:var(--surface-2);padding:8px;border-radius:6px;white-space:pre-wrap;margin-top:8px">curl -X POST ${esc(location.origin)}/api/ext/v1/stock \\\n -H "X-API-Key: wms_…" -H "Content-Type: application/json" \\\n -d '[{"sku":"SP-550W-M","qty":1240}]'</pre></div>`))}</div>`);  App.renderOdooCard($('[data-odoo]', el)).catch((e) => { const b = $('[data-odoo]', el); if (b) b.innerHTML = html(errState(e.message)); });

  // --- handlers ---
  $$('[data-secret]', el).forEach((f) => f.addEventListener('submit', async (e) => { e.preventDefault(); const v = f.value.value.trim(); if (!v) return toast('Kalitni kiriting', 'warn'); const r = await act(f.querySelector('button'), () => PUT(`/api/keys/${f.dataset.secret}`, { value: v }), 'Kalit saqlandi (shifrlangan)').catch(() => null); if (r?.bot) toast(r.bot.running ? `Telegram bot @${r.bot.bot} ulandi` : `Bot ulanmadi: ${r.bot.error || 'token noto‘g‘ri'}`, r.bot.running ? 'ok' : 'err'); App.refresh(); }));
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.matches('[data-del]')) { if (await confirmBox('Kalitni o‘chirish', 'Kalit o‘chiriladi (.env dagi qiymat bo‘lsa, o‘sha ishlatiladi).', 'O‘chirish', 'danger')) act(b, () => DEL(`/api/keys/${b.dataset.del}`), 'O‘chirildi').then(App.refresh); }
    if (b.matches('[data-aitest]')) { const box = $('[data-aires]', el); box.innerHTML = '<div class="sk sk-line"></div>'; const r = await POST('/api/keys/AI_API_KEY/test').catch((err) => ({ ok: false, error: err.message })); box.innerHTML = html(r.ok ? h`<div class="callout good">✅ AI javob berdi (${r.ms} ms): “${r.reply}” — ${r.provider} · ${r.model}</div>` : h`<div class="callout crit">❌ ${r.error}<div class="small" style="margin-top:4px">Kalit ishlamaguncha AI tahlili database ma’lumotlaridan hisoblanadi.</div></div>`); }
    if (b.matches('[data-aimeta]')) act(b, () => PUT('/api/keys/AI_API_KEY', { provider: $('[data-prov]', el).value || undefined, model: $('[data-model]', el).value.trim() || undefined }), 'Saqlandi').then(App.refresh);
    if (b.matches('[data-int]')) A.integrationForm();
    if (b.matches('[data-edit]')) A.integrationForm(d.integrations.find((i) => i.id === Number(b.dataset.edit)));
    if (b.matches('[data-sync]')) { const r = await act(b, () => POST(`/api/integrations/${b.dataset.sync}/sync`)).catch(() => null); if (r) { toast(r.errors?.length ? `Qisman: ${r.errors[0]}` : `Sinxronlandi: ${Object.entries(r.stats || {}).map(([k, v]) => `${ENT_LBL[k] || k} ${v.received ?? 0}`).join(', ')}`, r.errors?.length ? 'warn' : 'ok'); App.refresh(); } }
    if (b.matches('[data-rm]')) { if (await confirmBox('Integratsiyani o‘chirish', 'Ma’lumot tortish to‘xtatiladi.', 'O‘chirish', 'danger')) act(b, () => DEL(`/api/integrations/${b.dataset.rm}`), 'O‘chirildi').then(App.refresh); }
    if (b.matches('[data-revoke]')) { if (await confirmBox('Kalitni bekor qilish', 'Bu kalit bilan kelgan so‘rovlar rad etiladi.', 'Bekor qilish', 'danger')) act(b, () => POST(`/api/api-keys/${b.dataset.revoke}/revoke`), 'Bekor qilindi').then(App.refresh); }
    if (b.matches('[data-newkey]')) {
      const r = await formModal({ title: 'Yangi kiruvchi API kaliti', fields: [{ name: 'name', label: 'Nomi (qaysi tizim uchun)', required: true, full: true }, { name: 'read', label: 'O‘qish (read)', type: 'checkbox', value: true }, { name: 'write', label: 'Yozish (write)', type: 'checkbox', value: true }], onSubmit: (x) => POST('/api/api-keys', { name: x.name, scopes: [x.read && 'read', x.write && 'write'].filter(Boolean) }) });
      if (r) { await modal({ title: 'Kalit yaratildi', body: h`<div class="callout warn">${icon('alert')}<div>${r.note}</div></div><div class="mono" style="margin-top:12px;padding:12px;background:var(--surface-2);border-radius:8px;word-break:break-all;font-size:14px" data-k>${r.key}</div><button class="btn sm" style="margin-top:8px" data-copy>Nusxa olish</button>`, onOpen: (bg) => $('[data-copy]', bg).addEventListener('click', () => navigator.clipboard?.writeText(r.key).then(() => toast('Nusxa olindi', 'ok'))) }); App.refresh(); }
    }
  });
} });
A.integrationForm = async (i) => {
  const v = i || { authType: 'bearer', pollSeconds: 60, endpoints: {}, mapping: {} };
  const fields = [{ name: 'name', label: 'Nomi (masalan: 1C Ombor, Kompaniya ERP)', required: true, value: v.name, full: true }, { name: 'baseUrl', label: 'API asosiy manzili (https://…)', required: true, value: v.baseUrl, full: true },
    { name: 'authType', label: 'Kalit qanday yuboriladi', type: 'select', required: true, noEmpty: true, value: v.authType, options: [['bearer', 'Authorization: Bearer <kalit>'], ['header', 'Maxsus sarlavha (X-API-Key)'], ['query', 'URL parametr (?api_key=)'], ['none', 'Kalitsiz']] },
    { name: 'authName', label: 'Sarlavha / parametr nomi', value: v.authName, placeholder: 'X-API-Key' }, { name: 'apiKey', label: i ? 'API kalit (o‘zgartirish uchun kiriting)' : 'API kalit', type: 'password', full: true },
    ...Object.entries(ENT_LBL).map(([k, lbl]) => ({ name: `ep_${k}`, label: `${lbl} — endpoint`, value: v.endpoints[k] || '', placeholder: `/api/${k}` })),
    { name: 'pollSeconds', label: 'Har necha soniyada tortish', type: 'number', value: v.pollSeconds, min: 10 }, { name: 'active', label: 'Faol', type: 'checkbox', value: v.active !== false },
    { name: 'mapping', label: 'Maydonlar moslashuvi (JSON, ixtiyoriy)', type: 'textarea', full: true, rows: 5, value: Object.keys(v.mapping || {}).length ? JSON.stringify(v.mapping, null, 2) : '', placeholder: '{"root":{"stock":"data.items"},"fields":{"stock":{"sku":"code","qty":"quantity","location":"bin"}}}', hint: 'Agar kompaniya API maydon nomlari bizdagidan farq qilsa: root — massiv joylashgan yo‘l, fields — biz: ular' },
    { type: 'html', name: 'x', full: true, html: '<div data-testres></div>' }];
  const collect = (d) => ({ id: i?.id, name: d.name, baseUrl: d.baseUrl, authType: d.authType, authName: d.authName, apiKey: d.apiKey || undefined, pollSeconds: d.pollSeconds, active: d.active, mapping: d.mapping || '{}', endpoints: Object.fromEntries(Object.keys(ENT_LBL).map((k) => [k, d[`ep_${k}`] || ''])) });
  const r = await formModal({ title: i ? `Integratsiya — ${i.name}` : '+ Integratsiya', size: 'wide', fields, submitText: 'Saqlash',
    onOpen: (bg) => { const f = $('.modal-f', bg); const tb = document.createElement('button'); tb.type = 'button'; tb.className = 'btn'; tb.textContent = 'Ulanishni tekshirish'; f.prepend(tb);
      tb.addEventListener('click', async () => { const out = $('[data-testres]', bg); try { const d = await readForm($('form', bg), fields); out.innerHTML = '<div class="sk sk-line"></div>'; const t = await POST('/api/integrations/test', collect(d)); out.innerHTML = html(h`<div class="callout">${raw(Object.entries(t).map(([k, x]) => `<div>${x.ok ? '✅' : '❌'} <b>${esc(ENT_LBL[k] || k)}</b>: ${x.ok ? `${x.count} ta yozuv${x.sample ? ` · maydonlar: <span class="mono small">${esc(Object.keys(x.sample).slice(0, 10).join(', '))}</span>` : ''}` : esc(x.error)}</div>`).join('') || 'Endpoint kiritilmagan')}</div>`); } catch (err) { out.innerHTML = html(h`<div class="callout crit">${err.message}</div>`); } }); },
    onSubmit: (d) => (i ? PUT(`/api/integrations/${i.id}`, collect(d)) : POST('/api/integrations', collect(d))) });
  if (r) { toast('Integratsiya saqlandi — ma’lumot tortish boshlandi', 'ok'); if (r.id) POST(`/api/integrations/${r.id}/sync`).catch(() => {}); App.refresh(); }
};

// ================= AI dispetcher =================
const DSP_LBL = { NEW: ['Yangi', 'dark'], CONTACTING: ['Haydovchiga yozildi', 'warn'], AWAIT_CONFIRM: ['Telefon orqali tasdiq kerak', 'warn'], DRIVER_ACCEPTED: ['Haydovchi qabul qildi', 'blue'], DISPATCHED: ['Jo‘natildi', 'good'], REPLAN: ['Qayta rejalashtirish', 'serious'], NO_TRANSPORT: ['Transport topilmadi', 'crit'], CANCELLED: ['Bekor qilingan', 'dark'] };
App.page('/dispatch', { title: 'AI dispetcher', live: ['DISPATCH_PLANNED', 'DISPATCH_DRIVER_ACCEPTED', 'DISPATCH_DECLINED', 'DISPATCH_NO_TRANSPORT', 'DISPATCH_DONE', 'PACKING_COMPLETED', 'SHIPMENT_DISPATCHED'], async render({ el }) {
  const [d, plan] = await Promise.all([GET('/api/dispatch'), GET('/api/daily-reports/preview/morning')]);
  const s = d.settings; const active = d.jobs.filter((j) => ['CONTACTING', 'AWAIT_CONFIRM', 'DRIVER_ACCEPTED', 'NO_TRANSPORT', 'REPLAN'].includes(j.status));
  el.innerHTML = html(h`${pageHead('AI dispetcher', 'Jo‘natishga tayyor yuk → mos transport (og‘irlik/hajm/pallet) → haydovchi → Telegram orqali aloqa → tasdiq → ombordan chiqarish', h`${btn('Hozir rejalashtirish', { cls: 'accent', ico: 'ai', attrs: 'data-run', perm: 'dispatch.manage' })}`)}
  <div class="grid g2">
    ${card('Rejim', h`<div class="grid-form"><div class="field"><label>Ish rejimi</label><select class="input" data-mode ${can('dispatch.manage') ? '' : raw('disabled')}>${raw([['assist', 'Yordamchi — AI rejalashtiradi va bog‘lanadi, chiqarishni odam tasdiqlaydi'], ['auto', 'Avtomatik — haydovchi qabul qilsa, jo‘nash vaqtida AI o‘zi chiqaradi'], ['off', 'O‘chirilgan']].map(([k, l]) => `<option value="${k}" ${s.mode === k ? 'selected' : ''}>${esc(l)}</option>`).join(''))}</select></div>
      <div class="field"><label>Haydovchi javob berish muddati, daqiqa</label><input class="input" type="number" data-timeout value="${s.driverTimeoutMin}" min="2"></div><div class="field"><label>Tayyorgarlik vaqti (yuk qadoqlangandan jo‘nashgacha), soat</label><input class="input" type="number" data-lead value="${s.leadHours}" min="0" step="0.5"></div></div>
      <div style="margin-top:12px">${btn('Saqlash', { cls: 'primary', attrs: 'data-save', perm: 'dispatch.manage' })}</div>
      <div class="callout" style="margin-top:12px">${icon('shield')}<div class="small">Har bir amal audit logga yoziladi. Haydovchi rad etsa yoki ${s.driverTimeoutMin} daqiqada javob bermasa — AI keyingi transport/haydovchini tanlaydi. Mos transport bo‘lmasa, adminlarga 🔴 xabar yuboriladi.</div></div>`)}
    ${card('Bugungi reja (08:00 hisobot ko‘rinishi)', raw(`<pre class="small" style="white-space:pre-wrap;margin:0;font-family:var(--font);max-height:340px;overflow:auto">${esc(plan.text.replace(/<[^>]+>/g, ''))}</pre>`))}
  </div>
  <h3 style="margin:22px 0 10px">Faol topshiriqlar (${active.length})</h3>${card('', raw('<div data-t></div>'), { flush: true })}`);
  dataTable($('[data-t]', el), { rows: d.jobs, empty: 'Hozircha topshiriq yo‘q — buyurtma qadoqlanganda AI avtomatik transport qidiradi', columns: [
    { key: 'order_no', label: 'Buyurtma', render: (j) => h`<a href="#/orders/${j.order_id}"><b>${j.order_no}</b></a><div class="small muted">${j.customer || ''}</div>` }, { key: 'ship_no', label: 'Jo‘natma', render: (j) => (j.ship_no ? h`<a href="#/shipments/${j.ship_no}">${j.ship_no}</a><div class="small muted">${fmt.n(j.total_qty)} dona · ${j.pallet_count} pallet · ${fmt.kg(j.total_weight_kg)}</div>` : '—') },
    { key: 'vehicle', label: 'Transport', render: (j) => (j.vehicle ? h`${j.vehicle} ${j.vehicle_type || ''}<div class="small muted">${j.plate || ''}</div>` : '—') }, { key: 'driver', label: 'Haydovchi', render: (j) => (j.driver ? h`${j.driver} ${j.driver_telegram ? '📨' : ''}<div class="small muted">${j.driver_phone ? h`<a href="tel:${j.driver_phone}">${j.driver_phone}</a>` : ''}</div>` : '—') },
    { key: 'planned_at', label: 'Jo‘nash', render: (j) => fmt.dt(j.planned_at) }, { key: 'destination', label: 'Manzil' },
    { key: 'status', label: 'Holat', render: (j) => h`<span class="badge ${(DSP_LBL[j.status] || [])[1] || ''}">${(DSP_LBL[j.status] || [j.status])[0]}</span><div class="small muted">${j.note || ''}</div>` },
    { label: '', sort: false, render: (j) => (can('dispatch.manage') && ['CONTACTING', 'AWAIT_CONFIRM', 'DRIVER_ACCEPTED'].includes(j.status) ? h`<div style="display:flex;gap:6px;justify-content:flex-end"><button class="btn sm good" data-go="${j.id}">🚛 Chiqarish</button><button class="btn sm" data-re="${j.id}">Boshqa transport</button><button class="btn sm danger" data-cx="${j.id}">×</button></div>` : can('dispatch.manage') && ['NO_TRANSPORT', 'REPLAN'].includes(j.status) ? h`<button class="btn sm" data-plan="${j.order_id}">Qayta urinish</button>` : '') }] });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.matches('[data-run]')) act(b, () => POST('/api/dispatch/run'), (r) => (r.mode === 'off' ? 'Dispetcher o‘chirilgan' : `Rejalashtirildi: ${r.planned}, qayta: ${r.replanned}, jo‘natildi: ${r.dispatched}`)).then(App.refresh);
    if (b.matches('[data-save]')) act(b, () => PUT('/api/dispatch/settings', { mode: $('[data-mode]', el).value, driverTimeoutMin: Number($('[data-timeout]', el).value), leadHours: Number($('[data-lead]', el).value) }), 'Saqlandi').then(App.refresh);
    if (b.matches('[data-go]')) { if (await confirmBox('Yukni ombordan chiqarish', 'Yuklash yakunlanadi va jo‘natma DISPATCHED bo‘ladi (inventardan chiqariladi). Davom etasizmi?', 'Chiqarish', 'good')) act(b, () => POST(`/api/dispatch/${b.dataset.go}/dispatch`), (r) => `Jo‘natildi · ETA ${fmt.dt(r.eta)}`).then(App.refresh); }
    if (b.matches('[data-re]')) act(b, () => POST(`/api/dispatch/${b.dataset.re}/replan`), (r) => (r.shipNo ? `Yangi: ${r.shipNo} · ${r.vehicle} · ${r.driver}` : r.reason || r.status)).then(App.refresh);
    if (b.matches('[data-cx]')) { if (await confirmBox('Topshiriqni bekor qilish', 'Jo‘natma bekor qilinadi, transport bo‘shaydi.', 'Bekor qilish', 'danger')) act(b, () => POST(`/api/dispatch/${b.dataset.cx}/cancel`), 'Bekor qilindi').then(App.refresh); }
    if (b.matches('[data-plan]')) act(b, () => POST(`/api/dispatch/plan/${b.dataset.plan}`), (r) => (r.shipNo ? `${r.shipNo} · ${r.vehicle} · ${r.driver}` : r.reason || r.skipped || r.status)).then(App.refresh);
  });
} });

// ================= Kunlik AI hisobotlari =================
App.page('/daily', { title: 'Kunlik AI hisobotlari', live: ['DAILY_REPORT'], async render({ el, query }) {
  const d = await GET('/api/daily-reports');
  const sel = d.reports.find((r) => String(r.id) === query.id) || d.reports[0];
  el.innerHTML = html(h`${pageHead('Kunlik AI hisobotlari', `Har kuni ${String(d.hours.morning).padStart(2, '0')}:00 — omborda qancha yuk bor va bugun qaysi yuk soat nechida chiqishi kerak; ${String(d.hours.evening).padStart(2, '0')}:00 — qancha chiqdi va qancha qoldi. Adminlarga Telegram botga yuboriladi.`,
    h`${btn(`${String(d.hours.morning).padStart(2, '0')}:00 hisobotini hozir yuborish`, { cls: 'accent', ico: 'send', attrs: 'data-k="morning"', perm: 'ai.scan' })}${btn(`${String(d.hours.evening).padStart(2, '0')}:00 hisobotini hozir yuborish`, { ico: 'send', attrs: 'data-k="evening"', perm: 'ai.scan' })}`)}
  <div class="grid" style="grid-template-columns:280px minmax(0,1fr)">
    ${card('', h`<nav class="menu" style="margin:-4px -16px -16px">${d.reports.length ? d.reports.map((r) => h`<a href="#/daily?id=${r.id}" style="${sel && sel.id === r.id ? 'background:var(--surface-3);font-weight:600' : ''}">${r.kind === 'morning' ? '🌅' : '🌙'} ${r.report_date.split('-').reverse().join('.')} · ${r.kind === 'morning' ? 'ertalab' : 'kechqurun'}<span class="small muted" style="margin-left:auto">${r.sent_to ? `📨 ${r.sent_to}` : ''}</span></a>`) : raw('<div class="empty">Hali hisobot yo‘q</div>')}</nav>`)}
    ${sel ? card(`${sel.kind === 'morning' ? '🌅 Ertalabki' : '🌙 Kechki'} hisobot — ${sel.report_date.split('-').reverse().join('.')}`, raw(`<pre style="white-space:pre-wrap;margin:0;font-family:var(--font);font-size:13.5px;line-height:1.6">${esc(sel.text.replace(/<[^>]+>/g, ''))}</pre>`), { sub: `${sel.has_ai ? 'AI xulosasi bilan · ' : ''}${sel.sent_to ? `${sel.sent_to} ta chatga yuborildi` : 'Telegramga yuborilmagan (bot ulanmagan)'} · ${fmt.dt(sel.created_at)}` }) : card('', raw('<div class="empty">Hisobot tanlang yoki hozir yarating</div>'))}
  </div>`);
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) act(b, () => POST(`/api/daily-reports/${b.dataset.k}`, { send: true }), (r) => `Hisobot yaratildi${r.sent_to ? `, ${r.sent_to} ta chatga yuborildi` : ' (Telegram bot ulanmagan)'}`).then((r) => go(`#/daily?id=${r.id}`)); });
} });
