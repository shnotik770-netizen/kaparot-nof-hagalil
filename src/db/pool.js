import pg from 'pg';

const { Pool } = pg;

// זהה לדפוס ב-hazmanat-sfarim: SSL נשלט דרך PGSSL, לא מנוחש.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000, // כשל מהיר אם Postgres לא זמין, במקום להיתקע לנצח
});

// קריטי: בלי מאזין כאן, שגיאת רשת חולפת על לקוח לא-פעיל בבריכה (תקלה ידועה
// ב-pg) הופכת ל-uncaught exception שמפילה את כל התהליך — כלומר את השירות
// לכל הלקוחות בבת אחת, בדיוק כשיש הרבה בקשות בו-זמנית.
pool.on('error', (err) => {
  console.error('[db pool] unexpected error on idle client', err);
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
