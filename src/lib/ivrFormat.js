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
