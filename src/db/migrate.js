import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import 'dotenv/config';
import { pool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('✅ סכימת הדאטהבייס עודכנה בהצלחה.');
  await pool.end();
}

main().catch((err) => {
  console.error('❌ מיגרציה נכשלה:', err);
  process.exit(1);
});
