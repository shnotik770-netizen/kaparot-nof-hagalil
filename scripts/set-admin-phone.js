// שימוש: node scripts/set-admin-phone.js "0501234567"
// קובע את מספר הטלפון היחיד שרשאי להיכנס כמנהל בקוד חד-פעמי בסמס.
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import { normalizePhone } from '../src/lib/normalize.js';

async function main() {
  const phone = process.argv[2];
  const normalized = normalizePhone(phone);
  if (!normalized) {
    console.error('יש לספק מספר טלפון: node scripts/set-admin-phone.js "0501234567"');
    process.exit(1);
  }
  await pool.query(
    `INSERT INTO settings(key, value) VALUES ('admin_phone', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [phone]
  );
  await pool.query(
    `INSERT INTO settings(key, value) VALUES ('normalized_admin_phone', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [normalized]
  );
  console.log(`✅ טלפון המנהל לכניסה בקוד חד-פעמי נקבע: ${normalized}`);
  await pool.end();
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
