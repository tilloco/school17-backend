import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private config: ConfigService) {}

  // Berilgan emailga OTP kodini yuboradi
  async sendOtp(email: string, code: string): Promise<void> {
    // Development muhitida haqiqiy email yubormasdan konsolga chiqarish -
    // shunda Resend hisobingiz bo'lmasa ham lokal test qila olasiz.
    if (process.env.NODE_ENV !== 'production') {
      this.logger.warn(`[DEV MODE] ${email} manziliga OTP: ${code}`);
      return;
    }

    const apiKey = this.config.get<string>('RESEND_API_KEY');
    if (!apiKey) {
      throw new Error('RESEND_API_KEY .env da sozlanmagan');
    }

    const fromAddress = this.config.get<string>('RESEND_FROM_EMAIL') || 'onboarding@resend.dev';

    await axios.post(
      'https://api.resend.com/emails',
      {
        from: fromAddress,
        to: email,
        subject: 'Tasdiqlash kodi',
        html: `<p>Sizning tasdiqlash kodingiz: <strong style="font-size: 24px;">${code}</strong></p><p>Kod 5 daqiqa davomida amal qiladi.</p>`,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
      },
    );
  }
}