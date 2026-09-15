// גיבוי תקופתי של נתוני הלקוחות + יומן הפעולות לטבלת Google Sheets — רץ ברקע
// על טיימר, מנותק לגמרי מבקשות המשתמשים החיות (לא חלק מאף critical path). אם
// הסנכרון נכשל (רשת, מכסה, הרשאות) זה רק מדלג לניסיון הבא — אף פעם לא מפיל
// את השרת ואף פעם לא חוסם בקשה של לקוח/מנהל.

import { getSheetsAccessToken } from './googleAuth.js';
import { listCustomersSummary } from './adminOps.js';
import { getAllSlots } from './slots.js';
import { listAllActions } from './actionLog.js';
import { getSettings } from './settings.js';

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

// תואם את ACTION_LABELS ב-admin.html — עותק עצמאי בכוונה, זו קבועה קטנה
// שנצרכת משני צדדים עצמאיים (דפדפן מול גיליון), בלי מודול משותף ביניהם.
const ACTION_LABELS = {
  order_created: 'הזמנה נוצרה',
  payment_recorded_manual: 'תשלום ידני נרשם',
  payment_edited: 'תשלום ידני נערך',
  payment_deleted: 'תשלום ידני נמחק',
  payment_received_nedarim: 'תשלום התקבל (נדרים פלוס, Webhook)',
  payment_client_confirmed: 'תשלום אושר לפי הדפדפן (טרם אומת Webhook)',
  redemption_confirmed: 'מימוש עופות',
  redemption_manual_override: 'מימוש עודכן ידנית ע"י מנהל',
  order_item_edited: 'שורת הזמנה עודכנה',
  order_item_deleted: 'שורת הזמנה נמחקה',
  order_deleted: 'הזמנה נמחקה',
  sms_bulk_sent: 'סמס קבוצתי נשלח',
  payment_alert_dismissed: 'אזהרת תשלום לא-מאושר הוסתרה',
  settings_updated: 'הגדרות עודכנו',
  slot_created: 'זמן חלוקה נוסף',
  slot_updated: 'זמן חלוקה עודכן',
  slot_deleted: 'זמן חלוקה נמחק',
  admin_created: 'מנהל נוסף',
  admin_updated: 'מנהל עודכן',
  admin_deleted: 'מנהל נמחק',
  admin_login: 'כניסת מנהל',
  hard_reset: 'איפוס קשיח',
};

async function buildCustomerRows() {
  const [slots, customers] = await Promise.all([getAllSlots(), listCustomersSummary()]);

  const header = ['שם', 'טלפון'];
  for (const slot of slots) {
    header.push(`${slot.name} - הזמנה זכרים`, `${slot.name} - הזמנה נקבות`, `${slot.name} - מימוש זכרים`, `${slot.name} - מימוש נקבות`);
  }
  header.push('סה"כ לתשלום', 'שולם בפועל');

  const rows = [header];
  for (const c of customers) {
    const bySlotId = new Map((c.bySlot || []).map((s) => [s.slotId, s]));
    const row = [c.customerName || '', c.phone || ''];
    for (const slot of slots) {
      const s = bySlotId.get(slot.id);
      row.push(s?.male || 0, s?.female || 0, s?.maleRedeemed || 0, s?.femaleRedeemed || 0);
    }
    row.push(Number(c.totalAmount) || 0, Number(c.amountPaid) || 0);
    rows.push(row);
  }
  return rows;
}

async function buildLogRows() {
  const actions = await listAllActions();
  const header = ['תאריך ושעה', 'סוג פעולה', 'פרטים'];
  const rows = [header];
  for (const a of actions) {
    rows.push([
      new Date(a.createdAt).toLocaleString('he-IL'),
      ACTION_LABELS[a.actionType] || a.actionType,
      JSON.stringify(a.details || {}),
    ]);
  }
  return rows;
}

async function writeSheetTab(token, base, tabName, rows) {
  const lastCol = colLetter(Math.max(1, rows[0]?.length || 1));
  const range = `${tabName}!A1:${lastCol}${Math.max(1, rows.length)}`;

  const clearRes = await fetch(`${base}/values/${encodeURIComponent(`${tabName}!A:ZZ`)}:clear`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!clearRes.ok) {
    throw new Error(`ניקוי הלשונית "${tabName}" נכשל: ${clearRes.status} ${await clearRes.text().catch(() => '')}`);
  }

  const writeRes = await fetch(`${base}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: rows }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!writeRes.ok) {
    throw new Error(`כתיבה ללשונית "${tabName}" נכשלה: ${writeRes.status} ${await writeRes.text().catch(() => '')}`);
  }
}

export async function syncNow() {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) return { skipped: 'no_sheet_id' };

  // מתג ידני בטאב "הגדרות" (settings.sheetsSyncEnabled) — מאפשר להשהות את
  // הסנכרון בלי לגעת במשתני סביבה/דפלוי, למשל אם רוצים לצמצם עומס בזמן
  // החלוקה או שיש חשד לבעיה בגיליון.
  const { sheetsSyncEnabled } = await getSettings();
  if (!sheetsSyncEnabled) return { skipped: 'disabled' };

  const tabName = process.env.GOOGLE_SHEET_TAB_NAME || 'טבלה';
  const logTabName = process.env.GOOGLE_SHEET_LOG_TAB_NAME || 'יומן';

  const token = await getSheetsAccessToken();
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}`;

  const [customerRows, logRows] = await Promise.all([buildCustomerRows(), buildLogRows()]);
  await writeSheetTab(token, base, tabName, customerRows);
  await writeSheetTab(token, base, logTabName, logRows);
  return { skipped: false };
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
      .then((result) => {
        if (result.skipped === 'disabled') console.log('[sheetsSync] סנכרון מושהה ידנית (הגדרות → גיבוי לגוגל שיטס) — מדולג.');
        else if (!result.skipped) console.log('[sheetsSync] סנכרון גיבוי הושלם בהצלחה.');
      })
      .catch((err) => console.error('[sheetsSync] סנכרון גיבוי נכשל (לא קריטי, ינסה שוב):', err.message || err));
  };

  run();
  setInterval(run, intervalMs);
  console.log(`[sheetsSync] גיבוי תקופתי לגוגל שיטס הופעל, כל ${Math.round(intervalMs / 1000)} שניות.`);
}
