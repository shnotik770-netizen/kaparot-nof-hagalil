// רישום הזמנות: "הזמנה מספר 1", "הזמנה מספר 2"... לכל טלפון (לא "שלב ב'").
// מחיר כל שורה נלקח מהתעריף החי ברגע ההזמנה ו"מוקפא" ב-unit_price — שינוי
// תעריף מאוחר יותר לא נוגע בהזמנות שכבר נוצרו.

import crypto from 'node:crypto';
import { pool, withTransaction } from '../db/pool.js';
import { normalizePhone, isValidIsraeliPhone } from './normalize.js';
import { getSettings } from './settings.js';
import { getActivePriceRules } from './priceRules.js';

const VALID_DAYS = new Set(['thu', 'sun']);
const VALID_SLOTS = new Set(['morning', 'night']);
const VALID_GENDERS = new Set(['male', 'female']);

function priceKey(day, timeSlot, gender) {
  return `${day}|${timeSlot}|${gender}`;
}

function rowToOrder(row) {
  return {
    id: row.id,
    orderNumber: row.order_number,
    orderSequence: row.order_sequence,
    phone: row.phone,
    customerName: row.customer_name,
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

export async function createOrder(payload, { changedBy = 'customer' } = {}) {
  const settings = await getSettings();
  if (!settings.registrationOpen && changedBy !== 'admin') {
    const err = new Error('הרישום סגור כרגע.');
    err.status = 403;
    throw err;
  }

  const phone = String(payload?.phone || '').trim();
  const normalizedPhone = normalizePhone(phone);
  const customerName = String(payload?.customerName || '').trim();
  const items = Array.isArray(payload?.items) ? payload.items : [];

  if (!isValidIsraeliPhone(normalizedPhone)) {
    const err = new Error('מספר טלפון לא תקין.');
    err.status = 400;
    throw err;
  }
  if (!customerName) {
    const err = new Error('חסר שם מלא.');
    err.status = 400;
    throw err;
  }
  if (!items.length) {
    const err = new Error('יש לבחור לפחות פריט אחד (יום, שעה, מגדר וכמות).');
    err.status = 400;
    throw err;
  }

  const priceRules = await getActivePriceRules();
  const priceMap = new Map(priceRules.map((r) => [priceKey(r.day, r.timeSlot, r.gender), r.price]));

  const cleanItems = items.map((raw) => {
    const day = raw.day;
    const timeSlot = raw.timeSlot;
    const gender = raw.gender;
    const quantity = Number(raw.quantity);
    if (!VALID_DAYS.has(day) || !VALID_SLOTS.has(timeSlot) || !VALID_GENDERS.has(gender)) {
      const err = new Error('יום/שעה/מגדר לא תקינים.');
      err.status = 400;
      throw err;
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      const err = new Error('כמות חייבת להיות מספר שלם חיובי.');
      err.status = 400;
      throw err;
    }
    const unitPrice = priceMap.get(priceKey(day, timeSlot, gender));
    if (unitPrice == null) {
      const err = new Error('לא הוגדר תעריף לאחד מהפריטים שנבחרו. פנו למשרד.');
      err.status = 400;
      throw err;
    }
    return { day, timeSlot, gender, quantity, unitPrice, lineTotal: unitPrice * quantity };
  });

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
      `INSERT INTO orders(order_number, phone, normalized_phone, customer_name, order_sequence, access_token, total_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [orderNumber, phone, normalizedPhone, customerName, orderSequence, accessToken, totalAmount]
    );
    const orderRow = inserted[0];

    for (const it of cleanItems) {
      await client.query(
        `INSERT INTO order_items(order_id, day, time_slot, gender, quantity, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [orderRow.id, it.day, it.timeSlot, it.gender, it.quantity, it.unitPrice, it.lineTotal]
      );
    }

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
    `SELECT * FROM order_items WHERE order_id = ANY($1::int[]) ORDER BY id ASC`,
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
        day: it.day,
        timeSlot: it.time_slot,
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
