import { Router } from 'express';
import { normalizePhone, isValidIsraeliPhone } from '../lib/normalize.js';
import { getPublicSettings, getSettings, setSettings } from '../lib/settings.js';
import { requestOtp, verifyOtp } from '../lib/otp.js';
import {
  verifyAdminPassword, changeAdminPassword, setAdminPhone,
  requestAdminOtp, verifyAdminOtp, requireAdmin,
} from '../lib/auth.js';
import { getActivePriceRules, getAllPriceRules, upsertPriceRules } from '../lib/priceRules.js';
import { countOrdersForPhone, createOrder, listOrdersForPhone } from '../lib/orders.js';
import { getRedemptionStatus, confirmRedemption } from '../lib/redemption.js';
import { recordManualPayment, listPaymentsForOrder } from '../lib/payments.js';
import { listAllOrders, getDashboardStats, hardReset } from '../lib/adminOps.js';

const router = Router();

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
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

router.get('/price-rules', wrap(async (req, res) => {
  res.json(await getActivePriceRules());
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

router.get('/redeem/status', requireVerifiedPhone, wrap(async (req, res) => {
  const normalized = normalizePhone(req.query.phone);
  const settings = await getPublicSettings();
  res.json({ ...(await getRedemptionStatus(normalized)), distributionOpen: settings.distributionOpen });
}));

router.post('/redeem/confirm', requireVerifiedPhone, wrap(async (req, res) => {
  const normalized = normalizePhone(req.body.phone);
  const result = await confirmRedemption(normalized, req.body.orderItemId, req.body.quantity, normalized);
  res.json(result);
}));

// מחשב יתרת חוב לתשלום — פתיחת חלונית נדרים פלוס בפועל תתווסף בשלב הבא.
router.get('/payment-balance', requireVerifiedPhone, wrap(async (req, res) => {
  const normalized = normalizePhone(req.query.phone);
  const orders = await listOrdersForPhone(normalized);
  const balanceDue = orders.reduce((sum, o) => sum + o.balanceDue, 0);
  res.json({ balanceDue, ordersWithBalance: orders.filter((o) => o.balanceDue > 0).map((o) => o.orderNumber) });
}));

// מנקה את אימות הטלפון מה-session — קריטי בעמדת הקיוסק המשותפת, כדי שלקוח
// אחד לא "יישאר מחובר" במכשיר עבור הלקוח הבא בתור.
router.post('/session/end', (req, res) => {
  req.session.verifiedPhone = null;
  res.json({ success: true });
});

// ============== מנהל ==============

router.post('/admin/login-password', wrap(async (req, res) => {
  await verifyAdminPassword(req.body?.password);
  req.session.isAdmin = true;
  res.json({ success: true });
}));

router.post('/admin/otp/request', wrap(async (req, res) => {
  res.json(await requestAdminOtp(req.body?.phone));
}));

router.post('/admin/otp/verify', wrap(async (req, res) => {
  await verifyAdminOtp(req.body?.phone, req.body?.code);
  req.session.isAdmin = true;
  res.json({ success: true });
}));

router.post('/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.json({ success: true });
});

router.get('/admin/session', (req, res) => {
  res.json({ isAdmin: !!req.session?.isAdmin });
});

router.get('/admin/settings', requireAdmin, wrap(async (req, res) => {
  res.json(await getSettings());
}));

router.put('/admin/settings', requireAdmin, wrap(async (req, res) => {
  await setSettings(req.body || {});
  res.json(await getSettings());
}));

router.post('/admin/change-password', requireAdmin, wrap(async (req, res) => {
  res.json(await changeAdminPassword(req.body?.currentPassword, req.body?.newPassword));
}));

router.put('/admin/admin-phone', requireAdmin, wrap(async (req, res) => {
  res.json(await setAdminPhone(req.body?.phone));
}));

router.get('/admin/price-rules', requireAdmin, wrap(async (req, res) => {
  res.json(await getAllPriceRules());
}));

router.put('/admin/price-rules', requireAdmin, wrap(async (req, res) => {
  res.json(await upsertPriceRules(req.body?.rules || []));
}));

router.get('/admin/orders', requireAdmin, wrap(async (req, res) => {
  res.json(await listAllOrders());
}));

router.get('/admin/orders/:id/payments', requireAdmin, wrap(async (req, res) => {
  res.json(await listPaymentsForOrder(Number(req.params.id)));
}));

router.post('/admin/orders/:id/payments', requireAdmin, wrap(async (req, res) => {
  const payment = await recordManualPayment(
    Number(req.params.id), req.body?.amount, req.body?.method, 'admin', req.body?.note
  );
  res.json(payment);
}));

router.get('/admin/dashboard', requireAdmin, wrap(async (req, res) => {
  res.json(await getDashboardStats());
}));

router.post('/admin/hard-reset', requireAdmin, wrap(async (req, res) => {
  if (req.body?.confirmText !== 'איפוס') {
    return res.status(400).json({ error: 'יש להקליד בדיוק את המילה "איפוס" כדי לאשר.' });
  }
  res.json(await hardReset());
}));

export default router;
