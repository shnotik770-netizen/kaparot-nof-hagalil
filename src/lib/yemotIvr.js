// עטיפה לקריאות UpdateExtension של ימות המשיח — בונה שלוחות IVR דרך ה-API
// במקום ידנית בממשק שלהם. אותו YEMOT_SMS_API_KEY שמשמש לשליחת SMS משמש
// גם כאן — טוקן API יחיד לחשבון.

const YEMOT_API_BASE = 'https://www.call2all.co.il/ym/api';

async function callUpdateExtension(params) {
  const apiKey = process.env.YEMOT_SMS_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error('שירות ימות המשיח לא מוגדר (חסר YEMOT_SMS_API_KEY).'), { status: 500 });
  }

  const url = new URL(`${YEMOT_API_BASE}/UpdateExtension`);
  url.searchParams.set('token', apiKey);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  let httpStatus = null;
  let response;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    httpStatus = res.status;
    const text = await res.text();
    try {
      response = JSON.parse(text);
    } catch {
      response = { raw: text };
    }
  } catch (err) {
    response = { responseStatus: 'ERROR', message: `בעיית תקשורת: ${err.message}` };
  }

  // sentParams בכוונה בלי token בכלל (לא רק מוסתר) — זה מה שמוצג למנהל במסך.
  return { path: params.path, sentParams: params, httpStatus, response };
}

/**
 * בונה את מבנה השלוחות לכפרות: 9 (תפריט) -> 9/1 (רישום הזמנה) / 9/2 (בירור
 * הזמנה קיימת). מריץ את שלוש הקריאות ברצף ומחזיר את תוצאת כל אחת בנפרד,
 * גם אם חלקן נכשלות — כך שהמנהל רואה בדיוק מה נשלח ומה ימות המשיח החזיר
 * לכל שלב, ולא רק הצלחה/כישלון מצטבר.
 */
export async function setupKapparotIvrExtensions() {
  const steps = [
    { path: 'ivr2:9', type: 'menu', title: 'כפרות - הזמנה ובירור' },
    { path: 'ivr2:9/1', title: 'רישום הזמנה חדשה' },
    { path: 'ivr2:9/2', title: 'שמיעת מצב הזמנה קיימת' },
  ];
  const results = [];
  for (const step of steps) {
    results.push(await callUpdateExtension(step));
  }
  return results;
}
