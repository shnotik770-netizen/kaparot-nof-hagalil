// עטיפה ל-API של ימות המשיח (call2all.co.il) לשליחת SMS — לפי קוד עובד בפועל
// שסופק (Google Apps Script, processBulkSms). מפתח API יחיד (apik_...) הוא
// כל מה שצריך ב-token — אין צורך גם במספר-מערכת+סיסמה בנוסף אליו.

const SEND_SMS_URL = 'https://www.call2all.co.il/ym/api/SendSms';

export async function sendSms(normalizedPhone, message) {
  const apiKey = process.env.YEMOT_SMS_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error('שירות ה-SMS לא מוגדר (חסר YEMOT_SMS_API_KEY).'), { status: 500 });
  }

  const res = await fetch(SEND_SMS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: apiKey, phones: normalizedPhone, message }),
  });
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

/** אותה הודעה למספר טלפונים בבת אחת (API של ימות המשיח תומך ברשימת טלפונים מופרדת בפסיקים ב-phones). */
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

  const res = await fetch(SEND_SMS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: apiKey, phones: normalizedPhones.join(','), message }),
  });
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

  return { ...data, recipientCount: normalizedPhones.length };
}
