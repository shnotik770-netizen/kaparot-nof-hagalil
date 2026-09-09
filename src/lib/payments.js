// יומן תשלומים: רישום ידני ע"י מנהל, וקבלת תשלומים אמיתיים מנדרים פלוס
// (payment_sessions + הקצאה ב"מפל" על הזמנות פתוחות — ראו docs/nedarim-plus-integration.md).

import crypto from 'node:crypto';
import { pool, withTransaction } from '../db/pool.js';
import { logAction } from './actionLog.js';

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
  await logAction('payment_recorded_manual', { orderId, amount: amt, method, recordedBy, note: note || null });
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

/** נוצר כשהלקוח לוחץ "תשלום" — ה-token נשלח כ-Param2 לנדרים פלוס ומזהה את הבקשה כשה-Webhook חוזר. */
export async function createPaymentSession(normalizedPhone, requestedAmount) {
  const token = crypto.randomBytes(16).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO payment_sessions(token, normalized_phone, requested_amount)
     VALUES ($1,$2,$3) RETURNING *`,
    [token, normalizedPhone, requestedAmount]
  );
  return rows[0];
}

/**
 * מופעל מה-Webhook (אחרי אימות חתימה). מקצה את הסכום ששולם בפועל (מהעדכון
 * של נדרים פלוס, לא מה-session) על ההזמנות הפתוחות של הטלפון, "מפל" מהישנה
 * לחדשה — עד שהסכום נגמר. אידמפוטנטי: session שכבר completed לא מוקצה שוב.
 */
export async function allocateNedarimPayment({ token, transactionId, paidAmount }) {
  return withTransaction(async (client) => {
    const { rows: sessionRows } = await client.query(
      `SELECT * FROM payment_sessions WHERE token = $1 FOR UPDATE`,
      [token]
    );
    const session = sessionRows[0];
    if (!session) return { allocated: false, reason: 'unknown_session' };
    if (session.status === 'completed') return { allocated: false, reason: 'already_completed' };

    const { rows: orders } = await client.query(
      `SELECT o.id, b.balance_due
         FROM orders o
         JOIN order_balances b ON b.order_id = o.id
        WHERE o.normalized_phone = $1 AND NOT o.is_deleted AND b.balance_due > 0
        ORDER BY o.order_sequence ASC
        FOR UPDATE OF o`,
      [session.normalized_phone]
    );

    let remaining = Number(paidAmount);
    const allocations = [];
    for (const order of orders) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, Number(order.balance_due));
      if (take <= 0) continue;
      await client.query(
        `INSERT INTO payments(order_id, amount, method, nedarim_transaction_id, recorded_by)
         VALUES ($1,$2,'nedarim_plus',$3,'customer')`,
        [order.id, take, transactionId]
      );
      allocations.push({ orderId: order.id, amount: take });
      remaining -= take;
    }

    await client.query(
      `UPDATE payment_sessions SET status='completed', nedarim_transaction_id=$2, completed_at=now() WHERE id=$1`,
      [session.id, transactionId]
    );

    await logAction('payment_received_nedarim', {
      phone: session.normalized_phone, transactionId, paidAmount: Number(paidAmount),
      allocations, unallocatedSurplus: remaining,
    }, client);

    return { allocated: true, allocations, unallocatedSurplus: remaining };
  });
}
