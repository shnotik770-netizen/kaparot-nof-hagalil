// יום האירוע: "Gatekeeper" (מה מותר למשוך עכשיו) + "שריפת כרטיס" (משיכה בפועל).
//
// כל התנאים הבאים חייבים להתקיים יחד לכל שורת הזמנה (order_item):
//  1. זמן החלוקה שהפריט שייך אליו מסומן ע"י המנהל כ-open_for_pickup (פר-שורה, ראו distribution_slots).
//  2. ההזמנה שאליה הפריט שייך מסומנת 'paid' (לא 'partial' ולא 'unpaid').
//  3. quantity_redeemed < quantity (עוד לא נמשך במלואו).
//
// כך תשלום חלקי (הזמנה א' שולמה, הזמנה ב' לא) פותר את עצמו אוטומטית: רק
// הפריטים ששייכים להזמנה ששולמה נפתחים למשיכה, בלי קוד מיוחד לכל מקרה.
//
// המימוש עצמו הוא תמיד "לפי זמן חלוקה" (לא לפי שורת הזמנה בודדת): הלקוח
// בוחר כמות זכרים וכמות נקבות למשיכה כרגע (עם קיצור "הכל" בצד הלקוח), וכפתור
// אחד ("מימוש והצגה למחלק העופות") מבצע את שניהם יחד בעסקה אחת — גם אם הכמות
// מתפצלת בין כמה הזמנות ישנות של אותו טלפון לאותו זמן חלוקה.

import crypto from 'node:crypto';
import { pool, withTransaction } from '../db/pool.js';
import { getSettings } from './settings.js';
import { logAction } from './actionLog.js';

function itemLabel(row) {
  const genderLabel = row.gender === 'male' ? 'זכרים' : 'נקבות';
  return `${row.slot_name} · ${genderLabel}`;
}

function generateConfirmationCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

/**
 * מצב מלא של "מה אפשר למשוך עכשיו" ו"מה חסום ולמה" — לתצוגה בקיוסק/באזור האישי.
 * לא בודק שהמשיכה כן פתוחה בכלל (distribution_open) — זו בדיקה נפרדת ברמת המסך.
 */
export async function getRedemptionStatus(normalizedPhone) {
  const settings = await getSettings();
  const { rows } = await pool.query(
    `SELECT oi.*, o.order_number, o.order_sequence, o.customer_name, b.payment_status,
            s.name AS slot_name, s.color AS slot_color, s.active AS slot_active, s.open_for_pickup
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN order_balances b ON b.order_id = o.id
       JOIN distribution_slots s ON s.id = oi.slot_id
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
      customerName: r.customer_name,
      label: itemLabel(r),
      slotId: r.slot_id,
      slotName: r.slot_name,
      slotColor: r.slot_color,
      gender: r.gender,
      remaining,
      paymentStatus: r.payment_status,
    };

    if (!r.slot_active || !r.open_for_pickup) {
      blocked.push({ ...base, reason: 'wrong_slot', message: 'לא ניתן למשוך כרגע — הזמן הזה עדיין לא נפתח לחלוקה.' });
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

/**
 * מימוש משולב לזמן חלוקה שלם: כמות זכרים + כמות נקבות (כל אחת יכולה להיות 0),
 * נלקחות מכל שורות ההזמנה הזמינות (משולמות, פתוחות לחלוקה) של אותו טלפון
 * ואותו זמן חלוקה, מהישנה לחדשה, עד שהכמות המבוקשת מתמלאת. פעולה אחת,
 * קוד אישור אחד, למסך "הצגה למחלק העופות".
 */
export async function confirmSlotRedemption(normalizedPhone, slotId, { maleQuantity, femaleQuantity }, redeemedBy) {
  // אין יותר מתג-על גלובלי — הבדיקה שהזמן הזה פתוח לאספקה היא פר-זמן-חלוקה
  // בלבד (slot.active && slot.open_for_pickup), נבדקת מיד אחרי טעינת השורה למטה.
  const wanted = {
    male: Number(maleQuantity) || 0,
    female: Number(femaleQuantity) || 0,
  };
  if (wanted.male < 0 || wanted.female < 0 || (wanted.male === 0 && wanted.female === 0)) {
    const err = new Error('יש לבחור כמות לפחות עבור מין אחד.');
    err.status = 400;
    throw err;
  }

  return withTransaction(async (client) => {
    const { rows: slotRows } = await client.query(`SELECT * FROM distribution_slots WHERE id = $1`, [slotId]);
    const slot = slotRows[0];
    if (!slot) {
      const err = new Error('זמן החלוקה לא נמצא.');
      err.status = 404;
      throw err;
    }
    if (!slot.active || !slot.open_for_pickup) {
      const err = new Error('לא ניתן למשוך כרגע — הזמן הזה עדיין לא נפתח לחלוקה.');
      err.status = 409;
      throw err;
    }

    const confirmationCode = generateConfirmationCode();
    const redeemedTotals = { male: 0, female: 0 };
    let customerName = null;

    for (const gender of ['male', 'female']) {
      let toTake = wanted[gender];
      if (toTake <= 0) continue;

      const { rows: items } = await client.query(
        `SELECT oi.*, o.normalized_phone, o.customer_name, b.payment_status
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           JOIN order_balances b ON b.order_id = o.id
          WHERE o.normalized_phone = $1 AND oi.slot_id = $2 AND oi.gender = $3 AND NOT o.is_deleted
          ORDER BY oi.order_id ASC, oi.id ASC
          FOR UPDATE OF oi`,
        [normalizedPhone, slotId, gender]
      );

      for (const item of items) {
        if (toTake <= 0) break;
        if (item.payment_status !== 'paid') continue;
        const itemRemaining = item.quantity - item.quantity_redeemed;
        if (itemRemaining <= 0) continue;
        const take = Math.min(itemRemaining, toTake);

        await client.query(`UPDATE order_items SET quantity_redeemed = quantity_redeemed + $1 WHERE id = $2`, [take, item.id]);
        await client.query(
          `INSERT INTO redemptions(order_item_id, quantity, confirmation_code, redeemed_by) VALUES ($1,$2,$3,$4)`,
          [item.id, take, confirmationCode, redeemedBy]
        );

        redeemedTotals[gender] += take;
        toTake -= take;
        customerName = item.customer_name;
      }

      if (toTake > 0) {
        const genderLabel = gender === 'male' ? 'זכרים' : 'נקבות';
        const err = new Error(`אין מספיק ${genderLabel} זמינים למשיכה בכמות שביקשת.`);
        err.status = 409;
        throw err;
      }
    }

    await logAction('redemption_confirmed', {
      slotId, slotName: slot.name, phone: normalizedPhone, customerName,
      maleQuantity: redeemedTotals.male, femaleQuantity: redeemedTotals.female,
      confirmationCode, redeemedBy,
    }, client);

    return {
      confirmationCode,
      maleQuantity: redeemedTotals.male,
      femaleQuantity: redeemedTotals.female,
      customerName,
      slotName: slot.name,
      slotColor: slot.color,
    };
  });
}
