# Hostingga joylash — hostx.uz (ISPmanager)

## Nega Vercel 404 berdi?

Vercel faqat statik sayt va qisqa muddatli "serverless" funksiyalarni ishlatadi. Bu tizim esa **doimiy ishlaydigan Node.js server**:
- fayldagi SQLite baza;
- Telegram bot;
- 08:00 / 22:00 hisobotlari;
- AI dispetcher;
- real vaqt (SSE) ulanishi.

Vercel `app.js` ni ishga tushirmaydi, shuning uchun 404 chiqadi. Majburan ishlatilsa ham baza har safar o'chib ketadi. **Vercel bu tizim uchun yaroqsiz** — ISPmanager (hostx.uz), VPS, Railway yoki Render kerak.

## 0. Hostingni tekshiring

hostx.uz tarifingizda **Node.js ilovalar** yoqilgan bo'lishi kerak.

1. Panelda **Saytlar → Sayt yaratish** oynasida "Obrabotchik / Handler" ro'yxatida **Node.js** bor-yo'qligini qarang.
2. Agar bo'lmasa, qo'llab-quvvatlash xizmatiga yozing: *"Node.js 22 yoki undan yangi versiyada ilova ishga tushirish kerak, tarifga yoqib bera olasizmi?"*. Oddiy PHP tarifida ishlamaydi — kerak bo'lsa VPS'ga o'tiladi.

Tavsiya etilgan versiya: **Node.js 22.13+ yoki 24**. Qo'shimcha kutubxona kerak emas.
- **22.5–22.12:** `app.js` kerakli bayroqni o'zi qo'shadi.
- **22.5 dan past:** `npm install` bajarib, `better-sqlite3` ni o'rnatish kerak.

## 1. Sayt yaratish

1. ISPmanager → **Saytlar (WWW-domeny / Sites) → Yaratish**.
2. **Domen:** masalan `wms.korxona.uz` (DNS hostingga yo'naltirilgan bo'lsin).
3. **Obrabotchik (Handler): Node.js**.
4. **Versiya:** eng yangisi (22 yoki 24).
5. **Ilovani ishga tushirish fayli:** `app.js`.
6. **Ulanish usuli:** "Socket" yoki "Port" — ikkalasi ham ishlaydi. Tizim hosting bergan `PORT` qiymatini o'zi o'qiydi.
7. **SSL:** "Let's Encrypt" sertifikatini yoqing (HTTPS majburiy).

## 2. Fayllarni yuklash

1. **Menejer faylov (File manager)** → sayt papkasi (masalan `www/wms.korxona.uz`).
2. `solar-factory-wms.zip` ni yuklang va **"Arxivdan chiqarish"** qiling.
3. Fayllar papka ichidagi `solar-factory-wms/` papkasida emas, **to'g'ridan-to'g'ri sayt papkasida** tursin. Ya'ni `app.js`, `server/`, `public/` shu yerda bo'lsin (kerak bo'lsa ko'chiring).

## 3. `.env` faylini yaratish

File manager'da `.env.example` dan nusxa oling, nomini **`.env`** qiling va quyidagilarni yozing:

```
SEED=real
SUPERADMIN_LOGIN="Kira Fartuno"
SUPERADMIN_NAME="Kira Fartuno"
SUPERADMIN_PASSWORD="kuchli-parol-yozing"
BEHIND_HTTPS=1
TRUST_PROXY=1
WMS_BASE_URL=https://wms.korxona.uz
BOT_MORNING_HOUR=8
BOT_EVENING_HOUR=22
BOT_TZ_OFFSET_MIN=300
```

`PORT` va `HOST` ni **yozmang** — ularni ISPmanager o'zi beradi. AI kaliti va Telegram tokenini saytga kirgandan so'ng **Sozlamalar → API kalitlari** bo'limida kiriting — ular shifrlangan holda saqlanadi.

## 4. Ishga tushirish

1. Saytning Node.js sozlamalarida **"Qayta ishga tushirish / Restart"** ni bosing.
2. Node 22.5 dan past bo'lsa, avval **"npm install"** tugmasini bosing.
3. Brauzerda `https://wms.korxona.uz/api/health` ni oching. `{"ok":true,...}` chiqsa, server ishlayapti.
4. `https://wms.korxona.uz` ni ochib, super admin bilan kiring.

## 5. Tekshiruv

- **`https://domen/.env`** manzili parol yoki kalitlarni ko'rsatmasligi kerak — tizim faqat `public/` papkani beradi.
- **Telegram bot:** token faqat **bitta** ishlab turgan nusxada bo'lsin. Kompyuteringizdagi nusxani o'chiring, aks holda bot xabarlari ikki nusxa o'rtasida bo'linib ketadi (Telegram "409 Conflict").
- **Baza:** `data/wms.db` shu papkada saqlanadi. Tizim har kuni avtomatik zaxira nusxa oladi (`data/backups/`). Vaqti-vaqti bilan zaxira nusxani kompyuteringizga ham yuklab oling.

## Muammo bo'lsa

- **Ilova ishga tushmasa:** saytning Node.js bo'limidagi **log**ni qarang. Birinchi qatorlarda Node versiyasi va xato sababi yoziladi (masalan `SQLite topilmadi: Node.js 22.5+ kerak`).
- **502 / 504 xato:** ilova hali ishga tushmagan yoki to'xtab qolgan — Restart qiling va logni tekshiring.
- **Login sahifasi o'rniga "Super admin yaratish" chiqsa:** `.env` o'qilmagan. Fayl nomi aynan `.env` ekanini va u `app.js` bilan bir papkada turganini tekshiring.
