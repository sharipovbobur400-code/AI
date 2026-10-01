'use strict';
// Jamoa botlari: 4 ta alohida Telegram bot (Ta’minot, Ombor, Ishlab chiqarish, Xulosa) — sayt ichida ishlaydi.
// • Tugmasiz, to‘liq avtomatik; yagona buyruq /help.
// • Har bir bot faqat o‘z sohasidagi real ma’lumot bilan javob beradi (sayt bazasi: WMS + Odoo), AI faktlarni tushuntiradi.
// • Ovozli xabar → matn (Gemini STT) → javob.
// • 24/7: saytdagi har bir yangilanish tegishli botga (to‘plab, spam qilmasdan) yuboriladi; ertalab reja, kechqurun statistika.
// • Botlar bir-biri bilan gaplashadi (bitta jarayonda: bir botning xabariga boshqa bot o‘z ma’lumoti bilan javob qaytaradi).
// • Xulosa boti guruhdagi barcha xabarlar + barcha bo‘lim ma’lumotlaridan yakuniy xulosa va topshiriqlar chiqaradi.
const crypto = require('node:crypto');
const db = require('./db');
const secrets = require('./secrets');
const D = require('./teambots-data');
const { bus, clock } = require('./core');

// jadvallar: server/db.js (teambot_messages, teambot_groups)
const BOTS = {
  taminot: { label: 'Ta’minot', emoji: '🧾', secret: 'TAMINOT_BOT_TOKEN', area: 'ta’minot (xarid, zayavkalar, yetkazib beruvchilar, yetkazib berish, yetishmovchilik)',
    kw: /ta.?minot|zayavka|supplier|yetkazib|xarid|buyurtma ber|sotib ol|kechik|postavsh|narx|keladi|olib kel/i },
  ombor: { label: 'Ombor', emoji: '📦', secret: 'OMBOR_BOT_TOKEN', area: 'ombor (qoldiq, kirim, chiqim, QC, joylashuv, sig‘im, picking/packing)',
    kw: /ombor|qoldiq|zaxira|kirim|chiqim|\bqc\b|sifat nazorat|picking|packing|pallet|joy|sig.?im|nechta bor|qancha bor|inventar/i },
  ishlab: { label: 'Ishlab chiqarish', emoji: '🏭', secret: 'ISHLAB_BOT_TOKEN', area: 'ishlab chiqarish (reja, buyurtmalar uchun talab, xomashyo, tayyor va yarim tayyor mahsulot, brak)',
    kw: /ishlab|chiqarish|xom.?ashyo|brak|rework|nuqson|sex|partiya|smena|reja|tayyor mahsulot|yarim tayyor/i },
  xulosa: { label: 'Xulosa', emoji: '📋', secret: 'XULOSA_BOT_TOKEN', area: 'umumiy xulosa, tavsiyalar, bo‘limlar o‘rtasidagi muvofiqlik',
    kw: /xulosa|umumiy|tavsiya|nima qilish|vaziyat|hammasi|natija/i },
};
const KEYS = Object.keys(BOTS);
const cfgDefaults = { groupIds: [], adminIds: [], morningHour: 8, eveningHour: 19, summaryEveryHours: 3, hourly: true, workStart: 8, workEnd: 22, notify: true, enabled: { taminot: true, ombor: true, ishlab: true, xulosa: true } };
const SERVERLESS = !!process.env.VERCEL || process.env.WMS_SERVERLESS === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const SEP = '━━━━━━━━━━━━━━━━━━';
/** Telegram xabarini chiroyli qiladi (kirish: allaqachon HTML-escape qilingan matn). */
function pretty(t, { head = true } = {}) {
  const lines = String(t || '').split('\n');
  return lines.map((l, i) => {
    if (i === 0 && head && l.trim()) return `<b>${l}</b>${lines.length > 1 ? `\n${SEP}` : ''}`;
    if (/^\s*[^•\d\s].{0,70}:\s*$/.test(l)) return `<b>${l}</b>`; // “Kechikkan yetkazib berish:” kabi bo‘lim nomlari
    const m = /^(\s*(?:[\u{1F300}-\u{1FAFF}\u2600-\u27BF]\uFE0F?\s*)?)([^:]{2,48}):\s(.+)$/u.exec(l);
    if (m && !l.trim().startsWith('•')) return `${m[1]}<b>${m[2]}:</b> ${m[3]}`; // “📦 Bugun jami kelgan: 169”
    return l;
  }).join('\n');
}
const tzOff = () => Number(process.env.BOT_TZ_OFFSET_MIN ?? 300);
const local = () => { const d = new Date(Date.now() + tzOff() * 60000); return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes() }; };

function config() { const c = db.setting('teambots', {}) || {}; return { ...cfgDefaults, ...c, enabled: { ...cfgDefaults.enabled, ...(c.enabled || {}) } }; }
function saveConfig(patch) { const c = { ...config(), ...patch }; db.setSetting('teambots', c); return c; }
const tokenOf = (k) => secrets.get(BOTS[k].secret) || '';
const apiBase = () => (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
const adminIds = () => { const c = config(); const env = String(process.env.TEAMBOTS_ADMIN_IDS || process.env.ADMIN_TELEGRAM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean); return new Set([...c.adminIds.map(String), ...env]); };

// ---------------- holat ----------------
const state = Object.fromEntries(KEYS.map((k) => [k, { me: null, running: false, lastError: null, gen: 0, token: null, startedAt: null }]));
let listening = false; let timer = null;

async function tg(k, method, params = {}, timeoutMs = 20000) {
  const token = state[k].token || tokenOf(k); if (!token) throw new Error(`${BOTS[k].label}: token yo‘q`);
  const res = await fetch(`${apiBase()}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(timeoutMs) });
  const j = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!j.ok) { const e = new Error(j.description || 'Telegram xatosi'); e.code = j.error_code; e.retryAfter = j.parameters?.retry_after; throw e; }
  return j.result;
}
function logMsg(row) { try { db.run('INSERT OR IGNORE INTO teambot_messages(chat_id,message_id,bot,from_id,from_name,is_bot,kind,text,created_at) VALUES(?,?,?,?,?,?,?,?,?)', String(row.chat_id), row.message_id ?? null, row.bot || null, row.from_id ? String(row.from_id) : null, row.from_name || null, row.is_bot ? 1 : 0, row.kind || 'text', String(row.text || '').slice(0, 4000), clock.iso()); } catch { /* jadval yo‘q bo‘lsa */ } }

// navbat: Telegram limitlari (≈20 xabar/s) va 429 retry
const queue = []; let pumping = false; const pending = new Set();
function send(k, chatId, text, extra = {}) {
  if (!state[k].running && !SERVERLESS) return Promise.resolve(null);
  return new Promise((resolve) => { queue.push({ k, chatId: String(chatId), text: String(text).slice(0, 4000), extra, resolve }); pump(); });
}
async function pump() {
  if (pumping) return; pumping = true;
  const p = (async () => {
    while (queue.length) {
      const m = queue.shift();
      try {
        const r = await tg(m.k, 'sendMessage', { chat_id: m.chatId, text: m.text, parse_mode: 'HTML', disable_web_page_preview: true, ...m.extra });
        logMsg({ chat_id: m.chatId, message_id: r?.message_id, bot: m.k, from_id: state[m.k].me?.id, from_name: BOTS[m.k].label, is_bot: 1, kind: m.extra.kind || 'out', text: m.text.replace(/<[^>]+>/g, '') });
        m.resolve(r);
      } catch (err) {
        if (err.retryAfter) { queue.unshift(m); await sleep(err.retryAfter * 1000 + 200); continue; }
        if (err.code === 400 && m.extra.reply_to_message_id) { const { reply_to_message_id: _r, ...rest } = m.extra; queue.unshift({ ...m, extra: rest }); continue; }
        state[m.k].lastError = err.message; m.resolve(null);
      }
      await sleep(50);
    }
  })();
  pending.add(p); await p; pending.delete(p); pumping = false;
}
async function flush(timeoutMs = 15000) { flushEvents(); const t0 = Date.now(); while ((queue.length || pumping) && Date.now() - t0 < timeoutMs) await sleep(25); }
const toGroups = (k, text, extra) => Promise.all(config().groupIds.map((g) => send(k, g, text, extra)));

// ---------------- AI va ovoz ----------------
function systemPrompt(k) {
  const b = BOTS[k];
  return `Sen “${b.label} bot”san — quyosh panellari zavodining ${b.area} bo‘yicha AI yordamchisisan. Faqat o‘zbek tilida, aniq va qisqa (ko‘pi bilan 12 qator) javob ber.
Qoidalar: 1) Korxonaga oid raqam, mahsulot, supplier, sana — FAQAT berilgan FAKTLAR (JSON, sayt bazasidan real vaqtda) dan olinadi; faktlarda yo‘q narsani hech qachon o‘ylab topma, bunday holda “bu ma’lumot tizimda yo‘q” de.
2) ${b.label} sohasiga oid umumiy savollarga (usul, tavsiya, tushuncha) o‘z bilimingdan javob berishing mumkin, lekin buni korxona ma’lumoti deb ko‘rsatma.
3) Savol boshqa bo‘limga tegishli bo‘lsa, qisqa javob ber va tegishli botni ayt (Ta’minot / Ombor / Ishlab chiqarish / Xulosa).
4) Markdown ishlatma; ro‘yxatlar uchun “•” belgisidan foydalan; emoji ozgina.`;
}
async function aiAnswer(k, question, extraFacts) {
  const ai = require('./ai');
  if (!ai.llmInfo().configured) return null;
  const facts = { ...(k === 'xulosa' ? D.FACTS.xulosa() : D.FACTS[k]()), ...(extraFacts || {}) };
  try { return await ai.rawLLM(systemPrompt(k), `Savol: ${question}\n\nFAKTLAR (JSON):\n${JSON.stringify(facts).slice(0, 60000)}`, 900); } catch (e) { state[k].lastError = `AI: ${e.message}`; return null; }
}
const sttKey = () => secrets.get('STT_API_KEY') || (() => { const ai = require('./ai'); const c = ai.llmConfig?.(); return c && c.provider === 'gemini' ? c.key : null; })();
async function transcribe(k, fileId) {
  const key = sttKey();
  if (!key) return { error: 'Ovozli xabarni matnga aylantirish uchun Gemini kaliti kerak (Sozlamalar → Telegram botlar → Ovoz uchun kalit).' };
  const f = await tg(k, 'getFile', { file_id: fileId });
  if (f.file_size && f.file_size > 19 * 1024 * 1024) return { error: 'Ovozli xabar juda katta (20 MB dan kichik bo‘lsin).' };
  const res = await fetch(`${apiBase()}/file/bot${state[k].token || tokenOf(k)}/${f.file_path}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) return { error: `Faylni yuklab bo‘lmadi (HTTP ${res.status})` };
  const audio = Buffer.from(await res.arrayBuffer());
  const base = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const model = process.env.STT_MODEL || 'gemini-flash-latest';
  const r = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', signal: AbortSignal.timeout(45000), headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Bu ovozli xabarni so‘zma-so‘z matnga aylantir (asl tilida, odatda o‘zbek). Faqat matnni yoz, izoh qo‘shma.' }, { inline_data: { mime_type: /ogg|opus/.test(f.file_path) ? 'audio/ogg' : 'audio/mpeg', data: audio.toString('base64') } }] }], generationConfig: { temperature: 0 } }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: `Ovozni tanib bo‘lmadi: ${j.error?.message || `HTTP ${r.status}`}` };
  const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  return text ? { text } : { error: 'Ovozli xabarda nutq aniqlanmadi.' };
}

/** Savolga javob: AI (faktlar bilan) yoki AI yo‘q bo‘lsa — bazadan tayyor javob. */
async function answer(k, question) {
  const ai = await aiAnswer(k, question);
  if (ai) return { text: pretty(esc(ai), { head: false }) };
  if (k === 'xulosa') return { text: summaryText().text }; // tayyor HTML
  return { text: pretty(esc(D.quickAnswer(k, question) || D.dailyStats(k, 'now'))) };
}
/** Qaysi bo‘limga tegishli savol (kalit so‘zlar bo‘yicha). */
function classify(text) {
  const score = KEYS.map((k) => [k, (String(text).match(new RegExp(BOTS[k].kw.source, 'gi')) || []).length]).sort((a, b) => b[1] - a[1]);
  return score[0][1] > 0 ? score[0][0] : 'xulosa';
}
const isQuestion = (t) => /\?|\b(qancha|nechta|qachon|qayer|qaysi|nima|kim|qanday|nega|bormi|yetadimi|keldimi|kerakmi|ayt|ko.?rsat|xulosa)\b/i.test(t);

// ---------------- kiruvchi xabarlar ----------------
function helpText(k) {
  const all = KEYS.filter((x) => state[x].me).map((x) => `${BOTS[x].emoji} <b>${BOTS[x].label}</b> — @${state[x].me.username}`).join('\n');
  const b = BOTS[k];
  return `${b.emoji} <b>${b.label} bot</b>\n\nMen ${esc(b.area)} bo‘yicha savollarga javob beraman — ma’lumot saytdan real vaqtda olinadi. Tugmalar yo‘q, shunchaki yozing yoki 🎤 ovozli xabar yuboring.
\n• Guruhda: meni @ bilan belgilang yoki xabarimga javob yozing. Belgilanmagan savollarni tizim o‘zi tegishli botga yo‘naltiradi.\n• Saytdagi har bir yangilanishni shu guruhga yozib boraman; ${config().morningHour}:00 da reja, ${config().eveningHour}:00 da kunlik statistika.${k === 'xulosa' ? `\n• Har ${config().summaryEveryHours} soatda guruhdagi barcha ma’lumotlardan yakuniy xulosa va topshiriqlar beraman.` : ''}
\nMisollar: ${{ taminot: '“Qaysi yetkazib berish kechikyapti?”, “Nimaga buyurtma berish kerak?”', ombor: '“Oyna qancha bor?”, “Qaysi mahsulot kam?”', ishlab: '“Bugun nima ishlab chiqarish kerak?”, “Xomashyo yetadimi?”', xulosa: '“Umumiy xulosa ber”, “Bugun nima qilish kerak?”' }[k]}
\n<b>Jamoa:</b>\n${all || '—'}`;
}
function chatAllowed(chat, from) {
  const c = config();
  if (chat.type === 'private') {
    if (adminIds().has(String(from?.id))) return true;
    return !!db.get('SELECT 1 FROM bot_links WHERE user_id IS NOT NULL AND chat_id=? AND active=1', String(from?.id));
  }
  return c.groupIds.map(String).includes(String(chat.id));
}
function rememberGroup(k, chat, by) {
  if (!['group', 'supergroup'].includes(chat.type)) return false;
  const c = config();
  const ex = db.get('SELECT * FROM teambot_groups WHERE chat_id=?', String(chat.id));
  if (!ex) db.run('INSERT INTO teambot_groups(chat_id,title,allowed,first_bot,seen_at) VALUES(?,?,?,?,?)', String(chat.id), chat.title || null, 0, k, clock.iso());
  else db.run('UPDATE teambot_groups SET title=?, seen_at=? WHERE chat_id=?', chat.title || ex.title, clock.iso(), String(chat.id));
  // birinchi guruh: admin qo‘shgan bo‘lsa yoki adminlar ro‘yxati bo‘sh bo‘lsa — avtomatik ruxsat
  if (!c.groupIds.length && (adminIds().size === 0 || adminIds().has(String(by?.id)))) {
    saveConfig({ groupIds: [String(chat.id)] });
    db.run('UPDATE teambot_groups SET allowed=1 WHERE chat_id=?', String(chat.id));
    db.audit(null, 'TEAMBOTS_GROUP_ALLOW', 'teambot_groups', String(chat.id), { title: chat.title, by: by?.id });
    return true;
  }
  return c.groupIds.map(String).includes(String(chat.id));
}
const router = () => KEYS.slice().reverse().find((k) => state[k].running && config().enabled[k]) || null; // Xulosa → Ishlab → Ombor → Ta’minot

async function handleUpdate(k, up) {
  if (up.my_chat_member) {
    const m = up.my_chat_member; const st = m.new_chat_member?.status;
    if (['member', 'administrator'].includes(st)) {
      const ok = rememberGroup(k, m.chat, m.from);
      if (!ok) { await tg(k, 'leaveChat', { chat_id: m.chat.id }).catch(() => {}); return; }
      await send(k, m.chat.id, `${BOTS[k].emoji} <b>${BOTS[k].label} bot</b> guruhga qo‘shildi. Yordam: /help\n<i>Barcha xabarlarni o‘qishim uchun @BotFather → /setprivacy → Disable qiling yoki meni guruh admini qiling.</i>`);
    }
    return;
  }
  const msg = up.message || up.edited_message; if (!msg || !msg.chat) return;
  const chat = msg.chat; const from = msg.from || {};
  if (['group', 'supergroup'].includes(chat.type)) rememberGroup(k, chat, from);
  if (!chatAllowed(chat, from)) {
    if (chat.type === 'private') await send(k, chat.id, '🔒 Ruxsat yo‘q. Bot faqat korxona guruhida va ro‘yxatdagi adminlar bilan ishlaydi.');
    else await tg(k, 'leaveChat', { chat_id: chat.id }).catch(() => {});
    return;
  }
  const me = state[k].me; if (!me) return;
  const text = String(msg.text || msg.caption || '').trim();
  const fromName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'foydalanuvchi';
  // guruhdagi har bir xabar Xulosa uchun yoziladi (bir marta)
  if (text || msg.voice) logMsg({ chat_id: chat.id, message_id: msg.message_id, bot: null, from_id: from.id, from_name: fromName, is_bot: from.is_bot, kind: msg.voice ? 'voice' : 'text', text: text || '🎤 (ovozli xabar)' });
  if (from.id === me.id) return;
  const isGroup = chat.type !== 'private';
  const mentioned = text.toLowerCase().includes(`@${me.username.toLowerCase()}`);
  const replied = msg.reply_to_message?.from?.id === me.id;
  const cmd = /^\/(\w+)(@\w+)?/.exec(text);
  if (cmd) {
    if (cmd[2] && cmd[2].slice(1).toLowerCase() !== me.username.toLowerCase()) return;
    if (!cmd[2] && isGroup && k !== router()) return; // umumiy /help ga faqat bitta bot javob beradi
    if (['help', 'start', 'yordam'].includes(cmd[1].toLowerCase())) return send(k, chat.id, helpText(cmd[2] || !isGroup ? k : 'xulosa'), { reply_to_message_id: msg.message_id });
    return;
  }
  let target = null;
  if (!isGroup || mentioned || replied) target = k;
  else if (k === router() && (msg.voice || msg.audio || isQuestion(text)) && !from.is_bot) target = 'route';
  if (!target) return;
  let question = text.replace(new RegExp(`@${me.username}`, 'ig'), '').trim();
  if (msg.voice || msg.audio) {
    tg(k, 'sendChatAction', { chat_id: chat.id, action: 'typing' }).catch(() => {});
    const t = await transcribe(k, (msg.voice || msg.audio).file_id).catch((e) => ({ error: e.message }));
    if (t.error) return send(k, chat.id, `🎤 ${esc(t.error)}`, { reply_to_message_id: msg.message_id });
    question = t.text;
    db.run('UPDATE teambot_messages SET text=? WHERE chat_id=? AND message_id=?', `🎤 ${question}`, String(chat.id), msg.message_id);
    if (target === 'route' && !isQuestion(question) && !Object.values(BOTS).some((b) => b.kw.test(question))) return; // savol emas — faqat qayd etildi
  }
  if (!question) return;
  const who = target === 'route' ? classify(question) : target;
  const responder = state[who]?.running && config().enabled[who] ? who : k;
  tg(responder, 'sendChatAction', { chat_id: chat.id, action: 'typing' }).catch(() => {});
  const out = await answer(who, question);
  const prefix = msg.voice || msg.audio ? `🎤 <i>${esc(question.slice(0, 300))}</i>\n\n` : '';
  const ans = await send(responder, chat.id, `${prefix}${out.text}`, { reply_to_message_id: msg.message_id, kind: 'answer' });
  const next = D.FOLLOW[who];
  if (isGroup && next && ans && state[next].running && config().enabled[next]) {
    await sleep(Number(process.env.TEAMBOTS_FOLLOW_DELAY_MS ?? 1500));
    tg(next, 'sendChatAction', { chat_id: chat.id, action: 'typing' }).catch(() => {});
    const extra = await followUpText(next, who, question, out.text);
    if (extra) await send(next, chat.id, extra, { reply_to_message_id: ans.message_id, kind: 'follow' });
  }
  db.audit({ id: null, username: `tg:${from.id}` }, 'TEAMBOT_QUESTION', 'teambots', who, { q: question.slice(0, 300) });
}

/** Ikkinchi botning qo‘shimchasi: AI bo‘lsa — o‘z faktlari va birinchi javob asosida, bo‘lmasa — bazadan. */
async function followUpText(to, from, question, firstAnswer) {
  const ai = require('./ai');
  if (ai.llmInfo().configured) {
    try {
      const out = await ai.rawLLM(systemPrompt(to), `Guruhda savol: "${question}"\n${BOTS[from].label} bot javobi:\n${String(firstAnswer).replace(/<[^>]+>/g, '').slice(0, 2500)}\n\nVazifa: ${BOTS[to].label} bo‘limi nuqtai nazaridan 2–4 qatorda QO‘SHIMCHA ma’lumot yoz (takrorlama, faqat o‘z faktlaringdan). Boshida "${BOTS[to].emoji} ${BOTS[to].label}:" deb yoz.\n\nFAKTLAR:\n${JSON.stringify(D.FACTS[to]()).slice(0, 30000)}`, 400);
      if (out) return pretty(esc(out));
    } catch (e) { state[to].lastError = `AI: ${e.message}`; }
  }
  const t = D.followUp(from, to, question); return t ? pretty(esc(t)) : null;
}

// ---------------- 24/7 yangilanishlar (to‘plab yuborish) ----------------
const buffers = Object.fromEntries(KEYS.map((k) => [k, []]));
let stockCount = {}; let flushTimer = null;
const batchMs = () => Number(process.env.TEAMBOTS_BATCH_SECONDS ?? 60) * 1000;
function onEvent(ev) {
  if (!config().notify || !config().groupIds.length) return;
  if (ev.type === 'STOCK_CHANGED') { const t = ev.payload?.type || 'X'; stockCount[t] = (stockCount[t] || 0) + 1; }
  else {
    const lines = D.eventLine(ev); if (!lines) return;
    for (const [k, line] of Object.entries(lines)) if (line && config().enabled[k] && state[k].running) buffers[k].push({ line, type: ev.type, payload: ev.payload });
  }
  if (!flushTimer) { flushTimer = setTimeout(flushEvents, batchMs()); flushTimer.unref?.(); }
}
async function flushEvents() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  const sc = stockCount; stockCount = {};
  const names = { RECEIVE: 'kirim', ISSUE: 'chiqim', TRANSFER: 'ko‘chirish', RESERVE: 'rezerv', RELEASE: 'rezerv bo‘shatish', ADJUSTMENT: 'tuzatish', SHIP: 'jo‘natish', PACK: 'qadoqlash', REJECT: 'brak', SCRAP: 'scrap' };
  if (Object.keys(sc).length && state.ombor.running && config().enabled.ombor) buffers.ombor.push({ line: `🔁 Ombor harakatlari: ${Object.entries(sc).map(([t, c]) => `${names[t] || t} ${c}`).join(', ')}`, type: 'STOCK_CHANGED' });
  for (const k of KEYS) {
    const items = buffers[k].splice(0); if (!items.length) continue;
    const text = `🔔 <b>${BOTS[k].label}: yangilanishlar</b>\n${SEP}\n${items.slice(0, 20).map((i) => `• ${esc(i.line)}`).join('\n')}${items.length > 20 ? `\n… yana ${items.length - 20} ta` : ''}`;
    const sent = await toGroups(k, text, { kind: 'events' });
    react(k, items, sent).catch(() => {});
  }
}
/** Botlararo suhbat: bir botning xabariga boshqa bot o‘z ma’lumoti bilan javob beradi (bir bosqich, aylanma yo‘q). */
async function react(fromKey, items, sentMsgs) {
  const replies = [];
  for (const it of items) {
    const d = it.payload || {};
    if (fromKey === 'taminot' && it.type === 'SHORTAGE_DETECTED' && d.productId) {
      const s = require('./inventory').productStock(d.productId);
      if (s) replies.push(['ombor', `📦 Ombor: ${esc(s.name)} — erkin ${D.n(s.free)}, rezerv ${D.n(s.reserved)}, kelmoqda ${D.n(s.inbound)} ${esc(s.unit)}.`]);
    }
    if (fromKey === 'ombor' && it.type === 'QC_FAILED') {
      const open = db.val("SELECT COUNT(*) FROM purchase_requests WHERE status NOT IN ('RECEIVED','REJECTED','CANCELLED')");
      replies.push(['taminot', `🧾 Ta’minot: ${esc(d.sku)} bo‘yicha brak qayd etildi — supplier bilan reklamatsiya va o‘rnini to‘ldirish zayavkasi ko‘rib chiqiladi. Ochiq zayavkalar: ${open}.`]);
    }
    if (fromKey === 'ishlab' && it.type === 'ORDER_CREATED') {
      const low = D.FACTS.ishlab().xomashyo_kam;
      replies.push(['ombor', low.length ? `📦 Ombor: yangi buyurtma uchun xomashyo tekshirildi — kam: ${low.slice(0, 5).map((p) => `${esc(p.name)} (${D.n(p.erkin)}/${D.n(p.min)})`).join(', ')}. @ta’minot e’tibor bering.` : '📦 Ombor: yangi buyurtma uchun xomashyo yetarli ✅']);
      if (low.length) replies.push(['taminot', `🧾 Ta’minot: kam xomashyo bo‘yicha zayavkalar holati — ${low.slice(0, 5).map((p) => `${esc(p.name)}${p.kelmoqda ? ` (kelmoqda ${D.n(p.kelmoqda)})` : ' (zayavka yo‘q)'}`).join(', ')}.`]);
    }
    if (fromKey === 'taminot' && it.type === 'SUPPLIER_DELIVERY_ARRIVED') {
      const q = db.val("SELECT COUNT(*) FROM receiving_orders WHERE status='RECEIVING'");
      replies.push(['ombor', `📦 Ombor: yuk qabul qilinadi. QC navbatida ${q} ta kirim.`]);
    }
  }
  const uniq = [...new Map(replies.map((r) => [r[1], r])).values()].slice(0, 4);
  for (const [k, text] of uniq) {
    if (!state[k].running || !config().enabled[k]) continue;
    for (const m of sentMsgs.filter(Boolean)) await send(k, m.chat?.id, text, { reply_to_message_id: m.message_id, kind: 'react' });
  }
}

// ---------------- Xulosa ----------------
function summaryText() {
  const f = D.FACTS.xulosa();
  const n = D.n; const L = (rows, fn, empty) => (rows.length ? rows.map((r) => `• ${fn(r)}`).join('\n') : `• ${empty}`);
  const good = [];
  if (!f.taminot.kechikkan.length) good.push('Kechikkan yetkazib berish yo‘q');
  if (!f.ombor.minimaldan_past.length) good.push('Ombor qoldiqlari minimaldan yuqori');
  if (f.ishlab_chiqarish.bugun.miqdor > 0) good.push(`Bugun ${n(f.ishlab_chiqarish.bugun.miqdor)} dona ishlab chiqarildi`);
  if (f.jonatmalar.bugun_yetkazildi) good.push(`Bugun ${f.jonatmalar.bugun_yetkazildi} ta jo‘natma yetkazildi`);
  const risks = [...f.ai_ogohlantirishlar.slice(0, 5).map((a) => `${a.severity === 'CRITICAL' ? '🔴' : '🟠'} ${a.title}`)];
  const text = `📋 <b>XULOSA</b> · ${f.sana}\n${SEP}\n<i>Ta’minot, Ombor va Ishlab chiqarish botlari ma’lumotlari asosida</i>\n
<b>Asosiy holat:</b> ombor ${f.ombor.sigim ?? '—'}% band · yetishmovchilik ${f.taminot.yetishmovchilik} · ishlab chiqarish kerak ${f.ishlab_chiqarish.kerak.length} pozitsiya${require('./modules').logisticsOn() ? ` · faol jo‘natma ${f.jonatmalar.faol}` : ''}
\n✅ <b>Yaxshi ketyapti:</b>\n${L(good, (x) => x, 'Alohida ijobiy ko‘rsatkich yo‘q')}
\n⚠️ <b>Muammolar:</b>\n${L(risks, (x) => x, 'Kritik muammo yo‘q')}
\n🧾 <b>Ta’minotga — olib kelish / buyurtma berish kerak:</b>\n${L(f.taminot.buyurtma_kerak, (p) => `${esc(p.name)}: kamida ${n(Math.max(0, p.min - p.free))} ${esc(p.unit)} (erkin ${n(p.free)}, min ${n(p.min)})`, 'Yangi buyurtma kerak emas')}${f.taminot.kechikkan.length ? `\n${L(f.taminot.kechikkan, (d) => `⏰ ${esc(d.supplier)} — ${esc(d.name || '')} kechikmoqda, tezlashtirish kerak`, '')}` : ''}
\n📦 <b>Omborga:</b>\n${L(f.taminot.keladigan_7_kun, (d) => `${esc(d.supplier)}: ${esc(d.name || '')} ${n(d.qty)} — ${String(d.expected_date || '').slice(0, 10)} da keladi, joy tayyorlang`, 'Yaqin 7 kunda kiruvchi yuk yo‘q')}${f.ombor.qc_kutmoqda ? `\n• QC kutayotgan ${f.ombor.qc_kutmoqda} ta kirimni yakunlang` : ''}
\n🏭 <b>Ishlab chiqarishga:</b>\n${L(f.ishlab_chiqarish.kerak, (x) => `${esc(x.name)}: ${n(x.ishlab_chiqarish_kerak)} (muddat ${String(x.muddat || '').slice(0, 10)})`, 'Buyurtmalar zaxira bilan qoplangan')}${f.ishlab_chiqarish.xomashyo_kam.length ? `\n• Xomashyo kam: ${f.ishlab_chiqarish.xomashyo_kam.slice(0, 5).map((p) => esc(p.name)).join(', ')}` : ''}`;
  return { text, facts: f };
}
async function runSummary({ reason = 'schedule' } = {}) {
  if (!state.xulosa.running || !config().groupIds.length) return { skipped: true };
  const since = db.setting('teambots_last_summary_at', D.sinceIso(24));
  // asosiy manba — 3 ta bo‘lim botining guruhga yozganlari; odamlar yozganlari — qo‘shimcha kontekst
  const log = (() => { try { return db.all("SELECT from_name, is_bot, bot, text, created_at FROM teambot_messages WHERE created_at>? AND (bot IN ('taminot','ombor','ishlab') OR is_bot=0) ORDER BY id LIMIT 300", since); } catch { return []; } })();
  const botMsgs = log.filter((m) => m.is_bot);
  const base = summaryText();
  let text = base.text;
  const ai = require('./ai');
  if (ai.llmInfo().configured) {
    const out = await ai.rawLLM(systemPrompt('xulosa'), `Vazifa: Ta’minot, Ombor va Ishlab chiqarish botlari guruhga yozgan ma’lumotlar (pastda) asosida XULOSA tuz; odamlarning xabarlari — qo‘shimcha kontekst. Bo‘limlar: 1) Asosiy holat 2) Yaxshi ketayotganlar 3) Muammolar va xavflar 4) Ta’minotga topshiriqlar (nima olib kelish/buyurtma berish kerak, miqdori bilan) 5) Omborga topshiriqlar 6) Ishlab chiqarishga topshiriqlar 7) Keyingi ustuvor ishlar. Faqat faktlardan foydalan.
\nGURUH XABARLARI (${log.length}):\n${log.map((m) => `[${m.created_at.slice(11, 16)}] ${m.is_bot ? `🤖 ${m.from_name}` : m.from_name}: ${m.text}`).join('\n').slice(0, 30000)}\n\nFAKTLAR:\n${JSON.stringify(base.facts).slice(0, 40000)}`, 1400).catch(() => null);
    if (out) text = `📋 <b>XULOSA</b> — 3 ta bot ma’lumotlari asosida\n${SEP}\n${pretty(esc(out), { head: false })}`;
  }
  await toGroups('xulosa', `${text}\n\n<i>Tahlil qilindi: botlar xabarlari ${botMsgs.length}, jamoa xabarlari ${log.length - botMsgs.length}</i>`, { kind: 'summary' });
  db.setSetting('teambots_last_summary_at', clock.iso());
  return { ok: true, reason, messages: log.length, botMessages: botMsgs.length };
}

// ---------------- jadval: ertalab reja, kechki statistika, davriy xulosa ----------------
async function tick() {
  if (!config().groupIds.length) return { skipped: true };
  const { date, hour } = local(); const c = config(); const done = db.setting('teambots_daily', {}) || {};
  const out = {};
  for (const [kind, h] of [['morning', c.morningHour], ['evening', c.eveningHour]]) {
    const key = `${date}:${kind}`;
    if (hour >= h && hour < h + 3 && !done[key]) {
      done[key] = clock.iso(); db.setSetting('teambots_daily', Object.fromEntries(Object.entries(done).slice(-20)));
      for (const k of ['taminot', 'ombor', 'ishlab']) if (state[k].running && c.enabled[k]) await toGroups(k, pretty(esc(D.dailyStats(k, kind))), { kind: `daily-${kind}` });
      if (kind === 'evening') await runSummary({ reason: 'evening' });
      out[kind] = true;
    }
  }
  if (c.hourly && hour >= c.workStart && hour < c.workEnd) {
    const hk = `${date}:${hour}`; const hd = db.setting('teambots_hourly', {}) || {};
    if (!hd[hk]) {
      hd[hk] = clock.iso(); db.setSetting('teambots_hourly', Object.fromEntries(Object.entries(hd).slice(-48)));
      const hhmm = `${String(hour).padStart(2, '0')}:00`;
      for (const k of ['taminot', 'ombor', 'ishlab']) if (state[k].running && c.enabled[k]) await toGroups(k, pretty(esc(D.hourlyReport(k, hhmm))), { kind: 'hourly' });
      await flush(); // 3 bot yozib bo‘lgach — Xulosa ularning xabarlaridan xulosa chiqaradi
      out.hourly = hhmm; out.summary = await runSummary({ reason: 'hourly' });
    }
    return out;
  }
  const last = db.setting('teambots_last_summary_at', null);
  if (c.summaryEveryHours > 0 && hour >= c.workStart && hour < c.workEnd && (!last || Date.now() - new Date(last).getTime() >= c.summaryEveryHours * 3600000)) out.summary = await runSummary({ reason: 'interval' });
  return out;
}

// ---------------- ishga tushirish ----------------
async function poll(k, gen) {
  let offset = Number(db.setting(`teambots_offset_${k}`, 0)) || 0; let backoff = 1000;
  while (state[k].gen === gen && state[k].running) {
    try {
      const ups = await tg(k, 'getUpdates', { offset, timeout: Number(process.env.BOT_POLL_TIMEOUT ?? 25), allowed_updates: ['message', 'edited_message', 'my_chat_member'] }, (Number(process.env.BOT_POLL_TIMEOUT ?? 25) + 10) * 1000);
      backoff = 1000; state[k].conflicts = 0;
      if (state[k].lastError && /409|ulanib|ECONN|fetch failed|timeout/i.test(state[k].lastError)) state[k].lastError = null;
      if (state[k].gen !== gen) return; // bot qayta ishga tushirilgan — bu javoblarni yangi sikl oladi
      for (const up of ups) {
        offset = up.update_id + 1;
        try { await handleUpdate(k, up); } catch (e) { state[k].lastError = e.message; console.error(`teambot ${k}:`, e.message); }
      }
      if (ups.length) db.setSetting(`teambots_offset_${k}`, offset);
    } catch (e) {
      if (state[k].gen !== gen) return;
      state[k].lastError = e.message;
      if (e.code === 401 || e.code === 404) { state[k].running = false; console.error(`${BOTS[k].label} bot: token noto‘g‘ri — to‘xtatildi`); return; }
      if (e.code === 409) { state[k].conflicts = (state[k].conflicts || 0) + 1; state[k].lastError = `Shu token bilan boshqa joyda ham bot ishlayapti (409, ${state[k].conflicts} marta) — boshqa nusxani to‘xtating`; await tg(k, 'deleteWebhook', {}).catch(() => {}); }
      await sleep(backoff); backoff = Math.min(backoff * 2, 30000);
    }
  }
}
async function startBot(k) {
  const s = state[k]; s.gen++; s.running = false; s.me = null; s.lastError = null;
  const token = tokenOf(k); s.token = token || null;
  if (!token || !config().enabled[k]) return;
  const gen = s.gen;
  try {
    s.me = await tg(k, 'getMe');
    await tg(k, 'setMyCommands', { commands: [{ command: 'help', description: 'Yordam' }] }).catch(() => {});
    if (SERVERLESS) { await setWebhook(k); s.running = true; return; }
    await tg(k, 'deleteWebhook', {}).catch(() => {});
    s.running = true; s.startedAt = clock.iso();
    console.log(`${BOTS[k].label} bot: @${s.me.username} ishga tushdi`);
    poll(k, gen);
  } catch (e) { s.lastError = e.message; console.error(`${BOTS[k].label} bot:`, e.message); }
}
function webhookUrl(k) { const base = (process.env.WMS_BASE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '')).replace(/\/$/, ''); return base ? `${base}/api/teambots/webhook/${k}` : null; }
const webhookSecret = (k) => crypto.createHash('sha256').update(`teambot:${k}:${tokenOf(k)}`).digest('hex').slice(0, 48);
async function setWebhook(k) { const url = webhookUrl(k); if (!url) throw new Error('WMS_BASE_URL kerak (webhook manzili)'); await tg(k, 'setWebhook', { url, secret_token: webhookSecret(k), allowed_updates: ['message', 'edited_message', 'my_chat_member'] }); }
function checkWebhook(k, given) { if (!BOTS[k] || !tokenOf(k)) return false; const exp = webhookSecret(k); return typeof given === 'string' && given.length === exp.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(exp)); }
async function handleWebhook(k, update) { if (!state[k].me) await startBot(k); await handleUpdate(k, update); await flush(); }

function init() { /* jadvallar db.js da yaratiladi */ }
async function start() {
  if (!listening) { listening = true; bus.on('event', (ev) => { try { onEvent(ev); } catch (e) { console.error('teambots event:', e.message); } }); }
  await Promise.all(KEYS.map(startBot));
  if (!timer && !SERVERLESS) { timer = setInterval(() => tick().catch((e) => console.error('teambots tick:', e.message)), Number(process.env.TEAMBOTS_TICK_SECONDS || 60) * 1000); timer.unref(); }
  return status();
}
async function reload(k) { if (k) await startBot(k); else await Promise.all(KEYS.map(startBot)); return status(); }
function stop() { for (const k of KEYS) { state[k].gen++; state[k].running = false; } if (timer) clearInterval(timer); timer = null; }

function status() {
  const c = config();
  const ai = require('./ai').llmInfo();
  return {
    bots: KEYS.map((k) => { const t = tokenOf(k); return { key: k, label: BOTS[k].label, emoji: BOTS[k].emoji, configured: !!t, tokenMasked: t ? secrets.mask(t) : null, source: secrets.source(BOTS[k].secret),
      enabled: !!c.enabled[k], running: state[k].running, username: state[k].me?.username || null, lastError: state[k].lastError, startedAt: state[k].startedAt }; }),
    config: c, ai: { configured: ai.configured, provider: ai.provider, model: ai.model, lastError: ai.lastError || null }, stt: !!sttKey(),
    groups: (() => { try { return db.all('SELECT * FROM teambot_groups ORDER BY seen_at DESC'); } catch { return []; } })(),
    messages: (() => { try { return db.all('SELECT * FROM teambot_messages ORDER BY id DESC LIMIT 60'); } catch { return []; } })(),
    router: router(), lastSummaryAt: db.setting('teambots_last_summary_at', null),
  };
}
async function testMessage(k) {
  if (!state[k].running) throw new Error(`${BOTS[k].label} bot ishlamayapti`);
  if (!config().groupIds.length) throw new Error('Ruxsat berilgan guruh yo‘q — botlarni Telegram guruhiga qo‘shing');
  const r = await toGroups(k, `${BOTS[k].emoji} <b>${BOTS[k].label} bot</b> ishlayapti ✅\n${esc(D.dailyStats(k === 'xulosa' ? 'taminot' : k, 'now') || '').split('\n').slice(0, 6).join('\n')}`, { kind: 'test' });
  return { sent: r.filter(Boolean).length };
}

module.exports = { BOTS, KEYS, init, start, stop, reload, status, config, saveConfig, tick, flush, runSummary, testMessage, checkWebhook, handleWebhook, _test: { handleUpdate, flushEvents, classify, answer, state } };
