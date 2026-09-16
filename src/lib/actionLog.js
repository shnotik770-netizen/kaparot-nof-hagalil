// יומן פעולות: כל פעולה משמעותית במערכת (הזמנה, תשלום, מימוש, שינוי הגדרות/זמנים/מנהלים,
// כניסת מנהל) נרשמת כאן — כדי שיהיה תיעוד מלא ואפשר יהיה לאתר תקלות אחורה.
// כתיבה בתוך טרנזקציה (client מועבר) שומרת על אטומיות עם הפעולה עצמה.

import { pool } from '../db/pool.js';

export async function logAction(actionType, details = {}, client = pool) {
  await client.query(
    `INSERT INTO admin_actions(action_type, details) VALUES ($1, $2::jsonb)`,
    [actionType, JSON.stringify(details)]
  );
}

export async function listActions({ limit = 200, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, action_type, details, created_at FROM admin_actions ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [Math.min(Number(limit) || 200, 500), Math.max(Number(offset) || 0, 0)]
  );
  return rows.map((r) => ({
    id: r.id,
    actionType: r.action_type,
    details: r.details,
    createdAt: r.created_at,
  }));
}

/** כל היומן, כרונולוגי (ישן לחדש) — בלי הגבלת 500 של listActions, לצורך גיבוי מלא (ראו sheetsSync.js). */
export async function listAllActions() {
  const { rows } = await pool.query(
    `SELECT id, action_type, details, created_at FROM admin_actions ORDER BY created_at ASC`
  );
  return rows.map((r) => ({
    id: r.id,
    actionType: r.action_type,
    details: r.details,
    createdAt: r.created_at,
  }));
}
