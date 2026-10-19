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

/** שדה אופציונלי (ריק = לא נשלח הפעם): ריק -> שומר את הערך הקודם; זהה
 * לקודם -> אין שינוי בכלל; שונה מהקודם -> מוחלף רק אם confirmOverwrite=true
 * (אחרת נשאר הישן — ראו conflictFields ב-createYeshivaRegistration). */
function mergeOptionalField(newVal, oldVal, confirmOverwrite) {
  const clean = String(newVal || '').trim();
  if (!clean) return oldVal || null;
  if (clean === (oldVal || '')) return clean;
  return confirmOverwrite ? clean : (oldVal || null);
}

/**
 * Upsert לפי מספר טלפון — מילוי הטופס תמיד זהה/רגיל (ראו yeshiva.html), כל
 * הבדיקות והשאלות קורות כאן בשרת מיד עם השליחה, לא לפני:
 * 1. אם כבר קיימת רשומה לטלפון הזה ועדיין לא אושר confirmExisting — מוחזר
 *    needsExistingConfirmation בלי לשמור כלום, כדי שהלקוח יאשר שהוא אכן
 *    מתכוון לשנות תשובה קודמת (אחרת יכול לשנות את הטלפון ולנסות שוב).
 * 2. רק אחרי אישור קיום: שם+הגעה תמיד מוחלפים; אימייל/כתובת ריקים שומרים
 *    על הערך הקודם; ערך חדש ושונה מהקודם, ללא confirmOverwrite, מוחזר
 *    needsConfirmation (עדיין בלי לשמור) עד אישור מפורש לדריסה.
 */
export async function createYeshivaRegistration({ fullName, phone, attendance, email, address, confirmExisting, confirmOverwrite }) {
  const normalizedPhone = normalizePhone(phone);
  const { rows: existingRows } = await pool.query(
    `SELECT * FROM yeshiva_registrations WHERE normalized_phone = $1`, [normalizedPhone]
  );

  if (!existingRows.length) {
    const { rows } = await pool.query(
      `INSERT INTO yeshiva_registrations(full_name, phone, normalized_phone, attendance, email, address)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [fullName, phone, normalizedPhone, attendance, email || null, address || null]
    );
    await logAction('yeshiva_registration_created', { fullName, phone, attendance, email: email || null, address: address || null });
    return { registration: mapRow(rows[0]) };
  }

  if (!confirmExisting) {
    return { needsExistingConfirmation: true };
  }

  const existing = existingRows[0];
  const cleanEmail = String(email || '').trim();
  const cleanAddress = String(address || '').trim();
  const conflictFields = [
    ...(cleanEmail && cleanEmail !== (existing.email || '') ? ['email'] : []),
    ...(cleanAddress && cleanAddress !== (existing.address || '') ? ['address'] : []),
  ];
  if (conflictFields.length && confirmOverwrite === undefined) {
    return { needsConfirmation: true, conflictFields };
  }

  const finalEmail = mergeOptionalField(email, existing.email, confirmOverwrite);
  const finalAddress = mergeOptionalField(address, existing.address, confirmOverwrite);
  const { rows } = await pool.query(
    `UPDATE yeshiva_registrations SET full_name=$2, phone=$3, attendance=$4, email=$5, address=$6
      WHERE id=$1 RETURNING *`,
    [existing.id, fullName, phone, attendance, finalEmail, finalAddress]
  );
  await logAction('yeshiva_registration_updated_by_customer', { id: existing.id, fullName, phone, attendance, email: finalEmail, address: finalAddress });
  return { registration: mapRow(rows[0]) };
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
