// זהה ללוגיקה ב-hazmanat-sfarim (normalizePhone_ המקורי) — 05XXXXXXXX תמיד.
export function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.indexOf('972') === 0) {
    digits = '0' + digits.substring(3);
  } else if (digits.length === 9 && digits.charAt(0) !== '0') {
    digits = '0' + digits;
  }
  return digits;
}

// נייד/07X: 0 + קידומת דו-ספרתית + בדיוק 7 ספרות = 10 ספרות סה"כ (למשל 0501234567).
// קווי (02/03/04/08/09): 0 + קידומת חד-ספרתית + בדיוק 7 ספרות = 9 ספרות סה"כ.
// {6,7} הישן התיר בטעות גם מספר נייד קצר בספרה אחת (9 ספרות) — לא תקין בפועל.
export function isValidIsraeliPhone(normalizedPhone) {
  return /^0(5\d|7\d)\d{7}$/.test(normalizedPhone) || /^0[23489]\d{7}$/.test(normalizedPhone);
}
