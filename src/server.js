import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { pool } from './db/pool.js';
import apiRouter from './routes/api.js';
import webhooksRouter from './routes/webhooks.js';
import ivrRouter from './routes/ivr.js';
import { startPeriodicSheetsSync } from './lib/sheetsSync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PgSession = connectPgSimple(session);

// רשת ביטחון אחרונה: בלי זה, כל שגיאה לא-צפויה שמחמיצה את wrap()/try-catch
// (למשל ב-webhooks או בקוד שרץ מחוץ לבקשת HTTP) מפילה את כל התהליך — כלומר
// את השירות לכל הלקוחות המחוברים בבת אחת. עדיף לרשום ללוג ולהמשיך לרוץ.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

const app = express();
app.set('trust proxy', 1);

// לפני express.json() הגלובלי בכוונה: אימות ה-HMAC של נדרים פלוס חייב את
// הבייטים הגולמיים של הבקשה בדיוק כפי שהתקבלו (ראו docs/nedarim-plus-integration.md).
app.use('/webhooks', express.raw({ type: '*/*', limit: '256kb' }), webhooksRouter);

// ימות המשיח שולח GET כברירת מחדל (query string) — express.urlencoded כאן
// רק ליתרת-בטיחות אם בעתיד api_url_post=yes יופעל לשלוחות ה-IVR.
app.use('/ivr', express.urlencoded({ extended: true }), ivrRouter);

app.use(express.json({ limit: '1mb' }));

app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 20, // 20 יום
  },
}));

app.use('/api', apiRouter);

// no-cache (לא no-store) על כל הקבצים הסטטיים: הדפדפן עדיין עושה בקשה
// מותנית (If-None-Match) בכל טעינה ומקבל 304 זול אם שום דבר לא השתנה, אבל
// לא ממשיך "לזכור" גרסה ישנה של admin.html/index.html/kiosk.html בלי לבדוק
// מול השרת בכלל — שהיה גורם לשינויים בקוד להיראות כאילו לא נכנסו עד שעושים
// רענון קשיח (Ctrl+Shift+R) ידנית.
const staticOptions = { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') };
app.use(express.static(path.join(__dirname, '..', 'public'), staticOptions));

// שלוש חזיתות נפרדות: לקוח (index.html), קיוסק חלוקה (kiosk.html), מנהל (admin.html)
app.get('/kiosk*', (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, '..', 'public', 'kiosk.html')));
app.get('/admin*', (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.get('*', (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 400;
  const body = { error: err.message || 'שגיאה לא צפויה.' };
  if (err.paymentBlocked) body.paymentBlocked = true;
  res.status(status).json(body);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🐔 שרת כפרות רץ על פורט ${port}`);
  startPeriodicSheetsSync();
});
