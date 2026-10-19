// טופס רישום עצמאי "הישיבה הגדולה" — אישור הגעה פשוט, בלי שום תשלום (בשונה
// מ-seudot.js) ובלי קישור עריכה עצמית ללקוח: עריכה/מחיקה רק ע"י מנהל.

import { pool } from '../db/pool.js';
import { logAction } from './actionLog.js';
import { normalizePhone } from './normalize.js';

export const ATTENDANCE_VALUES = ['coming', 'checking', 'not_coming'];

function mapRow(r) {
  return {
    id: r.id,
    fullName: r.full_name,
    phone: r.phone,
    attendance: r.attendance,
    email: r.email,
    address: r.address,
    createdAt: r.created_at,
  };
}

/**
 * Upsert לפי מספר טלפון — מי שממלא את הטופס שוב עם אותו מספר (לשנות את
 * הבחירה/הכתובת/הפרטים) מעדכן את הרשומה הקיימת שלו, לא יוצר רשומה כפולה.
 * בכוונה בלי לחשוף בחזרה לדפדפן מה היה רשום קודם (בניגוד לאזור האישי של
 * הכפרות, שם יש אימות OTP לפני חשיפת פרטים) — הטופס תמיד מתחיל ריק, רק
 * ה-DB "זוכר" ומחליף לפי טלפון.
 */
export async function createYeshivaRegistration({ fullName, phone, attendance, email, address }) {
  const normalizedPhone = normalizePhone(phone);
  const { rows: existing } = await pool.query(
    `SELECT id FROM yeshiva_registrations WHERE normalized_phone = $1`, [normalizedPhone]
  );
  if (existing.length) {
    const { rows } = await pool.query(
      `UPDATE yeshiva_registrations SET full_name=$2, phone=$3, attendance=$4, email=$5, address=$6
        WHERE id=$1 RETURNING *`,
      [existing[0].id, fullName, phone, attendance, email || null, address || null]
    );
    await logAction('yeshiva_registration_updated_by_customer', { id: existing[0].id, fullName, phone, attendance, email: email || null, address: address || null });
    return mapRow(rows[0]);
  }
  const { rows } = await pool.query(
    `INSERT INTO yeshiva_registrations(full_name, phone, normalized_phone, attendance, email, address)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [fullName, phone, normalizedPhone, attendance, email || null, address || null]
  );
  await logAction('yeshiva_registration_created', { fullName, phone, attendance, email: email || null, address: address || null });
  return mapRow(rows[0]);
}

export async function listYeshivaRegistrations() {
  const { rows } = await pool.query(`SELECT * FROM yeshiva_registrations ORDER BY created_at DESC`);
  return rows.map(mapRow);
}

/** עריכה/מחיקה ע"י מנהל בלבד (ראו routes/api.js) — אין ללקוח קישור עריכה עצמית. */
export async function updateYeshivaRegistration(id, { fullName, phone, attendance, email, address }, adminName) {
  const normalizedPhone = normalizePhone(phone);
  const { rows } = await pool.query(
    `UPDATE yeshiva_registrations SET full_name=$2, phone=$3, normalized_phone=$4, attendance=$5, email=$6, address=$7
      WHERE id=$1 RETURNING *`,
    [id, fullName, phone, normalizedPhone, attendance, email || null, address || null]
  );
  if (!rows.length) {
    const err = new Error('רשומה לא נמצאה.');
    err.status = 404;
    throw err;
  }
  await logAction('yeshiva_registration_updated', { id, fullName, phone, attendance, adminName });
  return mapRow(rows[0]);
}

export async function deleteYeshivaRegistration(id, adminName) {
  const { rowCount } = await pool.query(`DELETE FROM yeshiva_registrations WHERE id=$1`, [id]);
  if (!rowCount) {
    const err = new Error('רשומה לא נמצאה.');
    err.status = 404;
    throw err;
  }
  await logAction('yeshiva_registration_deleted', { id, adminName });
  return { success: true };
}
