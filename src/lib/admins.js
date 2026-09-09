// מנהלים: כל אחד עם שם, טלפון וסיסמה קבועה משלו, וארבע הרשאות עצמאיות
// (הגדרות / הזמנות ותשלומים / דשבורד / זמני חלוקה) שקובעות אילו טאבים
// יראה בפאנל הניהול.

import bcrypt from 'bcryptjs';
import { query } from '../db/pool.js';
import { normalizePhone } from './normalize.js';
import { logAction } from './actionLog.js';

function rowToAdmin(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    normalizedPhone: row.normalized_phone,
    permissions: {
      settings: row.can_settings,
      orders: row.can_orders,
      dashboard: row.can_dashboard,
      slots: row.can_slots,
    },
    createdAt: row.created_at,
  };
}

export async function countAdmins() {
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM admins`);
  return rows[0].n;
}

export async function listAdmins() {
  const { rows } = await query(`SELECT * FROM admins ORDER BY created_at ASC`);
  return rows.map(rowToAdmin);
}

export async function getAdminByPhone(phone) {
  const normalized = normalizePhone(phone);
  const { rows } = await query(`SELECT * FROM admins WHERE normalized_phone = $1`, [normalized]);
  return rows.length ? { ...rowToAdmin(rows[0]), passwordHash: rows[0].password_hash } : null;
}

export async function createAdmin({ name, phone, password, permissions = {} }) {
  const clean = String(name || '').trim();
  const normalized = normalizePhone(phone);
  if (!clean) {
    const err = new Error('חסר שם.');
    err.status = 400;
    throw err;
  }
  if (!normalized) {
    const err = new Error('מספר טלפון לא תקין.');
    err.status = 400;
    throw err;
  }
  if (!password || String(password).length < 6) {
    const err = new Error('סיסמה חייבת להכיל לפחות 6 תווים.');
    err.status = 400;
    throw err;
  }
  const hash = await bcrypt.hash(String(password), 12);
  const { rows } = await query(
    `INSERT INTO admins(name, phone, normalized_phone, password_hash, can_settings, can_orders, can_dashboard, can_slots)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      clean, phone, normalized, hash,
      permissions.settings !== false, permissions.orders !== false,
      permissions.dashboard !== false, permissions.slots !== false,
    ]
  );
  const admin = rowToAdmin(rows[0]);
  await logAction('admin_created', { adminId: admin.id, name: admin.name, phone: admin.normalizedPhone, permissions: admin.permissions });
  return admin;
}

/** password ריק/לא נשלח = לא משנים את הסיסמה הקיימת. */
export async function updateAdmin(id, { name, phone, password, permissions = {} }) {
  const normalized = normalizePhone(phone);
  const passwordChanged = !!(password && String(password).length >= 6);
  let admin;
  if (passwordChanged) {
    const hash = await bcrypt.hash(String(password), 12);
    const { rows } = await query(
      `UPDATE admins SET name=$2, phone=$3, normalized_phone=$4, password_hash=$5,
         can_settings=$6, can_orders=$7, can_dashboard=$8, can_slots=$9
       WHERE id=$1 RETURNING *`,
      [id, name, phone, normalized, hash, permissions.settings !== false, permissions.orders !== false, permissions.dashboard !== false, permissions.slots !== false]
    );
    if (!rows.length) throw Object.assign(new Error('מנהל לא נמצא.'), { status: 404 });
    admin = rowToAdmin(rows[0]);
  } else {
    const { rows } = await query(
      `UPDATE admins SET name=$2, phone=$3, normalized_phone=$4,
         can_settings=$5, can_orders=$6, can_dashboard=$7, can_slots=$8
       WHERE id=$1 RETURNING *`,
      [id, name, phone, normalized, permissions.settings !== false, permissions.orders !== false, permissions.dashboard !== false, permissions.slots !== false]
    );
    if (!rows.length) throw Object.assign(new Error('מנהל לא נמצא.'), { status: 404 });
    admin = rowToAdmin(rows[0]);
  }
  await logAction('admin_updated', { adminId: admin.id, name: admin.name, phone: admin.normalizedPhone, permissions: admin.permissions, passwordChanged });
  return admin;
}

export async function deleteAdmin(id) {
  const { rows } = await query(`SELECT name, normalized_phone FROM admins WHERE id = $1`, [id]);
  await query(`DELETE FROM admins WHERE id = $1`, [id]);
  if (rows.length) {
    await logAction('admin_deleted', { adminId: id, name: rows[0].name, phone: rows[0].normalized_phone });
  }
  return { success: true };
}

export async function verifyAdminCredentials(phone, password) {
  const admin = await getAdminByPhone(phone);
  if (!admin) {
    const err = new Error('מספר טלפון או סיסמה שגויים.');
    err.status = 401;
    throw err;
  }
  const ok = await bcrypt.compare(String(password || ''), admin.passwordHash);
  if (!ok) {
    const err = new Error('מספר טלפון או סיסמה שגויים.');
    err.status = 401;
    throw err;
  }
  delete admin.passwordHash;
  return admin;
}
