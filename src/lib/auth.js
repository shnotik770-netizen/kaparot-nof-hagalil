// כניסת מנהל: תמיד דורשת מספר טלפון + או סיסמה קבועה או קוד חד-פעמי בסמס,
// נבדק מול טבלת admins (שם+טלפון+סיסמה+הרשאות, מנוהלת בפאנל עצמו).
//
// בוטסטרפ: כל עוד טבלת admins ריקה (התקנה חדשה, לפני שהוגדר אף מנהל בשם),
// מתקבלת סיסמת ה"בוטסטרפ" הישנה (settings.admin_password_hash, שנקבעת ע"י
// scripts/set-admin-password.js / INITIAL_ADMIN_PASSWORD) עם כל טלפון —
// כדי שאפשר יהיה להיכנס פעם ראשונה ולהוסיף מנהלים אמיתיים. ברגע שיש מנהל
// אחד לפחות, הבוטסטרפ מפסיק לעבוד לגמרי.

import bcrypt from 'bcryptjs';
import { getSettings } from './settings.js';
import { normalizePhone } from './normalize.js';
import { requestOtp, verifyOtp } from './otp.js';
import { countAdmins, getAdminByPhone, verifyAdminCredentials } from './admins.js';
import { logAction } from './actionLog.js';

const FULL_PERMISSIONS = { settings: true, orders: true, dashboard: true, slots: true };

export async function loginWithPassword(phone, password) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    const err = new Error('יש להזין מספר טלפון.');
    err.status = 400;
    throw err;
  }

  if ((await countAdmins()) === 0) {
    const settings = await getSettings();
    if (!settings.adminPasswordHash) {
      const err = new Error('טרם הוגדר אף מנהל. הריצו את scripts/set-admin-password.js.');
      err.status = 400;
      throw err;
    }
    const ok = await bcrypt.compare(String(password || ''), settings.adminPasswordHash);
    if (!ok) {
      const err = new Error('מספר טלפון או סיסמה שגויים.');
      err.status = 401;
      throw err;
    }
    await logAction('admin_login', { phone: normalized, method: 'password_bootstrap' });
    return { id: null, name: 'מנהל ראשי (זמני)', normalizedPhone: normalized, permissions: FULL_PERMISSIONS };
  }

  const admin = await verifyAdminCredentials(normalized, password);
  await logAction('admin_login', { adminId: admin.id, phone: normalized, name: admin.name, method: 'password' });
  return admin;
}

export async function requestAdminOtp(phone) {
  const normalized = normalizePhone(phone);
  if ((await countAdmins()) === 0) {
    const err = new Error('אימות בסמס עדיין לא זמין — יש להיכנס פעם ראשונה עם הסיסמה ולהוסיף מנהלים בהגדרות.');
    err.status = 400;
    throw err;
  }
  const admin = await getAdminByPhone(normalized);
  if (!admin) {
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
  const admin = await getAdminByPhone(normalized);
  if (!admin) {
    const err = new Error('מנהל לא נמצא.');
    err.status = 401;
    throw err;
  }
  await logAction('admin_login', { adminId: admin.id, phone: normalized, name: admin.name, method: 'otp' });
  return admin;
}

export function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'נדרשת התחברות מנהל.' });
}

/** לשימוש אחרי requireAdmin: requirePermission('slots') וכו'. */
export function requirePermission(permission) {
  return (req, res, next) => {
    if (req.session?.adminPermissions?.[permission]) return next();
    return res.status(403).json({ error: 'אין לך הרשאה לפעולה זו.' });
  };
}
