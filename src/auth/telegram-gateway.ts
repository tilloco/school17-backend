/**
 * Telegram Gateway (gatewayapi.telegram.org) — Telegram'ning rasmiy "Verification Codes" xizmati: kod foydalanuvchining Telegram'iga
 * Telegram'ning o'zidan keladi (SMS emas). Narx: yuborilgan xabar uchun taxminan $0.01 (tekshirilmagan; Telegram Gateway narxlarini ko'ring).
 * TELEGRAM_GATEWAY_TOKEN bo'lmasa — "dev" rejimi: kod hech qayerga yuborilmaydi (faqat NODE_ENV!=production va PHONE_DEV_CODES=1 bo'lsa javobda qaytadi).
 */
export interface CodeSender {
  readonly kind: 'telegram' | 'dev';
  send(phone: string, code: string, ttlSeconds: number): Promise<{ ok: boolean; reason?: 'NO_TELEGRAM' | 'FAILED' }>;
}

export class TelegramGatewaySender implements CodeSender {
  readonly kind = 'telegram' as const;
  constructor(private token: string, private fetchFn: typeof fetch = fetch) {}
  async send(phone: string, code: string, ttlSeconds: number) {
    try {
      const r = await this.fetchFn('https://gatewayapi.telegram.org/sendVerificationMessage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number: phone, code, ttl: ttlSeconds }),
      });
      const j: any = await r.json().catch(() => ({}));
      if (r.ok && j.ok) return { ok: true };
      // Raqamda Telegram yo'q yoki yuborib bo'lmaydi
      if (/PHONE_NUMBER_INVALID|NOT_FOUND|CANNOT_SEND|NOT_REGISTERED/i.test(String(j.error ?? ''))) return { ok: false, reason: 'NO_TELEGRAM' as const };
      return { ok: false, reason: 'FAILED' as const };
    } catch {
      return { ok: false, reason: 'FAILED' as const };
    }
  }
}

export class DevSender implements CodeSender {
  readonly kind = 'dev' as const;
  async send() { return { ok: true }; }
}

// Tests never talk to the real Telegram, even when a real token is present in .env (they use the dev sender or a fake fetch).
export const makeSender = (): CodeSender => (process.env.TELEGRAM_GATEWAY_TOKEN && process.env.NODE_ENV !== 'test' ? new TelegramGatewaySender(process.env.TELEGRAM_GATEWAY_TOKEN) : new DevSender());

/** +998 90 123-45-67 → +998901234567 (E.164, 8–15 raqam); noto'g'ri bo'lsa null */
export function normalizePhone(raw: string): string | null {
  const d = raw.replace(/[\s\-().]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(d) ? d : null;
}
