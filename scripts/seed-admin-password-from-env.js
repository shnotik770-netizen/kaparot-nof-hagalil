// רץ אוטומטית בכל דיפלוי (preDeployCommand) — קובע סיסמת מנהל התחלתית
// ממשתנה הסביבה INITIAL_ADMIN_PASSWORD, אבל *רק* אם עדיין לא הוגדרה סיסמה
// (בטוח להרצה חוזרת בכל דיפלוי, בלי לדרוס סיסמה שהמנהל כבר שינה בעצמו).
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db/pool.js';

const initial = process.env.INITIAL_ADMIN_PASSWORD;
if (!initial) {
  console.log('ℹ️ INITIAL_ADMIN_PASSWORD לא הוגדר — מדלג על קביעת סיסמת מנהל אוטומטית.');
  process.exit(0);
}

const { rows } = await pool.query(`SELECT value FROM settings WHERE key = 'admin_password_hash'`);
if (rows.length && rows[0].value) {
  console.log('ℹ️ כבר קיימת סיסמת מנהל — לא נוגעים בה.');
} else {
  const hash = await bcrypt.hash(initial, 12);
  await pool.query(
    `INSERT INTO settings(key, value) VALUES ('admin_password_hash', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [hash]
  );
  console.log('✅ סיסמת מנהל התחלתית נקבעה מ-INITIAL_ADMIN_PASSWORD.');
}

await pool.end();
