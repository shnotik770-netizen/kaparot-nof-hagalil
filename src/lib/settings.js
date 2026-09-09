// מקביל ל-settings.js של מערכת הספרים — קורא/כותב לטבלת settings (key/value).

import { query } from '../db/pool.js';
import { getOpenSlotsForRegistration, getOpenSlotsForPickup } from './slots.js';
import { logAction } from './actionLog.js';

const DEFAULTS = {
  orderTitle: 'הרשמה לכפרות',
  orderSubtitle: 'מוסדות חסדי מנחם נוף הגליל',
  deferredPaymentNotice: 'העופות נשמרים בוודאות מוחלטת רק למי ששילם בפועל בשעת ההזמנה.',
  unpaidBlockMessage: 'עליך לגשת למשרד להסדרת התשלום טרם מימוש ההזמנה.',
  partialPaymentNotice: 'שולם באופן חלקי — ניתן למשוך רק את ההזמנות ששולמו.',
  smsOtpTemplate: 'קוד האימות שלך: {code} (בתוקף ל-10 דקות)',
  closedRegistrationMessage: 'חלון ההזמנות סגור כרגע, ייפתח בקרוב.',
  welcomeNoticeTitle: '',
  welcomeNoticeBody: '',
};

export async function getSettings() {
  const { rows } = await query('SELECT key, value FROM settings');
  const map = {};
  rows.forEach((r) => { map[r.key] = r.value; });

  return {
    orderTitle: (map.order_title || '').trim() || DEFAULTS.orderTitle,
    orderSubtitle: (map.order_subtitle || '').trim() || DEFAULTS.orderSubtitle,
    adminPasswordHash: map.admin_password_hash || null,
    deferredPaymentNotice: (map.deferred_payment_notice || '').trim() || DEFAULTS.deferredPaymentNotice,
    unpaidBlockMessage: (map.unpaid_block_message || '').trim() || DEFAULTS.unpaidBlockMessage,
    partialPaymentNotice: (map.partial_payment_notice || '').trim() || DEFAULTS.partialPaymentNotice,
    smsOtpTemplate: (map.sms_otp_template || '').trim() || DEFAULTS.smsOtpTemplate,
    closedRegistrationMessage: (map.closed_registration_message || '').trim() || DEFAULTS.closedRegistrationMessage,
    // חלונית הסבר שמוצגת ללקוח במסך הראשי — ריק = לא מוצגת בכלל (ראו getPublicSettings)
    welcomeNoticeTitle: (map.welcome_notice_title || '').trim(),
    welcomeNoticeBody: (map.welcome_notice_body || '').trim(),
  };
}

/**
 * אין יותר מתגי-על גלובליים (registration_open / distribution_open) — כל
 * זה מנוהל לגמרי פר-זמן-חלוקה בטאב "זמני חלוקה". "פתוח בפועל" נגזר ישירות
 * מזה: יש הרשמה כל עוד יש לפחות זמן חלוקה אחד שפתוח כרגע להרשמה, ויש חלוקה
 * כל עוד יש לפחות זמן חלוקה אחד שסומן "פתוח לאספקה".
 */
export async function getPublicSettings() {
  const s = await getSettings();
  const openRegSlots = await getOpenSlotsForRegistration();
  const openPickupSlots = await getOpenSlotsForPickup();
  return {
    registrationOpen: openRegSlots.length > 0,
    distributionOpen: openPickupSlots.length > 0,
    orderTitle: s.orderTitle,
    orderSubtitle: s.orderSubtitle,
    deferredPaymentNotice: s.deferredPaymentNotice,
    closedRegistrationMessage: s.closedRegistrationMessage,
    welcomeNoticeTitle: s.welcomeNoticeTitle,
    welcomeNoticeBody: s.welcomeNoticeBody,
  };
}

export async function setSetting(key, value) {
  await query(
    `INSERT INTO settings(key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

/** קיצור לשמירת כמה הגדרות בבת אחת (טאב "הגדרות" בפאנל הניהול). */
export async function setSettings(map) {
  for (const [key, value] of Object.entries(map)) {
    await setSetting(key, value == null ? null : String(value));
  }
  await logAction('settings_updated', { changedKeys: Object.keys(map), values: map });
}
