// Webhook נכנס מנדרים פלוס — מקור האמת היחיד לאישור תשלום (ראו
// docs/nedarim-plus-integration.md). מותקן ב-server.js *לפני* express.json()
// הגלובלי, עם express.raw() ייעודי, כי אימות ה-HMAC חייב את הבייטים הגולמיים
// של הבקשה בדיוק כפי שהתקבלו.

import { Router } from 'express';
import { pool } from '../db/pool.js';
import { verifyWebhookSignature } from '../lib/nedarim.js';
import { allocateNedarimPayment } from '../lib/payments.js';

const router = Router();

router.post('/nedarim-plus', async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  let payload = null;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // ייתכן עדכון סירוב/פורמט אחר — נרשם גולמי ונענה 200 בכל מקרה (אין קשר בין קוד התשובה לניסיון חוזר)
  }

  const secret = process.env.NEDARIM_WEBHOOK_SECRET;
  const verification = verifyWebhookSignature({
    timestampHeader: req.headers['x-nedarim-timestamp'],
    signatureHeader: req.headers['x-nedarim-signature'],
    rawBody,
    secret,
  });

  // עד שמפתח החתימה יוגדר בפאנל נדרים פלוס (הגדרות > API > Webhook), אין לנו
  // עדיין דרך לאמת קריפטוגרפית — מעבדים בכל זאת (מוגן חלקית ע"י Param2 שחייב
  // להתאים ל-session פתוח + סכום), אבל עם רישום אזהרה בולט. ברגע שהסוד יוגדר
  // (NEDARIM_WEBHOOK_SECRET), חתימה לא תקינה תיחסם לגמרי.
  const softMode = !secret;
  if (!softMode && !verification.valid) {
    await pool.query(
      `INSERT INTO webhook_events(provider, transaction_id, raw_payload, processed_ok)
       VALUES ('nedarim_plus', $1, $2, false)`,
      [payload?.TransactionId || null, JSON.stringify({ payload, rejectedReason: verification.reason })]
    );
    return res.status(401).json({ error: 'signature_invalid' });
  }
  if (softMode) {
    console.warn('[nedarim webhook] מעבד ללא אימות חתימה — NEDARIM_WEBHOOK_SECRET לא מוגדר עדיין.');
  }

  const token = payload?.Param2;
  const amount = Number(payload?.Amount);
  const transactionId = payload?.TransactionId ? String(payload.TransactionId) : null;

  if (!payload || !token || !Number.isFinite(amount) || amount <= 0) {
    await pool.query(
      `INSERT INTO webhook_events(provider, transaction_id, raw_payload, processed_ok)
       VALUES ('nedarim_plus', $1, $2, false)`,
      [transactionId, JSON.stringify({ payload })]
    );
    return res.status(200).json({ ok: true, processed: false });
  }

  let result;
  try {
    result = await allocateNedarimPayment({ token, transactionId, paidAmount: amount });
  } catch (err) {
    await pool.query(
      `INSERT INTO webhook_events(provider, transaction_id, raw_payload, processed_ok)
       VALUES ('nedarim_plus', $1, $2, false)`,
      [transactionId, JSON.stringify({ payload, error: err.message })]
    );
    return res.status(500).json({ error: 'processing_failed' });
  }

  await pool.query(
    `INSERT INTO webhook_events(provider, order_id, transaction_id, raw_payload, processed_ok)
     VALUES ('nedarim_plus', $1, $2, $3, $4)`,
    [
      result.allocations?.[0]?.orderId || null,
      transactionId,
      JSON.stringify({ payload, allocations: result.allocations, reason: result.reason }),
      !!result.allocated,
    ]
  );

  res.status(200).json({ ok: true });
});

export default router;
