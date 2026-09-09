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

/** כל התשלומים במערכת, עם פרטי ההזמנה/לקוח — לדוח תשלומים בפאנל הניהול. */
export async function listAllPayments() {
  const { rows } = await pool.query(
    `SELECT p.*, o.order_number, o.order_sequence, o.customer_name, o.phone
       FROM payments p
       JOIN orders o ON o.id = p.order_id
      ORDER BY p.created_at DESC`
  );
  return rows.map((p) => ({
    id: p.id, orderId: p.order_id, orderNumber: p.order_number, orderSequence: p.order_sequence,
    customerName: p.customer_name, phone: p.phone,
    amount: Number(p.amount), method: p.method, recordedBy: p.recorded_by, note: p.note, createdAt: p.created_at,
  }));
}

/**
 * תשלום ידני מהפאנל, ברמת הלקוח (לא הזמנה בודדת) — "מפל" בדיוק כמו נדרים
 * פלוס: מקצה את הסכום שהמנהל הקליד על ההזמנות הפתוחות של הטלפון, הישנה
 * ביותר קודם, ורושם שורת payments לכל הזמנה שנפרעה/נפרעה חלקית.
 */
export async function recordManualPaymentForCustomer(normalizedPhone, amount, method, recordedBy, note) {
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
  return withTransaction(async (client) => {
    const { rows: orders } = await client.query(
      `SELECT o.id, b.balance_due
         FROM orders o
         JOIN order_balances b ON b.order_id = o.id
        WHERE o.normalized_phone = $1 AND NOT o.is_deleted AND b.balance_due > 0
        ORDER BY o.order_sequence ASC
        FOR UPDATE OF o`,
      [normalizedPhone]
    );
    let remaining = amt;
    const allocations = [];
    for (const order of orders) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, Number(order.balance_due));
      if (take <= 0) continue;
      await client.query(
        `INSERT INTO payments(order_id, amount, method, recorded_by, note) VALUES ($1,$2,$3,$4,$5)`,
        [order.id, take, method, recordedBy, note || null]
      );
      allocations.push({ orderId: order.id, amount: take });
      remaining -= take;
    }
    if (!allocations.length) {
      const err = new Error('אין יתרת חוב פתוחה ללקוח זה.');
      err.status = 400;
      throw err;
    }
    await logAction('payment_recorded_manual', { phone: normalizedPhone, amount: amt, method, recordedBy, note: note || null, allocations, unallocatedSurplus: remaining }, client);
    return { allocations, unallocatedSurplus: remaining };
  });
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

/** מפל משותף: מקצה amount על ההזמנות הפתוחות של הטלפון, הישנה קודם. קורא בתוך withTransaction קיים (client מועבר). */
async function allocateAcrossOpenOrders(client, normalizedPhone, amount, { transactionId = null, recordedBy = 'customer' } = {}) {
  const { rows: orders } = await client.query(
    `SELECT o.id, b.balance_due
       FROM orders o
       JOIN order_balances b ON b.order_id = o.id
      WHERE o.normalized_phone = $1 AND NOT o.is_deleted AND b.balance_due > 0
      ORDER BY o.order_sequence ASC
      FOR UPDATE OF o`,
    [normalizedPhone]
  );
  let remaining = Number(amount);
  const allocations = [];
  for (const order of orders) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(order.balance_due));
    if (take <= 0) continue;
    await client.query(
      `INSERT INTO payments(order_id, amount, method, nedarim_transaction_id, recorded_by)
       VALUES ($1,$2,'nedarim_plus',$3,$4)`,
      [order.id, take, transactionId, recordedBy]
    );
    allocations.push({ orderId: order.id, amount: take });
    remaining -= take;
  }
  return { allocations, unallocatedSurplus: remaining };
}

/**
 * מופעל מה-Webhook (אחרי אימות חתימה) — מקור האמת האמיתי, מגיע מהשרת של
 * נדרים פלוס. מקצה את הסכום ששולם בפועל (מהעדכון של נדרים פלוס, לא מה-
 * session) על ההזמנות הפתוחות של הטלפון. אידמפוטנטי: session שכבר completed
 * לא מוקצה שוב — כך שאם גם האישור האופטימי מהלקוח וגם ה-Webhook מגיעים,
 * לא נרשם תשלום כפול.
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

    const { allocations, unallocatedSurplus } = await allocateAcrossOpenOrders(
      client, session.normalized_phone, Number(paidAmount), { transactionId, recordedBy: 'customer' }
    );

    await client.query(
      `UPDATE payment_sessions SET status='completed', nedarim_transaction_id=$2, completed_at=now() WHERE id=$1`,
      [session.id, transactionId]
    );

    await logAction('payment_received_nedarim', {
      phone: session.normalized_phone, transactionId, paidAmount: Number(paidAmount),
      allocations, unallocatedSurplus,
    }, client);

    return { allocated: true, allocations, unallocatedSurplus };
  });
}

/**
 * אישור אופטימי מהלקוח: מופעל כשהדפדפן מקבל Status:'OK' מהאייפרם, בלי
 * לחכות ל-Webhook. לא סומכים על שום דבר שהלקוח טוען — הסכום שמוקצה הוא
 * requested_amount שכבר ננעל בשרת כשה-session נוצר (*לפני* שהלקוח בכלל
 * שילם), לא סכום שמגיע עכשיו מהדפדפן. הסיכון היחיד שנשאר הוא שהלקוח יזייף
 * "הצלחתי" בלי לשלם בפועל — סיכון שהוחלט להשלים איתו בשלב זה כדי לא לחכות
 * ל-Webhook (ראו גם getStalePendingPaymentAlert לזיהוי המקרה ההפוך — תשלום
 * שכן בוצע אבל לא התקבל עליו שום אישור). אידמפוטנטי מול allocateNedarimPayment:
 * שני הנתיבים בודקים session.status==='completed' לפני הקצאה.
 */
export async function confirmClientReportedPayment(token, normalizedPhone, transactionId) {
  return withTransaction(async (client) => {
    const { rows: sessionRows } = await client.query(
      `SELECT * FROM payment_sessions WHERE token = $1 FOR UPDATE`,
      [token]
    );
    const session = sessionRows[0];
    if (!session) {
      const err = new Error('בקשת התשלום לא נמצאה.');
      err.status = 404;
      throw err;
    }
    if (session.normalized_phone !== normalizedPhone) {
      const err = new Error('בקשת התשלום לא שייכת לטלפון זה.');
      err.status = 403;
      throw err;
    }
    if (session.status === 'completed') {
      return { allocated: false, reason: 'already_completed' };
    }

    const { allocations, unallocatedSurplus } = await allocateAcrossOpenOrders(
      client, normalizedPhone, Number(session.requested_amount), { transactionId: transactionId || null, recordedBy: 'client_confirmed' }
    );

    await client.query(
      `UPDATE payment_sessions SET status='completed', nedarim_transaction_id=$2, completed_at=now() WHERE id=$1`,
      [session.id, transactionId || null]
    );

    await logAction('payment_client_confirmed', {
      phone: normalizedPhone, transactionId: transactionId || null, amount: Number(session.requested_amount),
      allocations, unallocatedSurplus, note: 'אושר לפי תגובת הדפדפן בלבד — טרם התקבל אימות Webhook לעסקה זו.',
    }, client);

    return { allocated: true, allocations, unallocatedSurplus };
  });
}

/**
 * מנהל בדק ידנית (מול נדרים פלוס) והחליט שאין כאן תשלום אמיתי לטפל בו —
 * מסמן את ה-session כ-'dismissed' כדי שיפסיק להופיע כאזהרה "ייתכן שיש
 * תשלום שלא אושר". לא נוגע בהזמנות/תשלומים בכלל, רק מפסיק להתריע.
 */
export async function dismissStalePaymentSession(token, adminName) {
  const { rows } = await pool.query(
    `UPDATE payment_sessions SET status = 'dismissed' WHERE token = $1 AND status = 'pending' RETURNING *`,
    [token]
  );
  if (!rows.length) {
    const err = new Error('בקשת התשלום לא נמצאה או שכבר טופלה.');
    err.status = 404;
    throw err;
  }
  await logAction('payment_alert_dismissed', {
    phone: rows[0].normalized_phone, amount: Number(rows[0].requested_amount), adminName,
  });
  return { success: true };
}
