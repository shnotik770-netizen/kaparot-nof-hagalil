import crypto from 'node:crypto';
import { pool, withTransaction } from '../db/pool.js';
import { logAction } from './actionLog.js';
import { normalizePhone } from './normalize.js';

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
    paymentCoordinated: o.payment_coordinated,
    source: o.source,
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

  const { rows: closureRows } = await pool.query(
    `SELECT normalized_phone, note, admin_name, created_at FROM customer_case_closures`
  );
  const closureByPhone = new Map(closureRows.map((r) => [r.normalized_phone, {
    note: r.note, adminName: r.admin_name, closedAt: r.created_at,
  }]));

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
    let uncollectedValue = 0;
    let rawUncollectedValue = 0;
    for (const o of c.orders) {
      let orderUncollected = 0;
      for (const it of o.items) {
        hasAnyItem = true;
        if (it.quantityRedeemed < it.quantity) fullyRedeemed = false;
        orderUncollected += (it.quantity - it.quantityRedeemed) * it.unitPrice;
        if (!bySlot.has(it.slotId)) {
          bySlot.set(it.slotId, { slotId: it.slotId, slotName: it.slotName, slotColor: it.slotColor, male: 0, maleRedeemed: 0, female: 0, femaleRedeemed: 0 });
        }
        const s = bySlot.get(it.slotId);
        s[it.gender] += it.quantity;
        s[`${it.gender}Redeemed`] += it.quantityRedeemed;
      }
      // לכל הזמנה בנפרד: שווי מה שלא נאסף, פחות מה שעדיין לא שולם עליה
      // (balanceDue) — אם החוב הפתוח גדול/שווה לשווי מה שלא נאסף, אין
      // עודף תשלום פנוי ואין מה לזכות. מוגבל למעלה בשווי מה שלא נאסף
      // (למקרה של עודף תשלום, balanceDue שלילי). מתמטית זהה ל"מה ששולם
      // פחות מה שכבר נאסף", רק בניסוח פשוט יותר: כמה שווה מה שלא נאסף,
      // מינוס כמה מזה עדיין לא שולם.
      uncollectedValue += Math.max(0, Math.min(orderUncollected, orderUncollected - o.balanceDue));
      // שווי גולמי (לא מוגבל בעודף תשלום) — לתצוגה בלבד, "כמה עדיין לא
      // נאסף" בלי קשר לשאלה אם יש עליו כסף פנוי לזיכוי. משמש למשל לקביעה
      // אם צריך להציג כפתור "סגירת תיק" (רלוונטי גם ללקוח שלא שילם כלום).
      rawUncollectedValue += orderUncollected;
    }

    // "ייתכן שיש תשלום שלא אושר" — התראה אחת בלבד ללקוח, לא אחת לכל ניסיון
    // כושל, ורק אם עדיין יש לו חוב (אם הכל שולם, ניסיון ישן ולא-מאושר כבר
    // לא רלוונטי — הבעיה פתרה את עצמה).
    const staleList = staleByPhone.get(c.normalizedPhone) || [];
    const pendingUnconfirmedPayment = balanceDue > 0 && staleList.length
      ? { tokens: staleList.map((s) => s.token), amount: staleList[0].amount, createdAt: staleList[0].createdAt, count: staleList.length }
      : null;

    // כמה מההזמנות של הלקוח הזה אינן משולמות במלואן (גם אם כולן קיבלו סכום
    // כלשהו) — 2+ מסמן מצב "מפל תשלום מפוזר" שכדאי למנהל לשים לב אליו: אף
    // הזמנה בודדת לא בהכרח "נסגרה" למרות שהתקבל תשלום כלשהו.
    const unpaidOrdersCount = c.orders.filter((o) => o.paymentStatus !== 'paid').length;

    return {
      phone: c.phone,
      customerName: c.customerName,
      totalAmount, amountPaid, balanceDue, paymentStatus,
      fullyRedeemed: hasAnyItem && fullyRedeemed,
      bySlot: [...bySlot.values()],
      orders: c.orders,
      pendingUnconfirmedPayment,
      unpaidOrdersCount,
      caseClosed: closureByPhone.get(c.normalizedPhone) || null,
      uncollectedValue,
      rawUncollectedValue,
    };
  }).sort((a, b) => new Date(b.orders[0]?.createdAt || 0) - new Date(a.orders[0]?.createdAt || 0));
}

/**
 * "סגירת תיק" ללקוח — אחרי שהמנהל זיכה אותו (מלא/חלקי) ומחליט שאין יותר
 * מה לעקוב אחריו. לא יוצר שום פעולה כספית — רק דגל, ראו customer_case_closures.
 */
// client אופציונלי (ברירת מחדל pool) — מאפשר קריאה אטומית מתוך טרנזקציה
// אחרת, ראו הסגירה האוטומטית ב-recordCustomerCredit (payments.js) כשמזכים
// ללקוח את מלוא שווי העופות שלא נאספו.
export async function setCustomerCaseClosed(phone, note, adminName, client = pool) {
  const normalizedPhone = normalizePhone(phone);
  await client.query(
    `INSERT INTO customer_case_closures (normalized_phone, phone, note, admin_name, created_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (normalized_phone) DO UPDATE SET phone = $2, note = $3, admin_name = $4, created_at = now()`,
    [normalizedPhone, phone, note || null, adminName]
  );
  await logAction('customer_case_closed', { normalizedPhone, phone, note: note || null, adminName }, client);
  return { success: true };
}

export async function reopenCustomerCase(phone, adminName) {
  const normalizedPhone = normalizePhone(phone);
  const { rowCount } = await pool.query(`DELETE FROM customer_case_closures WHERE normalized_phone = $1`, [normalizedPhone]);
  if (!rowCount) {
    const err = new Error('לא נמצא תיק סגור עבור לקוח זה.');
    err.status = 404;
    throw err;
  }
  await logAction('customer_case_reopened', { normalizedPhone, phone, adminName });
  return { success: true };
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

/**
 * כשהזמנה נמחקת (ישירות, או אוטומטית כי כל השורות שלה הוסרו — למשל "העברת"
 * לקוח מזמן חלוקה אחד לאחר ע"י הקטנת הישן להעלאת החדש), כל תשלום שכבר
 * נרשם נגדה נשאר טכנית קיים (payments.order_id הוא NOT NULL FK, אי אפשר
 * "לרחף") אבל order_balances/listAllOrders מסננים out o.is_deleted — כלומר
 * הכסף שכבר שולם בפועל נעלם מהיתרה/סטטוס של הלקוח, והוא מוצג כ"לא שולם"
 * למרות ששילם. הפונקציה הזו מעבירה תשלומים כאלה להזמנות פעילות אחרות של
 * אותו לקוח, נקראת גם מנקודות המחיקה החיות וגם מ-reconcileOrphanedPayments
 * (ניקוי חד-פעמי למקרים היסטוריים מלפני התיקון הזה).
 *
 * מפל בין הזמנות (לא "הכל להזמנה אחת"!): אם ללקוח כמה הזמנות פעילות עם
 * חוב פתוח (למשל הזמנה שנמחקה פוצלה ידנית לכמה הזמנות חדשות), הסכום
 * היתום מתחלק ביניהן לפי מי שעדיין חייב — הישנה קודם, בדיוק כמו תשלום
 * רגיל (ראו allocateAcrossOpenOrders ב-payments.js). רק שארית שכבר אין
 * לה חוב לכסות (עודף תשלום גרידא) הולכת כולה להזמנה המועדפת (עם חוב
 * פתוח אם יש, אחרת החדשה ביותר) — בדיוק כמו קודם. בלי זה, הכל היה נוחת
 * על הזמנה אחת שרירותית ומשאיר הזמנה אחות בלי שום זיכוי על תשלום
 * שבפועל כן כיסה גם אותה.
 */
// עוזר משותף (גם ל-reassignOrphanedPayments וגם ל-reconcileHistoricalOrphanRebalance
// למטה): מקבל שורות תשלום ורשימת הזמנות-מועמדות עם balance_due, ומחזיר הקצאות
// { payment, orderId, amount } לפי אותו "מפל" — הישנה עם חוב פתוח קודם, כמו
// allocateAcrossOpenOrders ב-payments.js. שורות עם סכום שלילי (זיכוי/תיקון ידני)
// אין להן "קיבולת חוב" למלא באותו מובן, ומועברות שלמות ובלי פיצול ל-preferredTargetId.
function cascadeAllocatePayments(payments, candidates, preferredTargetId) {
  const openQueue = candidates
    .filter((c) => Number(c.balance_due) > 0)
    .sort((a, b) => a.order_sequence - b.order_sequence);

  const allocations = [];
  let queueIdx = 0;
  let remainingCapacity = openQueue.length ? Number(openQueue[0].balance_due) : 0;
  for (const payment of payments) {
    let remainingAmount = Number(payment.amount);
    if (remainingAmount <= 0) {
      allocations.push({ payment, orderId: preferredTargetId, amount: remainingAmount });
      continue;
    }
    while (remainingAmount > 0 && queueIdx < openQueue.length) {
      if (remainingCapacity <= 0) {
        queueIdx += 1;
        remainingCapacity = queueIdx < openQueue.length ? Number(openQueue[queueIdx].balance_due) : 0;
        continue;
      }
      const take = Math.min(remainingAmount, remainingCapacity);
      allocations.push({ payment, orderId: openQueue[queueIdx].id, amount: take });
      remainingAmount -= take;
      remainingCapacity -= take;
    }
    if (remainingAmount > 0) {
      allocations.push({ payment, orderId: preferredTargetId, amount: remainingAmount });
    }
  }
  return allocations;
}

// עוזר משותף: מבצע בפועל הקצאות שחושבו ע"י cascadeAllocatePayments. אם שורת
// תשלום מקור התחלקה בין כמה הזמנות, ההקצאה הראשונה שלה "יורשת" את השורה
// הקיימת (מעדכנים order_id+amount), וכל הקצאה נוספת מאותה שורה נוצרת כשורת
// תשלום חדשה (מעתיקה method/recorded_by/note/created_at מהמקור) — כדי לשמר
// את הסכום הכולל בדיוק ואת שיוך כל שקל להזמנה הנכונה. תשלום שהתפצל בין כמה
// הזמנות מקבל payment_group_id משותף לכל השורות שנוצרו ממנו (כדי שיוצג
// כתשלום אחד בפאנל הניהול, ראו payment_group_id בסכימה) — חוץ מתשלום נדרים
// פלוס, שכבר משותף דרך nedarim_transaction_id ולא זקוק לזה. אם השורה המקורית
// כבר הייתה חלק מקבוצה (payment_group_id לא ריק), משמרים את אותו מזהה כדי
// להישאר מאוחדים עם אחיות שלא הושפעו מהריצה הזו.
async function commitPaymentAllocations(client, allocations) {
  const allocsByPaymentId = new Map();
  for (const a of allocations) {
    if (!allocsByPaymentId.has(a.payment.id)) allocsByPaymentId.set(a.payment.id, []);
    allocsByPaymentId.get(a.payment.id).push(a);
  }
  const groupIdByPaymentId = new Map();
  for (const [paymentId, allocs] of allocsByPaymentId) {
    const existingGroupId = allocs[0].payment.payment_group_id || null;
    const needsGroup = allocs.length > 1 && !allocs[0].payment.nedarim_transaction_id;
    groupIdByPaymentId.set(paymentId, existingGroupId || (needsGroup ? crypto.randomUUID() : null));
  }

  const seenPaymentIds = new Set();
  for (const alloc of allocations) {
    const groupId = groupIdByPaymentId.get(alloc.payment.id);
    if (!seenPaymentIds.has(alloc.payment.id)) {
      seenPaymentIds.add(alloc.payment.id);
      await client.query(`UPDATE payments SET order_id = $1, amount = $2, payment_group_id = $3 WHERE id = $4`, [alloc.orderId, alloc.amount, groupId, alloc.payment.id]);
    } else {
      await client.query(
        `INSERT INTO payments(order_id, amount, method, recorded_by, note, nedarim_transaction_id, created_at, payment_group_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [alloc.orderId, alloc.amount, alloc.payment.method, alloc.payment.recorded_by, alloc.payment.note, alloc.payment.nedarim_transaction_id, alloc.payment.created_at, groupId]
      );
    }
  }
  return [...new Set(allocations.map((a) => a.orderId))];
}

async function reassignOrphanedPayments(client, orderId, normalizedPhone, adminName) {
  const { rows: payments } = await client.query(
    `SELECT id, amount, method, recorded_by, note, nedarim_transaction_id, created_at, payment_group_id
       FROM payments WHERE order_id = $1 ORDER BY id ASC`,
    [orderId]
  );
  if (!payments.length) return { moved: false };
  const totalAmount = payments.reduce((s, p) => s + Number(p.amount), 0);

  const { rows: candidates } = await client.query(
    `SELECT o.id, o.order_sequence, b.balance_due
       FROM orders o
       JOIN order_balances b ON b.order_id = o.id
      WHERE o.normalized_phone = $1 AND o.id <> $2 AND NOT o.is_deleted
      ORDER BY (b.balance_due > 0) DESC, o.order_sequence DESC
      FOR UPDATE OF o`,
    [normalizedPhone, orderId]
  );
  if (!candidates.length) {
    // אין לאן להעביר — ללקוח אין אף הזמנה פעילה אחרת. נרשם ביומן הפעולות
    // (בסגנון ivr_payment_orphaned) כדי שהמנהל יראה את זה ולא רק בלוג
    // הדיפלוי החד-פעמי, שאף אחד לא רואה אחרי שהוא גולל.
    const { rows: orderRow } = await client.query(`SELECT customer_name, phone FROM orders WHERE id = $1`, [orderId]);
    await logAction('payment_reassign_failed_no_active_order', {
      fromOrderId: orderId, customerName: orderRow[0]?.customer_name, phone: orderRow[0]?.phone,
      paymentIds: payments.map((p) => p.id), totalAmount, adminName,
    }, client);
    return { moved: false, reason: 'no_active_orders', orphanedAmount: totalAmount };
  }

  const preferredTargetId = candidates[0].id; // עודף תשלום גרידא (בלי עוד חוב לכסות) הולך לכאן, כמו קודם
  const allocations = cascadeAllocatePayments(payments, candidates, preferredTargetId);
  const targetOrderIds = await commitPaymentAllocations(client, allocations);

  await logAction('payments_reassigned_from_deleted_order', {
    fromOrderId: orderId, toOrderIds: targetOrderIds, paymentIds: payments.map((p) => p.id), totalAmount, adminName,
    allocations: allocations.map((a) => ({ orderId: a.orderId, amount: a.amount })),
  }, client);
  return { moved: true, targetOrderIds, totalAmount };
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
      const { rows: orderRows } = await client.query(`SELECT normalized_phone FROM orders WHERE id = $1`, [orderId]);
      await reassignOrphanedPayments(client, orderId, orderRows[0].normalized_phone, adminName);
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
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT order_number, customer_name, phone, normalized_phone FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId]
    );
    if (!rows.length) {
      const err = new Error('הזמנה לא נמצאה.');
      err.status = 404;
      throw err;
    }
    await reassignOrphanedPayments(client, orderId, rows[0].normalized_phone, adminName);
    await client.query(`UPDATE orders SET is_deleted = true WHERE id = $1`, [orderId]);
    await logAction('order_deleted', { orderId, orderNumber: rows[0].order_number, customerName: rows[0].customer_name, phone: rows[0].phone, adminName }, client);
    return { success: true };
  });
}

/**
 * ניקוי חד-פעמי (בטוח להרצה חוזרת) למקרים היסטוריים מלפני שנכתב הטיפול
 * ב-reassignOrphanedPayments: מאתר תשלומים שנשארו תקועים על הזמנות שנמחקו
 * (is_deleted), ומעביר אותם להזמנה פעילה אחרת של אותו לקוח. רץ אוטומטית
 * בכל דיפלוי (ראו migrate.js).
 */
export async function reconcileOrphanedPayments() {
  // מדלג על תשלומים שכבר סומנו "טופל" ידנית (orphan_acknowledged_at) — אחרי
  // שמנהל בירר את המקרה וסימן אותו, הוא לא אמור לחזור ולהטריד בכל דיפלוי,
  // ראו listStuckOrphanedPayments/acknowledgeOrphanedPayments למטה.
  const { rows: orphanedOrders } = await pool.query(
    `SELECT DISTINCT o.id, o.normalized_phone
       FROM payments p
       JOIN orders o ON o.id = p.order_id
      WHERE o.is_deleted AND p.orphan_acknowledged_at IS NULL`
  );
  let fixedCount = 0;
  let unresolvedCount = 0;
  for (const row of orphanedOrders) {
    const result = await withTransaction((client) => reassignOrphanedPayments(client, row.id, row.normalized_phone, 'system_reconcile'));
    if (result.moved) fixedCount++;
    else if (result.reason === 'no_active_orders') unresolvedCount++;
  }
  return { fixedCount, unresolvedCount };
}

/**
 * ניקוי חד-פעמי (בטוח להרצה חוזרת, רץ אוטומטית בכל דיפלוי) למקרים היסטוריים
 * מלפני שהמפל ההוגן נכתב ב-reassignOrphanedPayments: כשהתיקון הישן היה
 * "הכל להזמנה אחת שרירותית" (details.toOrderId יחיד ביומן הפעולות, לא
 * toOrderIds — מערך, הפורמט החדש), מאתר את השורות המקוריות ומריץ עליהן
 * מחדש את אותו מפל הוגן לפי מצב היתרות *הנוכחי*. אם היעד המקורי כבר לא
 * פעיל, או שהשורות כבר זזו/נמחקו/טופלו בינתיים (למשל ע"י מחיקת הזמנה
 * מאוחרת יותר שכבר עברה דרך הקוד המתוקן) — מדלג, לא נוגע בכלום.
 */
export async function reconcileHistoricalOrphanRebalance() {
  const { rows: oldEvents } = await pool.query(
    `SELECT id, details FROM admin_actions
      WHERE action_type = 'payments_reassigned_from_deleted_order' AND details ? 'toOrderId'
      ORDER BY created_at ASC`
  );
  let fixedCount = 0;
  let skippedCount = 0;
  for (const event of oldEvents) {
    const { rows: already } = await pool.query(
      `SELECT 1 FROM admin_actions
        WHERE action_type = 'orphan_reassignment_rebalanced' AND (details->>'sourceLogId')::int = $1`,
      [event.id]
    );
    if (already.length) continue;

    const toOrderId = Number(event.details.toOrderId);
    const paymentIds = Array.isArray(event.details.paymentIds) ? event.details.paymentIds.map(Number) : [];
    if (!toOrderId || !paymentIds.length) { skippedCount++; continue; }

    const result = await withTransaction((client) => rebalanceHistoricalPayments(client, toOrderId, paymentIds, event.id, 'system_reconcile'));
    if (result.rebalanced) fixedCount++;
    else skippedCount++;
  }
  return { fixedCount, skippedCount };
}

/** עוזר של reconcileHistoricalOrphanRebalance — ראו שם. */
async function rebalanceHistoricalPayments(client, currentOrderId, paymentIds, sourceLogId, adminName) {
  const { rows: orderRow } = await client.query(
    `SELECT normalized_phone FROM orders WHERE id = $1 AND NOT is_deleted FOR UPDATE`,
    [currentOrderId]
  );
  if (!orderRow.length) return { rebalanced: false, reason: 'target_order_missing_or_deleted' };
  const normalizedPhone = orderRow[0].normalized_phone;

  // רק שורות שעדיין באמת יושבות על ההזמנה הזו — אם כבר זזו/נמחקו/נערכו
  // ידנית בינתיים, מדלגים על מה שאין (אידמפוטנטי מול תיקונים מאוחרים יותר).
  const { rows: payments } = await client.query(
    `SELECT id, amount, method, recorded_by, note, nedarim_transaction_id, created_at, payment_group_id
       FROM payments WHERE id = ANY($1::int[]) AND order_id = $2 FOR UPDATE`,
    [paymentIds, currentOrderId]
  );
  if (!payments.length) return { rebalanced: false, reason: 'payments_moved_or_missing' };

  const { rows: candidates } = await client.query(
    `SELECT o.id, o.order_sequence, b.balance_due
       FROM orders o JOIN order_balances b ON b.order_id = o.id
      WHERE o.normalized_phone = $1 AND NOT o.is_deleted
      ORDER BY (b.balance_due > 0) DESC, o.order_sequence DESC
      FOR UPDATE OF o`,
    [normalizedPhone]
  );
  // preferredTargetId = ההזמנה שכבר קיבלה הכל בעבר (currentOrderId) — עודף
  // תשלום גרידא (אחרי שכל אחיה עם חוב פתוח קיבלה את חלקה) ממשיך לנחות שם,
  // בדיוק כמו בהתנהגות הרגילה של reassignOrphanedPayments.
  const preferredTargetId = currentOrderId;
  const allocations = cascadeAllocatePayments(payments, candidates, preferredTargetId);
  const changed = allocations.some((a) => a.orderId !== currentOrderId || a.amount !== Number(a.payment.amount));

  if (!changed) {
    await logAction('orphan_reassignment_rebalanced', {
      sourceLogId, orderId: currentOrderId, paymentIds, changed: false, adminName,
    }, client);
    return { rebalanced: true, changed: false };
  }

  const targetOrderIds = await commitPaymentAllocations(client, allocations);
  await logAction('orphan_reassignment_rebalanced', {
    sourceLogId, fromOrderId: currentOrderId, toOrderIds: targetOrderIds, paymentIds,
    allocations: allocations.map((a) => ({ orderId: a.orderId, amount: a.amount })), changed: true, adminName,
  }, client);
  return { rebalanced: true, changed: true };
}

/**
 * תשלומים שנשארו "תקועים" על הזמנות שנמחקו ולא הצלחנו להעביר להזמנה
 * פעילה אחרת של אותו לקוח — למסך ניהול ייעודי ("תשלומים תקועים" בדשבורד)
 * שבו אפשר לברר מול הלקוח ואז לסמן כטופל (ראו acknowledgeOrphanedPayments).
 */
export async function listStuckOrphanedPayments() {
  const { rows } = await pool.query(
    `SELECT o.id AS order_id, o.order_number, o.customer_name, o.phone, o.normalized_phone,
            COALESCE(SUM(p.amount), 0) AS total_amount,
            array_agg(p.id ORDER BY p.id) AS payment_ids,
            MIN(p.created_at) AS earliest_payment_at
       FROM payments p
       JOIN orders o ON o.id = p.order_id
      WHERE o.is_deleted AND p.orphan_acknowledged_at IS NULL
      GROUP BY o.id, o.order_number, o.customer_name, o.phone, o.normalized_phone
      ORDER BY MIN(p.created_at) DESC`
  );
  return rows.map((r) => ({
    orderId: r.order_id,
    orderNumber: r.order_number,
    customerName: r.customer_name,
    phone: r.phone,
    normalizedPhone: r.normalized_phone,
    totalAmount: Number(r.total_amount),
    paymentIds: r.payment_ids,
    earliestPaymentAt: r.earliest_payment_at,
  }));
}

/** מסמן את כל התשלומים התקועים על הזמנה מחוקה מסוימת כ"טופל" — ראו listStuckOrphanedPayments. */
export async function acknowledgeOrphanedPayments(orderId, adminName) {
  const { rows } = await pool.query(
    `UPDATE payments SET orphan_acknowledged_at = now()
      WHERE order_id = $1 AND orphan_acknowledged_at IS NULL
      RETURNING id, amount`,
    [orderId]
  );
  if (!rows.length) {
    const err = new Error('לא נמצאו תשלומים תקועים על הזמנה זו.');
    err.status = 404;
    throw err;
  }
  const totalAmount = rows.reduce((s, p) => s + Number(p.amount), 0);
  await logAction('orphaned_payment_acknowledged', { orderId, paymentIds: rows.map((p) => p.id), totalAmount, adminName });
  return { success: true };
}

/**
 * "תיאום תשלום" — מנהל מסמן שתיאם עם הלקוח תשלום שעדיין לא בוצע בפועל
 * (טלפונית/במשרד וכו'). לא נוגע ב-payment_status/יתרות/משיכה — רק נועל
 * את ההזמנה מפני ביטול/עריכה עצמית של הלקוח (ראו cancelUnpaidOrder ב-
 * orders.js), ומחליף את אזהרת "העופות לא נשמרים" בציון היתרה בלבד באזור
 * האישי (ראו /payment-balance ב-api.js).
 */
export async function setOrderPaymentCoordinated(orderId, coordinated, adminName) {
  const { rows } = await pool.query(`SELECT order_number, customer_name, phone FROM orders WHERE id = $1`, [orderId]);
  if (!rows.length) {
    const err = new Error('הזמנה לא נמצאה.');
    err.status = 404;
    throw err;
  }
  await pool.query(`UPDATE orders SET payment_coordinated = $2 WHERE id = $1`, [orderId, !!coordinated]);
  await logAction('payment_coordinated_set', {
    orderId, orderNumber: rows[0].order_number, customerName: rows[0].customer_name, phone: rows[0].phone,
    coordinated: !!coordinated, adminName,
  });
  return { success: true };
}

/**
 * כמו setOrderPaymentCoordinated, אבל על כל ההזמנות הפתוחות (לא 'paid')
 * של לקוח יחד — כדי שתיאום תשלום יחול על הלקוח כולו ולא רק על הזמנה
 * בודדת, שדורש סימון נפרד לכל הזמנה.
 */
export async function setCustomerPaymentCoordinated(normalizedPhone, coordinated, adminName) {
  const { rows } = await pool.query(
    `SELECT o.id, o.customer_name
       FROM orders o
       JOIN order_balances b ON b.order_id = o.id
      WHERE o.normalized_phone = $1 AND NOT o.is_deleted AND b.payment_status <> 'paid'`,
    [normalizedPhone]
  );
  if (!rows.length) {
    const err = new Error('אין ללקוח זה הזמנות שאינן משולמות במלואן.');
    err.status = 400;
    throw err;
  }
  const orderIds = rows.map((r) => r.id);
  await pool.query(`UPDATE orders SET payment_coordinated = $2 WHERE id = ANY($1::int[])`, [orderIds, !!coordinated]);
  await logAction('payment_coordinated_set', {
    phone: normalizedPhone, customerName: rows[0].customer_name, orderIds,
    coordinated: !!coordinated, adminName,
  });
  return { success: true, orderIds };
}

// מוריד `excess` מיומן המשיכות (redemptions) של שורת הזמנה נתונה, מהאירועים
// העדכניים ביותר קודם (LIFO), כולל פיצול אירוע חלקית אם צריך. משמש גם
// כשמנהל מבטל/מקטין איסוף (setItemRedeemedQuantity) וגם בניקוי חד-פעמי של
// רשומות שנשארו תקועות מלפני שהתיקון הזה נכתב (ראו reconcileRedemptionLog).
async function trimRedemptionLog(client, itemId, excess) {
  let remaining = excess;
  const { rows: existing } = await client.query(
    `SELECT id, quantity FROM redemptions WHERE order_item_id = $1 ORDER BY redeemed_at DESC, id DESC FOR UPDATE`,
    [itemId]
  );
  for (const r of existing) {
    if (remaining <= 0) break;
    if (r.quantity <= remaining) {
      await client.query(`DELETE FROM redemptions WHERE id = $1`, [r.id]);
      remaining -= r.quantity;
    } else {
      await client.query(`UPDATE redemptions SET quantity = quantity - $2 WHERE id = $1`, [r.id, remaining]);
      remaining = 0;
    }
  }
}

/**
 * "מצב איסוף" ידני ע"י מנהל: קובע ישירות כמה נמשכו בפועל משורת הזמנה, בלי
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
    } else if (delta < 0) {
      // תיקון-כלפי-מטה (כולל ביטול איסוף מלא): מורידים בהתאם את יומן
      // המשיכות (redemptions) עצמו — אחרת אירועי משיכה שבוטלו/תוקנו ימשיכו
      // להופיע לנצח בדוחות המבוססים על היומן (ציר הזמן בדשבורד), למרות
      // שבפועל אין להם כיסוי ב-quantity_redeemed.
      await trimRedemptionLog(client, itemId, -delta);
    }
    await logAction('redemption_manual_override', {
      itemId, orderId: item.order_id, oldQuantityRedeemed: item.quantity_redeemed, newQuantityRedeemed: q, delta, adminName,
    }, client);
    return { success: true };
  });
}

/**
 * ניקוי חד-פעמי (אך בטוח להרצה חוזרת — idempotent): לפני שנכתב הטיפול ב-
 * trimRedemptionLog למעלה, ביטול/הקטנת איסוף לא הוריד רשומות מיומן
 * redemptions, כך שאיסופי-ניסיון שבוטלו נשארו רשומים שם לנצח והמשיכו
 * להופיע בציר הזמן בדשבורד. מאתר כל שורת הזמנה שבה סכום היומן גדול
 * מהכמות שבאמת נמשכה כרגע, ומקצץ את העודף (LIFO) כדי שהיומן יתאים למצב
 * בפועל. רץ אוטומטית בכל דיפלוי (ראו migrate.js) — אחרי הריצה הראשונה
 * שמתקנת את הפער ההיסטורי, אין יותר מה לתקן וזה no-op.
 */
export async function reconcileRedemptionLog() {
  const { rows: mismatched } = await pool.query(
    `SELECT oi.id AS item_id, oi.quantity_redeemed, COALESCE(SUM(r.quantity), 0)::int AS logged
       FROM order_items oi
       LEFT JOIN redemptions r ON r.order_item_id = oi.id
      GROUP BY oi.id, oi.quantity_redeemed
     HAVING COALESCE(SUM(r.quantity), 0) > oi.quantity_redeemed`
  );
  for (const row of mismatched) {
    await withTransaction((client) => trimRedemptionLog(client, row.item_id, row.logged - row.quantity_redeemed));
  }
  return { itemsFixed: mismatched.length };
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
  // גרסה "מאובטחת" של אותה טבלה — רק הזמנות ששולמו במלואן או תואמו מול
  // המשרד, כלומר עופות שבאמת נחשבים שמורים. זו ברירת המחדל בתצוגה בדשבורד,
  // עם אפשרות להחליף לתצוגת "הכל" כולל מה שעוד לא הוסדר.
  const { rows: securedRows } = await pool.query(
    `SELECT oi.slot_id, s.name AS slot_name, oi.gender,
            SUM(oi.quantity)::int AS ordered,
            SUM(oi.quantity_redeemed)::int AS redeemed,
            SUM(oi.line_total) AS revenue_ordered
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN order_balances b ON b.order_id = o.id
       JOIN distribution_slots s ON s.id = oi.slot_id
      WHERE NOT o.is_deleted AND (b.payment_status = 'paid' OR o.payment_coordinated)
      GROUP BY oi.slot_id, s.name, oi.gender
      ORDER BY s.name, oi.gender`
  );
  const { rows: paidRows } = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total_paid FROM payments`
  );

  // פילוח תשלומים לפי אמצעי (נדרים פלוס / מזומן / אשראי ידני / אחר) — "אחר"
  // מפוצל לשורה נפרדת לכל הערה (note) שונה, כי "אחר" לבדו מסתיר פרטים
  // חשובים (למשל "העברה בנקאית" מול "ביט"); שאר האמצעים נשארים שורה אחת כרגיל.
  const { rows: paidByMethodRows } = await pool.query(
    `SELECT method,
            CASE WHEN method = 'manual_admin' THEN note ELSE NULL END AS note,
            COALESCE(SUM(amount),0) AS total
       FROM payments
      GROUP BY method, CASE WHEN method = 'manual_admin' THEN note ELSE NULL END
      ORDER BY method`
  );

  // כמה עוד לא שולם: בכסף — סכום היתרות הפתוחות בפועל (balance_due), לא שווי
  // מלא של ההזמנה (הבדל משמעותי בתשלום חלקי). בעופות — סכום הכמות בהזמנות
  // שעדיין לא שולמו במלואן (paymentStatus != 'paid'), כי זה בדיוק מה שחסום
  // למשיכה כרגע — ראו שער התשלום ב-redemption.js: כל שורות הזמנה שלא שולמה
  // עד תום נחסמות יחד, גם אם שולם בה חלקית, ולא רק שורות "היתרה" שלה.
  const { rows: unpaidMoneyRows } = await pool.query(
    `SELECT COALESCE(SUM(b.balance_due),0) AS unpaid_money
       FROM orders o JOIN order_balances b ON b.order_id = o.id
      WHERE NOT o.is_deleted`
  );
  const { rows: unpaidBirdsRows } = await pool.query(
    `SELECT COALESCE(SUM(oi.quantity),0)::int AS unpaid_birds
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN order_balances b ON b.order_id = o.id
      WHERE NOT o.is_deleted AND b.payment_status <> 'paid'`
  );
  // המראה של unpaidBirds — כמות עופות בהזמנות ששולמו במלואן, לתצוגה ליד "סה"כ שולם".
  const { rows: paidBirdsRows } = await pool.query(
    `SELECT COALESCE(SUM(oi.quantity),0)::int AS paid_birds
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN order_balances b ON b.order_id = o.id
      WHERE NOT o.is_deleted AND b.payment_status = 'paid'`
  );

  // ציר זמן הזמנות: סה"כ עופות שהוזמנו בכל יום קלנדרי (לפי מתי בוצעה ההזמנה, לא תאריך האספקה) — למעקב קצב הרשמה.
  const { rows: ordersByDateRows } = await pool.query(
    `SELECT o.created_at::date AS date, SUM(oi.quantity)::int AS total
       FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE NOT o.is_deleted
      GROUP BY o.created_at::date
      ORDER BY date`
  );

  // ציר זמן איסופים: עופות שנמשכו בפועל, בקפיצות של 10 דקות לפי שעון-קיר
  // (5:30-5:39, 5:40-5:49...) — ציר נפרד לכל חלוקה. floor לפי epoch (UTC) נותן
  // בדיוק את אותה רשת 10-דקות כמו floor לפי שעון ישראל, כי ההפרש בין
  // האזורים הוא תמיד כפולה של שעות שלמות (=כפולה של 10 דקות).
  const { rows: redemptionRows } = await pool.query(
    `SELECT oi.slot_id, s.name AS slot_name, s.color AS slot_color,
            to_timestamp(FLOOR(EXTRACT(EPOCH FROM red.redeemed_at) / 600) * 600) AS bucket_start,
            SUM(red.quantity)::int AS total
       FROM redemptions red
       JOIN order_items oi ON oi.id = red.order_item_id
       JOIN distribution_slots s ON s.id = oi.slot_id
      GROUP BY oi.slot_id, s.name, s.color, bucket_start
      ORDER BY oi.slot_id, bucket_start`
  );
  const redemptionBySlot = new Map();
  for (const r of redemptionRows) {
    if (!redemptionBySlot.has(r.slot_id)) {
      redemptionBySlot.set(r.slot_id, { slotId: r.slot_id, slotName: r.slot_name, slotColor: r.slot_color, buckets: [] });
    }
    redemptionBySlot.get(r.slot_id).buckets.push({ bucketStart: r.bucket_start, total: r.total });
  }

  const mapSlotRow = (r) => ({
    slotId: r.slot_id, slotName: r.slot_name, gender: r.gender,
    ordered: r.ordered, redeemed: r.redeemed, revenueOrdered: Number(r.revenue_ordered),
  });

  return {
    bySlotAll: rows.map(mapSlotRow),
    bySlotSecured: securedRows.map(mapSlotRow),
    totalPaid: Number(paidRows[0].total_paid),
    paidBirds: paidBirdsRows[0].paid_birds,
    paidByMethod: paidByMethodRows.map((r) => ({ method: r.method, note: r.note, total: Number(r.total) })),
    unpaidMoney: Number(unpaidMoneyRows[0].unpaid_money),
    unpaidBirds: unpaidBirdsRows[0].unpaid_birds,
    ordersByDate: ordersByDateRows.map((r) => ({ date: r.date, total: r.total })),
    redemptionTimeline: [...redemptionBySlot.values()],
  };
}

/** איפוס קשיח — מוחק את כל נתוני ההזמנות/תשלומים/משיכות. משמר settings, admins, זמני חלוקה ויומן הפעולות. */
export async function hardReset(performedBy) {
  await pool.query('TRUNCATE redemptions, webhook_events, payments, payment_sessions, order_items, orders, otp_codes RESTART IDENTITY');
  await pool.query(`ALTER SEQUENCE order_number_seq RESTART WITH 1001`);
  await logAction('hard_reset', { performedBy: performedBy || null });
  return { success: true };
}

/**
 * סימון ידני של תגובת לקוח לעדכון קבוצתי (מגיע/לא מגיע) — למי שלא הגיב
 * ב-SMS אבל המנהל בירר איתו (למשל בטלפון) מה מצבו. נשמר בטבלה נפרדת
 * וממוזג עם התגובות שהגיעו כ-SMS אמיתי ב-GET /admin/sms/responses (ראו
 * routes/api.js) — פנייה חוזרת לאותו טלפון פשוט מעדכנת (upsert).
 */
export async function setManualBroadcastResponse(phone, answer, adminName) {
  const answerNum = Number(answer);
  if (![1, 2].includes(answerNum)) {
    const err = new Error('סטטוס לא תקין.');
    err.status = 400;
    throw err;
  }
  const normalizedPhone = normalizePhone(phone);
  await pool.query(
    `INSERT INTO broadcast_manual_responses (normalized_phone, phone, answer, admin_name, created_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (normalized_phone) DO UPDATE SET phone = $2, answer = $3, admin_name = $4, created_at = now()`,
    [normalizedPhone, phone, answerNum, adminName]
  );
  await logAction('broadcast_response_marked_manually', { normalizedPhone, phone, answer: answerNum, adminName });
  return { success: true };
}

export async function getManualBroadcastResponses() {
  const { rows } = await pool.query(
    `SELECT normalized_phone, phone, answer, admin_name, created_at FROM broadcast_manual_responses`
  );
  return rows.map((r) => ({
    normalizedPhone: r.normalized_phone,
    phone: r.phone,
    answer: r.answer,
    adminName: r.admin_name,
    time: r.created_at,
  }));
}

/** מסמן/מבטל סימון SMS נכנס כ"טופל" — ראו incomingSmsMessageKey ב-sms.js. */
export async function markIncomingSmsHandled(messageKey, phone, adminName) {
  await pool.query(
    `INSERT INTO incoming_sms_handled (message_key, phone, admin_name, created_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (message_key) DO NOTHING`,
    [messageKey, phone, adminName]
  );
  await logAction('incoming_sms_marked_handled', { messageKey, phone, adminName });
  return { success: true };
}

export async function unmarkIncomingSmsHandled(messageKey) {
  await pool.query(`DELETE FROM incoming_sms_handled WHERE message_key = $1`, [messageKey]);
  return { success: true };
}

export async function getHandledIncomingSmsKeys() {
  const { rows } = await pool.query(`SELECT message_key FROM incoming_sms_handled`);
  return new Set(rows.map((r) => r.message_key));
}

function mapPhoneCreditRequest(r) {
  return {
    normalizedPhone: r.normalized_phone,
    phone: r.phone,
    ceilingAmount: Number(r.ceiling_amount),
    requestedAmount: Number(r.requested_amount),
    status: r.status,
    creditedAmount: r.credited_amount == null ? null : Number(r.credited_amount),
    handledBy: r.handled_by,
    handledAt: r.handled_at,
    apiCallId: r.api_call_id,
    createdAt: r.created_at,
  };
}

/** בקשת זיכוי שהוגשה טלפונית (שלוחה 9/3) — ראו routes/ivr.js וטבלת phone_credit_requests בסכימה. */
export async function getPhoneCreditRequest(normalizedPhone) {
  const { rows } = await pool.query(`SELECT * FROM phone_credit_requests WHERE normalized_phone = $1`, [normalizedPhone]);
  return rows[0] ? mapPhoneCreditRequest(rows[0]) : null;
}

// ON CONFLICT קיים בעיקר להגנה מפני מצב מירוץ (שתי שיחות בו-זמנית) — בפועל
// שלוחת ה-IVR עצמה לא קוראת לפונקציה הזו כשכבר יש בקשה קיימת (ראו שם).
export async function createPhoneCreditRequest({ normalizedPhone, phone, ceilingAmount, requestedAmount, apiCallId }) {
  await pool.query(
    `INSERT INTO phone_credit_requests(normalized_phone, phone, ceiling_amount, requested_amount, api_call_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (normalized_phone) DO UPDATE SET
       phone = $2, ceiling_amount = $3, requested_amount = $4, api_call_id = $5,
       status = 'pending', credited_amount = NULL, handled_by = NULL, handled_at = NULL, created_at = now()`,
    [normalizedPhone, phone, ceilingAmount, requestedAmount, apiCallId || null]
  );
  await logAction('phone_credit_request_submitted', { normalizedPhone, phone, ceilingAmount, requestedAmount, apiCallId: apiCallId || null });
}

/** לטאב "בקשות דרך הטלפון" (תת-טאב של הודעות נכנסות) בפאנל הניהול. */
export async function listPhoneCreditRequests() {
  const { rows } = await pool.query(`SELECT * FROM phone_credit_requests ORDER BY created_at DESC`);
  return rows.map(mapPhoneCreditRequest);
}

/**
 * מנהל מסמן בקשה כ"טופלה" ומזין את הסכום שבאמת זוכה (יכול להיות שונה
 * מהסכום שהלקוח ביקש, וגם 0 אם לא אושר זיכוי כלל) — זה מה שיוקרא ללקוח
 * בפעם הבאה שיתקשר לאותה שלוחה. לא מבצע שום זיכוי בפועל בעצמו — הזיכוי
 * האמיתי עדיין נרשם ידנית ע"י המנהל דרך "רישום תשלום" הרגיל, כמו כל זיכוי.
 */
export async function markPhoneCreditRequestHandled(normalizedPhone, creditedAmount, adminName) {
  const amt = Number(creditedAmount);
  if (!Number.isFinite(amt) || amt < 0) {
    const err = new Error('סכום הזיכוי שאושר אינו תקין.');
    err.status = 400;
    throw err;
  }
  const { rows } = await pool.query(
    `UPDATE phone_credit_requests SET status='handled', credited_amount=$2, handled_by=$3, handled_at=now()
      WHERE normalized_phone = $1 RETURNING *`,
    [normalizedPhone, amt, adminName]
  );
  if (!rows.length) {
    const err = new Error('בקשה לא נמצאה.');
    err.status = 404;
    throw err;
  }
  await logAction('phone_credit_request_handled', { normalizedPhone, creditedAmount: amt, adminName });
  return mapPhoneCreditRequest(rows[0]);
}

/** מוחקת את הבקשה — מאפשרת ללקוח להגיש בקשה חדשה בפעם הבאה שיתקשר. */
export async function deletePhoneCreditRequest(normalizedPhone, adminName) {
  const { rowCount } = await pool.query(`DELETE FROM phone_credit_requests WHERE normalized_phone = $1`, [normalizedPhone]);
  if (!rowCount) {
    const err = new Error('בקשה לא נמצאה.');
    err.status = 404;
    throw err;
  }
  await logAction('phone_credit_request_deleted', { normalizedPhone, adminName });
  return { success: true };
}
