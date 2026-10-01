'use strict';
// Telegram bot end-to-end test against a local mock of the Telegram Bot API.
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TOKEN = 'TEST:TOKEN';
const sent = []; const updates = []; const answers = []; const edits = []; let upd = 1; let msgId = 100;
const mock = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const p = body ? JSON.parse(body) : {}; const method = req.url.split('/').pop();
    const ok = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); };
    if (!req.url.startsWith(`/bot${TOKEN}/`)) { res.writeHead(401); return res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' })); }
    if (method === 'getMe') return ok({ id: 1, is_bot: true, first_name: 'Solar WMS', username: 'solar_wms_test_bot' });
    if (method === 'getUpdates') {
      const t0 = Date.now();
      while (Date.now() - t0 < (p.timeout || 0) * 1000 && !updates.some((u) => u.update_id >= (p.offset || 0))) await new Promise((r) => setTimeout(r, 50));
      return ok(updates.filter((u) => u.update_id >= (p.offset || 0)));
    }
    if (method === 'sendMessage') { const m = { ...p, message_id: ++msgId, at: Date.now() }; sent.push(m); return ok({ message_id: m.message_id, chat: { id: p.chat_id }, text: p.text }); }
    if (method === 'answerCallbackQuery') { answers.push(p); return ok(true); }
    if (method === 'editMessageText' || method === 'editMessageReplyMarkup') { edits.push({ method, ...p }); return ok(true); }
    return ok(true);
  });
});

const CHAT = { menejer: 1001, taminot: 1002, omborchi1: 1003, direktor: 1004 };
const pushText = (chatId, text, username = 'user') => updates.push({ update_id: upd++, message: { message_id: ++msgId, chat: { id: chatId, type: 'private', first_name: username }, from: { id: chatId, first_name: username, username }, text } });
const pushCallback = (chatId, data, message) => updates.push({ update_id: upd++, callback_query: { id: `cb${upd}`, from: { id: chatId }, data, message: { message_id: message.message_id, chat: { id: chatId, type: 'private' }, text: message.text } } });
const waitMsg = async (pred, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = sent.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 60)); } return null; };
const btns = (m) => (m?.reply_markup?.inline_keyboard || []).flat();

let BASE; let server;
class Client {
  async login(u) { const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'Solar2026!' }) }); this.cookie = r.headers.get('set-cookie').split(';')[0]; this.csrf = (await r.json()).csrf; return this; }
  async req(method, url, body) { const r = await fetch(BASE + url, { method, headers: { cookie: this.cookie, 'content-type': 'application/json', 'x-csrf-token': this.csrf }, body: body ? JSON.stringify(body) : undefined }); const d = await r.json(); if (!r.ok) throw new Error(`${url}: ${d.error}`); return d; }
  get(u) { return this.req('GET', u); } post(u, b) { return this.req('POST', u, b || {}); }
}
const results = [];
async function test(n, title, fn) { try { const d = await fn(); results.push(true); console.log(`  ✅ BOT ${n}: ${title} — ${d}`); } catch (e) { results.push(false); console.log(`  ❌ BOT ${n}: ${title} — ${e.message}`); } }
const assert = (c, m) => { if (!c) throw new Error(m); };
const plain = (t) => String(t || '').replace(/<[^>]+>/g, '').replace(/\n/g, ' ⏎ ');

(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockUrl = `http://127.0.0.1:${mock.address().port}`;
  const PORT = 4800 + Math.floor(Math.random() * 400); BASE = `http://127.0.0.1:${PORT}`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-bot-'));
  server = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'server.js')], { env: { ...process.env, WMS_NO_DOTENV: '1', LOGISTICS_MODULE: '1', PORT: String(PORT), DATA_DIR: DATA, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_API_BASE: mockUrl, BOT_POLL_TIMEOUT: '1', BOT_BATCH_SECONDS: '1', BOT_SUPERVISE_SECONDS: '2', BOT_ESCALATE_MINUTES: '0', AI_SCAN_SECONDS: '3600', BACKUP_DAILY: '0', ANTHROPIC_API_KEY: '', AI_API_KEY: '', GEMINI_API_KEY: '', SEED: 'demo', SUPERADMIN_LOGIN: '', SUPERADMIN_PASSWORD: '', DISPATCH_CYCLE_SECONDS: '3600', BOT_MORNING_HOUR: '99', BOT_EVENING_HOUR: '99' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  console.log('\nSolar Factory WMS — TELEGRAM BOT TEST (mock Telegram API)\n');
  const web = {}; for (const u of Object.keys(CHAT)) web[u] = await new Client().login(u);

  await test(1, 'Ulanmagan foydalanuvchi /start', async () => {
    pushText(9999, '/start'); const m = await waitMsg((x) => x.chat_id === '9999'); assert(m && /Sozlamalar → Telegram bot/.test(m.text), 'yo‘riqnoma kelmadi');
    pushText(9999, 'Omborda nima bor?'); const m2 = await waitMsg((x) => x.chat_id === '9999' && x !== m); assert(m2 && /Avval hisobingizni ulang/.test(m2.text), 'ulanmaganlarga ma’lumot berildi');
    return 'yo‘riqnoma ko‘rsatildi, ulanmagan chatga ma’lumot berilmadi';
  });
  await test(2, 'Web orqali kod olish va ulash (4 xodim)', async () => {
    for (const [u, chat] of Object.entries(CHAT)) {
      const c = await web[u].post('/api/bot/link-code'); assert(/^\d{6}$/.test(c.code) && c.deepLink.includes('solar_wms_test_bot'), 'kod/deeplink noto‘g‘ri');
      pushText(chat, `/start ${c.code}`, u); const m = await waitMsg((x) => x.chat_id === String(chat) && /Ulandi/.test(x.text)); assert(m, `${u} ulanmadi`);
    }
    const st = await web.direktor.get('/api/bot/status'); assert(st.all.length === 4, `ulangan: ${st.all.length}`);
    pushText(5555, '/start 000000'); const bad = await waitMsg((x) => x.chat_id === '5555'); assert(/Kod noto‘g‘ri/.test(bad.text), 'noto‘g‘ri kod qabul qilindi');
    return `4 ta chat ulandi (deep link t.me/solar_wms_test_bot?start=KOD), noto‘g‘ri kod rad etildi`;
  });
  await test(3, 'Ombor harakati → rolga mos xabar (to‘plam)', async () => {
    const n0 = sent.length;
    const glass = (await web.menejer.get('/api/inventory?q=RM-GLASS-32'))[0];
    await web.omborchi1.post('/api/inventory/issue', { productId: glass.product_id, qty: 12, reason: 'Ishlab chiqarishga berildi', reference: 'BOT-TEST-1' });
    const m = await waitMsg((x) => sent.indexOf(x) >= n0 && x.chat_id === String(CHAT.menejer) && /Ombor harakatlari/.test(x.text) && /RM-GLASS-32/.test(x.text));
    assert(m, 'menejerga ombor xabari kelmadi');
    await new Promise((r) => setTimeout(r, 400));
    assert(!sent.some((x) => sent.indexOf(x) >= n0 && x.chat_id === String(CHAT.taminot) && /Ombor harakatlari/.test(x.text)), 'ta’minotchiga keraksiz ombor xabari ketdi');
    return plain(m.text).slice(0, 150);
  });
  let pr1;
  await test(4, 'Yangi zayavka → tasdiqlash tugmasi → botdan tasdiqlash', async () => {
    const eva = (await web.menejer.get('/api/inventory?q=RM-EVA-045'))[0];
    pr1 = await web.menejer.post('/api/purchase-requests', { productId: eva.product_id, qty: 3000, reason: 'Bot test zayavka' });
    const mt = await waitMsg((x) => x.chat_id === String(CHAT.taminot) && x.text.includes(pr1.prNo) && /Yangi ta’minot zayavkasi/.test(x.text));
    const mm = await waitMsg((x) => x.chat_id === String(CHAT.menejer) && x.text.includes(pr1.prNo) && /Yangi ta’minot zayavkasi/.test(x.text));
    assert(mt && btns(mt).some((b) => b.callback_data === `pr:ok:${pr1.id}`), 'ta’minotchida tasdiqlash tugmasi yo‘q');
    assert(mm && !btns(mm).some((b) => b.callback_data?.startsWith('pr:ok')), 'yaratgan menejerga tasdiqlash tugmasi berildi (4 ko‘z)');
    pushCallback(CHAT.taminot, `pr:ok:${pr1.id}`, mt);
    const t0 = Date.now(); let st; while (Date.now() - t0 < 5000) { st = (await web.menejer.get(`/api/purchase-requests/${pr1.id}`)).request.status; if (st === 'APPROVED') break; await new Promise((r) => setTimeout(r, 100)); }
    assert(st === 'APPROVED', `holat ${st}`);
    const e0 = Date.now(); while (Date.now() - e0 < 4000 && !edits.some((x) => x.method === 'editMessageText' && /Tasdiqlandi/.test(x.text))) await new Promise((r) => setTimeout(r, 60));
    assert(edits.some((x) => x.method === 'editMessageText' && /Tasdiqlandi/.test(x.text)), 'xabar yangilanmadi');
    const audit = await web.direktor.get('/api/audit?q=PR_APPROVED'); assert(audit.some((a) => a.username === 'taminot'), 'audit yozilmadi');
    return `${pr1.prNo}: ta’minotchi Telegram tugmasi bilan tasdiqladi → APPROVED (audit: taminot)`;
  });
  await test(5, 'Rad etish — sabab so‘raladi', async () => {
    const eva = (await web.menejer.get('/api/inventory?q=RM-EVA-045'))[0];
    const pr2 = await web.menejer.post('/api/purchase-requests', { productId: eva.product_id, qty: 10, reason: 'Bot rad test' });
    const mt = await waitMsg((x) => x.chat_id === String(CHAT.taminot) && x.text.includes(pr2.prNo));
    pushCallback(CHAT.taminot, `pr:no:${pr2.id}`, mt);
    assert(await waitMsg((x) => x.chat_id === String(CHAT.taminot) && /sababini yozing/.test(x.text)), 'sabab so‘ralmadi');
    pushText(CHAT.taminot, 'Narx kelishilmagan');
    const t0 = Date.now(); let st; while (Date.now() - t0 < 5000) { st = (await web.menejer.get(`/api/purchase-requests/${pr2.id}`)).request.status; if (st === 'REJECTED') break; await new Promise((r) => setTimeout(r, 100)); }
    assert(st === 'REJECTED', `holat ${st}`);
    return `${pr2.prNo} → REJECTED, sabab: "Narx kelishilmagan"`;
  });
  await test(6, 'RBAC: omborchi tasdiqlash tugmasini soxtalashtirsa', async () => {
    const eva = (await web.menejer.get('/api/inventory?q=RM-EVA-045'))[0];
    const pr3 = await web.menejer.post('/api/purchase-requests', { productId: eva.product_id, qty: 5, reason: 'RBAC test' });
    const fake = { message_id: 1, text: 'x' };
    pushCallback(CHAT.omborchi1, `pr:ok:${pr3.id}`, fake);
    const t0 = Date.now(); while (Date.now() - t0 < 4000 && !answers.some((a) => /Ruxsat yo‘q/.test(a.text))) await new Promise((r) => setTimeout(r, 80));
    const st = (await web.menejer.get(`/api/purchase-requests/${pr3.id}`)).request.status;
    assert(st === 'REQUESTED' && answers.some((a) => /Ruxsat yo‘q/.test(a.text)), `holat ${st}`);
    return 'omborchining soxta “tasdiqlash” so‘rovi rad etildi (❌ Ruxsat yo‘q), zayavka REQUESTED qoldi';
  });
  await test(7, 'Yetishmovchilik → “AI zayavka yaratish” tugmasi', async () => {
    const p = (await web.menejer.get('/api/inventory?q=SP-410W-BL'))[0];
    const o = await web.menejer.post('/api/orders', { customerName: 'Bot Test MChJ', items: [{ productId: p.product_id, qty: p.free + 45 }], dueDate: new Date(Date.now() + 86400000).toISOString() });
    const m = await waitMsg((x) => x.chat_id === String(CHAT.taminot) && /YETISHMOVCHILIK/.test(x.text) && x.text.includes(o.orderNo));
    const b = btns(m).find((x) => x.callback_data?.startsWith('sh:pr:')); assert(b, 'AI zayavka tugmasi yo‘q');
    pushCallback(CHAT.taminot, b.callback_data, m);
    const t0 = Date.now(); let pr; while (Date.now() - t0 < 5000) { pr = (await web.menejer.get('/api/purchase-requests?open=1')).find((x) => x.order_id === o.id); if (pr) break; await new Promise((r) => setTimeout(r, 100)); }
    assert(pr && pr.ai_generated && pr.qty === 45 && pr.status === 'REQUESTED', 'AI zayavka yaratilmadi');
    return `${o.orderNo}: 45 dona yetishmaydi → tugma → ${pr.pr_no} (AI, ${pr.supplier}, REQUESTED — inson tasdig‘i kutilmoqda)`;
  });
  await test(8, 'Shaxsiy topshiriq faqat ijrochiga', async () => {
    const p = (await web.menejer.get('/api/inventory?q=SP-450W-M'))[0];
    const o = await web.menejer.post('/api/orders', { customerName: 'Bot Pick MChJ', items: [{ productId: p.product_id, qty: 5 }] });
    const n0 = sent.length;
    const t = await web.menejer.post('/api/picking', { orderId: o.id, assignedTo: 4 });
    const m = await waitMsg((x) => sent.indexOf(x) >= n0 && x.chat_id === String(CHAT.omborchi1) && x.text.includes(t.taskNo));
    assert(m && /Sizga yangi topshiriq/.test(m.text), 'omborchiga topshiriq kelmadi');
    await new Promise((r) => setTimeout(r, 300));
    assert(!sent.some((x) => sent.indexOf(x) >= n0 && x.chat_id === String(CHAT.taminot) && x.text.includes(t.taskNo)), 'begona xodimga ketdi');
    return plain(m.text);
  });
  await test(9, 'AI savol-javob (erkin matn)', async () => {
    const n0 = sent.length;
    pushText(CHAT.direktor, 'Omborda nima yetishmayapti?');
    const m = await waitMsg((x) => sent.indexOf(x) >= n0 && x.chat_id === String(CHAT.direktor) && /Manba/.test(x.text));
    assert(m && /Yetishmovchilik/.test(m.text), 'AI javob bermadi');
    pushText(CHAT.direktor, 'Qaysi supplier kechikyapti?');
    const m2 = await waitMsg((x) => sent.indexOf(x) > sent.indexOf(m) && x.chat_id === String(CHAT.direktor) && /Manba/.test(x.text));
    assert(m2 && /kechik/i.test(m2.text), 'supplier savoliga javob yo‘q');
    return plain(m.text).slice(0, 160);
  });
  await test(10, 'Buyruqlar: /holat, /ombor, /zayavkalar, /jonatmalar, /vazifalar', async () => {
    const n0 = sent.length;
    for (const c of ['/holat', '/ombor SP-550W-M', '/zayavkalar', '/jonatmalar', '/alertlar']) pushText(CHAT.direktor, c);
    pushText(CHAT.omborchi1, '/vazifalar');
    const h = await waitMsg((x) => sent.indexOf(x) >= n0 && x.chat_id === String(CHAT.direktor) && /AI holat hisoboti/.test(x.text));
    const s = await waitMsg((x) => sent.indexOf(x) >= n0 && x.chat_id === String(CHAT.direktor) && /Qoldiq/.test(x.text) && /SP-550W-M/.test(x.text));
    const z = await waitMsg((x) => sent.indexOf(x) >= n0 && x.chat_id === String(CHAT.direktor) && /^🧾/.test(x.text) && btns(x).some((b) => b.callback_data?.startsWith('pr:ok')));
    const j = await waitMsg((x) => sent.indexOf(x) >= n0 && x.chat_id === String(CHAT.direktor) && /Faol jo‘natmalar/.test(x.text));
    const v = await waitMsg((x) => sent.indexOf(x) >= n0 && x.chat_id === String(CHAT.omborchi1) && /Topshiriqlaringiz/.test(x.text));
    assert(h && s && z && j && v, `holat:${!!h} ombor:${!!s} zayavka:${!!z} jo‘natma:${!!j} vazifa:${!!v}`);
    return plain(h.text).slice(0, 170);
  });
  await test(11, 'AI nazorati: kritik muammo eskalatsiyasi', async () => {
    const m = await waitMsg((x) => x.chat_id === String(CHAT.direktor) && /ESKALATSIYA/.test(x.text), 8000);
    assert(m && btns(m).some((b) => b.callback_data?.startsWith('al:ack:')), 'eskalatsiya kelmadi');
    assert(!sent.some((x) => x.chat_id === String(CHAT.omborchi1) && /ESKALATSIYA/.test(x.text)), 'omborchiga eskalatsiya ketdi');
    const id = Number(btns(m).find((b) => b.callback_data?.startsWith('al:ack:')).callback_data.split(':')[2]);
    pushCallback(CHAT.direktor, `al:ack:${id}`, m);
    const t0 = Date.now(); let a; while (Date.now() - t0 < 4000) { a = (await web.direktor.get('/api/ai/alerts?status=ACK')).find((x) => x.id === id); if (a) break; await new Promise((r) => setTimeout(r, 100)); }
    assert(a, 'Ko‘rildi belgilanmadi');
    return `${plain(m.text).slice(0, 120)}… → “Ko‘rildi” tugmasi ishladi`;
  });
  await test(12, 'Xabar sozlamalari (/sozlamalar tugmalari)', async () => {
    const n0 = sent.length;
    pushText(CHAT.taminot, '/sozlamalar');
    const m = await waitMsg((x) => sent.indexOf(x) >= n0 && x.chat_id === String(CHAT.taminot) && /Qaysi xabarlar kelsin/.test(x.text));
    pushCallback(CHAT.taminot, 'set:cat:ombor', m);
    const t0 = Date.now(); let st; while (Date.now() - t0 < 4000) { st = await web.taminot.get('/api/bot/status'); if (st.mine[0].prefs.cats.includes('ombor')) break; await new Promise((r) => setTimeout(r, 100)); }
    assert(st.mine[0].prefs.cats.includes('ombor'), 'kategoriya yoqilmadi');
    return `ta’minotchi “Ombor” kategoriyasini yoqdi → ${st.mine[0].prefs.cats.join(', ')}`;
  });
  await test(13, 'AI brifing + web test xabar + /unlink', async () => {
    const n0 = sent.length;
    await web.menejer.post('/api/bot/briefing');
    const b = await waitMsg((x) => sent.indexOf(x) >= n0 && /AI holat hisoboti/.test(x.text) && x.chat_id === String(CHAT.direktor));
    await web.direktor.post('/api/bot/test');
    const t = await waitMsg((x) => sent.indexOf(x) >= n0 && /Test xabar/.test(x.text) && x.chat_id === String(CHAT.direktor));
    pushText(CHAT.omborchi1, '/unlink'); await waitMsg((x) => x.chat_id === String(CHAT.omborchi1) && /uzildi/.test(x.text));
    const st = await web.direktor.get('/api/bot/status');
    assert(b && t && st.all.length === 3, `brifing:${!!b} test:${!!t} chatlar:${st.all.length}`);
    const logs = await web.direktor.get('/api/bot/messages?limit=1000');
    return `brifing obunachilarga ketdi, test xabar keldi, omborchi uzildi (3 chat qoldi); jurnal: ${logs.length} yozuv, ${logs.filter((l) => l.status === 'FAILED').length} xato`;
  });

  const ok = results.filter(Boolean).length;
  console.log(`\nNATIJA: ${ok}/${results.length} bot testi o‘tdi · jami yuborilgan xabar: ${sent.length}\n`);
  if (ok !== results.length) console.log(log.split('\n').filter((l) => /error|xato/i.test(l)).slice(-15).join('\n'));
  server.kill(); mock.close(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.error(e); if (server) server.kill(); process.exit(1); });
