import pg from 'pg';

const { Pool } = pg;

// אבחון זמני — לא מדפיס ערכים סודיים, רק נוכחות/אורך, כדי להשוות משתנה
// "ליטרלי" (NODE_ENV) מול משתנה "reference" (DATABASE_URL) באותו דיפלוי.
console.log(`[db] DATABASE_URL present: ${!!process.env.DATABASE_URL}, length: ${(process.env.DATABASE_URL || '').length}`);
console.log(`[db] NODE_ENV literal value: "${process.env.NODE_ENV}"`);
console.log(`[db] SESSION_SECRET present: ${!!process.env.SESSION_SECRET}, length: ${(process.env.SESSION_SECRET || '').length}`);
console.log(`[db] RAILWAY_PRIVATE_DOMAIN: "${process.env.RAILWAY_PRIVATE_DOMAIN}"`);
console.log(`[db] all env keys starting with DATA/POSTGRES/PG: ${Object.keys(process.env).filter(k => /^(DATABASE|POSTGRES|PG)/.test(k)).join(',') || '(none)'}`);
{
  const raw = process.env.DATABASE_URL || '';
  const masked = raw.replace(/\/\/([^@]*)@/, '//***@');
  console.log(`[db] DATABASE_URL masked shape: "${masked}"`);
  console.log(`[db] PGUSER len: ${(process.env.PGUSER || '').length}, PGPASSWORD len: ${(process.env.PGPASSWORD || '').length}, PGHOST: "${process.env.PGHOST}", PGPORT: "${process.env.PGPORT}", PGDATABASE: "${process.env.PGDATABASE}"`);
}

// זהה לדפוס ב-hazmanat-sfarim: SSL נשלט דרך PGSSL, לא מנוחש.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

export function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
