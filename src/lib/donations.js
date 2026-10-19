// דף תרומות עצמאי למוסדות חסדי מנחם (דף השורש /) — במכוון לא בנוי על מודל
// ההזמנות/כפרות: תהליך שונה לגמרי, בלי OTP/זיהוי לקוח. כמו seudot.js, אותה
// תשתית נדרים פלוס (createTransaction/Webhook) עם state עצמאי משלו
// (donation_categories + donations), כדי לא לגעת בכלל בזרימות הקיימות.

import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { normalizePhone } from './normalize.js';
import { logAction } from './actionLog.js';

function mapCategory(r) {
  return { id: r.id, name: r.name, enabled: r.enabled, sortOrder: r.sort_order };
}

function mapDonation(r) {
  return {
    id: r.id,
    token: r.token,
    categoryId: r.category_id,
    categoryName: r.category_name,
    amount: Number(r.amount),
    fullName: r.full_name,
    phone: r.phone,
    idNumber: r.id_number,
    email: r.email,
    note: r.note,
    status: r.status,
    nedarimTransactionId: r.nedarim_transaction_id,
    createdAt: r.created_at,
    paidAt: r.paid_at,
  };
}

// ---- קטגוריות (ניהול בפאנל) ----

export async function listEnabledDonationCategories() {
  const { rows } = await pool.query(
    `SELECT * FROM donation_categories WHERE enabled = true ORDER BY sort_order ASC, id ASC`
  );
  return rows.map(mapCategory);
}

export async function listAllDonationCategories() {
  const { rows } = await pool.query(`SELECT * FROM donation_categories ORDER BY sort_order ASC, id ASC`);
  return rows.map(mapCategory);
}

export async function createDonationCategory(name) {
  const clean = String(name || '').trim();
  if (!clean) throw Object.assign(new Error('נא להזין שם קטגוריה.'), { status: 400 });
  const { rows: maxRows } = await pool.query(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM donation_categories`);
  const { rows } = await pool.query(
    `INSERT INTO donation_categories(name, sort_order) VALUES ($1, $2) RETURNING *`,
    [clean, maxRows[0].next]
  );
  await logAction('donation_category_created', { categoryId: rows[0].id, name: clean });
  return mapCategory(rows[0]);
}

export async function updateDonationCategory(id, { name, enabled }) {
  const clean = String(name || '').trim();
  if (!clean) throw Object.assign(new Error('נא להזין שם קטגוריה.'), { status: 400 });
  const { rows } = await pool.query(
    `UPDATE donation_categories SET name=$2, enabled=$3 WHERE id=$1 RETURNING *`,
    [id, clean, enabled !== false]
  );
  if (!rows.length) throw Object.assign(new Error('קטגוריה לא נמצאה.'), { status: 404 });
  await logAction('donation_category_updated', { categoryId: id, name: clean, enabled: enabled !== false });
  return mapCategory(rows[0]);
}

/** מחליף את sort_order בין שתי קטגוריות שכנות — עליה/הורדה ברשימה בפאנל. */
export async function swapDonationCategoryOrder(id, otherId) {
  const { rows } = await pool.query(
    `SELECT id, sort_order FROM donation_categories WHERE id IN ($1, $2)`,
    [id, otherId]
  );
  if (rows.length !== 2) return { success: false };
  const [a, b] = rows;
  await pool.query(`UPDATE donation_categories SET sort_order=$2 WHERE id=$1`, [a.id, b.sort_order]);
  await pool.query(`UPDATE donation_categories SET sort_order=$2 WHERE id=$1`, [b.id, a.sort_order]);
  return { success: true };
}

export async function deleteDonationCategory(id) {
  const { rows } = await pool.query(`SELECT name FROM donation_categories WHERE id = $1`, [id]);
  await pool.query(`DELETE FROM donation_categories WHERE id = $1`, [id]);
  if (rows.length) await logAction('donation_category_deleted', { categoryId: id, name: rows[0].name });
  return { success: true };
}

// ---- תרומות ----

export async function createDonation({ categoryId, amount, fullName, phone, idNumber, email, note }) {
  const { rows: catRows } = await pool.query(
    `SELECT * FROM donation_categories WHERE id = $1 AND enabled = true`,
    [categoryId]
  );
  if (!catRows.length) throw Object.assign(new Error('הקטגוריה שנבחרה לא נמצאה או לא פעילה.'), { status: 400 });
  const category = catRows[0];

  const token = crypto.randomBytes(16).toString('hex');
  const normalizedPhone = phone ? normalizePhone(phone) : null;
  const { rows } = await pool.query(
    `INSERT INTO donations(token, category_id, category_name, amount, full_name, phone, normalized_phone, id_number, email, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [token, category.id, category.name, amount, fullName || null, phone || null, normalizedPhone, idNumber || null, email || null, note || null]
  );
  await logAction('donation_created', { token, categoryName: category.name, amount, fullName: fullName || null });
  return mapDonation(rows[0]);
}

export async function getDonationByToken(token) {
  if (!token) return null;
  const { rows } = await pool.query(`SELECT * FROM donations WHERE token = $1`, [token]);
  return rows[0] ? mapDonation(rows[0]) : null;
}

/** אישור אופטימי מהדפדפן (Status:'OK' מהאייפרם) — ראו confirmSeudotPaymentClient ב-seudot.js להסבר המלא. */
export async function confirmDonationPaymentClient(token, transactionId) {
  const { rows } = await pool.query(
    `UPDATE donations SET status='paid', nedarim_transaction_id=$2, paid_at=now()
      WHERE token=$1 AND status='pending' RETURNING *`,
    [token, transactionId || null]
  );
  if (!rows.length) return { updated: false };
  await logAction('donation_payment_client_confirmed', {
    token, transactionId: transactionId || null, categoryName: rows[0].category_name, amount: Number(rows[0].amount),
    note: 'אושר לפי תגובת הדפדפן בלבד — טרם התקבל אימות Webhook לעסקה זו.',
  });
  return { updated: true };
}

/** מופעל מה-Webhook (אחרי אימות חתימה) — מקור האמת האמיתי. אידמפוטנטי מול confirmDonationPaymentClient. */
export async function allocateDonationPayment({ token, transactionId }) {
  const { rows } = await pool.query(
    `UPDATE donations SET status='paid', nedarim_transaction_id=$2, paid_at=now()
      WHERE token=$1 AND status='pending' RETURNING *`,
    [token, transactionId || null]
  );
  if (!rows.length) {
    const { rows: existing } = await pool.query(`SELECT id FROM donations WHERE token = $1`, [token]);
    return { allocated: false, reason: existing.length ? 'already_paid' : 'unknown_token' };
  }
  await logAction('donation_payment_received_webhook', {
    token, transactionId: transactionId || null, categoryName: rows[0].category_name, amount: Number(rows[0].amount),
  });
  return { allocated: true };
}

// רק תרומות ששולמו בפועל — מי שהתחיל טופס ולא השלים תשלום לא "נרשם" ולא
// אמור להופיע כאן, ראו הערה מקבילה ב-listSeudotRegistrations.
export async function listDonations() {
  const { rows } = await pool.query(`SELECT * FROM donations WHERE status = 'paid' ORDER BY created_at DESC`);
  return rows.map(mapDonation);
}
