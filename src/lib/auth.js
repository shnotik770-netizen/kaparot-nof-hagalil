// כניסת מנהל בשתי שיטות אפשריות (לבחירת המנהל בכל כניסה):
//  1) סיסמה קבועה (bcrypt) — בדיוק כמו במערכת הספרים.
//  2) קוד חד-פעמי בסמס לטלפון שהוגדר כ-admin_phone בהגדרות.

import bcrypt from 'bcryptjs';
import { getSettings, setSetting } from './settings.js';
import { normalizePhone } from './normalize.js';
import { requestOtp, verifyOtp } from './otp.js';

export async function verifyAdminPassword(password) {
  const settings = await getSettings();
  if (!settings.adminPasswordHash) {
    const err = new Error('סיסמת מנהל קבועה עדיין לא הוגדרה. הריצו את scripts/set-admin-password.js.');
    err.status = 400;
    throw err;
  }
  const ok = await bcrypt.compare(String(password || ''), settings.adminPasswordHash);
  if (!ok) {
    const err = new Error('סיסמה שגויה.');
    err.status = 401;
    throw err;
  }
  return true;
}

export async function changeAdminPassword(currentPassword, newPassword) {
  await verifyAdminPassword(currentPassword);
  const clean = String(newPassword || '').trim();
  if (clean.length < 6) {
    const err = new Error('סיסמה חדשה חייבת להכיל לפחות 6 תווים.');
    err.status = 400;
    throw err;
  }
  const hash = await bcrypt.hash(clean, 12);
  await setSetting('admin_password_hash', hash);
  return { success: true };
}

export async function setAdminPhone(phone) {
  const normalized = normalizePhone(phone);
  await setSetting('admin_phone', phone);
  await setSetting('normalized_admin_phone', normalized);
  return { success: true, normalizedPhone: normalized };
}

export async function requestAdminOtp(phone) {
  const settings = await getSettings();
  const normalized = normalizePhone(phone);
  if (!settings.normalizedAdminPhone || normalized !== settings.normalizedAdminPhone) {
    // לא חושפים אם המספר קיים במערכת או לא — הודעה גנרית בלבד.
    const err = new Error('לא ניתן לשלוח קוד למספר זה.');
    err.status = 401;
    throw err;
  }
  return requestOtp(normalized, 'admin_login');
}

export async function verifyAdminOtp(phone, code) {
  const normalized = normalizePhone(phone);
  await verifyOtp(normalized, code, 'admin_login');
  return true;
}

export function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'נדרשת התחברות מנהל.' });
}
