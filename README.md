# מערכת כפרות — נוף הגליל

מערכת רישום, תשלום וחלוקת כפרות. Node.js + Express + PostgreSQL, באותה ארכיטקטורה
כמו מערכת הזמנת הספרים הקיימת (session מבוסס-עוגייה, RPC/REST פשוט, PostgreSQL על Railway).

> **סטטוס**: שלד עובד מלא — הרשמה מבוססת זמני חלוקה דינמיים (ניהול מלא בפאנל, לא ימים/שעות
> קבועים בקוד), אזור אישי, אימות סמס, מימוש/חלוקה מקובץ לפי זמן חלוקה, פאנל ניהול מרובה
> מנהלים (עם הרשאות פר-טאב), ותשלום מקוון דרך אייפרם נדרים פלוס (שיטה 3 מסלול ב', ראו
> `docs/nedarim-plus-integration.md`), כולל תשלום חלקי. חסרים רק שני פרטים כדי שהתשלום
> יעבוד בפועל — ראו "מה עוד חסר" למטה.

## מבנה

- `src/server.js` — שרת Express, שלוש חזיתות: `/` (לקוח), `/kiosk` (עמדת חלוקה), `/admin` (ניהול).
  ה-Webhook של נדרים פלוס (`/webhooks/nedarim-plus`) מותקן *לפני* ה-JSON parser הגלובלי,
  עם body גולמי — נדרש לאימות חתימת ה-HMAC.
- `src/db/schema.sql` — סכימת הדאטהבייס המלאה, כולל `distribution_slots` (זמני חלוקה
  דינמיים שהמנהל מוסיף/עורך) ו-`admins` (מספר מנהלים עם שם/טלפון/סיסמה/הרשאות משלהם).
- `src/lib/*` — כל לוגיקת השרת: `settings`, `sms`, `otp`, `auth` (כניסת מנהל, בוטסטרפ),
  `admins` (CRUD מנהלים + הרשאות), `slots` (CRUD זמני חלוקה + חישוב פתוח/סגור),
  `hebcal` (תאריך עברי ללא ניקוד לכל זמן חלוקה), `orders`, `redemption` (מימוש מקובץ
  לפי זמן חלוקה, זכר+נקבה יחד), `payments`, `adminOps`, `nedarim`.
- `src/routes/api.js` — כל נקודות הקצה של ה-API. `src/routes/webhooks.js` — קבלת ה-Webhook.
- `public/*.html` — שלוש החזיתות (וניל JS, ללא build step): `index.html` (לקוח),
  `kiosk.html` (עמדת חלוקה משותפת), `admin.html` (ניהול — טאבים מוצגים לפי הרשאות המנהל
  המחובר: הגדרות / זמני חלוקה / הזמנות ותשלומים / דשבורד).
- `docs/nedarim-plus-integration.md` — סיכום האינטגרציה עם נדרים פלוס, מה הוחלט ולמה.

## הרצה מקומית

```bash
npm install
cp .env.example .env   # ומלאו DATABASE_URL, YEMOT_SMS_API_KEY וכו'
npm run migrate
node scripts/set-admin-password.js "הסיסמה-שלכם"   # סיסמת בוטסטרפ זמנית
npm start
```

לאחר הכניסה הראשונה עם סיסמת הבוטסטרפ (עם כל מספר טלפון), יש להוסיף מנהל אמיתי
(שם, טלפון, סיסמה, הרשאות) בטאב "הגדרות" → "ניהול מנהלים" בפאנל הניהול. ברגע שיש
מנהל אחד לפחות, סיסמת הבוטסטרפ מפסיקה לעבוד לגמרי.

## מה עוד חסר לפני עלייה לאוויר

1. **נדרים פלוס** — חסר `NEDARIM_MOSAD_ID` (מספר המוסד, 7 ספרות; יש רק `ApiValid` של
   "חסדי מנחם"). וברגע שיש דומיין: להגדיר בפאנל שלהם (הגדרות > API > Webhook) כתובת
   `https://<דומיין>/webhooks/nedarim-plus` ומפתח חתימת HMAC (`NEDARIM_WEBHOOK_SECRET`) —
   ראו `docs/nedarim-plus-integration.md`.
2. **SMS** — `src/lib/sms.js` מבוסס על קוד עובד שסופק (Google Apps Script, `SendSms`),
   כך שאמור לעבוד ללא שינוי — צריך רק להזין `YEMOT_SMS_API_KEY`.
3. **פריסה ל-Railway** — הפרויקט פרוס (`kaparot-nof-hagalil`, Railway + Postgres).
