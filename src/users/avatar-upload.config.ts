import { diskStorage } from 'multer';
import { extname } from 'path';
import { randomBytes } from 'crypto';
import { BadRequestException } from '@nestjs/common';

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // 2MB

// XAVFSIZLIK: fayl nomini foydalanuvchidan kelgan nom bilan EMAS, tasodifiy
// nom bilan saqlaymiz (path traversal va fayl nomi orqali hujumning oldini olish uchun).
// Faqat rasm MIME turlariga ruxsat beriladi, hajmi 2MB dan oshmasligi kerak.
export const avatarUploadOptions = {
  storage: diskStorage({
    destination: './uploads/avatars',
    filename: (req: any, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) => {
      const uniqueName = randomBytes(16).toString('hex') + extname(file.originalname).toLowerCase();
      cb(null, uniqueName);
    },
  }),
  limits: { fileSize: AVATAR_MAX_BYTES },
  fileFilter: (req: any, file: Express.Multer.File, cb: (error: Error | null, accept: boolean) => void) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new BadRequestException('Faqat JPEG, PNG yoki WebP rasmlar qabul qilinadi'), false);
    }
    cb(null, true);
  },
};
