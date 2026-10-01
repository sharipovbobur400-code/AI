# Vercel ga joylash (404 xatosiz)

## Nega avval 404 chiqqan?
Vercel loyiha ildizidan `index.html` qidirgan — u esa `public/` ichida, Node server esa umuman ishga tushmagan.
Endi:

| Nima | Qayerda ishlaydi |
|---|---|
| Sayt (HTML/CSS/JS) | `public/` → Vercel CDN (`vercel.json` → `outputDirectory: "public"`) |
| Barcha `/api/*` so‘rovlar | `api/index.js` → Serverless Function |
| Baza | har instansiyada `/tmp` dagi SQLite nusxa + **Neon Postgres** da doimiy saqlanadi |
| Telegram bot | webhook (`/api/telegram/webhook`) — tokenni saqlaganda avtomatik ulanadi |
| 08:00 / 22:00 hisobot, AI dispetcher | Vercel Cron → `/api/cron/tick` |

## 1. GitHub ga yuklash
Zip ichidagi fayllarni repozitoriy **ildiziga** joylang (`package.json`, `vercel.json`, `api/`, `public/`, `server/` bir darajada bo‘lsin).
`.env` va `data/` ni yuklamang (`.gitignore` da bor).

## 2. Vercel → Add New → Project
- Repozitoriyni tanlang. **Framework Preset: Other**. Root Directory: repozitoriy ildizi.
- Build / Output sozlamalariga tegmang — `vercel.json` o‘zi belgilaydi.

## 3. Baza: Storage → Create → Neon (Postgres)
Loyihaga ulang — `DATABASE_URL` avtomatik qo‘shiladi. (Bazasiz sayt ochiladi, lekin API “Server sozlanmagan: DATABASE_URL topilmadi” deydi.)

## 4. Settings → Environment Variables
| O‘zgaruvchi | Qiymat |
|---|---|
| `SUPERADMIN_LOGIN` | super admin logini |
| `SUPERADMIN_NAME` | super admin ismi |
| `SUPERADMIN_PASSWORD` | super admin paroli |
| `WMS_MASTER_KEY` | uzun tasodifiy satr (API kalitlarni shifrlaydi; **keyin o‘zgartirmang**) |
| `CRON_SECRET` | uzun tasodifiy satr (cron himoyasi) |
| `SEED` | `real` |
| `WMS_BASE_URL` | `https://<loyiha>.vercel.app` (Telegram webhook manzili uchun) |
| `BOT_MORNING_HOUR` / `BOT_EVENING_HOUR` | `8` / `22` |
| `AI_API_KEY`, `TELEGRAM_BOT_TOKEN` | ixtiyoriy — saytdagi **API kalitlar** bo‘limidan ham kiritish mumkin |

Tasodifiy satr olish: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## 5. Deploy
**Deployments → Redeploy**. Tekshirish: `https://<loyiha>.vercel.app/api/health` → `{"ok":true…}`, keyin bosh sahifada super admin bilan kiring.

## 6. Tez-tez ishlaydigan cron (tavsiya)
Vercel Hobby rejasi cronni kuniga 1 marta ishlatadi (`vercel.json` da 08:05 va 22:05 Toshkent vaqti).
AI nazorati, dispetcher va integratsiyalar tez-tez ishlashi uchun **cron-job.org** (bepul) da har 5 daqiqaga:
```
https://<loyiha>.vercel.app/api/cron/tick?key=<CRON_SECRET>
```
Har qanday yozuv (buyurtma, kirim…) dan keyin AI dispetcher baribir darhol ishlaydi.

## Cheklovlar (serverless tabiati)
- Har bir o‘zgartirish bazaning siqilgan nusxasini Neon ga yozadi — kichik/o‘rta korxona yuklamasi uchun mos; juda katta trafikda VPS ([HOSTING.md](HOSTING.md)) afzal.
- Hujjat fayllari bazada saqlanadi, bitta fayl ≤ 3 MB.
- Real-time (SSE) ~5 soniyada yangilanadi (serverda doimiy ulanish yo‘q).
- Telegram bot webhook bilan ishlaydi — tokenni saqlagach bot o‘zi ulanadi (`WMS_BASE_URL` to‘g‘ri bo‘lsin).

## Lokal tekshiruv
`npm run test:vercel` — ikki mustaqil “instansiya” bitta saqlovni ulashadi: login, sinxron yozuv, 16 ta parallel yozuv, cron himoyasi, webhook himoyasi, sovuq start, `.env` yopiqligi.
