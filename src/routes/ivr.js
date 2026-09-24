// נקודות קצה שנקראות ישירות ע"י ימות המשיח (מודול type=api): שלוחה 9/2
// "שמיעת מצב הזמנה קיימת", שלוחה 9/1 "רישום הזמנה חדשה" ושלוחה 9/3
// "בקשת זיכוי בעקבות אי קבלת עופות". לא דרך /api ולא מאומתות בסשן: הזיהוי
// כאן הוא ApiPhone (מספר הטלפון המתקשר, לפי Caller ID) בלבד — מודל אמון
// כמקובל בשלוחות IVR טלפוניות, ולא זהה לאימות ה-OTP שבאתר. תגובה חייבת
// להיות טקסט פשוט בלבד (ראו סקיל yemot-hamashiach-api) — לעולם לא JSON.

import { Router } from 'express';
import { normalizePhone } from '../lib/normalize.js';
import { listOrdersForPhone, createOrder } from '../lib/orders.js';
import { getIvrRegistrationSlots, priceForGender } from '../lib/slots.js';
import { recordIvrNedarimPayment, getCustomerCreditSummary } from '../lib/payments.js';
import { getPhoneCreditRequest, createPhoneCreditRequest } from '../lib/adminOps.js';
import { logAction } from '../lib/actionLog.js';
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
 * אבחון זמני בלבד (למחוק כשהתקלה עם ימות המשיח תיפתר): מחזיר תגובה
 * מינימלית — מספר קבוע בלבד, בלי שום טקסט חופשי (n- ולא t-) — כדי לבודד
 * אם התקלה ("שגיאה" מיידית לפני תוכן) קשורה ספציפית להקראת טקסט עברי
 * חופשי (t-), או שהיא רחבה יותר וקורית גם למקטע n- הכי בסיסי שיש.
 */
router.all('/diag-number', wrap(async (req, res) => {
  const params = { ...req.query, ...req.body };
  res.type('text/plain');
  if (params.hangup === 'yes') return res.send('ok');
  return res.send('id_list_message=n-5');
}));

/**
 * אבחון זמני נוסף (למחוק יחד עם diag-number): n- (מספר) עבד תקין — מבודד
 * שהתקלה ספציפית להקראת טקסט חופשי (t-) בלייב, לא לכל הצינור. הבדיקה הזו
 * בודקת מסלול ביניים: s- מקריא TTS מקובץ טקסט שמור מראש בחשבון (בשונה
 * מ-t- שמקריא טקסט חופשי שמגיע חי בתגובת ה-API) — אולי המסלול הזה לא נפגע
 * מהתקלה. תלוי בקובץ diagtts.tts שהועלה ידנית לתיקיית השלוחה (UploadTextFile).
 */
router.all('/diag-tts-file', wrap(async (req, res) => {
  const params = { ...req.query, ...req.body };
  res.type('text/plain');
  if (params.hangup === 'yes') return res.send('ok');
  return res.send('id_list_message=s-diagtts');
}));

/**
 * שלוחת "בקשת זיכוי" (9/3) — למי שהזמין ולא קיבל. ללא הגנת ivr_secret,
 * מאותה סיבה כמו 9/2: לא יוצרת שום חיוב/זיכוי אמיתי בעצמה, רק שורת בקשה
 * שממתינה לאישור ידני של מנהל (ראו markPhoneCreditRequestHandled) — הכי
 * גרוע שיכול לקרות עם שיחה מזויפת הוא בקשת סרק שהמנהל יזהה וימחק.
 *
 * שלושה מסלולים לפי מה שכבר קיים ללקוח הזה (getPhoneCreditRequest, שורה
 * אחת פר טלפון): בקשה ממתינה -> משמיע שהיא ממתינה. בקשה שטופלה -> משמיע
 * את הסכום שזוכה (או "לא אושר זיכוי" אם 0). אין בקשה בכלל -> מקריא את
 * התקרה (getCustomerCreditCeiling, אותה נוסחה בדיוק כמו זיכוי ידני מהפאנל)
 * ואוסף read= אחד עם הסכום שהלקוח מבקש בפועל, ואז יוצר בקשה.
 */
router.all('/credit-request', wrap(async (req, res) => {
  const params = { ...req.query, ...req.body };
  res.type('text/plain');

  if (params.hangup === 'yes') return res.send('ok');

  const normalizedPhone = normalizePhone(params.ApiPhone);
  const existing = await getPhoneCreditRequest(normalizedPhone);

  if (existing) {
    if (existing.status === 'pending') {
      return res.send(idListMessage([
        textSegment(`הבקשה שלכם לזיכוי בסך ${Math.round(existing.requestedAmount)} שקלים כבר התקבלה וממתינה לטיפול`),
      ]));
    }
    if (existing.creditedAmount > 0) {
      return res.send(idListMessage([
        textSegment(`הבקשה שלכם טופלה, זוכיתם בסך ${Math.round(existing.creditedAmount)} שקלים`),
      ]));
    }
    return res.send(idListMessage([textSegment('הבקשה שלכם טופלה, לא אושר זיכוי')]));
  }

  if (!params.RequestedAmount) {
    const summary = await getCustomerCreditSummary(normalizedPhone);
    if (!summary.hasOrders) {
      return res.send(idListMessage([
        textSegment('לא נמצאה הזמנה רשומה עבור מספר הטלפון ממנו התקשרתם'),
      ]));
    }
    if (summary.uncollectedCount <= 0) {
      // מימשו את מלוא ההזמנה — אין מה לבקש עליו זיכוי, לא משנה מה שולם.
      return res.send(idListMessage([
        textSegment(`ההזמנה שלכם הייתה בסך ${Math.round(summary.totalAmount)} שקלים, ולפי הרישומים שלנו מימשתם את מלוא ההזמנה, ולכן אינכם זכאים לזיכוי`),
      ]));
    }
    if (summary.ceiling <= 0) {
      // יש עופות שלא נאספו, אבל גם לא שולם עליהם — אין עודף תשלום לזכות.
      return res.send(idListMessage([
        textSegment(`ההזמנה שלכם הייתה בסך ${Math.round(summary.totalAmount)} שקלים, ולפי הרישומים שלנו לא קיבלתם ${summary.uncollectedCount} עופות מתוך ההזמנה, אך גם לא שולם עבורם, ולכן אין לכם יתרת זיכוי זמינה כרגע`),
      ]));
    }
    return res.send(readAction(
      [textSegment(`ההזמנה שלכם הייתה בסך ${Math.round(summary.totalAmount)} שקלים, ולפי הרישומים שלנו לא קיבלתם ${summary.uncollectedCount} עופות מתוך ההזמנה, שווי ההחזר המקסימלי העומד לזכותכם הוא ${Math.round(summary.ceiling)} שקלים, אנא הקישו את הסכום שאתם מבקשים לזכות ולסיום הקישו סולמית`)],
      ['RequestedAmount', '', 5, 1, 15, 'Number', '', 'yes', '', '', '', '', '', '', 'no'],
    ));
  }

  const summary = await getCustomerCreditSummary(normalizedPhone);
  await createPhoneCreditRequest({
    normalizedPhone, phone: params.ApiPhone, ceilingAmount: summary.ceiling,
    requestedAmount: Number(params.RequestedAmount), apiCallId: params.ApiCallId || null,
  });
  return res.send(idListMessage([textSegment('בקשתכם לזיכוי נקלטה בהצלחה, הבקשה תטופל בימים הקרובים')]));
}));

const GENDER_KEY_LABEL = { 1: 'זכרים', 2: 'נקבות' };
const GENDER_KEY_TO_FIELD = { 1: 'male', 2: 'female' };
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

  // הגנה: השלוחה הזו יוצרת הזמנות אמיתיות ומחייבת כרטיסי אשראי — חובה
  // לוודא שהבקשה אכן הגיעה מימות המשיח (עם api_add_0 בהגדרות השלוחה)
  // ולא ממישהו שמדביק/מנחש את הכתובת ישירות, בדיוק כפי שנבדק ידנית קודם
  // (אפשר היה ליצור הזמנה מזויפת עם CreditCard_CODE=OK בלי לשלם בפועל).
  // 9/2 (בירור מצב) נשאר בכוונה בלי הגנה כזו — קריאה בלבד, לא כסף.
  if (!process.env.IVR_REGISTRATION_SECRET || params.ivr_secret !== process.env.IVR_REGISTRATION_SECRET) {
    console.error('[ivr] registration-menu rejected: missing/invalid ivr_secret');
    return res.send(idListMessage([textSegment('ההרשמה נסגרה')]));
  }

  if (params.hangup === 'yes') return res.send('ok');

  const slots = await getIvrRegistrationSlots();
  if (!slots.length) {
    return res.send(idListMessage([textSegment('ההרשמה נסגרה')]));
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
      // אחרי שסיימנו לאסוף פריטים, עוד לפני שם/תשלום — מחשבים את הסכום
      // הכולל בכל סבב מחדש (לא נשמר בשום מקום, נגזר מהנתונים המצטברים).
      let total = 0;
      const summarySegments = [];
      for (let j = 1; j <= i; j++) {
        const s = slotsByCode.get(params[`SlotChoice${j}`]);
        const genderField = GENDER_KEY_TO_FIELD[params[`Gender${j}`]];
        const genderLabel = GENDER_KEY_LABEL[params[`Gender${j}`]] || params[`Gender${j}`];
        const qty = Number(params[`Quantity${j}`]) || 0;
        const lineTotal = s ? qty * priceForGender(s, genderField) : 0;
        total += lineTotal;
        summarySegments.push(textSegment(`${qty} ${genderLabel} ל${s?.ivrAnnouncement || ''}, מחיר ${lineTotal} שקלים`));
      }

      if (!params.CustomerName) {
        // read= לא ניתן לשרשור עם פעולה אחרת — לכן הסיכום עצמו הוא חלק
        // מה-prompt של אותו read=, לא הודעה נפרדת לפניו.
        return res.send(readAction(
          [
            textSegment('ההזמנה שלכם'),
            ...summarySegments,
            textSegment(`סך הכל לתשלום ${total} שקלים`),
            textSegment('לסיום ההזמנה ולתשלום חובה לשלם כעת, אנא אמרו בקול ברור את שמכם המלא'),
          ],
          ['CustomerName', '', 'voice', 'he-IL', 'no', '', 'record', 3, 8],
        ));
      }

      // סבב חזרה מנדרים פלוס אחרי ניסיון חיוב. אומת מול חיוב אמיתי (מוסד
      // בדיקות של נדרים פלוס): הצלחה מסומנת ב-CreditCard_CODE==="OK" בדיוק
      // (ראו סקיל yemot-hamashiach-api). כל דבר אחר = לא שולם, לא יוצרים
      // הזמנה בכלל — אין "הזמנה רפאים" ללא תשלום מאושר.
      // הערה: אין כאן הגנת אידמפוטנטיות מפני קריאה כפולה מימות המשיח על
      // אותו CreditCard_CODE — לא צפוי בהתנהגות התקנית של מודול ה-API.
      if (params.CreditCard_CODE) {
        console.log('[ivr] CreditCard follow-up received:', JSON.stringify(params));

        if (params.CreditCard_CODE !== 'OK') {
          return res.send(idListMessage([
            textSegment('החיוב לא הצליח, ההזמנה לא נשמרה'),
            textSegment('אנא נסו שוב או צרו קשר עם המשרד'),
          ]));
        }

        // מהנקודה הזו הלקוח כבר חויב בפועל אצל נדרים פלוס — אסור בשום
        // מצב שכשל כאן יוצג כ"שגיאה זמנית" סתמית בלי לתעד את זה בקול
        // רם, אחרת יש חיוב בלי הזמנה ובלי שאף אחד ידע לחפש אותו.
        try {
          const items = [];
          for (let j = 1; j <= i; j++) {
            const s = slotsByCode.get(params[`SlotChoice${j}`]);
            items.push({
              slotId: s.id,
              gender: GENDER_KEY_TO_FIELD[params[`Gender${j}`]],
              quantity: Number(params[`Quantity${j}`]),
            });
          }

          const order = await createOrder(
            { phone: params.ApiPhone, customerName: params.CustomerName, items },
            { changedBy: 'ivr_phone' }
          );
          await recordIvrNedarimPayment(order.id, order.totalAmount, `שלוחה טלפונית, שיחה ${params.ApiCallId || ''}`);

          return res.send(idListMessage([
            textSegment(`תודה ${params.CustomerName}`),
            textSegment('ההזמנה שלכם נקלטה ושולמה בהצלחה'),
          ]));
        } catch (err) {
          console.error('[ivr] CHARGED BUT ORDER CREATION FAILED — needs manual follow-up:', JSON.stringify(params), err);
          // חייב להופיע ביומן הפעולות שהמנהל רואה בפאנל — לא רק בלוג של
          // Railway שרק אני יכול לגשת אליו. זה כסף אמיתי שהתקבל בלי הזמנה.
          await logAction('ivr_payment_orphaned', {
            phone: params.ApiPhone, customerName: params.CustomerName,
            apiCallId: params.ApiCallId || null, error: err.message || String(err),
          }).catch((logErr) => console.error('[ivr] logAction itself also failed:', logErr));
          return res.send(idListMessage([
            textSegment('התשלום התקבל אך אירעה תקלה ברישום ההזמנה'),
            textSegment('אנא צרו קשר עם המשרד בהקדם עם מספר הטלפון שממנו התקשרתם'),
          ]));
        }
      }

      console.log(`[ivr] Triggering credit_card charge (${total} ILS) for phone ${params.ApiPhone}, name "${params.CustomerName}"`);
      return res.send(`${idListMessage([textSegment('מעבירים אתכם לתשלום')])}&credit_card=nedarim_plus,${total},,1,1`);
    }
    // moreItems === '1' — ממשיכים ללולאה הבאה (פריט i+1)
  }

  return res.send(idListMessage([textSegment('הגעתם למספר המרבי של פריטים בהזמנה אחת, אנא התקשרו שוב להזמנה נוספת')]));
}));

export default router;
