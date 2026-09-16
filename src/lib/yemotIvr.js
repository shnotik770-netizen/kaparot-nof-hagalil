// עטיפה לקריאות בדיקה חופשיות ל-API של ימות המשיח (כל web service), בלי
// לחשוף את הטוקן ללקוח. אותו YEMOT_SMS_API_KEY שמשמש לשליחת SMS משמש גם
// כאן — טוקן API יחיד לחשבון.

const YEMOT_API_BASE = 'https://www.call2all.co.il/ym/api';

async function callYemotApi(webService, params) {
  const apiKey = process.env.YEMOT_SMS_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error('שירות ימות המשיח לא מוגדר (חסר YEMOT_SMS_API_KEY).'), { status: 500 });
  }

  const url = new URL(`${YEMOT_API_BASE}/${webService}`);
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
  return { webService, sentParams: params, httpStatus, response };
}

/**
 * שורה = קריאה בפורמט "WebServiceName?param1=val1&param2=val2" (כמו כתובת
 * ה-API עצמה, בלי הבסיס ובלי token). token בשורה מתעלמים ממנו תמיד — הוא
 * מוזרק מהשרת בלבד, לעולם לא ממה שהמנהל מקליד בתיבה.
 */
function parseTestLine(line) {
  const trimmed = line.trim();
  const qIndex = trimmed.indexOf('?');
  const webService = (qIndex === -1 ? trimmed : trimmed.slice(0, qIndex)).replace(/^\/+/, '');
  const query = qIndex === -1 ? '' : trimmed.slice(qIndex + 1);
  const params = {};
  for (const [key, value] of new URLSearchParams(query)) {
    if (key.toLowerCase() === 'token') continue;
    params[key] = value;
  }
  return { webService, params };
}

/** מריץ קריאת בדיקה חופשית אחת לכל שורה לא-ריקה בטקסט שהמנהל הקליד. */
export async function runYemotTestCalls(rawText) {
  const lines = String(rawText || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) {
    const err = new Error('לא הוזן שום קוד לבדיקה.');
    err.status = 400;
    throw err;
  }
  const results = [];
  for (const line of lines) {
    const { webService, params } = parseTestLine(line);
    if (!webService) {
      results.push({
        webService: null, sentParams: {}, httpStatus: null,
        response: { responseStatus: 'ERROR', message: `לא זוהה שם שירות (WebServiceName) בשורה: "${line}"` },
      });
      continue;
    }
    results.push(await callYemotApi(webService, params));
  }
  return results;
}
