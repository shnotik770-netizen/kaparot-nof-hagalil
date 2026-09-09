// יומן תשלומים — כרגע רק רישום ידני ע"י מנהל (סליקת נדרים פלוס תתווסף בנפרד,
// ראו webhook_events בסכימה + ההערה ב-routes/api.js).

import { pool } from '../db/pool.js';

export async function recordManualPayment(orderId, amount, method, recordedBy, note) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    const err = new Error('סכום לא תקין.');
    err.status = 400;
    throw err;
  }
  if (!['manual_cash', 'manual_card', 'manual_admin'].includes(method)) {
    const err = new Error('אמצעי תשלום לא תקין.');
    err.status = 400;
    throw err;
  }
  const { rows } = await pool.query(
    `INSERT INTO payments(order_id, amount, method, recorded_by, note)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [orderId, amt, method, recordedBy, note || null]
  );
  return rows[0];
}

export async function listPaymentsForOrder(orderId) {
  const { rows } = await pool.query(
    `SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC`,
    [orderId]
  );
  return rows.map((p) => ({
    id: p.id, amount: Number(p.amount), method: p.method, recordedBy: p.recorded_by,
    note: p.note, createdAt: p.created_at,
  }));
}
