// רישום הזמנות: "הזמנה מספר 1", "הזמנה מספר 2"... לכל טלפון (לא "שלב ב'").
// מחיר כל שורה נלקח מהתעריף החי של זמן החלוקה ברגע ההזמנה ו"מוקפא" ב-unit_price —
// שינוי תעריף מאוחר יותר לא נוגע בהזמנות שכבר נוצרו.

import crypto from 'node:crypto';
import { pool, withTransaction } from '../db/pool.js';
import { normalizePhone, isValidIsraeliPhone } from './normalize.js';
import { getAllSlots, priceForGender } from './slots.js';
import { logAction } from './actionLog.js';

const VALID_GENDERS = new Set(['male', 'female']);

function rowToOrder(row) {
  return {
    id: row.id,
    orderNumber: row.order_number,
    orderSequence: row.order_sequence,
    phone: row.phone,
    customerName: row.customer_name,
    notes: row.notes,
    totalAmount: Number(row.total_amount),
    createdAt: row.created_at,
  };
}

export async function countOrdersForPhone(normalizedPhone) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM orders WHERE normalized_phone = $1 AND NOT is_deleted`,
    [normalizedPhone]
  );
  return rows[0].n;
}

export async function getCustomerName(normalizedPhone) {
  const { rows } = await pool.query(
    `SELECT customer_name FROM orders WHERE normalized_phone = $1 AND NOT is_deleted ORDER BY order_sequence DESC LIMIT 1`,
    [normalizedPhone]
  );
  return rows.length ? rows[0].customer_name : null;
}

/** מעדכן את שם הלקוח על כל ההזמנות שלו (אין טבלת "לקוחות" נפרדת — השם חי על כל שורת הזמנה). */
export async function updateCustomerName(normalizedPhone, customerName) {
  const name = String(customerName || '').trim();
  if (!name) {
    const err = new Error('יש להזין שם.');
    err.status = 400;
    throw err;
  }
  const { rowCount } = await pool.query(
    `UPDATE orders SET customer_name = $1 WHERE normalized_phone = $2 AND NOT is_deleted`,
    [name, normalizedPhone]
  );
  if (!rowCount) {
    const err = new Error('לא נמצאו הזמנות עבור מספר טלפון זה.');
    err.status = 404;
    throw err;
  }
  await logAction('customer_name_updated', { normalizedPhone, customerName: name });
  return { customerName: name };
}

export async function createOrder(payload, { changedBy = 'customer' } = {}) {
  // אין יותר מתג-על גלובלי — כל בדיקת "האם ההרשמה פתוחה" נעשית פר-זמן-חלוקה,
  // ראו הבדיקה על slot.isOpenForRegistration בכל שורת פריט למטה.
  const phone = String(payload?.phone || '').trim();
  const normalizedPhone = normalizePhone(phone);
  const notes = String(payload?.notes || '').trim() || null;
  const items = Array.isArray(payload?.items) ? payload.items : [];

  if (!isValidIsraeliPhone(normalizedPhone)) {
    const err = new Error('מספר טלפון לא תקין.');
    err.status = 400;
    throw err;
  }

  // "הזמנה נוספת" (יש כבר הזמנה קודמת לטלפון זה) לא מבקשת שם שוב — משתמשים
  // בשם שכבר נמסר בהזמנה הקודמת, בלי תלות במה שנשלח (אם בכלל) מהלקוח.
  const { rows: previousOrder } = await pool.query(
    `SELECT customer_name FROM orders WHERE normalized_phone = $1 AND NOT is_deleted ORDER BY order_sequence DESC LIMIT 1`,
    [normalizedPhone]
  );
  const customerName = previousOrder.length
    ? previousOrder[0].customer_name
    : String(payload?.customerName || '').trim();
  if (!customerName) {
    const err = new Error('חסר שם מלא.');
    err.status = 400;
    throw err;
  }
  if (!items.length) {
    const err = new Error('יש לבחור לפחות פריט אחד (זמן חלוקה, מגדר וכמות).');
    err.status = 400;
    throw err;
  }

  const slots = await getAllSlots();
  const slotsById = new Map(slots.map((s) => [s.id, s]));

  const cleanItems = items.map((raw) => {
    const slotId = Number(raw.slotId);
    const gender = raw.gender;
    const quantity = Number(raw.quantity);
    const slot = slotsById.get(slotId);
    if (!slot || !slot.active) {
      const err = new Error('זמן חלוקה לא תקין.');
      err.status = 400;
      throw err;
    }
    if (changedBy !== 'admin' && !slot.isOpenForRegistration) {
      const err = new Error(`ההרשמה ל"${slot.name}" סגורה כרגע.`);
      err.status = 400;
      throw err;
    }
    if (!VALID_GENDERS.has(gender)) {
      const err = new Error('סוג (מגדר) לא תקין.');
      err.status = 400;
      throw err;
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      const err = new Error('כמות חייבת להיות מספר שלם חיובי.');
      err.status = 400;
      throw err;
    }
    const unitPrice = priceForGender(slot, gender);
    return { slotId, gender, quantity, unitPrice, lineTotal: unitPrice * quantity, slotName: slot.name };
  });

  // לא מאפשרים שתי שורות לאותו זמן חלוקה+מגדר באותה הזמנה — צריך לאחד לכמות אחת.
  const seenCombos = new Set();
  for (const it of cleanItems) {
    const key = `${it.slotId}:${it.gender}`;
    if (seenCombos.has(key)) {
      const err = new Error(`יש כפילות: "${it.slotName}" (${it.gender === 'female' ? 'נקבות' : 'זכרים'}) מופיע יותר מפעם אחת. יש לאחד לשורה אחת עם הכמות הכוללת.`);
      err.status = 400;
      throw err;
    }
    seenCombos.add(key);
  }

  const totalAmount = cleanItems.reduce((sum, it) => sum + it.lineTotal, 0);
  const accessToken = crypto.randomBytes(24).toString('base64url');

  const order = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(
      `SELECT id FROM orders WHERE normalized_phone = $1 AND NOT is_deleted FOR UPDATE`,
      [normalizedPhone]
    );
    const orderSequence = existing.length + 1;

    const { rows: numRows } = await client.query(`SELECT nextval('order_number_seq') AS n`);
    const orderNumber = numRows[0].n;

    const { rows: inserted } = await client.query(
      `INSERT INTO orders(order_number, phone, normalized_phone, customer_name, notes, order_sequence, access_token, total_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [orderNumber, phone, normalizedPhone, customerName, notes, orderSequence, accessToken, totalAmount]
    );
    const orderRow = inserted[0];

    for (const it of cleanItems) {
      await client.query(
        `INSERT INTO order_items(order_id, slot_id, gender, quantity, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [orderRow.id, it.slotId, it.gender, it.quantity, it.unitPrice, it.lineTotal]
      );
    }

    await logAction('order_created', {
      orderId: orderRow.id, orderNumber, orderSequence, phone: normalizedPhone,
      customerName, totalAmount, itemCount: cleanItems.length, changedBy,
    }, client);

    return orderRow;
  });

  return { ...rowToOrder(order), items: cleanItems };
}

export async function listOrdersForPhone(normalizedPhone) {
  const { rows: orderRows } = await pool.query(
    `SELECT o.*, b.amount_paid, b.balance_due, b.payment_status
       FROM orders o
       JOIN order_balances b ON b.order_id = o.id
      WHERE o.normalized_phone = $1 AND NOT o.is_deleted
      ORDER BY o.order_sequence ASC`,
    [normalizedPhone]
  );
  if (!orderRows.length) return [];

  const orderIds = orderRows.map((r) => r.id);
  const { rows: itemRows } = await pool.query(
    `SELECT oi.*, s.name AS slot_name, s.day_label, s.hours_label, s.supply_date, s.color AS slot_color
       FROM order_items oi
       JOIN distribution_slots s ON s.id = oi.slot_id
      WHERE oi.order_id = ANY($1::int[]) ORDER BY oi.id ASC`,
    [orderIds]
  );

  return orderRows.map((o) => ({
    ...rowToOrder(o),
    amountPaid: Number(o.amount_paid),
    balanceDue: Number(o.balance_due),
    paymentStatus: o.payment_status, // 'unpaid' | 'partial' | 'paid'
    items: itemRows
      .filter((it) => it.order_id === o.id)
      .map((it) => ({
        id: it.id,
        slotId: it.slot_id,
        slotName: it.slot_name,
        slotColor: it.slot_color,
        dayLabel: it.day_label,
        hoursLabel: it.hours_label,
        supplyDate: it.supply_date,
        gender: it.gender,
        quantity: it.quantity,
        unitPrice: Number(it.unit_price),
        lineTotal: Number(it.line_total),
        quantityRedeemed: it.quantity_redeemed,
      })),
  }));
}

export async function getOrderById(orderId) {
  const { rows } = await pool.query(
    `SELECT o.*, b.amount_paid, b.balance_due, b.payment_status
       FROM orders o JOIN order_balances b ON b.order_id = o.id
      WHERE o.id = $1`,
    [orderId]
  );
  return rows[0] || null;
}
