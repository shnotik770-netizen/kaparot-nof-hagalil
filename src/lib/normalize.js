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

export function isValidIsraeliPhone(normalizedPhone) {
  return /^0(5\d|7\d|[23489])\d{6,7}$/.test(normalizedPhone);
}
