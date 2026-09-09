// יום האירוע: "Gatekeeper" (מה מותר למשוך עכשיו) + "שריפת כרטיס" (משיכה בפועל).
//
// שלושה תנאים חייבים להתקיים יחד לכל שורת הזמנה (order_item):
//  1. day/time_slot שלה תואמים בדיוק ל-active_day/active_time_slot הנוכחיים.
//  2. ההזמנה שאליה היא שייכת מסומנת 'paid' (לא 'partial' ולא 'unpaid').
//  3. quantity_redeemed < quantity (עוד לא נמשך במלואו).
//
// כך תשלום חלקי (הזמנה א' שולמה, הזמנה ב' לא) פותר את עצמו אוטומטית: רק
// הפריטים ששייכים להזמנה ששולמה נפתחים למשיכה, בלי קוד מיוחד לכל מקרה.

import crypto from 'node:crypto';
import { pool, withTransaction } from '../db/pool.js';
import { getSettings } from './settings.js';

function itemLabel(day, timeSlot, gender) {
  const dayLabel = day === 'thu' ? 'חמישי' : 'ראשון';
  const slotLabel = timeSlot === 'morning' ? 'בוקר' : 'לילה';
  const genderLabel = gender === 'male' ? 'זכרים' : 'נקבות';
  return `יום ${dayLabel} · ${slotLabel} · ${genderLabel}`;
}

/**
 * מצב מלא של "מה אפשר למשוך עכשיו" ו"מה חסום ולמה" — לתצוגה בקיוסק.
 * לא בודק שהמשיכה כן פתוחה בכלל (distribution_open) — זו בדיקה נפרדת ברמת המסך.
 */
export async function getRedemptionStatus(normalizedPhone) {
  const settings = await getSettings();
  const { rows } = await pool.query(
    `SELECT oi.*, o.order_number, o.order_sequence, b.payment_status
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN order_balances b ON b.order_id = o.id
      WHERE o.normalized_phone = $1 AND NOT o.is_deleted
      ORDER BY o.order_sequence ASC, oi.id ASC`,
    [normalizedPhone]
  );

  const available = [];
  const blocked = [];

  for (const r of rows) {
    const remaining = r.quantity - r.quantity_redeemed;
    if (remaining <= 0) continue; // כבר נמשך במלואו — לא מוצג בכלל

    const base = {
      orderItemId: r.id,
      orderNumber: r.order_number,
      orderSequence: r.order_sequence,
      label: itemLabel(r.day, r.time_slot, r.gender),
      day: r.day,
      timeSlot: r.time_slot,
      gender: r.gender,
      remaining,
      paymentStatus: r.payment_status,
    };

    const matchesActiveSlot = settings.activeDay === r.day && settings.activeTimeSlot === r.time_slot;
    if (!matchesActiveSlot) {
      blocked.push({ ...base, reason: 'wrong_slot', message: 'לא המועד הנוכחי — ניתן למשוך רק ביום/שעה שנפתחו כרגע.' });
      continue;
    }
    if (r.payment_status === 'unpaid') {
      blocked.push({ ...base, reason: 'unpaid', message: settings.unpaidBlockMessage });
      continue;
    }
    if (r.payment_status === 'partial') {
      blocked.push({ ...base, reason: 'partial', message: settings.partialPaymentNotice });
      continue;
    }
    available.push(base);
  }

  return { available, blocked };
}

/** משיכה בפועל — נעילת שורה (FOR UPDATE) ובדיקה חוזרת של כל התנאים בתוך אותה עסקה. */
export async function confirmRedemption(normalizedPhone, orderItemId, quantity, redeemedBy) {
  const settings = await getSettings();
  if (!settings.distributionOpen) {
    const err = new Error('החלוקה סגורה כרגע.');
    err.status = 403;
    throw err;
  }
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) {
    const err = new Error('כמות לא תקינה.');
    err.status = 400;
    throw err;
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT oi.*, o.normalized_phone, b.payment_status
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN order_balances b ON b.order_id = o.id
        WHERE oi.id = $1
        FOR UPDATE OF oi`,
      [orderItemId]
    );
    const item = rows[0];
    if (!item || item.normalized_phone !== normalizedPhone) {
      const err = new Error('הפריט לא נמצא.');
      err.status = 404;
      throw err;
    }
    if (settings.activeDay !== item.day || settings.activeTimeSlot !== item.time_slot) {
      const err = new Error('לא ניתן למשוך פריט זה כעת — אינו תואם למועד הפתוח.');
      err.status = 409;
      throw err;
    }
    if (item.payment_status !== 'paid') {
      const err = new Error(item.payment_status === 'unpaid' ? settings.unpaidBlockMessage : settings.partialPaymentNotice);
      err.status = 409;
      throw err;
    }
    const remaining = item.quantity - item.quantity_redeemed;
    if (qty > remaining) {
      const err = new Error(`ניתן למשוך עד ${remaining} בלבד מפריט זה.`);
      err.status = 409;
      throw err;
    }

    await client.query(
      `UPDATE order_items SET quantity_redeemed = quantity_redeemed + $1 WHERE id = $2`,
      [qty, item.id]
    );

    const confirmationCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    await client.query(
      `INSERT INTO redemptions(order_item_id, quantity, confirmation_code, redeemed_by)
       VALUES ($1,$2,$3,$4)`,
      [item.id, qty, confirmationCode, redeemedBy]
    );

    return { confirmationCode, quantity: qty, label: itemLabel(item.day, item.time_slot, item.gender) };
  });
}
