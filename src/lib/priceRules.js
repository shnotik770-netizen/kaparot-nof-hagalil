import { query } from '../db/pool.js';

export async function getActivePriceRules() {
  const { rows } = await query(
    `SELECT day, time_slot, gender, price FROM price_rules WHERE active ORDER BY day, time_slot, gender`
  );
  return rows.map((r) => ({ day: r.day, timeSlot: r.time_slot, gender: r.gender, price: Number(r.price) }));
}

export async function getAllPriceRules() {
  const { rows } = await query(
    `SELECT id, day, time_slot, gender, price, active FROM price_rules ORDER BY day, time_slot, gender`
  );
  return rows.map((r) => ({
    id: r.id, day: r.day, timeSlot: r.time_slot, gender: r.gender, price: Number(r.price), active: r.active,
  }));
}

/** מחיר חי נכון לרגע ההזמנה — לא משפיע רטרואקטיבית על הזמנות קיימות (הן שומרות unit_price משלהן). */
export async function getPrice(day, timeSlot, gender) {
  const { rows } = await query(
    `SELECT price FROM price_rules WHERE day=$1 AND time_slot=$2 AND gender=$3 AND active LIMIT 1`,
    [day, timeSlot, gender]
  );
  if (!rows.length) {
    const err = new Error(`לא הוגדר תעריף עבור ${day}/${timeSlot}/${gender}.`);
    err.status = 400;
    throw err;
  }
  return Number(rows[0].price);
}

/** עדכון מרוכז מפאנל הניהול — תמיד upsert לפי (day,time_slot,gender). */
export async function upsertPriceRules(list) {
  for (const rule of list) {
    await query(
      `INSERT INTO price_rules(day, time_slot, gender, price, active)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (day, time_slot, gender)
       DO UPDATE SET price = EXCLUDED.price, active = EXCLUDED.active, updated_at = now()`,
      [rule.day, rule.timeSlot, rule.gender, rule.price, rule.active !== false]
    );
  }
  return getAllPriceRules();
}
