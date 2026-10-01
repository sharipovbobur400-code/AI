/* Jamoa botlari admin paneli: Ta’minot, Ombor, Ishlab chiqarish, Xulosa — tokenlar, guruh, jadval, holat, xabarlar jurnali */
'use strict';

App.page('/teambots', { title: 'Telegram botlar', async render({ el }) {
  const s = await GET('/api/teambots');
  const c = s.config;
  const botCard = (b) => card(`${b.emoji} ${b.label} bot`, h`
    ${dl([['Holat', b.running ? h`<span class="badge good">ishlayapti</span> ${b.username ? h`<a href="https://t.me/${b.username}" target="_blank" rel="noopener">@${b.username}</a>` : ''}` : b.configured ? h`<span class="badge amber">to‘xtagan</span>` : h`<span class="badge dark">token yo‘q</span>`],
      ['Token', b.configured ? h`<span class="mono small">${b.tokenMasked}</span> <span class="small muted">(${b.source === 'ui' ? 'saytda, shifrlangan' : '.env'})</span>` : '—'],
      b.lastError ? ['Oxirgi xato', h`<span style="color:var(--crit-ink)">${b.lastError}</span>`] : null])}
    <form data-token="${b.key}" style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><input class="input mono" name="value" type="password" autocomplete="off" placeholder="${b.configured ? 'Yangi token bilan almashtirish' : '1234567890:AAH… (@BotFather)'}" style="flex:1;min-width:200px"><button class="btn primary sm">Saqlash</button></form>
    <div class="toolbar" style="margin-top:8px"><label class="check small"><input type="checkbox" data-en="${b.key}" ${b.enabled ? raw('checked') : ''}> Yoqilgan</label>
      ${b.running ? btn('Test xabar', { attrs: `data-test="${b.key}"`, ico: 'send', cls: 'sm' }) : ''}${b.key === 'xulosa' && b.running ? btn('Xulosani hozir', { attrs: 'data-sum', ico: 'ai', cls: 'sm accent' }) : ''}${b.source === 'ui' ? btn('Tokenni o‘chirish', { attrs: `data-deltok="${b.key}"`, cls: 'sm danger' }) : ''}</div>`);
  const groups = s.groups || [];
  el.innerHTML = html(h`${pageHead('Telegram botlar', 'Ta’minot · Ombor · Ishlab chiqarish · Xulosa — sayt ichida ishlaydi, ma’lumotni saytdan real vaqtda oladi', h`${btn('Botlarni qayta ishga tushirish', { attrs: 'data-reload', ico: 'refresh' })}`)}
    <div class="callout" style="margin-bottom:16px">${icon('send')}<div><b>Qanday ulanadi:</b> 1) Telegramda guruh oching va 4 ta botni qo‘shing. 2) Har bir bot uchun @BotFather → <span class="mono">/setprivacy</span> → <b>Disable</b> (yoki botlarni guruh admini qiling) — shunda botlar guruhdagi barcha xabarlarni ko‘radi. 3) Birinchi qo‘shilgan guruh avtomatik ruxsat oladi (pastdagi “Guruhlar”). Tugmalar yo‘q — faqat <span class="mono">/help</span>; savolni yozing yoki 🎤 ovozli xabar yuboring.</div></div>
    <div class="grid g2">${s.bots.map(botCard)}</div>
    <div class="grid g2" style="margin-top:16px">
      ${card('🤖 AI va ovoz', h`${dl([['AI (javoblar, xulosa)', s.ai.configured ? h`<span class="badge good">${s.ai.provider} · ${s.ai.model}</span>` : h`<span class="badge amber">ulanmagan</span> — bazadan tayyor javoblar ishlaydi`], s.ai.lastError ? ['AI xatosi', h`<span style="color:var(--crit-ink)">${s.ai.lastError}</span>`] : null,
        ['Ovoz → matn', s.stt ? h`<span class="badge good">ulangan</span>` : h`<span class="badge amber">kalit yo‘q</span>`]])}
        <p class="small t2">AI kaliti (Anthropic <span class="mono">sk-ant-…</span> yoki Gemini): <a href="#/apikeys">Sozlamalar → API kalitlari</a>. Ovozli xabarlar uchun Gemini kaliti (aistudio.google.com) — Anthropic ovozni tanimaydi.</p>
        <form data-token="stt" style="display:flex;gap:8px;flex-wrap:wrap"><input class="input mono" name="value" type="password" autocomplete="off" placeholder="Gemini API kaliti (ovoz uchun)" style="flex:1;min-width:200px"><button class="btn primary sm">Saqlash</button></form>`)}
      ${card('⚙️ Jadval va ruxsatlar', h`<form data-cfg>${raw(formHtml([
        { name: 'morningHour', label: 'Ertalabki reja, soat', type: 'number', value: c.morningHour, min: 0, max: 23 }, { name: 'eveningHour', label: 'Kunlik statistika, soat', type: 'number', value: c.eveningHour, min: 0, max: 23 },
        { name: 'summaryEveryHours', label: 'Xulosa har necha soatda (soatlik hisobot o‘chiq bo‘lsa)', type: 'number', value: c.summaryEveryHours, min: 0, max: 24 }, { name: 'workStart', label: 'Ish vaqti boshlanishi', type: 'number', value: c.workStart, min: 0, max: 23 },
        { name: 'workEnd', label: 'Ish vaqti tugashi', type: 'number', value: c.workEnd, min: 0, max: 24 }, { name: 'notify', label: 'Saytdagi yangilanishlarni 24/7 yozib borish', type: 'checkbox', value: c.notify },
        { name: 'hourly', label: 'Har soatda: 3 bot hisobot + Xulosa (ish vaqtida)', type: 'checkbox', value: c.hourly },
        { name: 'groupIds', label: 'Ruxsat berilgan guruh ID lari (vergul bilan)', value: c.groupIds.join(', '), full: true },
        { name: 'adminIds', label: 'Shaxsiy chatda gaplasha oladigan Telegram ID lar (vergul bilan)', value: c.adminIds.join(', '), full: true }]))}</form>
        <div style="margin-top:10px">${btn('Saqlash', { cls: 'primary', attrs: 'data-savecfg' })}</div>`)}
    </div>
    <div class="grid g2" style="margin-top:16px">
      ${card('👥 Guruhlar', raw(tableHtml([{ label: 'Guruh', render: (g) => h`<b>${g.title || '—'}</b><div class="small mono muted">${g.chat_id}</div>` }, { label: 'Holat', render: (g) => (c.groupIds.includes(String(g.chat_id)) ? h`<span class="badge good">ruxsat</span>` : h`<span class="badge dark">ruxsatsiz</span>`) },
        { label: 'Oxirgi faollik', render: (g) => fmt.rel(g.seen_at) }, { label: '', render: (g) => (c.groupIds.includes(String(g.chat_id)) ? '' : h`<button class="btn sm" data-allow="${g.chat_id}">Ruxsat berish</button>`) }], groups, 'Botlar hali guruhga qo‘shilmagan')), { flush: true })}
      ${card(`💬 Xabarlar jurnali (router: ${s.router || '—'}, oxirgi xulosa: ${s.lastSummaryAt ? fmt.dt(s.lastSummaryAt) : '—'})`, raw('<div data-log></div>'), { flush: true })}
    </div>`);
  dataTable($('[data-log]', el), { rows: s.messages, pageSize: 12, search: true, empty: 'Hozircha xabar yo‘q', columns: [{ key: 'created_at', label: 'Vaqt', render: (m) => fmt.dt(m.created_at) },
    { key: 'from_name', label: 'Kim', render: (m) => h`${m.is_bot ? '🤖 ' : ''}${m.from_name || '—'}` }, { key: 'text', label: 'Xabar', render: (m) => h`<span class="small">${String(m.text || '').slice(0, 160)}</span>` }] });

  const reload = () => App.refresh();
  $$('[data-token]', el).forEach((f) => f.addEventListener('submit', async (e) => { e.preventDefault(); const v = f.value.value.trim(); if (!v) return; await act($('button', f), () => PUT(`/api/teambots/token/${f.dataset.token}`, { value: v }), 'Saqlandi (shifrlangan)').catch(() => {}); reload(); }));
  el.addEventListener('change', async (e) => { const en = e.target.closest('[data-en]'); if (!en) return; await PUT('/api/teambots', { enabled: { [en.dataset.en]: en.checked } }).then(() => toast('Saqlandi', 'ok')).catch((err) => toast(err.message, 'err')); reload(); });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.matches('[data-test]')) act(b, () => POST(`/api/teambots/${b.dataset.test}/test`), (r) => `Guruhga yuborildi (${r.sent})`).catch(() => {});
    if (b.matches('[data-sum]')) act(b, () => POST('/api/teambots/summary'), 'Xulosa guruhga yuborildi').catch(() => {});
    if (b.matches('[data-reload]')) { await act(b, () => POST('/api/teambots/reload'), 'Botlar qayta ishga tushirildi').catch(() => {}); reload(); }
    if (b.matches('[data-deltok]') && await confirmBox('Token o‘chirilsinmi?', 'Bot to‘xtaydi (.env dagi token bo‘lsa, o‘sha ishlatiladi).', 'O‘chirish', 'danger')) { await DEL(`/api/teambots/token/${b.dataset.deltok}`); reload(); }
    if (b.matches('[data-allow]')) { await act(b, () => PUT('/api/teambots', { groupIds: [...c.groupIds, b.dataset.allow] }), 'Guruhga ruxsat berildi').catch(() => {}); reload(); }
    if (b.matches('[data-savecfg]')) {
      const d = await readForm($('[data-cfg]', el), [{ name: 'morningHour' }, { name: 'eveningHour' }, { name: 'summaryEveryHours' }, { name: 'workStart' }, { name: 'workEnd' }, { name: 'notify', type: 'checkbox' }, { name: 'hourly', type: 'checkbox' }, { name: 'groupIds' }, { name: 'adminIds' }]);
      await act(b, () => PUT('/api/teambots', d), 'Sozlamalar saqlandi').catch(() => {}); reload();
    }
  });
} });
