import { Router } from 'express';
import { normalizePhone, isValidIsraeliPhone } from '../lib/normalize.js';
import { getPublicSettings, getSettings, setSettings } from '../lib/settings.js';
import { requestOtp, verifyOtp } from '../lib/otp.js';
import {
  loginWithPassword, requestAdminOtp, verifyAdminOtp, requireAdmin, requirePermission, requireAnyPermission,
} from '../lib/auth.js';
import { listAdmins, createAdmin, updateAdmin, deleteAdmin } from '../lib/admins.js';
import { getOpenSlotsForRegistration, getAllSlots, createSlot, updateSlot, suggestDayLabel } from '../lib/slots.js';
import {
  countOrdersForPhone, createOrder, listOrdersForPhone, getCustomerName, updateCustomerName,
} from '../lib/orders.js';
import { getRedemptionStatus, confirmSlotRedemption } from '../lib/redemption.js';
import {
  recordManualPayment, recordManualPaymentForCustomer, listPaymentsForOrder, listAllPayments,
  createPaymentSession, confirmClientReportedPayment, dismissStalePaymentSession,
} from '../lib/payments.js';
import {
  listAllOrders, listCustomersSummary, getDashboardStats, hardReset,
  updateOrderItemQuantity, deleteOrderItem, deleteOrder, setItemRedeemedQuantity,
} from '../lib/adminOps.js';
import { createTransaction } from '../lib/nedarim.js';
import { listActions, logAction } from '../lib/actionLog.js';
import { sendBulkSms } from '../lib/sms.js';

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

// מימוש משולב (זכרים+נקבות יחד) לזמן חלוקה שלם — ראו confirmSlotRedemption ב-redemption.js.
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
  res.json({ balanceDue, ordersWithBalance: orders.filter((o) => o.balanceDue > 0).map((o) => o.orderNumber) });
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
  const session = await createPaymentSession(normalized, amount);
  // לא שולחים Zeout/Mail משלנו — לא אוספים אותם בדף שלנו בכוונה: לפי התיעוד
  // הרשמי, אם המוסד מוגדר לחייב ת"ז ולא נשלחה, שדה הטופס בתוך האייפרם עצמו
  // מבקש אותה (ראו docs/nedarim-plus-integration.md), כך שההצגה נשארת חלק
  // אחד רציף בתוך חלון התשלום ולא שלב נפרד בדף שלנו.
  const { transactionId, key } = await createTransaction({
    amount,
    param2: session.token,
    callbackUrl: `${publicBaseUrl()}/webhooks/nedarim-plus`,
    firstName,
    lastName,
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

router.get('/admin/orders/:id/payments', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  res.json(await listPaymentsForOrder(Number(req.params.id)));
}));

router.post('/admin/orders/:id/payments', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  const payment = await recordManualPayment(
    Number(req.params.id), req.body?.amount, req.body?.method, req.session.adminName || 'admin', req.body?.note
  );
  res.json(payment);
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

// שליחת אותה הודעת סמס לרשימת טלפונים (למשל כל מי שסונן בטבלה) בבת אחת.
router.post('/admin/sms/bulk', requireAdmin, requirePermission('orders'), wrap(async (req, res) => {
  const phones = Array.isArray(req.body?.phones) ? req.body.phones : [];
  const message = String(req.body?.message || '').trim();
  if (!message) {
    return res.status(400).json({ error: 'חסר תוכן הודעה.' });
  }
  const normalized = [...new Set(phones.map((p) => normalizePhone(p)).filter(Boolean))];
  const result = await sendBulkSms(normalized, message);
  await logAction('sms_bulk_sent', { recipientCount: normalized.length, message, sentBy: req.session.adminName || 'admin' });
  res.json(result);
}));

// ---- דשבורד ----

router.get('/admin/dashboard', requireAdmin, requirePermission('dashboard'), wrap(async (req, res) => {
  res.json(await getDashboardStats());
}));

// ---- איפוס קשיח ----

router.post('/admin/hard-reset', requireAdmin, requirePermission('settings'), wrap(async (req, res) => {
  if (req.body?.confirmText !== 'איפוס') {
    return res.status(400).json({ error: 'יש להקליד בדיוק את המילה "איפוס" כדי לאשר.' });
  }
  res.json(await hardReset(req.session.adminName || 'admin'));
}));

// ---- יומן פעולות ----

router.get('/admin/action-log', requireAdmin, requirePermission('settings'), wrap(async (req, res) => {
  res.json(await listActions({ limit: req.query.limit }));
}));

export default router;
