// מקביל ל-settings.js של מערכת הספרים — קורא/כותב לטבלת settings (key/value).

import { query } from '../db/pool.js';
import { normalizePhone } from './normalize.js';

const DEFAULTS = {
  registrationOpen: true,
  distributionOpen: false,
  activeDay: null,
  activeTimeSlot: null,
  orderTitle: 'הרשמה לכפרות',
  deferredPaymentNotice: 'העופות נשמרים בוודאות מוחלטת רק למי ששילם בפועל בשעת ההזמנה.',
  unpaidBlockMessage: 'עליך לגשת למשרד להסדרת התשלום טרם מימוש ההזמנה.',
  partialPaymentNotice: 'שולם באופן חלקי — ניתן למשוך רק את ההזמנות ששולמו.',
  smsOtpTemplate: 'קוד האימות שלך: {code} (בתוקף ל-10 דקות)',
};

export async function getSettings() {
  const { rows } = await query('SELECT key, value FROM settings');
  const map = {};
  rows.forEach((r) => { map[r.key] = r.value; });

  return {
    registrationOpen: map.registration_open === 'true',
    distributionOpen: map.distribution_open === 'true',
    activeDay: map.active_day || null,
    activeTimeSlot: map.active_time_slot || null,
    orderTitle: (map.order_title || '').trim() || DEFAULTS.orderTitle,
    adminPasswordHash: map.admin_password_hash || null,
    adminPhone: map.admin_phone || null,
    normalizedAdminPhone: map.normalized_admin_phone || (map.admin_phone ? normalizePhone(map.admin_phone) : null),
    deferredPaymentNotice: (map.deferred_payment_notice || '').trim() || DEFAULTS.deferredPaymentNotice,
    unpaidBlockMessage: (map.unpaid_block_message || '').trim() || DEFAULTS.unpaidBlockMessage,
    partialPaymentNotice: (map.partial_payment_notice || '').trim() || DEFAULTS.partialPaymentNotice,
    smsOtpTemplate: (map.sms_otp_template || '').trim() || DEFAULTS.smsOtpTemplate,
  };
}

export async function getPublicSettings() {
  const s = await getSettings();
  return {
    registrationOpen: s.registrationOpen,
    distributionOpen: s.distributionOpen,
    activeDay: s.activeDay,
    activeTimeSlot: s.activeTimeSlot,
    orderTitle: s.orderTitle,
    deferredPaymentNotice: s.deferredPaymentNotice,
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
