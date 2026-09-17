// עטיפה ל-API של ימות המשיח (call2all.co.il) לשליחת SMS — לפי קוד עובד בפועל
// שסופק (Google Apps Script, processBulkSms). מפתח API יחיד (apik_...) הוא
// כל מה שצריך ב-token — אין צורך גם במספר-מערכת+סיסמה בנוסף אליו.

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

  const messages = [
    ...incoming
      .filter((row) => normalizePhone(row.source) === normalizedPhone)
      .map((row) => ({ direction: 'incoming', phone: row.source, message: row.message, time: row.receive_date })),
    ...outgoing
      .filter((row) => normalizePhone(row.To) === normalizedPhone)
      .map((row) => ({ direction: 'outgoing', phone: row.To, message: row.Message, time: row.Time, deliveryStatus: row.DeliveryReport })),
  ].filter((m) => new Date(m.time).getTime() >= cutoff);

  messages.sort((a, b) => new Date(a.time) - new Date(b.time));
  return messages;
}
