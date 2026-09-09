// זמני חלוקה — מוחלף price_rules + יום/שעה קבועים. כל שורה היא "אירוע"
// עצמאי (תאריך, שעות, מחירים, צבע) שהמנהל מוסיף/עורך בפאנל הניהול.

import { query } from '../db/pool.js';
import { toHebrewDateString, hebrewWeekdayName } from './hebcal.js';
import { logAction } from './actionLog.js';

function rowToSlot(row) {
  const registrationCloseAt = row.registration_close_at;
  const isOpenForRegistration =
    row.active && (row.manual_open_override || !registrationCloseAt || new Date(registrationCloseAt) > new Date());
  const isOpenForPickup = row.active && row.open_for_pickup;

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
    active: row.active,
    isOpenForRegistration,
    isOpenForPickup,
  };
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

/** רק זמנים פתוחים בפועל לאספקה (משיכה) כרגע — לתג "החלוקה פתוחה" ולכפתור "מימוש הזמנה". */
export async function getOpenSlotsForPickup() {
  const all = await getAllSlots();
  return all.filter((s) => s.isOpenForPickup);
}

export async function getSlotById(id) {
  const { rows } = await query(`SELECT * FROM distribution_slots WHERE id = $1`, [id]);
  return rows.length ? rowToSlot(rows[0]) : null;
}

export async function createSlot(data) {
  const { rows } = await query(
    `INSERT INTO distribution_slots(name, supply_date, day_label, hours_label, color, price_male, price_female, registration_close_at, manual_open_override, open_for_pickup, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      data.name, data.supplyDate, data.dayLabel, data.hoursLabel || '', data.color || '#a5741f',
      data.priceMale, data.priceFemale, data.registrationCloseAt || null,
      !!data.manualOpenOverride, !!data.openForPickup, data.active !== false,
    ]
  );
  const slot = rowToSlot(rows[0]);
  await logAction('slot_created', { slotId: slot.id, name: slot.name, supplyDate: slot.supplyDate });
  return slot;
}

export async function updateSlot(id, data) {
  const { rows } = await query(
    `UPDATE distribution_slots SET
       name = $2, supply_date = $3, day_label = $4, hours_label = $5, color = $6,
       price_male = $7, price_female = $8, registration_close_at = $9,
       manual_open_override = $10, open_for_pickup = $11, active = $12,
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [
      id, data.name, data.supplyDate, data.dayLabel, data.hoursLabel || '', data.color || '#a5741f',
      data.priceMale, data.priceFemale, data.registrationCloseAt || null,
      !!data.manualOpenOverride, !!data.openForPickup, data.active !== false,
    ]
  );
  if (!rows.length) {
    const err = new Error('זמן החלוקה לא נמצא.');
    err.status = 404;
    throw err;
  }
  const slot = rowToSlot(rows[0]);
  await logAction('slot_updated', {
    slotId: slot.id, name: slot.name, active: slot.active,
    openForPickup: slot.openForPickup, manualOpenOverride: slot.manualOpenOverride,
  });
  return slot;
}

/** מחיר לפי מגדר, מתוך זמן ספציפי — לחישוב הזמנה. */
export function priceForGender(slot, gender) {
  return gender === 'female' ? slot.priceFemale : slot.priceMale;
}
