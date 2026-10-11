// Fayl turini ICHIDAGI baytlar bo'yicha aniqlash (mijoz aytgan mime/kengaytmaga ishonilmaydi).
// Ruxsat etilganlar: JPEG, PNG, WebP, PDF. Boshqa hamma narsa (SVG, HTML, skriptlar, bajariladigan fayllar, arxivlar) rad etiladi.

export type DetectedType = 'jpeg' | 'png' | 'webp' | 'pdf';

export const MIME_BY_TYPE: Record<DetectedType, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

export const EXT_BY_TYPE: Record<DetectedType, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', pdf: 'pdf' };

export function detectType(buf: Buffer): DetectedType | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  // PDF sarlavhasi odatda 0 ofsetda; ba'zi generatorlar 1024 bayt ichida qo'yadi. Faqat 0 ofsetni qabul qilamiz (polyglot xavfini kamaytirish).
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  return null;
}

export interface PdfCheck {
  ok: boolean;
  reason?: string;
  pageCount?: number;
}

/** PDF ichida faol kontent belgilari bo'lsa rad etiladi (JavaScript, avtomatik ishga tushirish, ichki fayllar). Konservativ va taxminiy. */
const ACTIVE_PDF = /\/(JavaScript|JS|Launch|EmbeddedFile|OpenAction|AA|RichMedia|XFA|SubmitForm|ImportData)\b/;

export function checkPdf(buf: Buffer): PdfCheck {
  const text = buf.toString('latin1');
  if (!/%%EOF\s*$/.test(text.slice(-2048))) return { ok: false, reason: 'pdf_truncated' };
  if (ACTIVE_PDF.test(text)) return { ok: false, reason: 'pdf_active_content' };
  const pages = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g);
  return { ok: true, pageCount: pages ? pages.length : undefined };
}
