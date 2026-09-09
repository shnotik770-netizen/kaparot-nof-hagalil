# מערכת כפרות — נוף הגליל

מערכת רישום, תשלום וחלוקת כפרות. Node.js + Express + PostgreSQL, באותה ארכיטקטורה
כמו מערכת הזמנת הספרים הקיימת (session מבוסס-עוגייה, RPC/REST פשוט, PostgreSQL על Railway).

> **סטטוס**: שלד עובד מלא — הרשמה, אזור אישי, אימות סמס, מימוש/חלוקה, פאנל ניהול,
> ותשלום מקוון דרך אייפרם נדרים פלוס (שיטה 3 מסלול ב', ראו `docs/nedarim-plus-integration.md`).
> חסרים רק שני פרטים כדי שהתשלום יעבוד בפועל — ראו "מה עוד חסר" למטה.

## מבנה

- `src/server.js` — שרת Express, שלוש חזיתות: `/` (לקוח), `/kiosk` (עמדת חלוקה), `/admin` (ניהול).
  ה-Webhook של נדרים פלוס (`/webhooks/nedarim-plus`) מותקן *לפני* ה-JSON parser הגלובלי,
  עם body גולמי — נדרש לאימות חתימת ה-HMAC.
- `src/db/schema.sql` — סכימת הדאטהבייס המלאה.
- `src/lib/*` — כל לוגיקת השרת (settings, sms, otp, auth, orders, redemption, priceRules,
  payments, adminOps, nedarim).
- `src/routes/api.js` — כל נקודות הקצה של ה-API. `src/routes/webhooks.js` — קבלת ה-Webhook.
- `public/*.html` — שלוש החזיתות (וניל JS, ללא build step).
- `docs/nedarim-plus-integration.md` — סיכום האינטגרציה עם נדרים פלוס, מה הוחלט ולמה.

## הרצה מקומית

```bash
npm install
cp .env.example .env   # ומלאו DATABASE_URL, YEMOT_SMS_API_KEY וכו'
npm run migrate
node scripts/set-admin-password.js "הסיסמה-שלכם"
node scripts/set-admin-phone.js "0501234567"   # אופציונלי — לכניסת מנהל בקוד סמס
npm start
```

## מה עוד חסר לפני עלייה לאוויר

1. **נדרים פלוס** — חסר `NEDARIM_MOSAD_ID` (מספר המוסד, 7 ספרות; יש רק `ApiValid` של
   "חסדי מנחם"). וברגע שיש דומיין: להגדיר בפאנל שלהם (הגדרות > API > Webhook) כתובת
   `https://<דומיין>/webhooks/nedarim-plus` ומפתח חתימת HMAC (`NEDARIM_WEBHOOK_SECRET`) —
   ראו `docs/nedarim-plus-integration.md`.
2. **SMS** — `src/lib/sms.js` מבוסס על קוד עובד שסופק (Google Apps Script, `SendSms`),
   כך שאמור לעבוד ללא שינוי — צריך רק להזין `YEMOT_SMS_API_KEY`.
3. **פריסה ל-Railway** — הפרויקט פרוס (`kaparot-nof-hagalil`, Railway + Postgres).
