import { Router } from 'express';
import { normalizePhone, isValidIsraeliPhone } from '../lib/normalize.js';
import { getPublicSettings, getSettings, setSettings } from '../lib/settings.js';
import { requestOtp, verifyOtp } from '../lib/otp.js';
import {
  loginWithPassword, requestAdminOtp, verifyAdminOtp, requireAdmin, requirePermission, requireAnyPermission,
} from '../lib/auth.js';
import { listAdmins, createAdmin, updateAdmin, deleteAdmin } from '../lib/admins.js';
import {
  getOpenSlotsForRegistration, getAllSlots, createSlot, updateSlot, deleteSlot, suggestDayLabel,
} from '../lib/slots.js';
import {
  countOrdersForPhone, createOrder, listOrdersForPhone, getCustomerName, updateCustomerName, updateCustomerPhone, cancelUnpaidOrder,
} from '../lib/orders.js';
import { getRedemptionStatus, confirmSlotRedemption, getRedemptionHistoryForPhone } from '../lib/redemption.js';
import {
  recordManualPayment, recordManualPaymentForCustomer, listPaymentsForOrder, listAllPayments,
  createPaymentSession, confirmClientReportedPayment, cancelPaymentSession,
  dismissStalePaymentSession, dismissAllStalePaymentSessions,
  updateManualPayment, deleteManualPayment,
} from '../lib/payments.js';
import {
  listAllOrders, listCustomersSummary, getDashboardStats, hardReset,
  updateOrderItemQuantity, deleteOrderItem, deleteOrder, setItemRedeemedQuantity, setOrderPaymentCoordinated, setCustomerPaymentCoordinated,
  setManualBroadcastResponse, getManualBroadcastResponses,
  listStuckOrphanedPayments, acknowledgeOrphanedPayments,
  setCustomerCaseClosed, reopenCustomerCase,
  markIncomingSmsHandled, unmarkIncomingSmsHandled, getHandledIncomingSmsKeys,
} from '../lib/adminOps.js';
import { createTransaction } from '../lib/nedarim.js';
import { listActions, logAction } from '../lib/actionLog.js';
import { sendSms, sendBulkSms, getSmsHistoryForPhone, getAllIncomingSms, getBroadcastResponses, BROADCAST_ANSWER_LABEL } from '../lib/sms.js';
import { runYemotTestCalls } from '../lib/yemotIvr.js';

const router = Router();

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function setAdminSession(req, admin) {
  req.session.isAdmin = true;
  req.session.adminId = admin.id;
  req.session.adminName = admin.name;
  req.session.adminPermissions = admin.permissions;
}

/** דורש שהטלפון הזה כבר עבר אימות OTP באותו session (ראו /otp/verify). */
function requireVerifiedPhone(req, res, next) {
  const phone = req.body?.phone ?? req.query?.phone;
  const normalized = normalizePhone(phone);
  if (!normalized || req.session?.verifiedPhone !== normalized) {
    return res.status(401).json({ error: 'נדרש אימות קוד סמס לטלפון זה.', requiresOtp: true });
  }
  next();
}

// ============== ציבורי ==============

router.get('/public-settings', wrap(async (req, res) => {
  res.json(await getPublicSettings());
}));

router.get('/slots/open', wrap(async (req, res) => {
  res.json(await getOpenSlotsForRegistration());
}));

// בודק אם זו הרשמה ראשונה (אין עדיין הזמנות לטלפון הזה -> לא נדרש OTP)
// או כניסה חוזרת (יש היסטוריה -> הלקוח יופנה לבקש/להזין קוד).
router.post('/check-phone', wrap(async (req, res) => {
  const normalized = normalizePhone(req.body?.phone);
  if (!isValidIsraeliPhone(normalized)) {
    return res.status(400).json({ error: 'מספר טלפון לא תקין.' });
  }
  const count = await countOrdersForPhone(normalized);
  res.json({
    normalizedPhone: normalized,
    isFirstTime: count === 0,
    alreadyVerified: req.session?.verifiedPhone === normalized,
  });
}));

router.post('/otp/request', wrap(async (req, res) => {
  const normalized = normalizePhone(req.body?.phone);
  if (!isValidIsraeliPhone(normalized)) {
    return res.status(400).json({ error: 'מספר טלפון לא תקין.' });
  }
  res.json(await requestOtp(normalized, 'personal_area'));
}));

router.post('/otp/verify', wrap(async (req, res) => {
  const normalized = normalizePhone(req.body?.phone);
  await verifyOtp(normalized, req.body?.code, 'personal_area');
  req.session.verifiedPhone = normalized;
  res.json({ verified: true });
}));

// הרשמה ראשונה (ללא OTP, אם באמת אין עדיין הזמנות לטלפון) או "הזמנה נוספת"
// (דורש שה-session כבר אומת עבור הטלפון הזה — נבדק בפועל ע"י createOrder
// דרך countOrdersForPhone, לא ע"י מה שהלקוח טוען מהדפדפן).
router.post('/register', wrap(async (req, res) => {
  const normalized = normalizePhone(req.body?.phone);
  const existingCount = await countOrdersForPhone(normalized);
  if (existingCount > 0 && req.session?.verifiedPhone !== normalized) {
    return res.status(401).json({ error: 'נדרש אימות קוד סמס לפני ביצוע הזמנה נוספת.', requiresOtp: true });
  }
  const order = await createOrder(req.body, { changedBy: 'customer' });
  req.session.verifiedPhone = normalized; // מאפשר גישה מיידית לאזור האישי באותו session
  res.json(order);
}));

router.get('/my-orders', requireVerifiedPhone, wrap(async (req, res) => {
  const normalized = normalizePhone(req.query.phone);
  res.json(await listOrdersForPhone(normalized));
}));

// ביטול עצמי של הזמנה שלא שולם עליה כלל — ראו cancelUnpaidOrder ב-orders.js לתנאים המדויקים.
router.post('/orders/:id/cancel', requireVerifiedPhone, wrap(async (req, res) => {
  const normalized = normalizePhone(req.body.phone);
  res.json(await cancelUnpaidOrder(Number(req.params.id), normalized));
}));

router.get('/customer-name', requireVerifiedPhone, wrap(async (req, res) => {
  const normalized = normalizePhone(req.query.phone);
  res.json({ customerName: await getCustomerName(normalized) });
}));

router.put('/customer-name', requireVerifiedPhone, wrap(async (req, res) => {
  const normalized = normalizePhone(req.body.phone);
  res.json(await updateCustomerName(normalized, req.body.customerName));
}));

router.get('/redeem/status', requireVerifiedPhone, wrap(async (req, res) => {
  const normalized = normalizePhone(req.query.phone);
  const settings = await getPublicSettings();
  res.json({ ...(await getRedemptionStatus(normalized)), distributionOpen: settings.distributionOpen });
}));

// איסוף משולב (זכרים+נקבות יחד) לזמן חלוקה שלם — ראו confirmSlotRedemption ב-redemption.js.
router.post('/redeem/confirm-slot', requireVerifiedPhone, wrap(async (req, res) => {
  const normalized = normalizePhone(req.body.phone);
  const result = await confirmSlotRedemption(
    normalized, Number(req.body.slotId),
    { maleQuantity: req.body.maleQuantity, femaleQuantity: req.body.femaleQuantity },
    normalized
  );
  res.json(result);
}));

router.get('/payment-balance', requireVerifiedPhone, wrap(async (req, res) => {
  const normalized = normalizePhone(req.query.phone);
  const orders = await listOrdersForPhone(normalized);
  const balanceDue = orders.reduce((sum, o) => sum + o.balanceDue, 0);
  const totalAmount = orders.reduce((sum, o) => sum + o.totalAmount, 0);
  const amountPaid = orders.reduce((sum, o) => sum + o.amountPaid, 0);
  const ordersWithBalance = orders.filter((o) => o.balanceDue > 0);
  res.json({
    balanceDue, totalAmount, amountPaid,
    // פירוט פר-הזמנה (לא רק סכום מצרפי) — כדי שהלקוח יראה בדיוק איזו הזמנה
    // "שמורה" (תואמה) ואיזו עדיין ממתינה לתשלום, ראו loadPersonalAreaDebtWarning ב-index.html.
    ordersWithBalance: ordersWithBalance.map((o) => ({
      orderSequence: o.orderSequence, balanceDue: o.balanceDue, paymentCoordinated: o.paymentCoordinated,
    })),
    // כל ההזמנות שיש בהן חוב תואמו עם המשרד — לא מציגים את אזהרת "העופות
    // לא נשמרים", רק את סכום היתרה עצמו (ראו loadPersonalAreaDebtWarning ב-index.html).
    allCoordinated: ordersWithBalance.length > 0 && ordersWithBalance.every((o) => o.paymentCoordinated),
  });
}));

function publicBaseUrl() {
  return process.env.PUBLIC_BASE_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
}

// שיטה 3 מסלול ב' (עסקה שהוקמה בשרת) — ראו docs/nedarim-plus-integration.md.
// מחשב את היתרה האמיתית ברגע הלחיצה (לא סומך על מה שהלקוח ראה קודם), פותח
// payment_session (Param2), ומקים עסקה נעולה-סכום מול נדרים פלוס.
// amount בגוף הבקשה הוא אופציונלי — מאפשר ללקוח לבחור לשלם רק חלק מהיתרה
// (למשל חוב של 150, בוחר לשלם 100 כרגע). ברירת המחדל (בלי amount) היא כל
// היתרה. תמיד נבדק מול היתרה האמיתית מה-DB, לא סומכים על מה שהלקוח שלח.
router.post('/payment/create-session', requireVerifiedPhone, wrap(async (req, res) => {
  const normalized = normalizePhone(req.body.phone);
  const orders = await listOrdersForPhone(normalized);
  const balanceDue = orders.reduce((sum, o) => sum + o.balanceDue, 0);
  if (balanceDue <= 0) {
    return res.status(400).json({ error: 'אין יתרת חוב פתוחה לתשלום.' });
  }
  let amount = balanceDue;
  if (req.body.amount != null && req.body.amount !== '') {
    amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > balanceDue) {
      return res.status(400).json({ error: `יש להזין סכום בין 1 ל-${balanceDue} ₪.` });
    }
  }
  const customerName = orders[0]?.customerName || '';
  const [firstName, ...restName] = customerName.split(' ').filter(Boolean);
  const lastName = restName.join(' ');
  const zeout = String(req.body.zeout || '').trim();
  if (zeout && !/^\d{4,9}$/.test(zeout)) {
    return res.status(400).json({ error: 'מספר תעודת הזהות שהוזן אינו תקין (4-9 ספרות) — אפשר גם להשאיר ריק.' });
  }
  const mail = String(req.body.mail || '').trim();
  if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    return res.status(400).json({ error: 'כתובת המייל אינה תקינה.' });
  }
  const session = await createPaymentSession(normalized, amount);
  const { transactionId, key } = await createTransaction({
    amount,
    param2: session.token,
    callbackUrl: `${publicBaseUrl()}/webhooks/nedarim-plus`,
    firstName,
    lastName,
    zeout: zeout || undefined,
    mail: mail || undefined,
    groupe: 'תשלום על כפרות',
  });
  res.json({ transactionId, key, amount, token: session.token });
}));

// אישור אופטימי מהדפדפן (Status:'OK' מהאייפרם) — ראו confirmClientReportedPayment
// ב-payments.js. לא מחכה ל-Webhook; לא סומך על שום סכום מהלקוח, רק על מה
// שכבר ננעל בשרת ב-payment_sessions.requested_amount.
router.post('/payment/confirm-client', requireVerifiedPhone, wrap(async (req, res) => {
  const normalized = normalizePhone(req.body.phone);
  const result = await confirmClientReportedPayment(req.body?.token, normalized, req.body?.transactionId);
  res.json(result);
}));

// האייפרם דיווח על כישלון/ביטול מפורש (Status !== 'OK') — ראו cancelPaymentSession
// ב-payments.js. מונע התראת "ייתכן שיש תשלום שלא אושר" שגויה על ניסיון שידוע שנכשל.
router.post('/payment/cancel-session', requireVerifiedPhone, wrap(async (req, res) => {
  const normalized = normalizePhone(req.body.phone);
  res.json(await cancelPaymentSession(req.body?.token, normalized));
}));

// מנקה את אימות הטלפון מה-session — קריטי בעמדת הקיוסק המשותפת (וגם כפתור
// "יציאה מהאזור האישי" הרגיל), כדי שלקוח אחד לא "יישאר מחובר" עבור הבא בתור.
router.post('/session/end', (req, res) => {
  req.session.verifiedPhone = null;
  res.json({ success: true });
});

// ============== מנהל ==============

router.post('/admin/login-password', wrap(async (req, res) => {
  const admin = await loginWithPassword(req.body?.phone, req.body?.password);
  setAdminSession(req, admin);
  res.json({ success: true, name: admin.name, permissions: admin.permissions });
}));

router.post('/admin/otp/request', wrap(async (req, res) => {
  res.json(await requestAdminOtp(req.body?.phone));
}));

router.post('/admin/otp/verify', wrap(async (req, res) => {
  const admin = await verifyAdminOtp(req.body?.phone, req.body?.code);
  setAdminSession(req, admin);
  res.json({ success: true, name: admin.name, permissions: admin.permissions });
}));

router.post('/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  req.session.adminId = null;
  req.session.adminPermissions = null;
  res.json({ success: true });
});

router.get('/admin/session', (req, res) => {
  if (!req.session?.isAdmin) return res.json({ isAdmin: false });
  res.json({ isAdmin: true, name: req.session.adminName, permissions: req.session.adminPermissions });
});

router.get('/admin/settings', requireAdmin, requirePermission('settings'), wrap(async (req, res) => {
  res.json(await getSettings());
}));

router.put('/admin/settings', requireAdmin, requirePermission('settings'), wrap(async (req, res) => {
  await setSettings(req.body || {});
  res.json(await getSettings());
}));

// טקסט התראת "מחיר עשוי להיות שונה" בטופס הזמנה ידנית (טאב הזמנות) — לכל
// מנהל מחובר, לא רק למי שיש לו הרשאת 'settings' (זו רק תצוגה, לא עריכה).
router.get('/admin/late-registration-notice', requireAdmin, wrap(async (req, res) => {
  const s = await getSettings();
  res.json({ text: s.lateRegistrationPriceNotice, enabled: s.lateRegistrationPriceNoticeEnabled });
}));

// ---- ניהול מנהלים (טאב הגדרות) ----

router.get('/admin/admins', requireAdmin, requirePermission('settings'), wrap(async (req, res) => {
  res.json(await listAdmins());
}));

router.post('/admin/admins', requireAdmin, requirePermission('settings'), wrap(async (req, res) => {
  res.json(await createAdmin(req.body || {}));
}));

router.put('/admin/admins/:id', requireAdmin, requirePermission('settings'), wrap(async (req, res) => {
  res.json(await updateAdmin(Number(req.params.id), req.body || {}));
}));

router.delete('/admin/admins/:id', requireAdmin, requirePermission('settings'), wrap(async (req, res) => {
  res.json(await deleteAdmin(Number(req.params.id)));
}));

// ---- זמני חלוקה (טאב זמני חלוקה) ----

// גם הרשאת 'orders' יכולה לקרוא (לא לערוך) — נדרש למסך "הזמנות ותשלומים" (פילטר זמן חלוקה, הוספת הזמנה ידנית).
router.get('/admin/slots', requireAdmin, requireAnyPermission('slots', 'orders'), wrap(async (req, res) => {
  res.json(await getAllSlots());
}));

router.get('/admin/slots/suggest-day-label', requireAdmin, requirePermission('slots'), wrap(async (req, res) => {
  res.json({ dayLabel: suggestDayLabel(req.query.date) });
}));

router.post('/admin/slots', requireAdmin, requirePermission('slots'), wrap(async (req, res) => {
  res.json(await createSlot(req.body || {}));
}));

router.put('/admin/slots/:id', requireAdmin, requirePermission('slots'), wrap(async (req, res) => {
  res.json(await updateSlot(Number(req.params.id), req.body || {}));
}));

router.delete('/admin/slots/:id', requireAdmin, requirePermission('slots'), wrap(async (req, res) => {
  res.json(await deleteSlot(Number(req.params.id)));
}));

// ---- הזמנות ותשלומים ----

router.get('/admin/orders', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  res.json(await listAllOrders());
}));

router.get('/admin/customers', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  res.json(await listCustomersSummary());
}));

router.get('/admin/payments', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  res.json(await listAllPayments());
}));

router.post('/admin/customers/:phone/payments', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  const normalized = normalizePhone(req.params.phone);
  const result = await recordManualPaymentForCustomer(
    normalized, req.body?.amount, req.body?.method, req.session.adminName || 'admin', req.body?.note
  );
  res.json(result);
}));

// "בדקתי ידנית, אין כאן תשלום אמיתי" — משתיק את אזהרת "ייתכן שיש תשלום שלא אושר" עבור session ספציפי.
router.post('/admin/payment-sessions/:token/dismiss', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  res.json(await dismissStalePaymentSession(req.params.token, req.session.adminName || 'admin'));
}));

// כמו למעלה, אבל מסתיר בבת אחת את כל ניסיונות התשלום הישנים של אותו לקוח
// (ראו pendingUnconfirmedPayment המאוחד ב-listCustomersSummary).
router.post('/admin/customers/:phone/payment-sessions/dismiss', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  const normalized = normalizePhone(req.params.phone);
  res.json(await dismissAllStalePaymentSessions(normalized, req.session.adminName || 'admin'));
}));

router.get('/admin/orders/:id/payments', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  res.json(await listPaymentsForOrder(Number(req.params.id)));
}));

router.post('/admin/orders/:id/payments', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  const payment = await recordManualPayment(
    Number(req.params.id), req.body?.amount, req.body?.method, req.session.adminName || 'admin', req.body?.note
  );
  res.json(payment);
}));

// עריכה/מחיקה של תשלום שהוזן ידנית בלבד (תיקון טעות הקלדה) — תשלומי נדרים
// פלוס האמיתיים חסומים בשכבת ה-lib עצמה, ראו assertManualPayment.
router.put('/admin/payments/:id', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  res.json(await updateManualPayment(Number(req.params.id), req.body || {}, req.session.adminName || 'admin'));
}));

router.delete('/admin/payments/:id', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  res.json(await deleteManualPayment(Number(req.params.id), req.session.adminName || 'admin'));
}));

// הזמנה ידנית ע"י מנהל — אותה createOrder בדיוק (כולל בדיקת כפילות זמן+מגדר
// ואיחוד שם ללקוח קיים), רק שעוקפת את שער "הרישום פתוח" הפומבי ואת סגירת ההרשמה
// הפר-זמן (changedBy:'admin'), כדי שאפשר יהיה להוסיף הזמנה גם כשההרשמה סגורה.
router.post('/admin/orders', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  const order = await createOrder(req.body || {}, { changedBy: 'admin' });
  res.json(order);
}));

router.delete('/admin/orders/:id', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  res.json(await deleteOrder(Number(req.params.id), req.session.adminName || 'admin'));
}));

router.put('/admin/orders/:id/payment-coordinated', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  res.json(await setOrderPaymentCoordinated(Number(req.params.id), req.body?.coordinated, req.session.adminName || 'admin'));
}));

// כמו למעלה, אבל על כל ההזמנות הפתוחות של הלקוח יחד — ראו setCustomerPaymentCoordinated.
router.put('/admin/customers/:phone/payment-coordinated', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  const normalized = normalizePhone(req.params.phone);
  res.json(await setCustomerPaymentCoordinated(normalized, req.body?.coordinated, req.session.adminName || 'admin'));
}));

// שינוי מספר הטלפון של לקוח — מעביר את כל ההזמנות שלו למספר החדש.
router.put('/admin/customers/:phone/phone', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  const normalized = normalizePhone(req.params.phone);
  res.json(await updateCustomerPhone(normalized, req.body?.newPhone));
}));

router.put('/admin/orders/:orderId/items/:itemId', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  res.json(await updateOrderItemQuantity(
    Number(req.params.orderId), Number(req.params.itemId), req.body?.quantity, req.session.adminName || 'admin'
  ));
}));

router.delete('/admin/orders/:orderId/items/:itemId', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  res.json(await deleteOrderItem(Number(req.params.orderId), Number(req.params.itemId), req.session.adminName || 'admin'));
}));

router.put('/admin/order-items/:id/redeemed', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  res.json(await setItemRedeemedQuantity(Number(req.params.id), req.body?.quantityRedeemed, req.session.adminName || 'admin'));
}));

// "מצב איסוף" — כלי חיפוש+איסוף מהיר למנהל (לא לתשלומים), ראו admin.html.
// זהה לזרימת הלקוח/קיוסק (redeem/status + redeem/confirm-slot), אבל מאומת
// כמנהל (לא OTP), ומאפשר allowUnpaid (עם אזהרה בצד הלקוח) כי מנהל רשאי
// לעקוף את חסימת "לא שולם" בעוד שלקוח בעצמו לא.
router.get('/admin/redeem/status', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  const normalized = normalizePhone(req.query.phone);
  res.json(await getRedemptionStatus(normalized));
}));

// היסטוריית איסופים כרונולוגית מלאה של לקוח (תאריך+שעה, ומערכת מול ידני
// ע"י מנהל) — לתצוגה בכרטיס הלקוח, ראו getRedemptionHistoryForPhone.
router.get('/admin/customers/:phone/redemption-history', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  const normalized = normalizePhone(req.params.phone);
  res.json(await getRedemptionHistoryForPhone(normalized));
}));

// התכתבות SMS דו-כיוונית מול ימות המשיח עם הלקוח — לתצוגה בכרטיס הלקוח.
router.get('/admin/customers/:phone/sms-history', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  const normalized = normalizePhone(req.params.phone);
  res.json(await getSmsHistoryForPhone(normalized));
}));

// כל ה-SMS הנכנסים מכל הלקוחות — לטאב "הודעות נכנסות" הנפרד. ממזג סטטוס
// "טופל" (ראו incoming_sms_handled) לכל הודעה לפי מפתחה היציב (key).
router.get('/admin/sms/incoming', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  const [messages, handledKeys] = await Promise.all([getAllIncomingSms(), getHandledIncomingSmsKeys()]);
  res.json(messages.map((m) => ({ ...m, handled: handledKeys.has(m.key) })));
}));

// סימון/ביטול סימון הודעה נכנסת כ"טופל".
router.put('/admin/sms/incoming/:key/handled', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  res.json(await markIncomingSmsHandled(req.params.key, req.body?.phone, req.session.adminName || 'admin'));
}));
router.delete('/admin/sms/incoming/:key/handled', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  res.json(await unmarkIncomingSmsHandled(req.params.key));
}));

// תגובות "1"/"2" להודעת עדכון קבוצתית — לטבלת התגובות בטאב "הודעות נכנסות".
// ממזג תגובות SMS אמיתיות עם סימונים ידניים (broadcast_manual_responses) —
// לכל טלפון, מה שיותר עדכני מבין השניים הוא זה שמוצג (כך שסימון ידני אחרי
// שיחת טלפון יכול "לעקוף" תגובת SMS ישנה, ולהפך).
router.get('/admin/sms/responses', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  const [smsResponses, manualResponses] = await Promise.all([getBroadcastResponses(), getManualBroadcastResponses()]);
  const byPhone = new Map();
  for (const r of smsResponses) byPhone.set(r.normalizedPhone, { ...r, source: 'sms' });
  for (const r of manualResponses) {
    const existing = byPhone.get(r.normalizedPhone);
    if (!existing || new Date(r.time) >= new Date(existing.time)) {
      byPhone.set(r.normalizedPhone, {
        phone: r.phone, normalizedPhone: r.normalizedPhone, answer: r.answer,
        label: BROADCAST_ANSWER_LABEL[r.answer], time: r.time, source: 'manual', adminName: r.adminName,
      });
    }
  }
  res.json([...byPhone.values()].sort((a, b) => new Date(b.time) - new Date(a.time)));
}));

// סימון ידני של תגובת לקוח (מגיע/לא מגיע) שלא הגיב ב-SMS בעצמו.
router.put('/admin/customers/:phone/broadcast-response', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  res.json(await setManualBroadcastResponse(req.params.phone, req.body?.answer, req.session.adminName || 'admin'));
}));

// "סגירת תיק" ללקוח (אחרי זיכוי מלא/חלקי) — ופתיחתו מחדש אם צריך.
router.put('/admin/customers/:phone/case-closed', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  res.json(await setCustomerCaseClosed(req.params.phone, req.body?.note, req.session.adminName || 'admin'));
}));
router.delete('/admin/customers/:phone/case-closed', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  res.json(await reopenCustomerCase(req.params.phone, req.session.adminName || 'admin'));
}));

// שליחת הודעת SMS אישית ללקוח בודד — מריבוע הכתיבה בראש פאנל ההתכתבות.
router.post('/admin/customers/:phone/sms', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  const normalized = normalizePhone(req.params.phone);
  const message = String(req.body?.message || '').trim();
  if (!message) {
    return res.status(400).json({ error: 'חסר תוכן הודעה.' });
  }
  const sentBy = req.session.adminName || 'admin';
  try {
    await sendSms(normalized, message);
  } catch (err) {
    await logAction('sms_sent', { phone: normalized, message, sentBy, error: err.message });
    throw err;
  }
  await logAction('sms_sent', { phone: normalized, message, sentBy });
  res.json({ success: true });
}));

router.post('/admin/redeem/confirm-slot', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  const normalized = normalizePhone(req.body.phone);
  const result = await confirmSlotRedemption(
    normalized, Number(req.body.slotId),
    { maleQuantity: req.body.maleQuantity, femaleQuantity: req.body.femaleQuantity },
    req.session.adminName || 'admin',
    { allowUnpaid: !!req.body.allowUnpaid }
  );
  res.json(result);
}));

// שליחת אותה הודעת סמס לרשימת טלפונים (למשל כל מי שסונן בטבלה) בבת אחת.
router.post('/admin/sms/bulk', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  const phones = Array.isArray(req.body?.phones) ? req.body.phones : [];
  const message = String(req.body?.message || '').trim();
  if (!message) {
    return res.status(400).json({ error: 'חסר תוכן הודעה.' });
  }
  const normalized = [...new Set(phones.map((p) => normalizePhone(p)).filter(Boolean))];
  const sentBy = req.session.adminName || 'admin';

  let result;
  try {
    result = await sendBulkSms(normalized, message);
  } catch (err) {
    // גם כישלון מוחלט (לא רק נמענים בודדים) נרשם ביומן — אחרת ניסיון שנכשל
    // כולו (למשל שרת הסמס לא זמין) נעלם בלי עקבות.
    await logAction('sms_bulk_sent', {
      recipientCount: 0, failedCount: normalized.length, error: err.message, errorDetails: err.details || null,
      message, sentBy,
    });
    throw err;
  }

  await logAction('sms_bulk_sent', {
    recipientCount: result.recipientCount, failedCount: result.failedCount, failed: result.failed,
    message, sentBy,
  });
  res.json(result);
}));

// ---- דשבורד ----

router.get('/admin/dashboard', requireAdmin, requirePermission('dashboard'), wrap(async (req, res) => {
  res.json(await getDashboardStats());
}));

// תשלומים שנתקעו על הזמנות שנמחקו (ראו reassignOrphanedPayments) — מסך
// לבירור ולסימון ידני כטופל, כדי שיפסיקו להטריד את אזהרת הדיפלוי.
router.get('/admin/orphaned-payments', requireAdmin, requirePermission('dashboard'), wrap(async (req, res) => {
  res.json(await listStuckOrphanedPayments());
}));
router.put('/admin/orphaned-payments/:orderId/acknowledge', requireAdmin, requirePermission('dashboard'), wrap(async (req, res) => {
  res.json(await acknowledgeOrphanedPayments(Number(req.params.orderId), req.session.adminName || 'admin'));
}));

// ---- איפוס קשיח ----

router.post('/admin/hard-reset', requireAdmin, requirePermission('settings'), wrap(async (req, res) => {
  if (req.body?.confirmText !== 'איפוס') {
    return res.status(400).json({ error: 'יש להקליד בדיוק את המילה "איפוס" כדי לאשר.' });
  }
  res.json(await hardReset(req.session.adminName || 'admin'));
}));

// ---- בדיקת קריאות API לימות המשיח ----

router.post('/admin/ivr/test-call', requireAdmin, requirePermission('settings'), wrap(async (req, res) => {
  res.json({ results: await runYemotTestCalls(req.body?.code) });
}));

// ---- יומן פעולות ----

router.get('/admin/action-log', requireAdmin, requirePermission('settings'), wrap(async (req, res) => {
  res.json(await listActions({ limit: req.query.limit, offset: req.query.offset }));
}));

export default router;
