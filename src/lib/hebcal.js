// תרגום תאריך לועזי לעברי (ללא ניקוד), לפי ספריית Hebcal הרשמית.

import { HDate } from '@hebcal/core';

/** date: Date object (או כל דבר ש-new Date() מקבל). מחזיר מחרוזת כמו "כ״ז אלול תשפ״ו". */
export function toHebrewDateString(date) {
  const hd = new HDate(date instanceof Date ? date : new Date(date));
  return hd.renderGematriya(true);
}

const WEEKDAY_HEBREW = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/** שם היום בשבוע בעברית (לפי היום הלועזי) — הצעה ראשונית לשדה "יום", הניתן לעריכה. */
export function hebrewWeekdayName(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `יום ${WEEKDAY_HEBREW[d.getDay()]}`;
}
