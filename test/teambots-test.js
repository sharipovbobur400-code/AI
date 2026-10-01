'use strict';
// TEAM BOTS test: 4 ta bot (Ta’minot, Ombor, Ishlab chiqarish, Xulosa) — mock Telegram + mock ovoz tanish.
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SA = { login: 'Test Superadmin', password: 'Test#Pass2026' }; // test-only credentials
const TOK = { taminot: '1001:TAMINOT-TEST-TOKEN-aaaaaaaaaaaaaaaaaaaaaaaa', ombor: '1002:OMBOR-TEST-TOKEN-bbbbbbbbbbbbbbbbbbbbbbbbbb', ishlab: '1003:ISHLAB-TEST-TOKEN-cccccccccccccccccccccccc', xulosa: '1004:XULOSA-TEST-TOKEN-dddddddddddddddddddddddd' };
const USER = { taminot: 'taminot_test_bot', ombor: 'ombor_test_bot', ishlab: 'ishlab_test_bot', xulosa: 'xulosa_test_bot' };
const byToken = Object.fromEntries(Object.entries(TOK).map(([k, t]) => [t, k]));
const ADMIN = 7001; const GROUP = -100777;
const sent = []; const left = []; const queues = Object.fromEntries(Object.keys(TOK).map((k) => [k, []])); let upd = 1; let msgId = 1000;
const tgMock = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const ok = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); };
    const fm = /^\/file\/bot([^/]+)\/(.+)$/.exec(req.url);
    if (fm) { res.writeHead(200, { 'content-type': 'audio/ogg' }); return res.end(Buffer.from('OggS-fake-voice')); }
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url); const k = m && byToken[m[1]];
    if (!k) { res.writeHead(401); return res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' })); }
    const p = body ? JSON.parse(body) : {};
    switch (m[2]) {
      case 'getMe': return ok({ id: 9000 + Object.keys(TOK).indexOf(k), is_bot: true, first_name: k, username: USER[k] });
      case 'getUpdates': { const t0 = Date.now(); while (Date.now() - t0 < 600 && !queues[k].some((u) => u.update_id >= (p.offset || 0))) await new Promise((r) => setTimeout(r, 40)); return ok(queues[k].filter((u) => u.update_id >= (p.offset || 0))); }
      case 'sendMessage': { const mm = { bot: k, ...p, message_id: ++msgId }; sent.push(mm); return ok({ message_id: mm.message_id, chat: { id: p.chat_id } }); }
      case 'leaveChat': left.push({ bot: k, chat: p.chat_id }); return ok(true);
      case 'getFile': return ok({ file_id: p.file_id, file_path: 'voice/file_1.oga', file_size: 2048 });
      default: return ok(true);
    }
  });
});
let claudeCalls = 0;
const claudeMock = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    claudeCalls++; const j = JSON.parse(body);
    const ok = req.headers['x-api-key'] === 'sk-ant-test-key-0000000000' && req.url === '/v1/messages' && j.model && j.messages?.[0]?.content;
    const bot = /“([^”]+) bot”/.exec(j.system || '')?.[1] || '?';
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { content: [{ type: 'text', text: `Claude (${bot}): faktlar asosida javob.` }] } : { error: { message: 'invalid x-api-key' } }));
  });
});
let sttCalls = 0;
const gemMock = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => { sttCalls++; const j = JSON.parse(body); const hasAudio = j.contents[0].parts.some((x) => x.inline_data?.data); res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: hasAudio ? 'Qaysi yetkazib berish kechikyapti?' : '' }] } }] })); });
});
const chat = (id = GROUP) => ({ id, type: id < 0 ? 'supergroup' : 'private', title: id < 0 ? 'Zavod jamoasi' : undefined });
const fromUser = (id = ADMIN) => ({ id, is_bot: false, first_name: 'Ali', last_name: 'Valiyev' });
function pushAll(message, bots = Object.keys(TOK)) { for (const k of bots) queues[k].push({ update_id: upd++, message: { ...message, message_id: message.message_id } }); }
const say = (text, opts = {}) => { const m = { message_id: ++msgId, chat: chat(opts.chat), from: fromUser(opts.from), date: Math.floor(Date.now() / 1000), text, ...opts.extra }; pushAll(m); return m; };
const wait = async (pred, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = pred(); if (r && (!Array.isArray(r) || r.length)) return r; await new Promise((x) => setTimeout(x, 60)); } return pred(); };
const plain = (t) => String(t || '').replace(/<[^>]+>/g, '');

let BASE; let server; let log = '';
class Client {
  async login(u, pw) { const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: pw }) }); this.cookie = r.headers.get('set-cookie').split(';')[0]; this.csrf = (await r.json()).csrf; return this; }
  async req(m, url, body) { const r = await fetch(BASE + url, { method: m, headers: { cookie: this.cookie, 'content-type': 'application/json', 'x-csrf-token': this.csrf }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
  async ok(m, url, body) { const r = await this.req(m, url, body); if (r.status >= 400) throw new Error(`${m} ${url}: ${r.status} ${r.data.error}`); return r.data; }
}
const results = [];
async function test(n, title, fn) { try { const d = await fn(); results.push(true); console.log(`  ✅ TEAMBOT ${n}: ${title} — ${d}`); } catch (e) { results.push(false); console.log(`  ❌ TEAMBOT ${n}: ${title} — ${e.message}`); } }
const assert = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  await new Promise((r) => tgMock.listen(0, '127.0.0.1', r)); await new Promise((r) => gemMock.listen(0, '127.0.0.1', r)); await new Promise((r) => claudeMock.listen(0, '127.0.0.1', r));
  const PORT = 7900 + Math.floor(Math.random() * 300); BASE = `http://127.0.0.1:${PORT}`;
  server = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'server.js')], { env: { ...process.env, WMS_NO_DOTENV: '1', PORT: String(PORT), DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'wms-teambots-')), SEED: 'demo',
    SUPERADMIN_LOGIN: SA.login, SUPERADMIN_NAME: SA.login, SUPERADMIN_PASSWORD: SA.password, TELEGRAM_BOT_TOKEN: '', ANTHROPIC_API_KEY: '', AI_API_KEY: '', GEMINI_API_KEY: '',
    TAMINOT_BOT_TOKEN: TOK.taminot, OMBOR_BOT_TOKEN: TOK.ombor, ISHLAB_CHIQARISH_BOT_TOKEN: TOK.ishlab, XULOSA_BOT_TOKEN: TOK.xulosa, STT_API_KEY: 'stt-test-key-123456',
    TELEGRAM_API_BASE: `http://127.0.0.1:${tgMock.address().port}`, GEMINI_API_BASE: `http://127.0.0.1:${gemMock.address().port}`, ANTHROPIC_API_BASE: `http://127.0.0.1:${claudeMock.address().port}`, TEAMBOTS_FOLLOW_DELAY_MS: '200', TEAMBOTS_ADMIN_IDS: String(ADMIN),
    TEAMBOTS_BATCH_SECONDS: '1', TEAMBOTS_TICK_SECONDS: '1', BOT_POLL_TIMEOUT: '1', BOT_MORNING_HOUR: '99', BOT_EVENING_HOUR: '99', BACKUP_DAILY: '0', AI_SCAN_SECONDS: '3600', DISPATCH_CYCLE_SECONDS: '3600', ANTIVIRUS: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 300; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  console.log('\nSolar Factory WMS — JAMOA BOTLARI TESTI\n');
  const sa = await new Client().login(SA.login, SA.password);
  const offHour = (new Date(Date.now() + 300 * 60000).getUTCHours() + 12) % 24; // joriy soatdan uzoq — jadval testga aralashmasin
  await sa.ok('PUT', '/api/teambots', { summaryEveryHours: 0, hourly: false, morningHour: offHour, eveningHour: offHour });

  await test(1, '4 ta bot sayt ichida ishga tushdi (tokenlar .env dan, maskalangan)', async () => {
    const s = await wait(async () => null, 10) || await sa.ok('GET', '/api/teambots');
    assert(s.bots.length === 4 && s.bots.every((b) => b.running && b.username && !JSON.stringify(b).includes('TEST-TOKEN-aaaa')), JSON.stringify(s.bots.map((b) => [b.key, b.running, b.lastError])));
    const keys = await sa.ok('GET', '/api/keys'); assert(!keys.secrets.some((x) => /BOT_TOKEN/.test(x.name) && x.name !== 'TELEGRAM_BOT_TOKEN'), 'bot tokenlari API kalitlari sahifasida');
    return s.bots.map((b) => `${b.emoji} @${b.username}`).join(' ');
  });
  await test(2, 'Guruhga qo‘shilish: admin qo‘shgan guruh avtomatik ruxsat oladi', async () => {
    for (const k of Object.keys(TOK)) queues[k].push({ update_id: upd++, my_chat_member: { chat: chat(), from: fromUser(), new_chat_member: { status: 'member', user: { id: 1 } } } });
    const greet = await wait(() => sent.filter((m) => /guruhga qo‘shildi/.test(m.text)).length >= 4 && sent.filter((m) => /guruhga qo‘shildi/.test(m.text)));
    const s = await sa.ok('GET', '/api/teambots'); assert(s.config.groupIds.includes(String(GROUP)) && greet.length === 4, `guruh: ${s.config.groupIds}, salom: ${greet.length}`);
    return '4 bot salomlashdi, guruh ruxsat ro‘yxatida';
  });
  await test(3, '/help: umumiy — bitta bot, @bot bilan — o‘sha bot', async () => {
    let before = sent.length; say('/help');
    await wait(() => sent.length > before); await new Promise((r) => setTimeout(r, 900));
    const h1 = sent.slice(before); assert(h1.length === 1 && /Jamoa/.test(h1[0].text), `javoblar: ${h1.length}`);
    before = sent.length; say(`/help@${USER.ombor}`);
    const h2 = await wait(() => sent.slice(before).find((m) => m.bot === 'ombor')); assert(h2 && /Ombor bot/.test(h2.text), 'ombor help');
    return `umumiy /help → 1 javob (${h1[0].bot}); /help@ombor → Ombor bot`;
  });
  await test(4, 'Belgilanmagan savollar to‘g‘ri botga yo‘naltiriladi, oddiy suhbatga javob yo‘q', async () => {
    const cases = [['Qaysi yetkazib berish kechikyapti?', 'taminot'], ['Oyna qancha bor?', 'ombor'], ['Bugun nima ishlab chiqarish kerak?', 'ishlab']];
    const got = [];
    for (const [q, k] of cases) {
      const before = sent.length; const m = say(q);
      const r = await wait(() => sent.slice(before).filter((x) => x.reply_to_message_id === m.message_id)); await new Promise((x) => setTimeout(x, 500));
      const all = sent.slice(before).filter((x) => x.reply_to_message_id === m.message_id);
      assert(all.length === 1 && all[0].bot === k, `“${q}” → ${all.map((x) => x.bot)} (kutilgan ${k})`); got.push(`${k}`);
      void r;
    }
    const before = sent.length; say('Salom hammaga, ishlar yaxshi'); await new Promise((r) => setTimeout(r, 1500));
    assert(!sent.slice(before).some((x) => x.reply_to_message_id), 'oddiy xabarga javob berildi');
    return `ta’minot / ombor / ishlab chiqarish to‘g‘ri; “Salom” → javobsiz (faqat Xulosa uchun yozildi)`;
  });
  await test(5, 'Bot @ bilan belgilansa — o‘zi javob beradi', async () => {
    const before = sent.length; const m = say(`@${USER.ishlab} xomashyo yetadimi?`);
    const r = await wait(() => sent.slice(before).find((x) => x.reply_to_message_id === m.message_id));
    assert(r && r.bot === 'ishlab' && /Xomashyo|xomashyo/.test(plain(r.text)), `javob: ${r?.bot} ${plain(r?.text).slice(0, 80)}`);
    return plain(r.text).split('\n')[0];
  });
  await test(6, 'Ovozli xabar → matn → tegishli bot javobi', async () => {
    const before = sent.length; const m = say('', { extra: { voice: { file_id: 'VOICE1', duration: 3, mime_type: 'audio/ogg' } } });
    const r = await wait(() => sent.slice(before).find((x) => x.reply_to_message_id === m.message_id));
    assert(r && r.bot === 'taminot' && /🎤/.test(r.text) && /kechikyapti/.test(r.text) && sttCalls >= 1, `javob: ${r?.bot} ${plain(r?.text).slice(0, 100)}`);
    return `🎤 “Qaysi yetkazib berish kechikyapti?” → Ta’minot bot`;
  });
  await test(7, 'Saytdagi yangilanishlar 24/7 guruhga (to‘plab) + botlararo suhbat', async () => {
    const before = sent.length;
    const prods = await sa.ok('GET', '/api/products'); const fin = prods.find((p) => p.category === 'FINISHED');
    await sa.ok('POST', '/api/orders', { customerName: 'Bot test mijoz', items: [{ productId: fin.id, qty: 5 }], destination: 'Toshkent' });
    const rm = prods.find((p) => p.category === 'RAW');
    await sa.ok('POST', '/api/purchase-requests', { productId: rm.id, qty: 10, reason: 'Bot test', priority: 'NORMAL' });
    const ev = await wait(() => { const s = sent.slice(before); return s.some((x) => x.bot === 'ishlab' && /yangilanishlar/.test(x.text)) && s.some((x) => x.bot === 'taminot' && /Yangi zayavka/.test(x.text)) && s.some((x) => x.bot === 'ombor' && x.reply_to_message_id) && s; }, 9000);
    assert(ev, `xabarlar: ${sent.slice(before).map((x) => `${x.bot}:${plain(x.text).slice(0, 40)}`).join(' | ')}`);
    const reactMsg = ev.find((x) => x.bot === 'ombor' && x.reply_to_message_id);
    return `Ishlab: yangi buyurtma, Ta’minot: yangi zayavka; Ombor javob qaytardi: “${plain(reactMsg.text).slice(0, 60)}…”`;
  });
  await test(8, 'Ruxsatsiz guruh va begona shaxsiy chat rad etiladi', async () => {
    const before = sent.length;
    say('Qaysi yetkazib berish kechikyapti?', { chat: -100999, from: 5555 });
    say('Salom', { chat: 5555, from: 5555 });
    await wait(() => left.some((l) => l.chat === -100999));
    await new Promise((r) => setTimeout(r, 800));
    const priv = sent.slice(before).filter((x) => String(x.chat_id) === '5555');
    assert(left.some((l) => l.chat === -100999) && !sent.slice(before).some((x) => String(x.chat_id) === '-100999') && priv.every((x) => /Ruxsat yo‘q/.test(x.text)), 'ruxsatsiz javob oldi');
    const before2 = sent.length; say('Oyna qancha bor?', { chat: ADMIN, from: ADMIN });
    const a = await wait(() => sent.slice(before2).find((x) => String(x.chat_id) === String(ADMIN) && !/Ruxsat/.test(x.text)));
    assert(a, 'admin shaxsiy chatda javob olmadi');
    return 'begona guruhdan chiqib ketdi, begona shaxsga “Ruxsat yo‘q”, admin shaxsiy chatda javob oldi';
  });
  await test(9, 'Xulosa boti: 3 ta bot yozgan ma’lumotlar asosida xulosa', async () => {
    const before = sent.length;
    const r = await sa.ok('POST', '/api/teambots/summary');
    const sum = await wait(() => sent.slice(before).find((x) => x.bot === 'xulosa' && /XULOSA/.test(x.text)));
    assert(sum && r.botMessages > 0, `xulosa: ${sent.slice(before).map((x) => x.bot).join(',')} · bot xabarlari ${r.botMessages}`);
    for (const part of ['botlari ma’lumotlari asosida', 'Ta’minotga', 'Omborga', 'Ishlab chiqarishga', 'Yaxshi ketyapti']) assert(plain(sum.text).includes(part), `bo‘lim yo‘q: ${part}`);
    return `xulosa: ${r.botMessages} ta bot xabari + ${r.messages - r.botMessages} ta jamoa xabari tahlil qilindi`;
  });
  await test(10, 'Ertalabki reja va kunlik statistika jadval bo‘yicha', async () => {
    const before = sent.length; const hour = new Date(Date.now() + 300 * 60000).getUTCHours();
    await sa.ok('PUT', '/api/teambots', { morningHour: hour });
    const d = await wait(() => { const s = sent.slice(before).filter((x) => /Ertalabki reja/.test(x.text)); return s.length >= 3 && s; }, 8000);
    assert(d && new Set(d.map((x) => x.bot)).size === 3, `reja: ${sent.slice(before).map((x) => x.bot)}`);
    await new Promise((r) => setTimeout(r, 2500)); const again = sent.slice(before).filter((x) => /Ertalabki reja/.test(x.text)).length;
    assert(again === 3, `takrorlandi: ${again}`);
    return 'Ta’minot, Ombor, Ishlab chiqarish — bir martadan';
  });
  await test(11, 'Admin panel API: token formati tekshiriladi, jurnal mavjud', async () => {
    const bad = await sa.req('PUT', '/api/teambots/token/ombor', { value: 'not-a-token' });
    const s = await sa.ok('GET', '/api/teambots');
    assert(bad.status === 400 && s.messages.length > 10 && s.groups.length >= 1, `${bad.status} ${s.messages.length}`);
    return `noto‘g‘ri token → 400; jurnal ${s.messages.length} xabar; router: ${s.router}`;
  });

  await test(12, '“Bugun omborga qancha mahsulot keldi?” → Ombor javob beradi, keyin Ta’minot qo‘shadi', async () => {
    const prods = await sa.ok('GET', '/api/products');
    await sa.ok('POST', '/api/receiving', { source: 'OTHER', productId: prods[0].id, qty: 7 });
    await sa.ok('POST', '/api/receiving', { source: 'OTHER', productId: prods[1].id, qty: 3 });
    const before = sent.length; const m = say('Bugun omborga qancha mahsulot keldi?');
    const a = await wait(() => sent.slice(before).find((x) => x.reply_to_message_id === m.message_id));
    assert(a && a.bot === 'ombor' && /Bugun omborga kelgan/.test(plain(a.text)) && /2 ta kirim/.test(plain(a.text)), `ombor: ${a?.bot} ${plain(a?.text).slice(0, 120)}`);
    const f2 = await wait(() => sent.slice(before).find((x) => x.reply_to_message_id === a.message_id));
    assert(f2 && f2.bot === 'taminot' && /Ta’minot/.test(plain(f2.text)), `ta’minot: ${f2?.bot}`);
    return `Ombor: “${plain(a.text).split('\n')[0]}” → Ta’minot: “${plain(f2.text).split('\n')[0].slice(0, 70)}…”`;
  });
  await test(13, 'Har soatda: Ta’minot, Ombor, Ishlab chiqarish hisobot yozadi, keyin Xulosa', async () => {
    const before = sent.length;
    await sa.ok('PUT', '/api/teambots', { hourly: true, workStart: 0, workEnd: 24 });
    const got = await wait(() => { const s2 = sent.slice(before); const hr = s2.filter((x) => /soatlik hisobot/.test(x.text)); const sm = s2.find((x) => x.bot === 'xulosa' && /XULOSA/.test(x.text)); return hr.length >= 3 && sm && { hr, sm, s2 }; }, 9000);
    assert(got && new Set(got.hr.map((x) => x.bot)).size === 3, `soatlik: ${sent.slice(before).map((x) => x.bot).join(',')}`);
    assert(got.s2.indexOf(got.sm) > Math.max(...got.hr.map((x) => got.s2.indexOf(x))), 'Xulosa botlardan oldin yozdi');
    assert(/botlar xabarlari ([3-9]|\d\d)/.test(plain(got.sm.text)), `xulosa manbasi: ${plain(got.sm.text).slice(-80)}`);
    await new Promise((r) => setTimeout(r, 2500));
    assert(sent.slice(before).filter((x) => /soatlik hisobot/.test(x.text)).length === 3, 'bir soatda takrorlandi');
    return `${got.hr.map((x) => x.bot).join(' → ')} → xulosa (${/botlar xabarlari (\d+)/.exec(plain(got.sm.text))[1]} ta bot xabari asosida); shu soatda takrorlanmadi`;
  });
  await test(14, 'Claude (Anthropic) API kaliti: javob, qo‘shimcha va xulosa AI orqali', async () => {
    await sa.ok('PUT', '/api/keys/AI_API_KEY', { value: 'sk-ant-test-key-0000000000' });
    const s0 = await sa.ok('GET', '/api/teambots'); assert(s0.ai.configured && s0.ai.provider === 'anthropic', `provayder: ${s0.ai.provider}`);
    const before = sent.length; const m = say('Bugun omborga qancha mahsulot keldi?');
    const a = await wait(() => sent.slice(before).find((x) => x.reply_to_message_id === m.message_id));
    const f2 = a && await wait(() => sent.slice(before).find((x) => x.reply_to_message_id === a.message_id));
    assert(a && /Claude \(Ombor\)/.test(a.text) && f2 && /Claude \(Ta’minot\)/.test(f2.text), `${plain(a?.text)} | ${plain(f2?.text)}`);
    const b2 = sent.length; await sa.ok('POST', '/api/teambots/summary');
    const sm = await wait(() => sent.slice(b2).find((x) => x.bot === 'xulosa'));
    assert(sm && /Claude \(Xulosa\)/.test(sm.text) && /3 ta bot/.test(sm.text), plain(sm?.text).slice(0, 120));
    return `model: ${s0.ai.model}; Ombor → Ta’minot → Xulosa javoblari Claude orqali (${claudeCalls} ta so‘rov)`;
  });

  server.kill(); tgMock.close(); gemMock.close(); claudeMock.close();
  const ok = results.filter(Boolean).length;
  console.log(`\nNATIJA: ${ok}/${results.length} jamoa boti testi o‘tdi · yuborilgan xabarlar: ${sent.length}\n`);
  if (ok !== results.length) console.log(log.slice(-3000));
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.error(e); server?.kill(); process.exit(1); });
