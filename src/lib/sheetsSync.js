// גיבוי תקופתי של נתוני הלקוחות לטבלת Google Sheets — רץ ברקע על טיימר,
// מנותק לגמרי מבקשות המשתמשים החיות (לא חלק מאף critical path). אם הסנכרון
// נכשל (רשת, מכסה, הרשאות) זה רק מדלג לניסיון הבא — אף פעם לא מפיל את השרת
// ואף פעם לא חוסם בקשה של לקוח/מנהל.

import { getSheetsAccessToken } from './googleAuth.js';
import { listCustomersSummary } from './adminOps.js';
import { getAllSlots } from './slots.js';

let started = false;

function colLetter(n) {
  let s = '';
  let x = n;
  while (x > 0) {
    const rem = (x - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

async function buildRows() {
  const [slots, customers] = await Promise.all([getAllSlots(), listCustomersSummary()]);

  const header = ['שם לקוח', 'טלפון'];
  for (const slot of slots) {
    header.push(`${slot.name} - הזמנה זכרים`, `${slot.name} - הזמנה נקבות`, `${slot.name} - מימוש זכרים`, `${slot.name} - מימוש נקבות`);
  }

  const rows = [header];
  for (const c of customers) {
    const bySlotId = new Map((c.bySlot || []).map((s) => [s.slotId, s]));
    const row = [c.customerName || '', c.phone || ''];
    for (const slot of slots) {
      const s = bySlotId.get(slot.id);
      row.push(s?.male || 0, s?.female || 0, s?.maleRedeemed || 0, s?.femaleRedeemed || 0);
    }
    rows.push(row);
  }
  return rows;
}

export async function syncNow() {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) return;

  const tabName = process.env.GOOGLE_SHEET_TAB_NAME || 'גיבוי';
  const rows = await buildRows();
  const lastCol = colLetter(Math.max(1, rows[0]?.length || 1));
  const range = `${tabName}!A1:${lastCol}${Math.max(1, rows.length)}`;

  const token = await getSheetsAccessToken();
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}`;

  const clearRes = await fetch(`${base}/values/${encodeURIComponent(`${tabName}!A:ZZ`)}:clear`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!clearRes.ok) {
    throw new Error(`ניקוי הגיליון נכשל: ${clearRes.status} ${await clearRes.text().catch(() => '')}`);
  }

  const writeRes = await fetch(`${base}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: rows }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!writeRes.ok) {
    throw new Error(`כתיבה לגיליון נכשלה: ${writeRes.status} ${await writeRes.text().catch(() => '')}`);
  }
}

export function startPeriodicSheetsSync() {
  if (started) return;
  if (!process.env.GOOGLE_SHEET_ID) {
    console.log('[sheetsSync] GOOGLE_SHEET_ID לא מוגדר — גיבוי לגוגל שיטס מושבת.');
    return;
  }
  started = true;

  const intervalMs = Number(process.env.SHEETS_SYNC_INTERVAL_MS) || 120_000;
  const run = () => {
    syncNow()
      .then(() => console.log('[sheetsSync] סנכרון גיבוי הושלם בהצלחה.'))
      .catch((err) => console.error('[sheetsSync] סנכרון גיבוי נכשל (לא קריטי, ינסה שוב):', err.message || err));
  };

  run();
  setInterval(run, intervalMs);
  console.log(`[sheetsSync] גיבוי תקופתי לגוגל שיטס הופעל, כל ${Math.round(intervalMs / 1000)} שניות.`);
}
