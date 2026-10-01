/* Telegram bot: ulash, xabar sozlamalari, holat, jurnal */
'use strict';
App.page('/telegram', { title: 'Telegram bot', live: ['BOT_LINKED'], async render({ el }) {
  const s = await GET('/api/bot/status');
  const admin = s.all !== undefined;
  const LVL = [['CRITICAL', 'Faqat 🔴 kritik'], ['WARNING', '🔴 kritik + 🟠 ogohlantirish'], ['INFO', 'Hammasi (tavsiyalar ham)']];
  const chatCard = (c) => card(`${c.chat_type === 'private' ? '👤' : '👥'} ${c.chat_title || c.tg_username || c.chat_id}`, h`
    <div class="small muted" style="margin-bottom:10px">${c.tg_username ? `@${c.tg_username} · ` : ''}chat ${c.chat_id} · ulangan ${fmt.dt(c.linked_at)} · oxirgi faollik ${fmt.rel(c.last_seen)}</div>
    <div data-chat="${c.chat_id}"><div style="display:grid;gap:6px">${Object.entries(s.categories).map(([k, v]) => h`<label class="check"><input type="checkbox" data-cat="${k}" ${c.prefs.cats.includes(k) ? raw('checked') : ''}> ${v}</label>`)}</div>
    <div class="grid-form" style="margin-top:12px"><div class="field"><label>AI ogohlantirish darajasi</label><select class="input" data-lvl>${raw(LVL.map(([v, l]) => `<option value="${v}" ${c.prefs.level === v ? 'selected' : ''}>${esc(l)}</option>`).join(''))}</select></div>
    <div class="field" style="justify-content:end"><label class="check"><input type="checkbox" data-mute ${c.prefs.mute ? raw('checked') : ''}> 🔕 Ovozsiz (faqat shaxsiy topshiriq va eskalatsiya)</label></div></div>
    <div style="display:flex;gap:8px;margin-top:12px"><button class="btn primary sm" data-save>Saqlash</button><button class="btn danger sm" data-unlink="${c.chat_id}">Uzish</button></div></div>`);
  el.innerHTML = html(h`${pageHead('Telegram bot', 'Saytdagi barcha ishlar haqida Telegramga real vaqtda xabar · AI nazorati · botdan tasdiqlash', h`${s.mine.length ? btn('Test xabar', { ico: 'send', attrs: 'data-test' }) : ''}${s.enabled ? btn('AI brifingni hozir yuborish', { cls: 'accent', ico: 'ai', attrs: 'data-brief', perm: 'ai.scan' }) : ''}`)}
  ${!s.enabled ? h`<div class="callout warn" style="margin-bottom:16px">${icon('alert')}<div><b>Bot hali yoqilmagan.</b> Serverdagi <span class="mono">.env</span> faylga <span class="mono">TELEGRAM_BOT_TOKEN=…</span> qo‘shing va serverni qayta ishga tushiring.
    <ol class="small" style="margin:8px 0 0;padding-left:18px"><li>Telegramda <b>@BotFather</b> → <span class="mono">/newbot</span> → nom bering → token oling</li><li><span class="mono">.env</span> fayl: <span class="mono">TELEGRAM_BOT_TOKEN=123456:ABC…</span> (ixtiyoriy: <span class="mono">WMS_BASE_URL=https://wms.korxona.uz</span> — xabarlarda saytga havola)</li><li><span class="mono">npm start</span> — shu sahifada “Kod olish” tugmasi paydo bo‘ladi</li></ol></div></div>` : ''}
  <div class="grid g2">
    ${card('Holat', dl([['Bot', s.enabled ? (s.bot ? h`<a href="https://t.me/${s.bot.username}" target="_blank" rel="noopener">@${s.bot.username}</a> — ${s.bot.name}` : 'token bor, lekin Telegramga ulanib bo‘lmadi') : 'o‘chirilgan'], ['Ishlayapti', s.running ? '🟢 Ha (long polling)' : '⚫ Yo‘q'], admin && s.lastError ? ['Oxirgi xato', h`<span style="color:var(--crit-ink)">${s.lastError}</span>`] : null,
      ['AI brifing', `har kuni ${s.schedule.morning}:00 (ertalab) va ${s.schedule.evening}:00 (kechki hisobot), UTC${s.schedule.tzOffsetMin >= 0 ? '+' : ''}${s.schedule.tzOffsetMin / 60}`], ['Eskalatsiya', `🔴 kritik muammo ${s.schedule.escalateMin} daqiqa ichida “Ko‘rildi” qilinmasa — direktor va menejerga qayta xabar`], ['Saytga havola', s.baseUrl || 'WMS_BASE_URL berilmagan'], admin && s.stats ? ['24 soat', `yuborildi ${s.stats.sent || 0} · xato ${s.stats.failed || 0} · kiruvchi ${s.stats.incoming || 0}`] : null]))}
    ${card('Hisobingizni ulash', s.enabled ? h`<p class="t2" style="margin-top:0">Kod oling va uni botga yuboring — bot sizning rolingizga mos xabarlarni yuboradi va buyruqlaringizni sizning ruxsatlaringiz bilan bajaradi.</p>${btn('Kod olish', { cls: 'primary', ico: 'lock', attrs: 'data-code' })}<div data-codebox style="margin-top:14px"></div>` : raw('<div class="muted">Bot yoqilgach bu yerda ulash kodi olinadi.</div>'))}
  </div>
  ${s.mine.length ? h`<h3 style="margin:22px 0 10px">Ulangan chatlarim va xabar sozlamalari</h3><div class="grid g2">${s.mine.map(chatCard)}</div>` : ''}
  <div class="grid g2" style="margin-top:16px">
    ${card('Bot nimalar haqida xabar beradi', h`<ul class="small t2" style="margin:0;padding-left:18px;line-height:1.8"><li>📦 Ombor harakatlari (kirim, chiqim, ko‘chirish, rezerv… — 20 soniyalik to‘plamlarda), QC natijalari</li><li>🛒 Yangi buyurtmalar, picking/packing, buyurtma holati</li><li>🔴 Yetishmovchilik — “🤖 AI zayavka yaratish” tugmasi bilan</li><li>🧾 Yangi zayavkalar — “✅ Tasdiqlash / ❌ Rad etish” tugmalari (4 ko‘z tamoyili saqlanadi)</li><li>🚚 Supplier kechikishi, yuk kelishi${App.meta?.modules?.logistics ? '; transport, yuklash, jo‘natma, yetkazildi' : '; 🏭 ishlab chiqarish holatlari'}</li><li>📑 XETQ va hujjat holatlari; 🤖 AI ogohlantirishlar (“Ko‘rildi” tugmasi)</li><li>📋 Shaxsiy topshiriqlar — faqat ijrochining o‘ziga</li><li>📰 Ertalabki AI brifing va kechki hisobot; ⏰ hal qilinmagan kritik muammolar eskalatsiyasi</li><li>💬 Istalgan savol: “Ertangi buyurtmaga yetadimi?” — AI database asosida javob beradi</li></ul>`)}
    ${card('AI brifing (hozirgi holat bo‘yicha)', raw('<pre data-prev class="small" style="white-space:pre-wrap;margin:0;font-family:var(--font)"></pre>'))}
  </div>
  ${admin ? h`<div class="grid g2" style="margin-top:16px">${card('Barcha ulangan chatlar', raw(tableHtml([{ label: 'Xodim', render: (c) => h`<b>${c.full_name}</b><div class="small muted">${c.role_code}</div>` }, { label: 'Chat', render: (c) => h`${c.chat_title || ''} ${c.tg_username ? `@${c.tg_username}` : ''}<div class="small muted mono">${c.chat_id} · ${c.chat_type}</div>` }, { label: 'Oxirgi faollik', render: (c) => fmt.rel(c.last_seen) }, { label: '', render: (c) => h`<button class="btn sm danger" data-unlink="${c.chat_id}">Uzish</button>` }], s.all, 'Hali hech kim ulanmagan')), { flush: true })}
    ${card('Xabarlar jurnali', raw('<div data-log></div>'), { flush: true })}</div>` : ''}`);
  GET('/api/bot/preview').then((p) => { const pre = $('[data-prev]', el); if (pre) pre.textContent = p.text.replace(/<[^>]+>/g, ''); }).catch(() => {});
  if (admin) {
    const log = await GET('/api/bot/messages?limit=300');
    dataTable($('[data-log]', el), { rows: log, pageSize: 10, empty: 'Hozircha xabar yo‘q', columns: [{ key: 'created_at', label: 'Vaqt', render: (m) => fmt.dt(m.created_at) }, { key: 'direction', label: '', render: (m) => (m.direction === 'OUT' ? '⬆️' : '⬇️') }, { key: 'kind', label: 'Turi' },
      { key: 'text', label: 'Matn', render: (m) => h`<span class="small">${(m.text || '').replace(/<[^>]+>/g, '').slice(0, 120)}</span>` }, { key: 'status', label: 'Holat', render: (m) => (m.status === 'FAILED' ? h`<span class="badge crit" title="${m.error}">xato</span>` : h`<span class="badge good">${m.status}</span>`) }] });
  }
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.matches('[data-test]')) act(b, () => POST('/api/bot/test'), (r) => `${r.sent} ta chatga test xabar yuborildi`);
    if (b.matches('[data-brief]')) act(b, () => POST('/api/bot/briefing'), 'AI brifing obunachilarga yuborildi');
    if (b.matches('[data-code]')) {
      const r = await act(b, () => POST('/api/bot/link-code')).catch(() => null); if (!r) return;
      const qr = r.deepLink ? await qrSvg(r.deepLink, 120) : '';
      $('[data-codebox]', el).innerHTML = html(h`<div class="callout ai"><div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">${qr ? raw(`<div style="background:#fff;padding:6px;border-radius:8px">${qr}</div>`) : ''}<div><div class="small t2">Ulash kodi (10 daqiqa amal qiladi):</div><div style="font:700 30px var(--mono);letter-spacing:.12em">${r.code}</div>
        ${r.deepLink ? h`<a class="btn primary sm" href="${r.deepLink}" target="_blank" rel="noopener" style="margin-top:6px">${icon('send')}Telegramda ochish</a><div class="small muted" style="margin-top:6px">yoki telefon kamerasi bilan QR ni skanerlang</div>` : ''}
        <div class="small muted" style="margin-top:6px">Qo‘lda: botga <span class="mono">/start ${r.code}</span> yuboring</div></div></div></div>`);
    }
    if (b.matches('[data-unlink]')) { if (await confirmBox('Chatni uzish', 'Bu chatga boshqa xabar yuborilmaydi.', 'Uzish', 'danger')) act(b, () => POST(`/api/bot/unlink/${b.dataset.unlink}`), 'Uzildi').then(App.refresh); }
    if (b.matches('[data-save]')) { const box = b.closest('[data-chat]'); act(b, () => PUT(`/api/bot/prefs/${box.dataset.chat}`, { cats: $$('[data-cat]:checked', box).map((c) => c.dataset.cat), level: $('[data-lvl]', box).value, mute: $('[data-mute]', box).checked }), 'Sozlamalar saqlandi'); }
  });
} });
