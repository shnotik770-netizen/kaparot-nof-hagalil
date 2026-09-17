// זמני חלוקה — מוחלף price_rules + יום/שעה קבועים. כל שורה היא "אירוע"
// עצמאי (תאריך, שעות, מחירים, צבע) שהמנהל מוסיף/עורך בפאנל הניהול.

import { query } from '../db/pool.js';
import { toHebrewDateString, hebrewWeekdayName } from './hebcal.js';
import { logAction } from './actionLog.js';

function rowToSlot(row) {
  const registrationCloseAt = row.registration_close_at;
  // "פתוח להרשמה" נגזר רק מזמן הסגירה + הדריסה הידנית — אין יותר מתג-על
  // נפרד ("זמן פעיל"); מי שרוצה להסתיר זמן חלוקה שאין לו הזמנות, מוחק אותו.
  const isOpenForRegistration =
    row.manual_open_override || !registrationCloseAt || new Date(registrationCloseAt) > new Date();
  const isOpenForPickup = row.open_for_pickup;

  return {
    id: row.id,
    name: row.name,
    supplyDate: row.supply_date,
    hebrewDate: toHebrewDateString(row.supply_date),
    dayLabel: row.day_label,
    hoursLabel: row.hours_label,
    color: row.color,
    priceMale: Number(row.price_male),
    priceFemale: Number(row.price_female),
    registrationCloseAt: row.registration_close_at,
    manualOpenOverride: row.manual_open_override,
    openForPickup: row.open_for_pickup,
    isOpenForRegistration,
    isOpenForPickup,
    ivrCode: row.ivr_code,
    ivrAnnouncement: row.ivr_announcement,
  };
}

/** ivrCode ריק = לא מוצג בתפריט הטלפוני; אם מוגדר, חייב להיות ספרה בודדת 1-9. */
function normalizeIvrCode(rawIvrCode) {
  const trimmed = String(rawIvrCode ?? '').trim();
  if (!trimmed) return null;
  if (!/^[1-9]$/.test(trimmed)) {
    const err = new Error('קוד לשלוחה הטלפונית חייב להיות ספרה בודדת בין 1 ל-9.');
    err.status = 400;
    throw err;
  }
  return trimmed;
}

/**
 * מונע תפריט טלפוני דו-משמעי: שתי הזמנות שפתוחות להרשמה בו-זמנית לא יכולות
 * לחלוק אותה ספרת בחירה. בדיקה מקורבת (active + פתוח להרשמה כרגע), לא
 * ייחודיות מוחלטת על פני כל הזמנים שאי-פעם היו — אירועים ישנים/סגורים
 * מותר להם לחזור על אותה ספרה.
 */
async function assertIvrCodeAvailable(ivrCode, excludeId) {
  if (!ivrCode) return;
  const { rows } = await query(
    `SELECT id FROM distribution_slots
      WHERE active = true AND ivr_code = $1 AND id <> $2
        AND (manual_open_override OR registration_close_at IS NULL OR registration_close_at > now())`,
    [ivrCode, excludeId || 0]
  );
  if (rows.length) {
    const err = new Error(`הספרה ${ivrCode} כבר תפוסה ע"י זמן חלוקה אחר שפתוח להרשמה כרגע.`);
    err.status = 409;
    throw err;
  }
}

/** הצעה ראשונית ל"יום" בעברית, לפי תאריך — הלקוח (טופס ניהול) יכול לערוך את הטקסט לפני שמירה. */
export function suggestDayLabel(supplyDate) {
  return hebrewWeekdayName(supplyDate);
}

/** רשימת כל הזמנים (כולל לא-פעילים), למסך הניהול. */
export async function getAllSlots() {
  const { rows } = await query(`SELECT * FROM distribution_slots ORDER BY supply_date ASC, id ASC`);
  return rows.map(rowToSlot);
}

/** רק זמנים פתוחים בפועל להרשמה כרגע — לטופס ההרשמה של הלקוח. */
export async function getOpenSlotsForRegistration() {
  const all = await getAllSlots();
  return all.filter((s) => s.isOpenForRegistration);
}

/**
 * רק זמנים פתוחים להרשמה כרגע *וגם* מוגדר להם קוד לשלוחה הטלפונית —
 * בדיוק מה שתפריט ה-IVR (9/1) צריך להקריא, ממוין לפי הספרה. זמן שפתוח
 * להרשמה באתר אבל בלי ivr_code לא נחשף בטלפון בכלל.
 */
export async function getIvrRegistrationSlots() {
  const open = await getOpenSlotsForRegistration();
  return open.filter((s) => s.ivrCode && s.ivrAnnouncement).sort((a, b) => a.ivrCode.localeCompare(b.ivrCode));
}

/** רק זמנים פתוחים בפועל לאספקה (משיכה) כרגע — לתג "החלוקה פתוחה" ולכפתור "איסוף הזמנה". */
export async function getOpenSlotsForPickup() {
  const all = await getAllSlots();
  return all.filter((s) => s.isOpenForPickup);
}

export async function getSlotById(id) {
  const { rows } = await query(`SELECT * FROM distribution_slots WHERE id = $1`, [id]);
  return rows.length ? rowToSlot(rows[0]) : null;
}

export async function createSlot(data) {
  const ivrCode = normalizeIvrCode(data.ivrCode);
  await assertIvrCodeAvailable(ivrCode, null);
  const { rows } = await query(
    `INSERT INTO distribution_slots(name, supply_date, day_label, hours_label, color, price_male, price_female, registration_close_at, manual_open_override, open_for_pickup, active, ivr_code, ivr_announcement)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [
      data.name, data.supplyDate, data.dayLabel, data.hoursLabel || '', data.color || '#a5741f',
      data.priceMale, data.priceFemale, data.registrationCloseAt || null,
      !!data.manualOpenOverride, !!data.openForPickup, data.active !== false,
      ivrCode, data.ivrAnnouncement?.trim() || null,
    ]
  );
  const slot = rowToSlot(rows[0]);
  await logAction('slot_created', { slotId: slot.id, name: slot.name, supplyDate: slot.supplyDate });
  return slot;
}

export async function updateSlot(id, data) {
  const ivrCode = normalizeIvrCode(data.ivrCode);
  await assertIvrCodeAvailable(ivrCode, id);
  const { rows } = await query(
    `UPDATE distribution_slots SET
       name = $2, supply_date = $3, day_label = $4, hours_label = $5, color = $6,
       price_male = $7, price_female = $8, registration_close_at = $9,
       manual_open_override = $10, open_for_pickup = $11, active = $12,
       ivr_code = $13, ivr_announcement = $14,
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [
      id, data.name, data.supplyDate, data.dayLabel, data.hoursLabel || '', data.color || '#a5741f',
      data.priceMale, data.priceFemale, data.registrationCloseAt || null,
      !!data.manualOpenOverride, !!data.openForPickup, data.active !== false,
      ivrCode, data.ivrAnnouncement?.trim() || null,
    ]
  );
  if (!rows.length) {
    const err = new Error('זמן החלוקה לא נמצא.');
    err.status = 404;
    throw err;
  }
  const slot = rowToSlot(rows[0]);
  await logAction('slot_updated', {
    slotId: slot.id, name: slot.name,
    openForPickup: slot.openForPickup, manualOpenOverride: slot.manualOpenOverride,
  });
  return slot;
}

/** מחיר לפי מגדר, מתוך זמן ספציפי — לחישוב הזמנה. */
export function priceForGender(slot, gender) {
  return gender === 'female' ? slot.priceFemale : slot.priceMale;
}

/** מוחק זמן חלוקה לגמרי — רק אם אין לו אף שורת הזמנה משויכת (למשל זמן שנוצר לניסוי). */
export async function deleteSlot(id) {
  const { rows: usage } = await query(`SELECT COUNT(*)::int AS n FROM order_items WHERE slot_id = $1`, [id]);
  if (usage[0].n > 0) {
    const err = new Error('לא ניתן למחוק — יש כבר הזמנות המשויכות לזמן חלוקה זה. אפשר להשבית אותו במקום (בטל את "זמן פעיל").');
    err.status = 400;
    throw err;
  }
  const { rows } = await query(`DELETE FROM distribution_slots WHERE id = $1 RETURNING id, name`, [id]);
  if (!rows.length) {
    const err = new Error('זמן החלוקה לא נמצא.');
    err.status = 404;
    throw err;
  }
  await logAction('slot_deleted', { slotId: rows[0].id, name: rows[0].name });
  return { success: true };
}
