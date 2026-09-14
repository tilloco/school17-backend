import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private config: ConfigService) {}

  async sendOtp(email: string, code: string): Promise<void> {
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
        from: `Mamun <${fromAddress}>`,
        to: email,
        subject: 'Tasdiqlash kodi',
        html: `<p>Bu sizning Mamun ilovasiga kirish uchun kodingiz: <strong style="font-size: 24px;">${code}</strong></p><p>Kod 5 daqiqa davomida amal qiladi.</p>`,
        text: `Bu sizning Mamun ilovasiga kirish uchun kodingiz: ${code}\nKod 5 daqiqa davomida amal qiladi.`,
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