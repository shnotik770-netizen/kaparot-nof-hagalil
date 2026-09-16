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

const GENDER_KEY_LABEL = { 1: 'זכרים', 2: 'נקבות' };
const MAX_ORDER_ITEMS = 6; // הגנה מפני לולאה אינסופית — לא צפוי שמישהו יזמין יותר מ-6 שורות בשיחה אחת

function slotMenuAction(paramName, slots, introText) {
  const promptSegments = [
    textSegment(introText),
    ...slots.map((s) => textSegment(`להזמנת ${s.ivrAnnouncement} הקישו ${s.ivrCode}`)),
  ];
  const allowedKeys = slots.map((s) => s.ivrCode).join('');
  return readAction(promptSegments, [paramName, '', 1, 1, 10, 'NO', '', '', '', allowedKeys, '', '', '', '', 'no']);
}

/**
 * שלוחת "רישום הזמנה חדשה" (9/1) — תפריט זמני חלוקה חי מה-DB (רק זמנים
 * שפתוחים להרשמה כרגע *ושמוגדר להם קוד+טקסט הקראה*, בדיוק כמו טופס
 * ההרשמה באתר: getOpenSlotsForRegistration). לכל שורת הזמנה: זמן חלוקה
 * -> מגדר -> כמות -> "עוד פריט?" בלולאה, עם שמות פרמטרים ממוספרים
 * (SlotChoice1, Gender1, Quantity1, SlotChoice2, ...) כדי שלא יתנגשו בין
 * איטרציות — ימות המשיח שולח כל פעם את כל מה שנאסף עד עכשיו יחד, אז שם
 * פרמטר חוזר על עצמו היה גורם לאובדן הנתון הקודם.
 * המשך התהליך (שם + תשלום) עוד לא בנוי — נקודת עצירה מכוונת לבדיקה.
 */
router.all('/registration-menu', wrap(async (req, res) => {
  const params = { ...req.query, ...req.body };
  res.type('text/plain');

  if (params.hangup === 'yes') return res.send('ok');

  const slots = await getIvrRegistrationSlots();
  if (!slots.length) {
    return res.send(idListMessage([textSegment('ההרשמה סגורה כרגע, אנא נסו שוב מאוחר יותר')]));
  }
  const slotsByCode = new Map(slots.map((s) => [s.ivrCode, s]));

  for (let i = 1; i <= MAX_ORDER_ITEMS; i++) {
    const slotChoice = params[`SlotChoice${i}`];
    if (!slotChoice) {
      const intro = i === 1 ? 'ברוכים הבאים להרשמה' : 'לאיזה זמן חלוקה עבור הפריט הבא';
      return res.send(slotMenuAction(`SlotChoice${i}`, slots, intro));
    }

    const chosenSlot = slotsByCode.get(slotChoice);
    if (!chosenSlot) {
      return res.send(idListMessage([textSegment('הבחירה שהוקשה כבר לא זמינה, אנא התקשרו שוב')]));
    }

    const gender = params[`Gender${i}`];
    if (!gender) {
      return res.send(readAction(
        [textSegment(`עבור ${chosenSlot.ivrAnnouncement}, להזמנת זכרים הקישו 1, להזמנת נקבות הקישו 2`)],
        [`Gender${i}`, '', 1, 1, 10, 'NO', '', '', '', '12', '', '', '', '', 'no'],
      ));
    }

    const quantity = params[`Quantity${i}`];
    if (!quantity) {
      return res.send(readAction(
        [textSegment('כמה עופות תרצו להזמין, לסיום הקישו סולמית')],
        [`Quantity${i}`, '', 2, 1, 10, 'Number', '', 'yes', '', '', '', '', '', '', 'no'],
      ));
    }

    const moreItems = params[`MoreItems${i}`];
    if (!moreItems) {
      return res.send(readAction(
        [textSegment('להוספת פריט נוסף להזמנה הקישו 1, לסיום ההזמנה הקישו 2')],
        [`MoreItems${i}`, '', 1, 1, 10, 'NO', '', '', '', '12', '', '', '', '', 'no'],
      ));
    }

    if (moreItems === '2') {
      const summarySegments = [];
      for (let j = 1; j <= i; j++) {
        const s = slotsByCode.get(params[`SlotChoice${j}`]);
        const genderLabel = GENDER_KEY_LABEL[params[`Gender${j}`]] || params[`Gender${j}`];
        summarySegments.push(textSegment(`${params[`Quantity${j}`]} ${genderLabel} ל${s?.ivrAnnouncement || ''}`));
      }
      return res.send(idListMessage([
        textSegment('ההזמנה שלכם'),
        ...summarySegments,
        textSegment('בקרוב נמשיך לרישום השם והתשלום'),
      ]));
    }
    // moreItems === '1' — ממשיכים ללולאה הבאה (פריט i+1)
  }

  return res.send(idListMessage([textSegment('הגעתם למספר המרבי של פריטים בהזמנה אחת, אנא התקשרו שוב להזמנה נוספת')]));
}));

export default router;
