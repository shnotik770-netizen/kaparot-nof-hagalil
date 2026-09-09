import pg from 'pg';

const { Pool } = pg;

// אבחון זמני — לא מדפיס את הערך עצמו, רק אם הוא קיים ומאיפה host/port נגזרים.
console.log(`[db] DATABASE_URL present: ${!!process.env.DATABASE_URL}, length: ${(process.env.DATABASE_URL || '').length}`);

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
