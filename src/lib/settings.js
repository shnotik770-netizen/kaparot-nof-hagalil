// מקביל ל-settings.js של מערכת הספרים — קורא/כותב לטבלת settings (key/value).

import { query } from '../db/pool.js';
import { getOpenSlotsForRegistration } from './slots.js';

const DEFAULTS = {
  registrationOpen: true,
  distributionOpen: false,
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
    registrationOpen: map.registration_open === 'true',
    distributionOpen: map.distribution_open === 'true',
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
 * "פתוח בפועל" = המנהל אישר (registrationOpen) *וגם* יש לפחות זמן חלוקה
 * אחד שפתוח כרגע להרשמה. בלי זמן פתוח הטופס לא שמיש בכל מקרה — עדיף
 * להראות ללקוח הודעת "סגור, ייפתח בקרוב" ברורה במקום טופס בלי אף אפשרות בחירה.
 */
export async function getPublicSettings() {
  const s = await getSettings();
  const openSlots = await getOpenSlotsForRegistration();
  const registrationEffectivelyOpen = s.registrationOpen && openSlots.length > 0;
  return {
    registrationOpen: registrationEffectivelyOpen,
    distributionOpen: s.distributionOpen,
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
}
