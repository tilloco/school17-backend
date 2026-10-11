import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Tezlik cheklovi kaliti: tasdiqlangan foydalanuvchi bo'lsa — uning id'si, aks holda IP.
 * Sabab: mobil operatorlarda ko'p odam bitta IP ortida; IP bo'yicha cheklov bitta suiste'molchi uchun hammani to'sardi.
 * XAVFSIZLIK: token imzosi TEKSHIRILADI (imzosiz "sub" ga ishonilsa, har so'rovda tasodifiy id bilan cheklovni aylanib o'tish mumkin bo'lardi).
 * Admin tokenlari alohida kalit bilan tekshiriladi.
 */
@Injectable()
export class ActorThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const auth: string | undefined = req.headers?.authorization;
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice(7);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const jwt = require('jsonwebtoken');
      for (const [prefix, secret] of [['u', process.env.JWT_SECRET], ['a', process.env.ADMIN_JWT_SECRET]] as const) {
        if (!secret) continue;
        try {
          const p = jwt.verify(token, secret, { algorithms: ['HS256'] }) as { sub?: string };
          if (p.sub) return `${prefix}:${p.sub}`;
        } catch {
          /* keyingi kalit yoki IP */
        }
      }
    }
    return `ip:${req.ip}`;
  }
}
