// נקודות קצה שנקראות ישירות ע"י ימות המשיח (מודול type=api של שלוחה 9/2 —
// "שמיעת מצב הזמנה קיימת"). לא דרך /api ולא מאומתות בסשן: הזיהוי כאן הוא
// ApiPhone (מספר הטלפון המתקשר, לפי Caller ID) בלבד — מודל אמון כמקובל
// בשלוחות IVR טלפוניות, ולא זהה לאימות ה-OTP שבאתר. תגובה חייבת להיות
// טקסט פשוט בלבד (ראו סקיל yemot-hamashiach-api) — לעולם לא JSON.

import { Router } from 'express';
import { normalizePhone } from '../lib/normalize.js';
import { listOrdersForPhone } from '../lib/orders.js';
import { getIvrRegistrationSlots } from '../lib/slots.js';
import { textSegment, idListMessage, readAction } from '../lib/ivrFormat.js';

const router = Router();

const GENDER_LABEL = { male: 'זכרים', female: 'נקבות' };
const STATUS_LABEL = { paid: 'שולם', partial: 'שולם חלקית', unpaid: 'לא שולם' };

function wrap(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('[ivr]', err);
      res.type('text/plain').send(idListMessage([textSegment('אירעה שגיאה זמנית, נסו שוב מאוחר יותר')]));
    });
  };
}

router.all('/order-status', wrap(async (req, res) => {
  const params = { ...req.query, ...req.body };
  res.type('text/plain');

  // התראת ניתוק שיחה — לא צריך תוכן משמעותי, רק לא ליפול.
  if (params.hangup === 'yes') return res.send('ok');

  const normalizedPhone = normalizePhone(params.ApiPhone);
  const orders = await listOrdersForPhone(normalizedPhone);

  if (!orders.length) {
    return res.send(idListMessage([
      textSegment('לא נמצאה הזמנה רשומה עבור מספר הטלפון ממנו התקשרתם'),
    ]));
  }

  const segments = [textSegment(`נמצאו ${orders.length} הזמנות עבורכם`)];
  for (const o of orders) {
    const itemsText = o.items
      .map((it) => `${it.quantity} ${GENDER_LABEL[it.gender] || it.gender} ל${it.slotName}`)
      .join(', ');
    const statusText = STATUS_LABEL[o.paymentStatus] || o.paymentStatus;
    segments.push(textSegment(
      `הזמנה מספר ${o.orderSequence}, ${itemsText}, סכום כולל ${Math.round(o.totalAmount)} שקלים, סטטוס תשלום ${statusText}`
    ));
  }
  res.send(idListMessage(segments));
}));

/**
 * שלוחת "רישום הזמנה חדשה" (9/1) — כרגע רק צעד ראשון: קורא בקול את זמני
 * החלוקה הפתוחים להרשמה כרגע *ושמוגדר להם קוד+טקסט הקראה*, ישירות מה-DB
 * (חי, לא רשימה קבועה), ותופס את הבחירה. בדיקת "זמן הרשמה פעיל" נגזרת
 * מאותה לוגיקה בדיוק כמו טופס ההרשמה באתר (getOpenSlotsForRegistration).
 * המשך התהליך (מגדר/כמות/תשלום) עוד לא בנוי — נקודת עצירה מכוונת לבדיקה.
 */
router.all('/registration-menu', wrap(async (req, res) => {
  const params = { ...req.query, ...req.body };
  res.type('text/plain');

  if (params.hangup === 'yes') return res.send('ok');

  const slots = await getIvrRegistrationSlots();

  // סבב שני: כבר הקישו קוד זמן חלוקה בסבב הקודם.
  if (params.SlotChoice) {
    const chosen = slots.find((s) => s.ivrCode === params.SlotChoice);
    if (!chosen) {
      return res.send(idListMessage([textSegment('הבחירה שהוקשה כבר לא זמינה, אנא התקשרו שוב')]));
    }
    return res.send(idListMessage([textSegment(`בחרתם ${chosen.ivrAnnouncement}, בקרוב נמשיך משם`)]));
  }

  if (!slots.length) {
    return res.send(idListMessage([textSegment('ההרשמה סגורה כרגע, אנא נסו שוב מאוחר יותר')]));
  }

  const promptSegments = [
    textSegment('ברוכים הבאים להרשמה'),
    ...slots.map((s) => textSegment(`להזמנת ${s.ivrAnnouncement} הקישו ${s.ivrCode}`)),
  ];
  const allowedKeys = slots.map((s) => s.ivrCode).join('');
  res.send(readAction(promptSegments, [
    'SlotChoice', '', 1, 1, 10, 'NO', '', '', '', allowedKeys, '', '', '', '', 'no',
  ]));
}));

export default router;
