// בניית תגובות טקסט פשוט למודול type=api של ימות המשיח (id_list_message
// וכו') — ראו סקיל yemot-hamashiach-api. תגובת ימות המשיח חייבת להיות
// טקסט פשוט בלבד, בלי HTML/JSON.

// תו . מפריד בין מקטעי id_list_message, ותו - הוא מפריד סוג-תוכן (t-...).
// טקסט חופשי (t-) אסור להכיל את שני אלה — מחליפים ברווח כדי לא לשבור את
// הפורמט (למשל תווית שעות עם מקף כמו "17:00-19:00").
export function sanitizeSpeech(text) {
  return String(text ?? '').replace(/[.\-]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function textSegment(text) {
  return `t-${sanitizeSpeech(text)}`;
}

export function idListMessage(segments) {
  return `id_list_message=${segments.filter(Boolean).join('.')}`;
}

/**
 * read=<prompt>=<capture> — ממשיך את הדיאלוג (הצעד היחיד שלא מסיים את
 * השיחה). captureFields הוא מערך של 15 השדות של הקשה (name, reuse, max,
 * min, timeout, format, blockStar, blockZero, keySub, allowedKeys,
 * repeatCount, emptyAction, emptyPlaceholder, keyboardLock, skipConfirm) —
 * לפי הסדר האמיתי שאומת מול דוגמאות רשמיות (ראו סקיל yemot-hamashiach-api),
 * לא לפי התיאור הכתוב שיש בו טעות off-by-one. ערך undefined/null -> ריק
 * (ברירת מחדל).
 */
export function readAction(promptSegments, captureFields) {
  const prompt = promptSegments.filter(Boolean).join('.');
  const capture = captureFields.map((f) => (f === undefined || f === null ? '' : f)).join(',');
  return `read=${prompt}=${capture}`;
}
