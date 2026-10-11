// Voyaga yetmaganlar bilan suhbatda shaxsiy aloqa ma'lumotlarini (telefon, email, havola, messenjer) almashishni aniqlash.
// Maqsad: o'qituvchi va bola o'rtasidagi gaplashuv platformadan tashqariga chiqib ketmasligi (xavfsizlik + vasiy nazorati).
// Bu to'liq himoya EMAS: odamlar yozuvni aylanib o'tishi mumkin (rasm ichida yozuv, so'zlar bilan yozilgan raqamlar). KNOWN_GAPS.

export type ContactKind = 'email' | 'url' | 'handle' | 'phone' | 'messenger';

const MESSENGERS = /(telegram|whatsapp|whats\s*app|viber|instagram|insta\b|tiktok|snapchat|skype|discord|facebook|messenger|signal\s+app|imo\b|тг\b|телеграм\w*|ватсап\w*|вотсап\w*|вайбер\w*|инстаграм\w*|инста\b|фейсбук\w*|телега\w*|telegramda|vatsap\w*|instagramda)/i;

export function detectContactInfo(text: string): { found: boolean; kinds: ContactKind[] } {
  const kinds = new Set<ContactKind>();
  const lower = text.toLowerCase();

  if (/[a-z0-9._%+-]+\s*(@|\(at\)|\[at\]|\sat\s)\s*[a-z0-9-]+\s*(\.|\(dot\)|\[dot\]|\sdot\s)\s*[a-z]{2,}/i.test(lower)) kinds.add('email');
  if (/(https?:\/\/|www\.)\S+/i.test(lower) || /\b[a-z0-9-]+\.(com|org|net|uz|ru|me|io|ly|gl|app|info|site|link)\b/i.test(lower) || /\b(t\.me|wa\.me|vk\.com|ig\.me)\b/i.test(lower)) kinds.add('url');
  if (/(^|[\s(])@[a-z0-9_]{4,}/i.test(lower)) kinds.add('handle');
  if (MESSENGERS.test(lower)) kinds.add('messenger');

  // Sana va vaqtlarni olib tashlaymiz (2026-11-03 14:30 telefon emas)
  const cleaned = lower.replace(/\b\d{4}[-./]\d{1,2}[-./]\d{1,2}\b/g, ' ').replace(/\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g, ' ').replace(/\b\d{1,2}[:.]\d{2}\b/g, ' ');
  const compact = cleaned.replace(/(?<=\d)[\s().-]+(?=\d)/g, '');
  if (/\+\s*\d[\d\s().-]{7,}\d/.test(cleaned)) kinds.add('phone'); // +998 90 123 45 67
  else if (/\d{9,}/.test(compact) && /(?:\d[\s().-]*){9,}/.test(cleaned)) {
    // 9+ raqam: O'zbekiston raqam shakllari (90 123 45 67, 901234567, 0 90 ..., 998...) yoki uzun ketma-ket raqam
    if (/\b(?:998|0)?\s*[39]\d[\s().-]*\d{3}[\s().-]*\d{2}[\s().-]*\d{2}\b/.test(cleaned) || /\d{10,}/.test(compact)) kinds.add('phone');
  }
  return { found: kinds.size > 0, kinds: [...kinds] };
}
