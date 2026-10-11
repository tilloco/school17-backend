// Karta ma'lumotlarini tekshirish (sof mantiq). Faqat 16 xonali Luhn-to'g'ri raqam va 2-40 harfli ism qabul qilinadi.

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Bo'shliq va chiziqchalarni olib tashlaydi; to'g'ri bo'lmasa null. */
export function normalizeCardNumber(input: string): string | null {
  if (typeof input !== 'string') return null;
  if (!/^[\d\s-]+$/.test(input)) return null; // harf, belgi, "/", "*" yo'q: muddat (MM/YY) yoki niqoblangan raqam ham rad etiladi
  const digits = input.replace(/[\s-]/g, '');
  return digits.length === 16 && luhnValid(digits) ? digits : null;
}

/** 2-40 harf; bo'shliq, defis va apostrof (O'ral, D'Artagnan) ruxsat; raqam va boshqa belgilar yo'q. */
export function normalizeHolderName(input: string): string | null {
  if (typeof input !== 'string') return null;
  const name = input.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 40) return null;
  if (!/^\p{L}+(?:[ '’‘ʻʼ-]\p{L}+)*$/u.test(name)) return null;
  return name;
}

export const formatCard = (digits: string) => digits.replace(/(\d{4})(?=\d)/g, '$1 ');
