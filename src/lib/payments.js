// יומן תשלומים: רישום ידני ע"י מנהל, וקבלת תשלומים אמיתיים מנדרים פלוס
// (payment_sessions + הקצאה ב"מפל" על הזמנות פתוחות — ראו docs/nedarim-plus-integration.md).

import crypto from 'node:crypto';
import { pool, withTransaction } from '../db/pool.js';
import { logAction } from './actionLog.js';
import { setCustomerCaseClosed } from './adminOps.js';

/**
 * תשלום שהתקבל בפועל מנדרים פלוס דרך מודול הסליקה הטלפוני של ימות המשיח
 * (ערוץ נפרד לגמרי מה-Webhook של האתר — ראו docs/nedarim-plus-integration.md
 * ו-src/routes/ivr.js: שם ימות המשיח מדבר ישירות מול נדרים פלוס ומחזיר לנו
 * רק CreditCard_CODE). ההזמנה כבר נוצרה ברגע הזה עם הסכום המדויק שחויב —
 * זו שורת תשלום בודדת שסוגרת אותה במלואה, בלי צורך ב"מפל" כמו בתשלום ידני-כללי.
 */
export async function recordIvrNedarimPayment(orderId, amount, note) {
  const { rows } = await pool.query(
    `INSERT INTO payments(order_id, amount, method, recorded_by, note)
     VALUES ($1,$2,'nedarim_plus','customer',$3) RETURNING *`,
    [orderId, amount, note || null]
  );
  await logAction('payment_received_nedarim_ivr', { orderId, amount: Number(amount), note: note || null });
  return rows[0];
}

export async function recordManualPayment(orderId, amount, method, recordedBy, note) {
  const amt = Number(amount);
  // סכום שלילי מותר בכוונה — זיכוי/תיקון ידני עבור לקוח ששילם על הזמנה
  // שתוקנה אח"כ למטה במחיר (ראו גם payments_amount_check בסכימה).
  if (!Number.isFinite(amt) || amt === 0) {
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
 * סכום שלילי (זיכוי/תיקון, למשל ללקוח ששילם על הזמנה שתוקנה אח"כ למטה
 * במחיר) מטופל אחרת — ראו recordCustomerCredit.
 */
export async function recordManualPaymentForCustomer(normalizedPhone, amount, method, recordedBy, note) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt === 0) {
    const err = new Error('סכום לא תקין.');
    err.status = 400;
    throw err;
  }
  if (!['manual_cash', 'manual_card', 'manual_admin'].includes(method)) {
    const err = new Error('אמצעי תשלום לא תקין.');
    err.status = 400;
    throw err;
  }
  if (amt < 0) {
    return recordCustomerCredit(normalizedPhone, amt, method, recordedBy, note);
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

/**
 * זיכוי/תיקון (סכום שלילי) ברמת הלקוח — מזהה אוטומטית הזמנה להצמיד אליה
 * את התשלום השלילי. מעדיפה הזמנה שכבר במצב עודף תשלום (balance_due שלילי,
 * הכי גדול קודם — בד"כ תיקון מחיר ידני שהוריד את הסכום אחרי ששולם), ואם
 * אין כזו — הזמנה ששולמה במלואה בדיוק (balance_due = 0), כדי לתמוך גם
 * בזיכוי/החזר יזום ללקוח (למשל השיב "לא מגיע" ומבקש זיכוי על מה ששילם).
 * חסום לסכום שלא עולה על שווי העופות שעדיין לא נאספו אצל הלקוח (ראו
 * uncollectedValue) — אי אפשר לזכות על עופות שכבר נמסרו בפועל. לא "מפל"
 * כמו סכום חיובי — זו תמיד הזמנה אחת.
 */
async function recordCustomerCredit(normalizedPhone, amt, method, recordedBy, note) {
  return withTransaction(async (client) => {
    // חוסם זיכוי מעבר לשווי העופות שעדיין לא נאספו — עופות שכבר נמסרו
    // ללקוח כבר "נוצלו", ואי אפשר לזכות עליהם בדיעבד. סופר רק פריטים
    // מהזמנות עם balance_due <= 0 — בדיוק אותו תנאי שלפיו נבחרת למטה
    // הזמנת-היעד לזיכוי; הזמנה עם חוב פתוח לא יכולה לשמש יעד, אז אין
    // טעם לספור את הפריטים שלה בתקרה (אחרת הלקוח "יכול" לזכות על סכום
    // שהשרת בפועל ידחה כי אין הזמנה מתאימה לרשום מולה).
    const { rows: valueRows } = await client.query(
      `SELECT COALESCE(SUM((oi.quantity - oi.quantity_redeemed) * oi.unit_price), 0) AS uncollected_value
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN order_balances b ON b.order_id = o.id
        WHERE o.normalized_phone = $1 AND NOT o.is_deleted AND b.balance_due <= 0`,
      [normalizedPhone]
    );
    const uncollectedValue = Number(valueRows[0].uncollected_value);
    if (Math.abs(amt) > uncollectedValue) {
      const err = new Error(`אפשר לזכות עד ${uncollectedValue} — שווי העופות שעדיין לא נאספו (לא ניתן לזכות על עופות שכבר נמסרו).`);
      err.status = 400;
      throw err;
    }

    const { rows: orders } = await client.query(
      `SELECT o.id, b.balance_due
         FROM orders o
         JOIN order_balances b ON b.order_id = o.id
        WHERE o.normalized_phone = $1 AND NOT o.is_deleted AND b.balance_due <= 0
        ORDER BY b.balance_due ASC, o.order_sequence ASC
        FOR UPDATE OF o`,
      [normalizedPhone]
    );
    if (!orders.length) {
      const err = new Error('לא נמצאה ללקוח זה הזמנה ששולמה (חלקית או במלואה) לרישום הזיכוי מולה.');
      err.status = 400;
      throw err;
    }
    const target = orders[0];
    await client.query(
      `INSERT INTO payments(order_id, amount, method, recorded_by, note) VALUES ($1,$2,$3,$4,$5)`,
      [target.id, amt, method, recordedBy, note || null]
    );
    await logAction('payment_recorded_manual', {
      phone: normalizedPhone, amount: amt, method, recordedBy, note: note || null,
      allocations: [{ orderId: target.id, amount: amt }], unallocatedSurplus: 0, isCredit: true,
    }, client);

    // זיכוי שמכסה בדיוק את מלוא שווי העופות שלא נאספו — אין יותר מה לעקוב
    // אחרי הלקוח הזה, סוגרים את התיק אוטומטית (אותה טרנזקציה, אטומי).
    if (uncollectedValue > 0 && Math.abs(amt) === uncollectedValue) {
      await setCustomerCaseClosed(
        normalizedPhone,
        `זוכה מלוא שווי העופות שלא נאספו (${uncollectedValue}) — התיק נסגר אוטומטית.`,
        recordedBy,
        client
      );
    }

    return { allocations: [{ orderId: target.id, amount: amt }], unallocatedSurplus: 0 };
  });
}

const MANUAL_METHODS = new Set(['manual_cash', 'manual_card', 'manual_admin']);

function assertManualPayment(payment) {
  if (!payment) {
    const err = new Error('תשלום לא נמצא.');
    err.status = 404;
    throw err;
  }
  if (!MANUAL_METHODS.has(payment.method)) {
    const err = new Error('לא ניתן לערוך/למחוק תשלום שהתקבל אוטומטית מנדרים פלוס — רק תשלומים שהוזנו ידנית ניתנים לעריכה/מחיקה.');
    err.status = 400;
    throw err;
  }
}

/** עריכת תשלום שהוזן ידנית (תיקון טעות הקלדה) — לא נוגעים בתשלומי נדרים פלוס האמיתיים. */
export async function updateManualPayment(paymentId, { amount, method, note }, adminName) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt === 0) {
    const err = new Error('סכום לא תקין.');
    err.status = 400;
    throw err;
  }
  if (!MANUAL_METHODS.has(method)) {
    const err = new Error('אמצעי תשלום לא תקין.');
    err.status = 400;
    throw err;
  }
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]);
    const payment = rows[0];
    assertManualPayment(payment);
    await client.query(
      `UPDATE payments SET amount = $2, method = $3, note = $4 WHERE id = $1`,
      [paymentId, amt, method, note || null]
    );
    await logAction('payment_edited', {
      paymentId, orderId: payment.order_id,
      oldAmount: Number(payment.amount), newAmount: amt,
      oldMethod: payment.method, newMethod: method,
      adminName,
    }, client);
    return { success: true };
  });
}

/** מחיקת תשלום שהוזן ידנית (הוקלד בטעות) — לא נוגעים בתשלומי נדרים פלוס האמיתיים. */
export async function deleteManualPayment(paymentId, adminName) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]);
    const payment = rows[0];
    assertManualPayment(payment);
    await client.query(`DELETE FROM payments WHERE id = $1`, [paymentId]);
    await logAction('payment_deleted', {
      paymentId, orderId: payment.order_id, amount: Number(payment.amount), method: payment.method, adminName,
    }, client);
    return { success: true };
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
 * הדפדפן מדווח שהאייפרם החזיר Status שאינו 'OK' (כישלון/ביטול מפורש בתוך
 * נדרים פלוס) — זה איתות שלילי וודאי, לא רק "לא קיבלנו תשובה". בלי זה,
 * ה-session היה נשאר 'pending' ומצטרף כעבור 10 דקות לאזהרת "ייתכן שיש
 * תשלום שלא אושר" בפאנל הניהול, אף שידוע בוודאות שהתשלום הזה לא עבר.
 * לא זורקת שגיאה אם ה-session לא נמצא/כבר טופל — זה איתות best-effort,
 * לא פעולת מנהל.
 */
export async function cancelPaymentSession(token, normalizedPhone) {
  const { rows } = await pool.query(
    `UPDATE payment_sessions SET status = 'dismissed'
      WHERE token = $1 AND normalized_phone = $2 AND status = 'pending'
      RETURNING id`,
    [token, normalizedPhone]
  );
  return { success: rows.length > 0 };
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

/**
 * כמו dismissStalePaymentSession, אבל מסמן בבת אחת את כל בקשות התשלום
 * הממתינות/הישנות של אותו לקוח — כדי שהתראה אחת מכסה כמה ניסיונות תשלום
 * כושלים שהצטברו (לא צריך ללחוץ "בדקתי" בנפרד על כל ניסיון).
 */
export async function dismissAllStalePaymentSessions(normalizedPhone, adminName) {
  const { rows } = await pool.query(
    `UPDATE payment_sessions SET status = 'dismissed'
      WHERE normalized_phone = $1 AND status = 'pending' AND created_at < now() - interval '10 minutes'
      RETURNING id, requested_amount`,
    [normalizedPhone]
  );
  if (!rows.length) {
    const err = new Error('לא נמצאו בקשות תשלום ממתינות עבור לקוח זה.');
    err.status = 404;
    throw err;
  }
  await logAction('payment_alert_dismissed', {
    phone: normalizedPhone, count: rows.length,
    totalAmount: rows.reduce((sum, r) => sum + Number(r.requested_amount), 0), adminName,
  });
  return { success: true, dismissedCount: rows.length };
}
