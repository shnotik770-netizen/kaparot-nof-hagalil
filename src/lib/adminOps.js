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
    `SELECT oi.*, s.name AS slot_name, s.day_label, s.hours_label
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
    notes: o.notes,
    totalAmount: Number(o.total_amount),
    amountPaid: Number(o.amount_paid),
    balanceDue: Number(o.balance_due),
    paymentStatus: o.payment_status,
    createdAt: o.created_at,
    items: itemRows
      .filter((it) => it.order_id === o.id)
      .map((it) => ({
        id: it.id, slotId: it.slot_id, slotName: it.slot_name, dayLabel: it.day_label, hoursLabel: it.hours_label,
        gender: it.gender, quantity: it.quantity, unitPrice: Number(it.unit_price), lineTotal: Number(it.line_total),
        quantityRedeemed: it.quantity_redeemed,
      })),
  }));
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

/** איפוס קשיח — מוחק את כל נתוני ההזמנות/תשלומים/משיכות. משמר settings, admins וזמני חלוקה. */
export async function hardReset() {
  await pool.query('TRUNCATE redemptions, webhook_events, payments, payment_sessions, order_items, orders, otp_codes RESTART IDENTITY');
  await pool.query(`ALTER SEQUENCE order_number_seq RESTART WITH 1001`);
  await pool.query(
    `INSERT INTO admin_actions(action_type, details) VALUES ('hard_reset', '{}'::jsonb)`
  );
  return { success: true };
}
