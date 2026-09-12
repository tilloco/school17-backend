import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private token: string | null = null;

  constructor(private config: ConfigService) {}

  // Eskiz.uz'dan vaqtinchalik auth token oladi (token ~30 kun amal qiladi,
  // shuning uchun production'da uni keshlab qo'yish tavsiya etiladi)
  private async getToken(): Promise<string> {
    if (this.token) return this.token;

    const baseUrl = this.config.get<string>('ESKIZ_BASE_URL');
    const email = this.config.get<string>('ESKIZ_EMAIL');
    const password = this.config.get<string>('ESKIZ_PASSWORD');

    const res = await axios.post(`${baseUrl}/auth/login`, { email, password });
    this.token = res.data?.data?.token;
    if (!this.token) {
      throw new Error('Eskiz.uz token olinmadi - .env ni tekshiring');
    }
    return this.token;
  }

  // Berilgan telefon raqamiga SMS OTP kodini yuboradi
  async sendOtp(phone: string, code: string): Promise<void> {
    const baseUrl = this.config.get<string>('ESKIZ_BASE_URL');

    // Development muhitida haqiqiy SMS yubormasdan konsolga chiqarish -
    // shunda Eskiz.uz hisobingiz bo'lmasa ham lokal test qila olasiz.
    if (process.env.NODE_ENV !== 'production') {
      this.logger.warn(`[DEV MODE] ${phone} raqamiga OTP: ${code}`);
      return;
    }

    const token = await this.getToken();
    await axios.post(
      `${baseUrl}/message/sms/send`,
      {
        mobile_phone: phone.replace('+', ''),
        message: `Huquq test tasdiqlash kodi: ${code}`,
        from: '4546',
      },
      { headers: { Authorization: `Bearer ${token}` } },
    );
  }
}
