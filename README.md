# SOLAR FACTORY AI — Ombor + Ta'minot + Yig'ish + Logistika + XETQ (WMS)

Quyosh paneli zavodi uchun real vaqtda ishlaydigan Warehouse Management System: backend business-logic, SQLite database, REST API, SSE real-time, RBAC, audit, AI nazorati, AI dispetcher, Telegram bot va professional web interfeys.

## Ishga tushirish (real rejim)

> **Joylash:** Vercel — [VERCEL.md](VERCEL.md) (Neon Postgres bilan, serverless); hostx.uz / ISPmanager yoki VPS — [HOSTING.md](HOSTING.md).

Talab: **Node.js 22.5+** (tavsiya 24). Tashqi npm paketlari yo'q — `npm install` shart emas.

1. `.env.example` ni `.env` nomi bilan nusxalang va super admin ma'lumotlarini yozing:
   ```
   SUPERADMIN_LOGIN="Ism Familiya"
   SUPERADMIN_PASSWORD="..."
   ```
   (Bo'sh qoldirilsa — birinchi ochilishda saytning o'zi "Super admin yaratish" sahifasini ko'rsatadi.)
2. `npm start` (Windows: `start.bat`) → brauzerda http://localhost:3000
3. Super admin bilan kiring → **Sozlamalar → API kalitlari va integratsiya**:
   - **AI API kaliti** (Google Gemini `AIza…`/`AQ.…` yoki Anthropic `sk-ant-…`) → "Ulanishni tekshirish";
   - **Telegram bot tokeni** (@BotFather) — saqlanishi bilan bot ulanadi;
   - **Kompaniya tizimi**: API manzili + kalit → ombor qoldig'i, buyurtmalar, transport, haydovchilar har N soniyada tortiladi; yoki kompaniya tizimi `/api/ext/v1/*` ga o'zi yuboradi (kiruvchi kalit shu yerda yaratiladi).
4. **Foydalanuvchilar va adminlar** — super admin adminlarni qo'shadi, adminlar xodimlarni qo'shadi.
5. **Haydovchilar** → "Telegram kodi" — haydovchi botga ulanadi, AI dispetcher unga yuk takliflarini yuboradi.

Birinchi ishga tushishda faqat ombor tuzilmasi (WH-01…WH-06, zonalar, lokatsiyalar — saytda o'zgartiriladi) va super admin yaratiladi; mahsulot, buyurtma, transport ma'lumotlari kompaniya tizimidan yoki qo'lda kiritiladi.

```bash
npm run test:all   # 39 ta avtomatik test: 15 qabul + 13 Telegram bot + 11 real rejim (alohida vaqtinchalik bazalarda)
npm run reset      # bazani o'chiradi — keyingi start qayta yaratadi
```
`SEED=demo` bilan ishga tushirilsa, sinov uchun 3 haftalik namunaviy ma'lumotlar yaratiladi (testlar shu rejimda ishlaydi).

## AI dispetcher va kunlik hisobotlar

- Buyurtma qadoqlanishi bilan AI mos transportni (og'irlik / hajm / pallet / balandlik) va bo'sh haydovchini tanlaydi, jo'natma va yuklash topshirig'ini yaratadi, haydovchiga Telegramda "✅ Qabul qilaman / ❌ Qila olmayman" taklifini yuboradi, logist va adminlarga xabar beradi. Rad etilsa yoki javob kelmasa — keyingi transport/haydovchi tanlanadi. Haydovchi "🚛 Yo'lga chiqdim" (yoki logist "Yuk chiqdi") bosganda yuk ombordan chiqariladi (SHIP tranzaksiyasi). "Avtomatik" rejimda qabul qilingan yuk jo'nash vaqtida o'zi chiqariladi.
- **08:00** — omborda qancha yuk bor, bugun qaysi yuk soat nechida, qaysi transport bilan chiqishi kerak; **22:00** — bugun qancha yuk chiqdi, qancha qoldi, rejadan nima qoldi. Hisobotlar super admin / admin / direktorga Telegramga yuboriladi va saytda **Kunlik AI hisobotlari** bo'limida saqlanadi (soatlar Sozlamalarda).

## Arxitektura

```
Brauzer (SPA, vanilla JS)  ──REST + CSRF──▶  server/server.js (HTTP/HTTPS, sessiya, RBAC, rate limit, SSE)
        ▲                                           │
        └──────── SSE /api/events/stream ◀── event bus ◀── db.tx() commit
                                                    ▼
   inventory.js · orders.js · procurement.js · logistics.js · documents.js · xetq.js · ai.js · reports.js
                                                    ▼
                                    SQLite (node:sqlite, WAL) — data/wms.db
                                                    ▼
                         AI Service (ai.js) ──(ixtiyoriy, server-side kalit)──▶ Anthropic API
```

- **Stock hech qachon qo'lda o'zgartirilmaydi.** Yagona yo'l — `inventory.move()`: har bir o'zgarish `inventory_transactions` jadvaliga yoziladi (RECEIVE, ISSUE, TRANSFER, RESERVE, RELEASE, ADJUSTMENT, RETURN, REJECT, SCRAP, REWORK, PACK, UNPACK, SHIP). Tranzaksiyalar va audit log DB triggerlari bilan o'zgartirish/o'chirishdan himoyalangan. `qty >= 0` CHECK — manfiy qoldiq imkonsiz.
- Qoldiq `mahsulot × lokatsiya × partiya × holat` (RECEIVING, AVAILABLE, QUARANTINE, REWORK, SCRAP, PICKED, PACKED, LOADED) kesimida; serial raqamlar har bir harakatda avtomatik kuzatiladi.
- `Available / Reserved / Free`: Free = Available − faol rezervlar. Yetishmovchilik = kerakli − (buyurtma rezervi + erkin qoldiq); yangi stock kelganda (QC PASS) ustuvorlik/muddat bo'yicha avtomatik rezerv va shortage yopiladi.
- Eventlar tranzaksiya COMMIT bo'lgandan keyingina SSE orqali yuboriladi (STOCK_CHANGED, ORDER_CREATED, ORDER_RESERVED, SHORTAGE_DETECTED, SUPPLIER_REQUEST_CREATED, DELIVERY_DELAYED, MATERIAL_RECEIVED, QC_FAILED, PICKING_STARTED/COMPLETED, PACKING_COMPLETED, LOADING_STARTED/COMPLETED, SHIPMENT_DISPATCHED/ARRIVED, DOCUMENT_SUBMITTED/APPROVED …). Uzilishdan keyin `Last-Event-ID` bilan qayta yuboriladi.

## Modullar

Ombor dashboard · Direktor paneli · Kirim (supplier / ishlab chiqarish Good-Rework-Reject / qaytarish) va QC (FAIL → brak) · Chiqim · Mahsulot kartochkasi (o'lcham, og'irlik, pallet, QR/barcode) · WH→Zona→Rack→Shelf→Position lokatsiyalar va ombor xaritasi · Rezerv (buyurtma va loyiha) · Ko'chirish · Inventarizatsiya (System/Physical/Difference → ADJUSTMENT, sabab majburiy) · Brak/rework · QR/Barcode (kamera + USB skaner) · Traceability · Buyurtmalar ("Yangi yig'ish" jonli stock tekshiruvi) · Picking (AI marshrut, ✅/❌ skan) · Packing/pallet (gross = soni × og'irlik + pallet + qadoq) · Yetishmovchilik → AI zayavka loyihasi (inson tasdiqlaydi, 4-ko'z tamoyili) · Zayavka workflow REQUESTED→…→RECEIVED · Supplier performance · Yetkazib berish kechikish alerti · Transport hisoblash (og'irlik/hajm/pallet/balandlik/LDM, stack) · Shipment + yuklash ketma-ketligi va noto'g'ri kombinatsiya ogohlantirishi · Dispatch (hujjatlarsiz va XETQ talab qilinsa kelishuvsiz bloklanadi) · Logistika hujjatlari (admin tahrirlaydigan shablonlar) · Texnik shartlar versiyalari (eski — ARCHIVED) · Hujjat nazorati (SHA-256 butunlik) · XETQ workflow (REVISION_REQUIRED: nima, kim, deadline, yangi versiya) · AI alertlar, prognoz (faqat tavsiya), sig'im/joy optimizatsiyasi, cycle count, root cause, direktor savol-javob · 16 ta hisobot (CSV/print) · Xodim KPI · Foydalanuvchilar/ruxsatlar matritsasi · Audit · Backup.

## AI

AI xulosalari **faqat database faktlaridan** hisoblanadi (ogohlantirishlar, prognoz, root cause, "Ertangi jo'natmaga yetadimi?" va h.k.). API kalitlari bo'limida AI kaliti (Gemini yoki Anthropic) berilsa, javoblar va hisobot xulosalarini LLM shu faktlar asosida ifodalaydi; kalit serverda shifrlangan, frontendga yuborilmaydi. AI hech qachon xarid/zayavkani o'zi yubormaydi — faqat loyiha tayyorlaydi.

## Telegram bot (AI nazorati)

1. Telegramda **@BotFather** → `/newbot` → token oling.
2. `.env.example` ni `.env` ga nusxalang va `TELEGRAM_BOT_TOKEN=...` yozing (ixtiyoriy: `WMS_BASE_URL=https://wms.korxona.uz` — xabarlarda saytga havola).
3. `npm start` → saytda **Sozlamalar → Telegram bot** → **Kod olish** → QR / "Telegramda ochish" yoki botga `/start KOD`.

Har bir xodim o‘z hisobi bilan ulanadi; bot uning **rolini va ruxsatlarini** hisobga oladi.

- **Xabarlar:** ombor harakatlari (20 soniyalik to‘plamlarda), kirim/QC, buyurtma, picking/packing, yetishmovchilik, zayavkalar, supplier kechikishi, transport/yuklash/jo‘natma, XETQ/hujjatlar, AI ogohlantirishlar. Shaxsiy topshiriqlar faqat ijrochiga boradi. Har kim `/sozlamalar` yoki saytda qaysi toifalar kelishini tanlaydi.
- **Botdan amallar:** zayavkani ✅ tasdiqlash / ❌ rad etish (sabab bilan, 4-ko‘z tamoyili saqlanadi), yetishmovchilikdan 🤖 AI zayavka loyihasi yaratish, alertni 👁 "Ko‘rildi" qilish. Hammasi RBAC va audit orqali o‘tadi.
- **AI nazorati:** ertalabki brifing (08:00) va kechki hisobot (18:00). 🔴 kritik muammo 30 daqiqa ichida "Ko‘rildi" qilinmasa, direktor va menejerga eskalatsiya yuboriladi. Istalgan savolga ("Ertangi jo‘natmaga yetadimi?") database asosida javob beradi.
- **Buyruqlar:** `/holat /brifing /hisobot /ombor [SKU] /yetishmovchilik /zayavkalar /jonatmalar /alertlar /vazifalar /sozlamalar /unlink /help`.

```bash
npm run test:bot   # soxta Telegram API bilan 13 ta end-to-end test
```

## Xavfsizlik

scrypt parol xeshi + 5 xatoda 15 daqiqa blok · HttpOnly/SameSite=Strict sessiya (DBda xeshlangan token) · CSRF token + Origin tekshiruvi · RBAC har bir API marshrutda · kiritish validatsiyasi · rate limiting · CSP, HSTS, X-Frame-Options, nosniff · yuklangan fayllar turi/hajmi cheklangan, sandbox'da ko'rsatiladi · shablonlarda skript taqiqlangan · kunlik avtomatik backup (`VACUUM INTO`). Ishlab chiqarishda HTTPS: `TLS_CERT/TLS_KEY` yoki proksi ortida `BEHIND_HTTPS=1`.

## Boshqa noutbukka ko‘chirish
1. Eski kompyuterda: **Sozlamalar → Boshqa kompyuterga ko‘chirish → Eksport**. Parol bering, `.sfwms` fayl yuklanadi (barcha ma’lumot, hujjat fayllari, API kalitlari — parol bilan shifrlangan).
2. Yangi kompyuterda dasturni o‘rnating (`start.bat`), vaqtinchalik super admin bilan kiring.
3. **Sozlamalar → Import**: faylni va parolni tanlang → “Tekshirish” → “Import qilish”.
4. Keyin eski kompyuterdagi login/parol bilan kiring. Import oldidan joriy baza `data/backups/pre-import-*.db` ga saqlanadi.

## Fayl xavfsizligi (viruslar)
- Faqat PDF, PNG, JPG, WEBP, DOCX, XLSX, CSV, TXT, DWG qabul qilinadi; fayl ichidagi haqiqiy format kengaytmaga mos bo‘lishi shart.
- Dastur fayllari (.exe, skriptlar, ELF/Mach-O), ikki kengaytmali nomlar, makrosli Office va ichida skript/ichki fayl bo‘lgan PDF rad etiladi.
- Har bir fayl Windows Defender (Windows) yoki ClamAV (Linux) bilan skanerlanadi (`ANTIVIRUS=auto|required|off`).
- Import paketidagi har bir fayl ham xuddi shunday tekshiriladi; begona trigger/view bo‘lgan baza qabul qilinmaydi.

## Odoo ERP ulash (API kalit)
1. Odoo → Sozlamalar → Foydalanuvchilar → (API uchun foydalanuvchi) → *Account Security* → **New API Key**.
2. Saytda super admin: **Sozlamalar → API kalitlari va Odoo** → Odoo manzili, baza nomi, login, API kalit → “Ulanishni tekshirish” → “Saqlash”.
3. Har N daqiqada (standart 15) avtomatik tortiladi, “Hozir sinxronlash” tugmasi ham bor:
   - **Ombor** — mahsulotlar (SKU = Internal Reference), qoldiq (Odoo qoldig‘i asosiy manba), minimal qoldiq (reordering rules);
   - **Ta’minot** — yetkazib beruvchilar, RFQ/PO va qatorlari, kechikkan buyurtmalar → AI ogohlantirish (menyu: Ta’minot → Odoo xaridlari);
   - **Logistika** — chiquvchi jo‘natmalar (menyu: Logistika → Odoo jo‘natmalari).
   Odoo'ga hech narsa yozilmaydi. API kalit serverda shifrlangan.

## Demo → Real
Bazada demo ma’lumot bo‘lsa, super admin **Sozlamalar** sahifasida “Real rejimga o‘tish” kartasini ko‘radi. Tasdiqlash (REAL) → demo ma’lumotlar o‘chadi;
super admin, adminlar, bo‘lim loginlari, API/AI/Telegram/Odoo kalitlari saqlanadi; zaxira `data/backups/pre-real-*.db`.

## Telegram jamoa botlari (Ta’minot, Ombor, Ishlab chiqarish, Xulosa)
Sayt ichida ishlaydi (alohida server kerak emas). **Sozlamalar → Telegram botlar (4 ta)**.
1. @BotFather'da 4 ta bot → tokenlarni `.env` (`TAMINOT_BOT_TOKEN`, `OMBOR_BOT_TOKEN`, `ISHLAB_BOT_TOKEN`, `XULOSA_BOT_TOKEN`) yoki saytdagi panelga kiriting.
2. Har bir bot uchun @BotFather → `/setprivacy` → **Disable** (yoki botlarni guruh admini qiling).
3. Telegram guruh oching, 4 botni qo‘shing (admin `TEAMBOTS_ADMIN_IDS` dagi kishi qo‘shsa, guruh avtomatik ruxsat oladi).
4. Tugmalar yo‘q, faqat `/help`. Savol yozing yoki ovozli xabar yuboring — tegishli bot javob beradi.
5. Saytdagi har bir yangilanish 1 daqiqalik to‘plamlarda tegishli botdan guruhga keladi; 08:00 reja, 19:00 statistika; Xulosa boti har 3 soatda yakuniy xulosa.
**Muhim:** bitta token bilan faqat bitta joyda bot ishlashi mumkin — boshqa server/kompyuterda shu tokenlar bilan dastur ishlab tursa, botlar 409 xatosini ko‘rsatadi.

## Ishlab chiqarish
Menyu: **Ishlab chiqarish** (Ombor va Ta’minot bilan birga asosiy bo‘lim; logistika sahifalari “Logistika (jo‘natish)” guruhida saqlandi).
- **Panel** — bugungi/haftalik natija, nuqson %, ochiq va kechikkan buyurtmalar, mijoz buyurtmalari bo‘yicha ishlab chiqarish rejasi, 14 kunlik grafik.
- **Buyurtmalar** — Reja → Materiallarni berish (ombordan chiqim) → Jarayon → Natija (yaroqli omborga kirim, rework/brak zonalarga) → Bajarildi.
- **Mahsulot tarkibi (BOM)** — 1 dona mahsulot uchun materiallar va chiqindi %.
- **Material ehtiyoji (MRP)** — yetishmaydigan materiallar va bir tugma bilan Ta’minotga zayavka.
- Bo‘lim logini: **Ishlab chiqarish** (login ish-XXXX, rol PRODUCTION). Ishlab chiqarish boti buyurtmalar, natija va material yetishmovchiligi haqida yozadi.
