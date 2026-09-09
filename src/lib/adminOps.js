import { pool, withTransaction } from '../db/pool.js';
import { logAction } from './actionLog.js';

export async function listAllOrders() {
  const { rows: orderRows } = await pool.query(
    `SELECT o.*, b.amount_paid, b.balance_due, b.payment_status
       FROM orders o JOIN order_balances b ON b.order_id = o.id
      WHERE NOT o.is_deleted
      ORDER BY o.created_at DESC`
  );
  if (!orderRows.length) return [];
  const orderIds = orderRows.map((r) => r.id);
  const { rows: itemRows } = await pool.query(
    `SELECT oi.*, s.name AS slot_name, s.day_label, s.hours_label, s.color AS slot_color
       FROM order_items oi
       JOIN distribution_slots s ON s.id = oi.slot_id
      WHERE oi.order_id = ANY($1::int[]) ORDER BY oi.id ASC`,
    [orderIds]
  );
  return orderRows.map((o) => ({
    id: o.id,
    orderNumber: o.order_number,
    orderSequence: o.order_sequence,
    phone: o.phone,
    customerName: o.customer_name,
    normalizedPhone: o.normalized_phone,
    notes: o.notes,
    totalAmount: Number(o.total_amount),
    amountPaid: Number(o.amount_paid),
    balanceDue: Number(o.balance_due),
    paymentStatus: o.payment_status,
    createdAt: o.created_at,
    items: itemRows
      .filter((it) => it.order_id === o.id)
      .map((it) => ({
        id: it.id, slotId: it.slot_id, slotName: it.slot_name, slotColor: it.slot_color,
        dayLabel: it.day_label, hoursLabel: it.hours_label,
        gender: it.gender, quantity: it.quantity, unitPrice: Number(it.unit_price), lineTotal: Number(it.line_total),
        quantityRedeemed: it.quantity_redeemed,
      })),
  }));
}

/**
 * תצוגה מקובצת לפי לקוח (טלפון) — לטאב "הזמנות ותשלומים" בפאנל הניהול.
 * לכל לקוח: כל ההזמנות שלו (לצורך פירוט מלא), פילוח מאוחד לפי זמן חלוקה
 * (סכום כמויות מכל ההזמנות יחד), ויתרה כספית כוללת.
 */
export async function listCustomersSummary() {
  const orders = await listAllOrders();
  if (!orders.length) return [];

  // "ייתכן שיש תשלום שלא אושר" — session שנפתח מזמן ולא הושלם לא ע"י אישור
  // הלקוח (confirmClientReportedPayment) ולא ע"י Webhook (allocateNedarimPayment).
  const { rows: staleRows } = await pool.query(
    `SELECT normalized_phone, token, requested_amount, created_at FROM payment_sessions
      WHERE status = 'pending' AND created_at < now() - interval '10 minutes'
      ORDER BY created_at DESC`
  );
  const staleByPhone = new Map();
  for (const r of staleRows) {
    if (!staleByPhone.has(r.normalized_phone)) staleByPhone.set(r.normalized_phone, []);
    staleByPhone.get(r.normalized_phone).push({ token: r.token, amount: Number(r.requested_amount), createdAt: r.created_at });
  }

  const byPhone = new Map();
  for (const o of orders) {
    if (!byPhone.has(o.phone)) {
      byPhone.set(o.phone, { phone: o.phone, normalizedPhone: o.normalizedPhone, customerName: o.customerName, orders: [] });
    }
    const c = byPhone.get(o.phone);
    c.orders.push(o);
    // השם מההזמנה העדכנית ביותר (orders כבר ממוין created_at DESC)
    if (o.createdAt > (c.latestCreatedAt || '')) {
      c.customerName = o.customerName;
      c.latestCreatedAt = o.createdAt;
    }
  }

  return [...byPhone.values()].map((c) => {
    const totalAmount = c.orders.reduce((s, o) => s + o.totalAmount, 0);
    const amountPaid = c.orders.reduce((s, o) => s + o.amountPaid, 0);
    const balanceDue = c.orders.reduce((s, o) => s + o.balanceDue, 0);
    const paymentStatus = balanceDue <= 0 ? 'paid' : amountPaid > 0 ? 'partial' : 'unpaid';

    const bySlot = new Map();
    let fullyRedeemed = true;
    let hasAnyItem = false;
    for (const o of c.orders) {
      for (const it of o.items) {
        hasAnyItem = true;
        if (it.quantityRedeemed < it.quantity) fullyRedeemed = false;
        if (!bySlot.has(it.slotId)) {
          bySlot.set(it.slotId, { slotId: it.slotId, slotName: it.slotName, slotColor: it.slotColor, male: 0, maleRedeemed: 0, female: 0, femaleRedeemed: 0 });
        }
        const s = bySlot.get(it.slotId);
        s[it.gender] += it.quantity;
        s[`${it.gender}Redeemed`] += it.quantityRedeemed;
      }
    }

    return {
      phone: c.phone,
      customerName: c.customerName,
      totalAmount, amountPaid, balanceDue, paymentStatus,
      fullyRedeemed: hasAnyItem && fullyRedeemed,
      bySlot: [...bySlot.values()],
      orders: c.orders,
      pendingUnconfirmedPayments: staleByPhone.get(c.normalizedPhone) || [],
    };
  }).sort((a, b) => (b.orders[0]?.createdAt || '').localeCompare(a.orders[0]?.createdAt || ''));
}

/**
 * עריכת כמות ע"י מנהל (כפתור "עריכה"): משנה ישירות את השורה הקיימת — לא
 * יוצר הזמנה חדשה — כדי לא לשבור סכימות/חישובים שמניחים quantity חיובי בכל
 * שורה. הכמות החדשה חסומה מלרדת מתחת למה שכבר נמשך בפועל. כל שינוי נרשם
 * ביומן הפעולות עם הכמות הישנה/החדשה — כך שהעריכה שקופה לחלוטין בהיסטוריה.
 */
export async function updateOrderItemQuantity(orderId, itemId, newQuantity, adminName) {
  const quantity = Number(newQuantity);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    const err = new Error('כמות חייבת להיות מספר שלם חיובי.');
    err.status = 400;
    throw err;
  }
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE`,
      [itemId, orderId]
    );
    const item = rows[0];
    if (!item) {
      const err = new Error('פריט ההזמנה לא נמצא.');
      err.status = 404;
      throw err;
    }
    if (quantity < item.quantity_redeemed) {
      const err = new Error(`לא ניתן להקטין מתחת ל-${item.quantity_redeemed} — כבר נמשכו כמות זו בפועל.`);
      err.status = 400;
      throw err;
    }
    const newLineTotal = Number(item.unit_price) * quantity;
    await client.query(
      `UPDATE order_items SET quantity = $2, line_total = $3 WHERE id = $1`,
      [itemId, quantity, newLineTotal]
    );
    const { rows: totalRows } = await client.query(
      `SELECT COALESCE(SUM(line_total),0) AS total FROM order_items WHERE order_id = $1`,
      [orderId]
    );
    await client.query(`UPDATE orders SET total_amount = $2, updated_at = now() WHERE id = $1`, [orderId, totalRows[0].total]);
    await logAction('order_item_edited', {
      orderId, itemId, oldQuantity: item.quantity, newQuantity: quantity, delta: quantity - item.quantity, adminName,
    }, client);
    return { success: true };
  });
}

/** מחיקת שורת הזמנה — רק אם עוד לא נמשך ממנה כלום (אחרת יש למחוק את ההזמנה כולה, ראו deleteOrder). */
export async function deleteOrderItem(orderId, itemId, adminName) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE`,
      [itemId, orderId]
    );
    const item = rows[0];
    if (!item) {
      const err = new Error('פריט ההזמנה לא נמצא.');
      err.status = 404;
      throw err;
    }
    if (item.quantity_redeemed > 0) {
      const err = new Error('לא ניתן למחוק שורה שכבר נמשך ממנה — ניתן להקטין כמות עתידית בלבד.');
      err.status = 400;
      throw err;
    }
    await client.query(`DELETE FROM order_items WHERE id = $1`, [itemId]);
    const { rows: remaining } = await client.query(
      `SELECT COALESCE(SUM(line_total),0) AS total, COUNT(*)::int AS n FROM order_items WHERE order_id = $1`,
      [orderId]
    );
    await client.query(`UPDATE orders SET total_amount = $2, updated_at = now() WHERE id = $1`, [orderId, remaining[0].total]);
    if (remaining[0].n === 0) {
      await client.query(`UPDATE orders SET is_deleted = true WHERE id = $1`, [orderId]);
    }
    await logAction('order_item_deleted', {
      orderId, itemId, slotId: item.slot_id, gender: item.gender, quantity: item.quantity, adminName,
      orderDeletedToo: remaining[0].n === 0,
    }, client);
    return { success: true };
  });
}

/** מחיקת הזמנה שלמה (הסתרה רכה, is_deleted) — פעולת מנהל, בלתי הפיכה מבחינת הלקוח. */
export async function deleteOrder(orderId, adminName) {
  const { rows } = await pool.query(`SELECT order_number, customer_name, phone FROM orders WHERE id = $1`, [orderId]);
  if (!rows.length) {
    const err = new Error('הזמנה לא נמצאה.');
    err.status = 404;
    throw err;
  }
  await pool.query(`UPDATE orders SET is_deleted = true WHERE id = $1`, [orderId]);
  await logAction('order_deleted', { orderId, orderNumber: rows[0].order_number, customerName: rows[0].customer_name, phone: rows[0].phone, adminName });
  return { success: true };
}

/**
 * "מצב מימוש" ידני ע"י מנהל: קובע ישירות כמה נמשכו בפועל משורת הזמנה, בלי
 * לעבור דרך שערי התשלום/פתיחת-הזמן הרגילים (למשל תיקון טעות, או משיכה
 * שתועדה טלפונית). גידול נרשם גם ב-redemptions (אירוע משיכה אמיתי); הקטנה
 * (תיקון) לא — זו לא "משיכה", רק תיקון של הספירה, ונרשמת ביומן הפעולות בלבד.
 */
export async function setItemRedeemedQuantity(itemId, quantityRedeemed, adminName) {
  const q = Number(quantityRedeemed);
  if (!Number.isInteger(q) || q < 0) {
    const err = new Error('כמות שנמשכה חייבת להיות מספר שלם, 0 ומעלה.');
    err.status = 400;
    throw err;
  }
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM order_items WHERE id = $1 FOR UPDATE`, [itemId]);
    const item = rows[0];
    if (!item) {
      const err = new Error('פריט ההזמנה לא נמצא.');
      err.status = 404;
      throw err;
    }
    if (q > item.quantity) {
      const err = new Error(`לא ניתן לסמן יותר מ-${item.quantity} (הכמות שהוזמנה).`);
      err.status = 400;
      throw err;
    }
    const delta = q - item.quantity_redeemed;
    await client.query(`UPDATE order_items SET quantity_redeemed = $2 WHERE id = $1`, [itemId, q]);
    if (delta > 0) {
      await client.query(
        `INSERT INTO redemptions(order_item_id, quantity, confirmation_code, redeemed_by) VALUES ($1,$2,'ADMIN-MANUAL',$3)`,
        [itemId, delta, adminName]
      );
    }
    await logAction('redemption_manual_override', {
      itemId, orderId: item.order_id, oldQuantityRedeemed: item.quantity_redeemed, newQuantityRedeemed: q, delta, adminName,
    }, client);
    return { success: true };
  });
}

/** מוזמן מול נמשך, לפי זמן חלוקה + מגדר — לדשבורד. */
export async function getDashboardStats() {
  const { rows } = await pool.query(
    `SELECT oi.slot_id, s.name AS slot_name, oi.gender,
            SUM(oi.quantity)::int AS ordered,
            SUM(oi.quantity_redeemed)::int AS redeemed,
            SUM(oi.line_total) AS revenue_ordered
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN distribution_slots s ON s.id = oi.slot_id
      WHERE NOT o.is_deleted
      GROUP BY oi.slot_id, s.name, oi.gender
      ORDER BY s.name, oi.gender`
  );
  const { rows: paidRows } = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total_paid FROM payments`
  );
  return {
    bySlot: rows.map((r) => ({
      slotId: r.slot_id, slotName: r.slot_name, gender: r.gender,
      ordered: r.ordered, redeemed: r.redeemed, revenueOrdered: Number(r.revenue_ordered),
    })),
    totalPaid: Number(paidRows[0].total_paid),
  };
}

/** איפוס קשיח — מוחק את כל נתוני ההזמנות/תשלומים/משיכות. משמר settings, admins, זמני חלוקה ויומן הפעולות. */
export async function hardReset(performedBy) {
  await pool.query('TRUNCATE redemptions, webhook_events, payments, payment_sessions, order_items, orders, otp_codes RESTART IDENTITY');
  await pool.query(`ALTER SEQUENCE order_number_seq RESTART WITH 1001`);
  await logAction('hard_reset', { performedBy: performedBy || null });
  return { success: true };
}
