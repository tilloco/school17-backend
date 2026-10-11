import { DetectedType } from './sniff';

export interface ProcessedImage {
  data: Buffer;
  mime: string;
  width: number;
  height: number;
  thumb: Buffer;
}

export class ProcessingError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const MAX_DIMENSION = 12_000;

/**
 * Rasmni QAYTA KODLAYDI (decode -> encode). Natija: EXIF/GPS/XMP/IPTC metama'lumotlari yo'q (sharp standartda tashlaydi),
 * yo'nalish (orientation) piksellarga qo'llangan, yashirin ma'lumot/polyglot yuklamalar saqlanib qolmaydi,
 * va fayl haqiqatan ham ochiladigan rasm ekani tasdiqlanadi. Animatsiya olinmaydi (faqat 1-kadr).
 */
export async function processImage(input: Buffer, type: Exclude<DetectedType, 'pdf'>): Promise<ProcessedImage> {
  // sharp kechiktirib yuklanadi: o'rnatilmagan bo'lsa ilova ishga tushadi, faqat rasm yuklash 503 beradi
  let sharp: any;
  try {
    sharp = require('sharp');
  } catch {
    throw new ProcessingError('image_processor_unavailable');
  }
  try {
    const base = sharp(input, { limitInputPixels: 80_000_000, failOn: 'error', animated: false });
    const meta = await base.metadata();
    if (!meta.width || !meta.height) throw new ProcessingError('image_unreadable');
    if (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION) throw new ProcessingError('image_too_large_dimensions');

    let pipeline = sharp(input, { limitInputPixels: 80_000_000, failOn: 'error', animated: false }).rotate();
    let mime: string;
    if (type === 'jpeg') {
      pipeline = pipeline.jpeg({ quality: 85 });
      mime = 'image/jpeg';
    } else if (type === 'png') {
      pipeline = pipeline.png({ compressionLevel: 9 });
      mime = 'image/png';
    } else {
      pipeline = pipeline.webp({ quality: 85 });
      mime = 'image/webp';
    }
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    const thumb = await sharp(data).resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true }).webp({ quality: 70 }).toBuffer();
    return { data, mime, width: info.width, height: info.height, thumb };
  } catch (e) {
    if (e instanceof ProcessingError) throw e;
    throw new ProcessingError('image_unreadable');
  }
}
