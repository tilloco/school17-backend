# Backend — ishga tushirish qo'llanmasi

Bu qismda tayyor: **Prisma schema** (barcha jadvallar) va **SMS OTP autentifikatsiya**
(`/auth/request-otp`, `/auth/verify-otp`) + himoyalangan `/users/me` va `/users/dashboard`.

## 1. Kerakli dasturlarni o'rnating

- [Node.js](https://nodejs.org) (18 yoki undan yuqori versiya)
- PostgreSQL — eng oson yo'li: [Docker](https://www.docker.com/) o'rnatib, quyidagi komandani ishga tushiring:

```bash
docker run --name huquq-postgres -e POSTGRES_PASSWORD=password -e POSTGRES_DB=huquq_db -p 5432:5432 -d postgres:16
```

(Docker o'rnatishni istamasangiz, Neon.tech yoki Supabase da bepul PostgreSQL bazasini bulutda oching va DATABASE_URL'ni o'shandan oling.)

## 2. Loyihani sozlang

```bash
cd backend
npm install
cp .env.example .env
```

`.env` faylini oching va DATABASE_URL, JWT_SECRET qiymatlarini o'zingizga moslang.
(Eskiz.uz ma'lumotlarini hozircha bo'sh qoldirsangiz ham bo'ladi — development rejimida
kod real SMS yubormasdan konsolga chiqaradi, shuning uchun sinab ko'rish uchun kifoya.)

## 3. Ma'lumotlar bazasini yarating

```bash
npx prisma migrate dev --name init
```

Bu komanda prisma/schema.prisma dagi jadvallarni haqiqiy PostgreSQL bazasida yaratadi.

## 4. Serverni ishga tushiring

```bash
npm run start:dev
```

Konsolda "Backend ishga tushdi: http://localhost:3000" degan xabarni ko'rasiz.

## 5. Sinab ko'ring (masalan Postman yoki curl bilan)

Kod so'rash:
```bash
curl -X POST http://localhost:3000/auth/request-otp \
  -H "Content-Type: application/json" \
  -d '{"phone": "+998901234567"}'
```
Konsolda (server ishlab turgan terminalda) "[DEV MODE] +998901234567 raqamiga OTP: 123456" kabi qator chiqadi — shu 6 xonali kodni oling.

Kodni tasdiqlash (birinchi marta kirish = avtomatik ro'yxatdan o'tish):
```bash
curl -X POST http://localhost:3000/auth/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"phone": "+998901234567", "code": "123456", "name": "Ali"}'
```
Javobda accessToken keladi — shuni saqlab qoling.

Himoyalangan endpoint (profil):
```bash
curl http://localhost:3000/users/me \
  -H "Authorization: Bearer <accessToken>"
```

## 6. Ma'lumotlarni ko'rish uchun (ixtiyoriy, foydali)

```bash
npx prisma studio
```
Bu brauzerda bazangizni jadval ko'rinishida ochadi — foydalanuvchilar, savollar va h.k.ni ko'rish/tahrirlash uchun qulay.

---

## Keyingi qadam

Shu qism tayyor va ishlaydi bo'lsa, keyingi bosqichga (referral + premium logika, so'ng
Click/Payme webhook) o'tamiz. Ishga tushirishda biror xatolik chiqsa, xatolik matnini
menga yuboring — birga hal qilamiz.

---

## 2-BOSQICH QO'SHIMCHASI: Kontent + test yechish

Yangi fayllarni oldingi papka ustiga ko'chirgandan so'ng (VS Code'da shunchaki
`backend/src/content` va `backend/src/quiz` papkalarini qo'shing, `app.module.ts`,
`.env.example` va shu README avtomatik yangilangan holatda keladi):

```bash
npm install
npx prisma generate
npm run start:dev
```

### Yangi endpointlar

**Kontent (mobil ilova o'qiydi, ochiq):**
```bash
curl http://localhost:3000/content/modules
curl http://localhost:3000/content/lessons/<lessonId>
```

**Kontent qo'shish (faqat admin, .env dagi ADMIN_API_KEY kerak):**
```bash
curl -X POST http://localhost:3000/content/modules \
  -H "Content-Type: application/json" \
  -H "x-admin-key: <ADMIN_API_KEY>" \
  -d '{"title": "Konstitutsiyaviy huquq", "order": 1}'
```
Xuddi shunday `/content/weeks`, `/content/lessons`, `/content/questions` orqali hafta/dars/savol qo'shiladi.

**Test yechish (login talab qiladi, Authorization: Bearer header bilan):**
```bash
curl -X POST http://localhost:3000/quiz/answer \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"questionId": "<questionId>", "chosenIndex": 1}'
```
Javobda `isCorrect`, `correctIndex`, `explanation` keladi. Premium bo'lmagan
foydalanuvchi kuniga 3 tadan ko'p javob bersa, `403 FREE_LIMIT_REACHED` xatosi qaytadi
— bu hozirgi Telegram botingizdagi bepul limit bilan bir xil model.

**Sinov ma'lumotlarini qo'shish (ixtiyoriy, tez sinash uchun):**
```bash
npm run prisma:seed
```

---

## XAVFSIZLIK YAMOG'I (2-bosqichdan keyin, mobil boshlashdan oldin)

Auth oqimi mobil ilova ustiga quriladigan asosiy fundament bo'lgani uchun, davom etishdan
oldin quyidagi zaifliklar tuzatildi:

1. **OTP kodlari endi hash qilinib saqlanadi** (`codeHash`, HMAC-SHA256 + `.env`dagi
   `OTP_PEPPER`), ochiq matnda emas — DB sizib ketsa ham kodlar to'g'ridan-to'g'ri ishlatib bo'lmaydi.
2. **Brute-force himoyasi**: bitta OTP yozuvi 5 tadan ortiq noto'g'ri urinishga chidamaydi,
   shundan keyin bekor qilinadi va foydalanuvchi yangi kod so'rashga majbur bo'ladi.
3. **SMS-bombing himoyasi**: bir raqamga 60 soniyada 1 martadan va 1 soatda 5 martadan
   ortiq kod yuborilmaydi (bu boshqa birovning raqamiga cheksiz SMS yuborib, sizning
   Eskiz.uz hisobingizni "quritish" hujumining oldini oladi).
4. **IP-asosli throttling** qo'shildi (`@nestjs/throttler`): butun API uchun IP boshiga
   daqiqasiga 60 so'rov, `/auth/request-otp` uchun 3, `/auth/verify-otp` uchun 10.
5. **Helmet** yoqildi (standart xavfsizlik HTTP headerlari).
6. **CORS endi cheklangan** — `.env`dagi `ALLOWED_ORIGINS` orqali faqat sizning mobil
   ilova/admin panel originlariga ruxsat beriladi (production uchun bu qatorni albatta to'ldiring).
7. Admin kalitini solishtirish endi doimiy-vaqtli (`timingSafeEqual`) — vaqt asosidagi hujumga qarshi.

**Yangilashdan keyin qiladigan ishlaringiz:**
```bash
npm install
cp .env.example .env   # yoki mavjud .env ga OTP_PEPPER va ALLOWED_ORIGINS qo'shing
npx prisma migrate dev --name otp_hardening
npm run start:dev
```

`OTP_PEPPER`ni o'zgartirsangiz (yoki birinchi marta qo'ysangiz), bazadagi eski OTP
yozuvlari avtomatik yaroqsiz bo'ladi — bu xavfsiz va kutilgan holat, foydalanuvchilar
shunchaki yangi kod so'raydi.

## 4-BOSQICH: REFERRAL VA PREMIUM LOGIKASI

Bu bosqichda ikkita yangi modul qo'shildi: `premium/` (premium muddatini hisoblaydigan
markaziy servis) va `referral/` (referral bog'lanishi, mukofotlar, hamyon, pul yechib olish).

### Yangilashdan keyin qiladigan ishlaringiz

```bash
npm install
npx prisma migrate dev --name referral_and_premium
npm run start:dev
```

### Ishlash mantig'i

1. **Ro'yxatdan o'tishda referral bog'lanadi.** `/auth/verify-otp`ga `referredByCode`
   yuborilsa (mobil ilova referral kodi bilan link orqali ochilganda), yangi
   foydalanuvchi va referral qiluvchi o'rtasida `Referral` yozuvi (`PENDING`) yaratiladi.
   Noto'g'ri/mavjud bo'lmagan kod bo'lsa — xato tashlanmaydi, shunchaki referral
   bog'lanmaydi (ro'yxatdan o'tish hech qachon shu sabab bilan to'xtamaydi).
2. **3 ta do'st taklif qilish → bepul premium.** Har safar taklif qilingan odam
   ro'yxatdan o'tganda (pullik bo'lishi shart emas), referral qiluvchining jami
   takliflari soni tekshiriladi. 3 ga bo'linganda (3, 6, 9...) avtomatik 1 oylik
   premium beriladi — `PremiumService.extendPremium()` orqali, mavjud premium
   muddatiga QO'SHILADI (yo'qotilmaydi).
3. **Do'sting premium sotib olsa → 5,000 so'm.** Bu qism `ReferralService.rewardOnPremiumPurchase(referredUserId)`
   orqali ishlaydi — lekin buni chaqiradigan joy hali yo'q, chunki to'lov (Click/Payme)
   webhook'i 5-BOSQICHDA quriladi. Webhook yozilganda, to'lov muvaffaqiyatli bo'lgan
   `userId` bilan shu funksiyani chaqirish kifoya — qolgan hammasi (hamyonga pul
   qo'shish, referral holatini `REWARDED`ga o'tkazish, ikki marta mukofotlanmasligini
   tekshirish) allaqachon tayyor.
4. **PremiumService — yagona manba.** Premium bilan bog'liq har qanday joy (referral
   bonusi, to'lov, admin qo'lda berishi) shu servisdan foydalanadi, shuning uchun
   muddat hisoblash logikasi hech qayerda takrorlanmaydi. `quiz.service.ts`dagi eski
   dublikat tekshiruv ham shu servisga o'tkazildi.

### Yangi endpointlar

| Method | Path | Auth | Tavsif |
|---|---|---|---|
| GET | `/referral/me` | JWT | O'z referral kodi, hamyon balansi, taklif tarixi, 3ta-do'st progressi |
| POST | `/referral/withdraw` | JWT | `{ "amount": 50000 }` — hamyondan yechib olish so'rovi (min 10,000 so'm) |
| GET | `/referral/withdrawals` | JWT | O'zining yechib olish so'rovlari tarixi |
| GET | `/referral/admin/withdrawals?status=PENDING` | `x-admin-key` | Barcha so'rovlar (admin) |
| PATCH | `/referral/admin/withdrawals/:id` | `x-admin-key` | `{ "status": "APPROVED\|REJECTED\|PAID", "note": "..." }` |

**Xavfsizlik eslatmasi:** yechib olish so'rovi yuborilganda summasi hamyondan DARHOL
ayiriladi (bir xil pulni ikki marta so'rab, ikki marta yechib olishning oldini olish
uchun). Agar admin so'rovni RAD ETSA, pul avtomatik hamyonga qaytariladi.

Admin endpointlari hali `/content` bilan bir xil vaqtinchalik `x-admin-key` kaliti
bilan himoyalangan — 6-BOSQICHDA (admin panel + login) bular haqiqiy admin
autentifikatsiyasiga o'tkaziladi.

## 5-BOSQICH: CLICK VA PAYME TO'LOV INTEGRATSIYASI

### Yangilashdan keyin qiladigan ishlaringiz

```bash
npm install
npx prisma migrate dev --name payments
cp .env.example .env   # yoki mavjud .env ga CLICK_*/PAYME_* qatorlarini qo'shing
npm run start:dev
```

`.env`ga quyidagilarni to'ldiring (tegishli merchant kabinetdan olinadi):
- Click: `merchant.click.uz` → `CLICK_SERVICE_ID`, `CLICK_MERCHANT_ID`, `CLICK_SECRET_KEY`
- Payme: `business.payme.uz` → `PAYME_MERCHANT_ID`, `PAYME_MERCHANT_KEY`

### Narxlar

`src/payments/pricing.ts` faylida — narx HECH QACHON mobil ilovadan qabul qilinmaydi,
faqat shu fayldan olinadi (aks holda so'rovni o'zgartirib arzonroq "sotib olish" mumkin
bo'lardi). Hozircha 1 oylik/3 oylik uchun namunaviy narxlar qo'yilgan — haqiqiy narxga
almashtiring.

### Oqim (ikkala provayder uchun ham bir xil shakl)

1. Mobil ilova `POST /payments/init` ga `{ "provider": "CLICK", "months": 1 }` yuboradi
   (JWT bilan). Backend narxni serverda hisoblab, `Payment` yozuvini `PENDING` holatda
   yaratadi va tayyor to'lov havolasini (`payUrl`) qaytaradi.
2. Mobil ilova `payUrl`ni brauzer/WebView orqali ochadi — foydalanuvchi kartasi bilan
   to'laydi.
3. Click/Payme backendimizga (`/payments/click/webhook` yoki `/payments/payme`) server-
   server so'rov yuboradi. Bu yerda **HECH QACHON JWT talab qilinmaydi** — o'rniga:
   - Click: har bir so'rov `sign_string` (MD5 imzo) orqali tekshiriladi.
   - Payme: HTTP Basic Auth (`Paycom:PAYME_MERCHANT_KEY`) orqali tekshiriladi.
4. To'lov muvaffaqiyatli tasdiqlanganda (Click "Complete" yoki Payme "PerformTransaction"),
   backend avtomatik: `Payment.status = SUCCESS` → `PremiumService.extendPremium()` →
   `ReferralService.rewardOnPremiumPurchase()`. Foydalanuvchi hech narsa qilmasdan
   premium oladi, referral qiluvchi (agar bo'lsa) hamyoniga 5,000 so'm tushadi.

### Xavfsizlik va ishonchlilik bo'yicha muhim qarorlar

- **Narx serverda hisoblanadi**, clientdan qabul qilinmaydi (yuqorida aytilgan).
- **Imzo/autentifikatsiya tekshiruvi hech qachon o'tkazib yuborilmaydi** — Click uchun
  MD5 sign_string, Payme uchun Basic Auth, ikkalasi ham doimiy-vaqtli solishtirish
  (`timingSafeEqual`) bilan.
- **Idempotentlik**: Click va Payme ikkalasi ham webhook/so'rovni bir necha marta qayta
  yuborishi mumkin (tarmoq xatosi, retry). Shuning uchun premium/referral mukofoti
  berilishi state='CREATED' shartli **atomik** `updateMany` orqali amalga oshiriladi —
  ikkita parallel yoki takroriy so'rov bo'lsa ham, faqat BITTASI premium beradi va
  hamyonga pul qo'shadi.
- **Click ikki bosqichli oqimi** (Prepare → Complete) uchun alohida `ClickTransaction`
  jadvali, **Payme holat mashinasi** uchun alohida `PaymeTransaction` jadvali qo'shildi —
  ikkalasi ham asosiy `Payment` yozuvidan mustaqil ravishda provayderning o'ziga xos
  bosqichlarini kuzatadi.
- **Refund/bekor qilish**: agar to'langan tranzaksiya keyinchalik bekor qilinsa (Payme
  `CancelTransaction`, state=COMPLETED dan keyin chaqirilsa), `Payment.status = FAILED`
  qilinadi va **DIQQAT** darajasida log yoziladi, lekin premium/hamyon avtomatik qaytarib
  olinmaydi — bu real pul harakati bo'lgani uchun qo'lda admin tekshiruvi (6-bosqich)
  bilan qilingani xavfsizroq deb qaror qilindi.

### ⚠️ Ishga tushirishdan oldin albatta tekshiring

Click va Payme signature formulalari (`ClickService.verifySign`,
`PaymeController.isAuthorized`) ularning rasman e'lon qilingan hujjatlari va ko'plab
ochiq-manba kutubxonalar asosida yozilgan, lekin har ikkala provayder ham **test muhiti
(sandbox)** taqdim etadi — production kalitlarni ulashdan oldin albatta o'sha yerda
sinab ko'ring. Agar Click yoki Payme hamkor menejeri boshqacha sign formula/error kod
bersa, mos ravishda moslashtiring.

### Yangi endpointlar

| Method | Path | Auth | Tavsif |
|---|---|---|---|
| POST | `/payments/init` | JWT | `{ "provider": "CLICK\|PAYME", "months": 1\|3 }` — to'lov havolasini yaratadi |
| POST | `/payments/click/webhook` | Click imzosi | Click Prepare/Complete (bitta URL, `action` maydoni bilan farqlanadi) |
| POST | `/payments/payme` | Payme Basic Auth | Payme JSON-RPC (CheckPerformTransaction/CreateTransaction/PerformTransaction/CancelTransaction/CheckTransaction) |

Click va Payme kabinetlarida callback/webhook URL sifatida mos ravishda
`https://<domeningiz>/payments/click/webhook` va `https://<domeningiz>/payments/payme`
ni ko'rsating.
