// שימוש: node scripts/set-admin-password.js "הסיסמה-שלכם"
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db/pool.js';

async function main() {
  const password = process.argv[2];
  if (!password || password.length < 6) {
    console.error('יש לספק סיסמה בת 6 תווים לפחות: node scripts/set-admin-password.js "הסיסמה"');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO settings(key, value) VALUES ('admin_password_hash', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [hash]
  );
  console.log('✅ סיסמת המנהל הקבועה עודכנה.');
  await pool.end();
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
