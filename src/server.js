import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { pool } from './db/pool.js';
import apiRouter from './routes/api.js';
import webhooksRouter from './routes/webhooks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PgSession = connectPgSimple(session);

const app = express();
app.set('trust proxy', 1);

// לפני express.json() הגלובלי בכוונה: אימות ה-HMAC של נדרים פלוס חייב את
// הבייטים הגולמיים של הבקשה בדיוק כפי שהתקבלו (ראו docs/nedarim-plus-integration.md).
app.use('/webhooks', express.raw({ type: '*/*', limit: '256kb' }), webhooksRouter);

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

app.use(express.static(path.join(__dirname, '..', 'public')));

// שלוש חזיתות נפרדות: לקוח (index.html), קיוסק חלוקה (kiosk.html), מנהל (admin.html)
app.get('/kiosk*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'kiosk.html')));
app.get('/admin*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 400;
  res.status(status).json({ error: err.message || 'שגיאה לא צפויה.' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🐔 שרת כפרות רץ על פורט ${port}`);
});
