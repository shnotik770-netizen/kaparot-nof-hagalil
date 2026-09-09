// קודי אימות חד-פעמיים בסמס — משמשים גם לכניסה חוזרת לאזור אישי וגם לכניסת מנהל.

import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { sendSms } from './sms.js';
import { getSettings } from './settings.js';

const CODE_TTL_MINUTES = 10;
const RESEND_COOLDOWN_SECONDS = 30;

function generateCode() {
  return String(crypto.randomInt(100000, 1000000)); // 6 ספרות
}

export async function requestOtp(normalizedPhone, purpose) {
  const { rows: recent } = await query(
    `SELECT created_at FROM otp_codes
      WHERE normalized_phone = $1 AND purpose = $2
      ORDER BY created_at DESC LIMIT 1`,
    [normalizedPhone, purpose]
  );
  if (recent.length) {
    const secondsSince = (Date.now() - new Date(recent[0].created_at).getTime()) / 1000;
    if (secondsSince < RESEND_COOLDOWN_SECONDS) {
      const err = new Error(`יש להמתין עוד ${Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSince)} שניות לפני שליחה חוזרת.`);
      err.status = 429;
      throw err;
    }
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);
  await query(
    `INSERT INTO otp_codes(normalized_phone, code, purpose, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [normalizedPhone, code, purpose, expiresAt]
  );

  const settings = await getSettings();
  const message = settings.smsOtpTemplate.replace('{code}', code);
  await sendSms(normalizedPhone, message);

  return { sent: true, expiresInMinutes: CODE_TTL_MINUTES };
}

export async function verifyOtp(normalizedPhone, code, purpose) {
  const { rows } = await query(
    `SELECT id, expires_at, consumed_at FROM otp_codes
      WHERE normalized_phone = $1 AND purpose = $2 AND code = $3
      ORDER BY created_at DESC LIMIT 1`,
    [normalizedPhone, purpose, String(code || '').trim()]
  );
  const row = rows[0];
  if (!row) {
    const err = new Error('קוד שגוי.');
    err.status = 401;
    throw err;
  }
  if (row.consumed_at) {
    const err = new Error('קוד זה כבר נוצל. יש לבקש קוד חדש.');
    err.status = 401;
    throw err;
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    const err = new Error('הקוד פג תוקף. יש לבקש קוד חדש.');
    err.status = 401;
    throw err;
  }

  await query('UPDATE otp_codes SET consumed_at = now() WHERE id = $1', [row.id]);
  return true;
}
