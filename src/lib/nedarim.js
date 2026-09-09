// אינטגרציית נדרים פלוס — שיטה 3, מסלול ב' (עסקה שהוקמה בשרת), לפי התיעוד
// הרשמי. ראו docs/nedarim-plus-integration.md להסבר המלא ולמקורות.

import crypto from 'node:crypto';

const CREATE_TRANSACTION_URL = 'https://matara.pro/nedarimplus/V6/Files/WebServices/DebitIframe.aspx?Action=CreateTransaction';
const HMAC_TOLERANCE_SECONDS = 300; // 5 דקות — הגנה מפני שידור חוזר

/**
 * מקימה עסקה בצד שרת (הסכום ננעל, לא ניתן לשינוי מהדפדפן). מחזירה
 * { transactionId, key } שאותם שולחים לאייפרם ב-StartPayment.
 */
export async function createTransaction({ amount, param2, callbackUrl }) {
  const mosad = process.env.NEDARIM_MOSAD_ID;
  const apiValid = process.env.NEDARIM_API_VALID;
  if (!mosad || !apiValid) {
    const err = new Error('סליקת נדרים פלוס לא מוגדרת עדיין (חסר NEDARIM_MOSAD_ID / NEDARIM_API_VALID).');
    err.status = 500;
    throw err;
  }

  const form = new URLSearchParams({
    Mosad: mosad,
    ApiValid: apiValid,
    PaymentType: 'Ragil',
    Amount: String(amount),
    Currency: '1',
    Tashlumim: '1',
    Param2: param2, // המזהה שלנו לצורך הצלבה מול ה-Webhook — לא Param1 (חוסם ביט/העברה)
    CallBack: callbackUrl,
  });

  const res = await fetch(CREATE_TRANSACTION_URL, { method: 'POST', body: form });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok || data.Status !== 'OK') {
    const err = new Error(data.Message || 'פתיחת עסקת תשלום נכשלה.');
    err.status = 502;
    err.details = data;
    throw err;
  }

  return { transactionId: data.ID, key: data.Key };
}

/**
 * אימות חתימת HMAC-SHA256 של Webhook נכנס — בדיוק לפי הקוד הרשמי
 * (X-Nedarim-Timestamp + X-Nedarim-Signature: v1=..., מחושב על timestamp + "." + rawBody).
 * rawBody חייב להיות הבייטים הגולמיים של הבקשה (Buffer/string), לא JSON שפורסר ונבנה מחדש.
 */
export function verifyWebhookSignature({ timestampHeader, signatureHeader, rawBody, secret }) {
  if (!secret) return { valid: false, reason: 'no_secret_configured' };
  const ts = timestampHeader;
  const sig = String(signatureHeader || '').replace(/^v1=/, '');
  if (!ts || !sig) return { valid: false, reason: 'missing_headers' };
  if (Math.abs(Date.now() / 1000 - Number(ts)) > HMAC_TOLERANCE_SECONDS) {
    return { valid: false, reason: 'timestamp_out_of_window' };
  }
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const sigBuf = Buffer.from(sig);
  const valid = expectedBuf.length === sigBuf.length && crypto.timingSafeEqual(expectedBuf, sigBuf);
  return { valid, reason: valid ? null : 'signature_mismatch' };
}

export const NEDARIM_WEBHOOK_IPS = ['18.196.146.117', '18.194.219.73'];
