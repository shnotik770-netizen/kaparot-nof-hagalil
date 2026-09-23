// טופס רישום עצמאי לסעודות שמחת תורה — במכוון לא בנוי על מודל ההזמנות/
// כפרות (orders/payments/order_balances): תהליך שונה לגמרי — טופס פשוט +
// תשלום קבוע חד-פעמי חובה לסיום ההרשמה, בלי איסוף/פדיון. אותה שיטת
// אינטגרציה מול נדרים פלוס (createTransaction/Webhook, ראו lib/nedarim.js)
// אבל עם state עצמאי משלה (seudot_registrations), כדי לא לגעת בכלל
// בזרימת הכפרות הקיימת.

import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { logAction } from './actionLog.js';

export const SEUDOT_AMOUNT = 200;

function mapRow(r) {
  return {
    id: r.id,
    token: r.token,
    fullName: r.full_name,
    adultsCount: r.adults_count,
    childrenCount: r.children_count,
    amount: Number(r.amount),
    status: r.status,
    viaCoupon: r.via_coupon,
    nedarimTransactionId: r.nedarim_transaction_id,
    createdAt: r.created_at,
    paidAt: r.paid_at,
  };
}

/**
 * viaCoupon=true (קוד קופון תקין שהוזן בטופס, ראו routes/api.js) — נרשם
 * ישר כ'paid', amount=0, בלי לפנות בכלל לנדרים פלוס. עדיין מקבל token
 * (לעריכה עצמית עתידית ולעקביות עם הזרימה הרגילה), רק לא לתשלום.
 */
export async function createSeudotRegistration({ fullName, adultsCount, childrenCount, viaCoupon = false }) {
  const token = crypto.randomBytes(16).toString('hex');
  if (viaCoupon) {
    const { rows } = await pool.query(
      `INSERT INTO seudot_registrations(token, full_name, adults_count, children_count, amount, status, via_coupon, paid_at)
       VALUES ($1,$2,$3,$4,0,'paid',true,now()) RETURNING *`,
      [token, fullName, adultsCount, childrenCount]
    );
    await logAction('seudot_registration_via_coupon', { token, fullName, adultsCount, childrenCount });
    return mapRow(rows[0]);
  }
  const { rows } = await pool.query(
    `INSERT INTO seudot_registrations(token, full_name, adults_count, children_count, amount)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [token, fullName, adultsCount, childrenCount, SEUDOT_AMOUNT]
  );
  await logAction('seudot_registration_created', { token, fullName, adultsCount, childrenCount, amount: SEUDOT_AMOUNT });
  return mapRow(rows[0]);
}

export async function getSeudotRegistrationByToken(token) {
  if (!token) return null;
  const { rows } = await pool.query(`SELECT * FROM seudot_registrations WHERE token = $1`, [token]);
  return rows[0] ? mapRow(rows[0]) : null;
}

/** עריכה עצמית של הלקוח (שם/כמות נפשות) — ידיעת ה-token היא ההרשאה, ראו routes/api.js
 * שבודק שם גם את חלון הזמן (עד סגירת הרשימה) לפני קריאה לפונקציה הזו. */
export async function updateSeudotRegistration(token, { fullName, adultsCount, childrenCount }) {
  const { rows } = await pool.query(
    `UPDATE seudot_registrations SET full_name=$2, adults_count=$3, children_count=$4
      WHERE token=$1 RETURNING *`,
    [token, fullName, adultsCount, childrenCount]
  );
  if (!rows.length) return null;
  await logAction('seudot_registration_updated', { token, fullName, adultsCount, childrenCount });
  return mapRow(rows[0]);
}

/**
 * אישור אופטימי מהדפדפן (Status:'OK' מהאייפרם) — לא מחכה ל-Webhook, ראו
 * confirmClientReportedPayment ב-payments.js להסבר המלא של הדפוס. אידמפוטנטי:
 * UPDATE ... WHERE status='pending' לא עושה כלום אם כבר סומן 'paid'
 * (בין ע"י הקריאה האופטימית הזו ובין ע"י ה-Webhook), כך שאין רישום כפול.
 */
export async function confirmSeudotPaymentClient(token, transactionId) {
  const { rows } = await pool.query(
    `UPDATE seudot_registrations SET status='paid', nedarim_transaction_id=$2, paid_at=now()
      WHERE token=$1 AND status='pending' RETURNING *`,
    [token, transactionId || null]
  );
  if (!rows.length) return { updated: false };
  await logAction('seudot_payment_client_confirmed', {
    token, transactionId: transactionId || null, fullName: rows[0].full_name,
    note: 'אושר לפי תגובת הדפדפן בלבד — טרם התקבל אימות Webhook לעסקה זו.',
  });
  return { updated: true };
}

/** מופעל מה-Webhook (אחרי אימות חתימה) — מקור האמת האמיתי. אידמפוטנטי מול confirmSeudotPaymentClient. */
export async function allocateSeudotPayment({ token, transactionId }) {
  const { rows } = await pool.query(
    `UPDATE seudot_registrations SET status='paid', nedarim_transaction_id=$2, paid_at=now()
      WHERE token=$1 AND status='pending' RETURNING *`,
    [token, transactionId || null]
  );
  if (!rows.length) {
    const { rows: existing } = await pool.query(`SELECT id FROM seudot_registrations WHERE token = $1`, [token]);
    return { allocated: false, reason: existing.length ? 'already_paid' : 'unknown_token' };
  }
  await logAction('seudot_payment_received_webhook', {
    token, transactionId: transactionId || null, fullName: rows[0].full_name,
  });
  return { allocated: true };
}

// רק הרשמות ששולמו בפועל (כולל קופון) — מי שמילא את הטופס ולא השלים
// תשלום לא "נרשם" בפועל ולא אמור להופיע בדוח למנהל; עדיין קיים כרשומה
// ב-DB ומתועד ב-admin_actions (seudot_registration_created), למי שצריך
// לחפש שם ספציפית, ראו logAction ב-createSeudotRegistration.
export async function listSeudotRegistrations() {
  const { rows } = await pool.query(`SELECT * FROM seudot_registrations WHERE status = 'paid' ORDER BY created_at DESC`);
  return rows.map(mapRow);
}
