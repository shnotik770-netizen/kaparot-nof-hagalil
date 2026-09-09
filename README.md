# מערכת כפרות — נוף הגליל

מערכת רישום, תשלום וחלוקת כפרות. Node.js + Express + PostgreSQL, באותה ארכיטקטורה
כמו מערכת הזמנת הספרים הקיימת (session מבוסס-עוגייה, RPC/REST פשוט, PostgreSQL על Railway).

> **סטטוס**: שלד עובד מלא — הרשמה, אזור אישי, אימות סמס, מימוש/חלוקה, פאנל ניהול.
> **עדיין לא מחובר בפועל**: תשלום מקוון בפועל דרך iframe של נדרים פלוס (הכפתור קיים ומחשב
> יתרה, אך לא פותח את חלונית התשלום עצמה — ממתין להנחיות סופיות). ה-API של ימות המשיח
> (SMS) מחובר אך יש לאמת את הפרמטרים המדויקים מול הפאנל שלכם, ראו `src/lib/sms.js`.

## מבנה

- `src/server.js` — שרת Express, שלוש חזיתות: `/` (לקוח), `/kiosk` (עמדת חלוקה), `/admin` (ניהול).
- `src/db/schema.sql` — סכימת הדאטהבייס המלאה.
- `src/lib/*` — כל לוגיקת השרת (settings, sms, otp, auth, orders, redemption, priceRules, payments, adminOps).
- `src/routes/api.js` — כל נקודות הקצה של ה-API.
- `public/*.html` — שלוש החזיתות (וניל JS, ללא build step).

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

1. **נדרים פלוס** — פתיחת חלונית תשלום אמיתית + נקודת קצה ל-Webhook. ממתין לפרמטרים
   הסופיים (ApiValid, Mosad ID) ולהנחיה איך למפות את ה-callback לטבלת `payments`.
2. **SMS** — `src/lib/sms.js` מבוסס על קוד עובד שסופק (Google Apps Script, `SendSms`),
   כך שאמור לעבוד ללא שינוי — צריך רק להזין `YEMOT_SMS_API_KEY`.
3. **פריסה ל-Railway** — עדיין לא הוגדר שירות Railway/Postgres לפרויקט הזה.
