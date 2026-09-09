import { pool } from '../db/pool.js';

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
    `SELECT * FROM order_items WHERE order_id = ANY($1::int[]) ORDER BY id ASC`,
    [orderIds]
  );
  return orderRows.map((o) => ({
    id: o.id,
    orderNumber: o.order_number,
    orderSequence: o.order_sequence,
    phone: o.phone,
    customerName: o.customer_name,
    totalAmount: Number(o.total_amount),
    amountPaid: Number(o.amount_paid),
    balanceDue: Number(o.balance_due),
    paymentStatus: o.payment_status,
    createdAt: o.created_at,
    items: itemRows
      .filter((it) => it.order_id === o.id)
      .map((it) => ({
        id: it.id, day: it.day, timeSlot: it.time_slot, gender: it.gender,
        quantity: it.quantity, unitPrice: Number(it.unit_price), lineTotal: Number(it.line_total),
        quantityRedeemed: it.quantity_redeemed,
      })),
  }));
}

/** מוזמן מול נמשך, לפי יום+שעה+מגדר — לדשבורד. */
export async function getDashboardStats() {
  const { rows } = await pool.query(
    `SELECT oi.day, oi.time_slot, oi.gender,
            SUM(oi.quantity)::int AS ordered,
            SUM(oi.quantity_redeemed)::int AS redeemed,
            SUM(oi.line_total) AS revenue_ordered
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE NOT o.is_deleted
      GROUP BY oi.day, oi.time_slot, oi.gender
      ORDER BY oi.day, oi.time_slot, oi.gender`
  );
  const { rows: paidRows } = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total_paid FROM payments`
  );
  return {
    bySlot: rows.map((r) => ({
      day: r.day, timeSlot: r.time_slot, gender: r.gender,
      ordered: r.ordered, redeemed: r.redeemed, revenueOrdered: Number(r.revenue_ordered),
    })),
    totalPaid: Number(paidRows[0].total_paid),
  };
}

/** איפוס קשיח — מוחק את כל נתוני ההזמנות/תשלומים/משיכות. משמר settings ו-price_rules. */
export async function hardReset() {
  await pool.query('TRUNCATE redemptions, webhook_events, payments, order_items, orders, otp_codes RESTART IDENTITY');
  await pool.query(`ALTER SEQUENCE order_number_seq RESTART WITH 1001`);
  await pool.query(
    `INSERT INTO admin_actions(action_type, details) VALUES ('hard_reset', '{}'::jsonb)`
  );
  return { success: true };
}
