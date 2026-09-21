// עטיפה ל-API של ימות המשיח (call2all.co.il) לשליחת SMS — לפי קוד עובד בפועל
// שסופק (Google Apps Script, processBulkSms). מפתח API יחיד (apik_...) הוא
// כל מה שצריך ב-token — אין צורך גם במספר-מערכת+סיסמה בנוסף אליו.

import crypto from 'node:crypto';
import { normalizePhone } from './normalize.js';

const SEND_SMS_URL = 'https://www.call2all.co.il/ym/api/SendSms';
const GET_INCOMING_SMS_URL = 'https://www.call2all.co.il/ym/api/GetIncomingSms';
const GET_SMS_OUT_LOG_URL = 'https://www.call2all.co.il/ym/api/GetSmsOutLog';

export async function sendSms(normalizedPhone, message) {
  const apiKey = process.env.YEMOT_SMS_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error('שירות ה-SMS לא מוגדר (חסר YEMOT_SMS_API_KEY).'), { status: 500 });
  }

  // בלי timeout, שרת ימות שנתקע/מאט משאיר בקשות לקוחות (למשל בקשת קוד אימות)
  // תלויות ללא סוף — עם הרבה בקשות בו-זמנית זה נערם ומחמיר את המצב.
  let res;
  try {
    res = await fetch(SEND_SMS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: apiKey, phones: normalizedPhone, message }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw Object.assign(new Error('שליחת ה-SMS נכשלה (בעיית תקשורת עם שרת הסמס).'), { status: 502 });
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok || data?.responseStatus !== 'OK') {
    const err = new Error('שליחת ה-SMS נכשלה. בדקו את YEMOT_SMS_API_KEY.');
    err.status = 502;
    err.details = data;
    throw err;
  }

  return data;
}

/**
 * אותה הודעה למספר טלפונים בבקשה אחת. לפי תיעוד רשמי של ימות המשיח,
 * ההפרדה בין טלפונים ב-phones היא ':' (נקודתיים) — לא ',' כפי שהונח
 * בטעות בגרסה קודמת (מה שגרם ל-API להתייחס לכל הרשימה כטלפון בודד
 * לא-תקין ולהחזיר "all Phone not is valid"). תשובת הצלחה כוללת oks/errors
 * פר-טלפון — כלומר responseStatus יכול להיות 'OK' גם כשחלק מהנמענים נכשלו.
 */
export async function sendBulkSms(normalizedPhones, message) {
  const apiKey = process.env.YEMOT_SMS_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error('שירות ה-SMS לא מוגדר (חסר YEMOT_SMS_API_KEY).'), { status: 500 });
  }
  if (!normalizedPhones.length) {
    const err = new Error('אין נמענים לשליחה.');
    err.status = 400;
    throw err;
  }

  let res;
  try {
    res = await fetch(SEND_SMS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: apiKey, phones: normalizedPhones.join(':'), message }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw Object.assign(new Error('שליחת ה-SMS נכשלה (בעיית תקשורת עם שרת הסמס).'), { status: 502 });
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok || data?.responseStatus !== 'OK') {
    const err = new Error('שליחת ה-SMS נכשלה. בדקו את YEMOT_SMS_API_KEY.');
    err.status = 502;
    err.details = data;
    throw err;
  }

  const failedEntries = Object.entries(data.errors || {});
  return {
    recipientCount: data.sendCount ?? (Array.isArray(data.oks) ? data.oks.length : normalizedPhones.length),
    failedCount: failedEntries.length,
    failed: failedEntries.map(([phone, error]) => ({ phone, error })),
  };
}

/**
 * שולף סמסים נכנסים/יוצאים גולמיים מהחשבון כולו (לא פר-לקוח — ל-API של
 * ימות המשיח אין סינון לפי טלפון בצד השרת). הסינון ללקוח ספציפי קורה
 * ב-getSmsHistoryForPhone למטה. limit גבוה (1000, כמו בקוד ה-Apps Script
 * שסופק) כדי לא לפספס תכתובת ישנה יחסית עם לקוח שלא כתב הרבה.
 */
async function fetchSmsLog(url) {
  const apiKey = process.env.YEMOT_SMS_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error('שירות ה-SMS לא מוגדר (חסר YEMOT_SMS_API_KEY).'), { status: 500 });
  }
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: apiKey, limit: 1000 }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw Object.assign(new Error('שליפת היסטוריית הסמסים נכשלה (בעיית תקשורת עם שרת הסמס).'), { status: 502 });
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  if (!res.ok || data?.responseStatus !== 'OK') {
    const err = new Error('שליפת היסטוריית הסמסים נכשלה. בדקו את YEMOT_SMS_API_KEY.');
    err.status = 502;
    err.details = data;
    throw err;
  }
  return data.rows || [];
}

const SMS_HISTORY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * שרשור התכתבות SMS דו-כיווני מלא (נכנס+יוצא) עם טלפון אחד — לתצוגה
 * בכרטיס הלקוח. משווה מספרים אחרי נירמול (normalizePhone), כי ימות
 * המשיח לא בהכרח מחזיר את אותו פורמט (972.../05.../5...) שבו שמור הלקוח
 * אצלנו. מוגבל לשבועיים האחרונים בלבד — לא רלוונטי להציג תכתובת ישנה
 * משנים קודמות (למשל תזכורת OTP מהזמנה קודמת).
 */
export async function getSmsHistoryForPhone(normalizedPhone) {
  const [incoming, outgoing] = await Promise.all([
    fetchSmsLog(GET_INCOMING_SMS_URL),
    fetchSmsLog(GET_SMS_OUT_LOG_URL),
  ]);

  const cutoff = Date.now() - SMS_HISTORY_WINDOW_MS;

  // שליחה קבוצתית (sendBulkSms) שולחת את כל הנמענים במחרוזת אחת מופרדת
  // ב-':' (phones: normalizedPhones.join(':')), וכך זה גם חוזר בשדה To של
  // GetSmsOutLog — לא כטלפון בודד. נירמול המחרוזת השלמה לא יתאים לאף לקוח
  // בודד, אז צריך לפצל קודם ולבדוק אם הטלפון המבוקש הוא אחד מהנמענים.
  const outgoingMatchesPhone = (to) => String(to || '').split(':').some((p) => normalizePhone(p) === normalizedPhone);

  const messages = [
    ...incoming
      .filter((row) => normalizePhone(row.source) === normalizedPhone)
      .map((row) => ({ direction: 'incoming', phone: row.source, message: row.message, time: row.receive_date })),
    ...outgoing
      .filter((row) => outgoingMatchesPhone(row.To))
      .map((row) => ({ direction: 'outgoing', phone: row.To, message: row.Message, time: row.Time, deliveryStatus: row.DeliveryReport })),
  ].filter((m) => new Date(m.time).getTime() >= cutoff);

  // החדש ביותר ראשון (מוצג למעלה בפאנל), הישן ביותר אחרון (למטה).
  messages.sort((a, b) => new Date(b.time) - new Date(a.time));
  return messages;
}

// ל-API של ימות המשיח אין מזהה יציב פר-הודעה נכנסת (רק source/message/
// receive_date) — כדי לאפשר "סימון כטופל" בכל זאת, בונים מפתח יציב מ-hash
// של טלפון+זמן+תוכן. אותה הודעה תמיד תניב אותו מפתח, גם בין בקשות שונות.
export function incomingSmsMessageKey({ normalizedPhone, time, message }) {
  return crypto.createHash('sha1').update(`${normalizedPhone}|${time}|${message}`).digest('hex');
}

/**
 * כל ה-SMS הנכנסים מכל הלקוחות יחד (לא פר-לקוח) — לטאב "הודעות נכנסות"
 * הנפרד בפאנל הניהול, כדי שלא יהיה צריך לפתוח כל כרטיס לקוח בנפרד כדי
 * לגלות שהגיעה הודעה חדשה. אותו מקור נתונים בדיוק כמו getSmsHistoryForPhone,
 * רק בלי הסינון לטלפון ספציפי ובלי חלון הזמן של שבועיים.
 */
export async function getAllIncomingSms() {
  const incoming = await fetchSmsLog(GET_INCOMING_SMS_URL);
  return incoming
    .map((row) => {
      const phone = row.source;
      const normalizedPhone = normalizePhone(phone);
      const message = row.message;
      const time = row.receive_date;
      return { phone, normalizedPhone, message, time, key: incomingSmsMessageKey({ normalizedPhone, time, message }) };
    })
    .sort((a, b) => new Date(b.time) - new Date(a.time));
}

export const BROADCAST_ANSWER_LABEL = { 1: 'מגיע', 2: 'לא מגיע — מבקש זיכוי' };

/**
 * תגובות ("1"/"2") להודעת עדכון קבוצתית ("אם מגיעים השיבו 1, אם לא — 2") —
 * לטבלת "תגובות" בפאנל הניהול. לוקח רק הודעות נכנסות שהתוכן שלהן (אחרי
 * חיתוך רווחים) הוא בדיוק "1" או "2" — מתעלם מכל שאר ההתכתבות. לקוח
 * שהשיב פעמיים (למשל טעה ותיקן) — נלקחת התגובה המאוחרת ביותר שלו בלבד.
 */
export async function getBroadcastResponses() {
  const incoming = await fetchSmsLog(GET_INCOMING_SMS_URL);
  const latestByPhone = new Map();
  for (const row of incoming) {
    const text = String(row.message || '').trim();
    if (text !== '1' && text !== '2') continue;
    const normalizedPhone = normalizePhone(row.source);
    const existing = latestByPhone.get(normalizedPhone);
    if (existing && new Date(existing.time) >= new Date(row.receive_date)) continue;
    latestByPhone.set(normalizedPhone, {
      phone: row.source,
      normalizedPhone,
      answer: Number(text),
      label: BROADCAST_ANSWER_LABEL[Number(text)],
      time: row.receive_date,
    });
  }
  return [...latestByPhone.values()].sort((a, b) => new Date(b.time) - new Date(a.time));
}
