import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import 'dotenv/config';
import { pool } from './pool.js';
import { reconcileRedemptionLog, reconcileOrphanedPayments, reconcileHistoricalOrphanRebalance } from '../lib/adminOps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('✅ סכימת הדאטהבייס עודכנה בהצלחה.');

  const { itemsFixed } = await reconcileRedemptionLog();
  if (itemsFixed > 0) {
    console.log(`✅ יומן איסופים נוקה: ${itemsFixed} שורות הזמנה תוקנו (איסופים שבוטלו והמשיכו להופיע ביומן).`);
  }

  const { fixedCount, unresolvedCount } = await reconcileOrphanedPayments();
  if (fixedCount > 0) {
    console.log(`✅ תשלומים שנתקעו על הזמנות מחוקות תוקנו: ${fixedCount} הזמנות מחוקות, התשלומים הועברו להזמנה פעילה.`);
  }
  if (unresolvedCount > 0) {
    console.log(`⚠️ ${unresolvedCount} הזמנות מחוקות עם תשלומים שלא ניתן היה להעביר (ללקוח אין אף הזמנה פעילה אחרת) — דורש בדיקה ידנית.`);
  }

  const { fixedCount: rebalancedCount } = await reconcileHistoricalOrphanRebalance();
  if (rebalancedCount > 0) {
    console.log(`✅ תשלומים יתומים היסטוריים אוזנו מחדש בין הזמנות פעילות (${rebalancedCount} מקרים), לפי אותו מפל הוגן.`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('❌ מיגרציה נכשלה:', err);
  process.exit(1);
});
