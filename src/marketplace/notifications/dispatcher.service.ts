import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ClockService } from '../common/clock';
import { render } from './templates';

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}
export interface PushResult {
  token: string;
  ok: boolean;
  /** 'DeviceNotRegistered' bo'lsa token o'chiriladi */
  error?: string;
}
export interface PushSender {
  readonly name: string;
  send(messages: PushMessage[]): Promise<PushResult[]>;
}
export const PUSH_SENDER = Symbol('PUSH_SENDER');

/** Dev: hech narsa yubormaydi, faqat "yuborildi" deb qaytaradi. */
export class LogPushSender implements PushSender {
  readonly name = 'log';
  readonly sent: PushMessage[] = [];
  async send(messages: PushMessage[]) {
    this.sent.push(...messages);
    return messages.map((m) => ({ token: m.to, ok: true }));
  }
}

/**
 * Expo Push xizmati (bepul, akkaunt talab qilinmaydi dev-build uchun; production uchun FCM/APNs kalitlari Expo orqali sozlanadi).
 * HOLAT: UNTESTED haqiqiy Expo serveriga qarshi — faqat soxta fetch bilan sinalgan.
 */
export class ExpoPushSender implements PushSender {
  readonly name = 'expo';
  constructor(private fetchFn: typeof fetch = fetch, private url = 'https://exp.host/--/api/v2/push/send') {}

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    const out: PushResult[] = [];
    for (let i = 0; i < messages.length; i += 100) {
      const batch = messages.slice(i, i + 100);
      try {
        const res = await this.fetchFn(this.url, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(batch.map((m) => ({ to: m.to, title: m.title, body: m.body, data: m.data, sound: 'default', priority: 'high' }))),
        });
        if (!res.ok) throw new Error(`expo push http ${res.status}`);
        const j: any = await res.json();
        batch.forEach((m, k) => {
          const t = j?.data?.[k];
          out.push(t?.status === 'ok' ? { token: m.to, ok: true } : { token: m.to, ok: false, error: t?.details?.error ?? t?.message ?? 'unknown' });
        });
      } catch (e: any) {
        batch.forEach((m) => out.push({ token: m.to, ok: false, error: e.message }));
      }
    }
    return out;
  }
}

export function createPushSender(env: NodeJS.ProcessEnv = process.env): PushSender {
  return (env.PUSH_PROVIDER || 'log') === 'expo' ? new ExpoPushSender() : new LogPushSender();
}

const MAX_ATTEMPTS = 5;
/** Push `data` ichiga faqat navigatsiya uchun id'lar kiradi (summalar, vaqtlar, matn kirmaydi: qulf ekranida ko'rinishi mumkin). */
const PUSH_DATA_KEYS = ['bookingId', 'threadId', 'reviewId', 'payoutId'];
function pushData(type: string, data: unknown): Record<string, unknown> {
  const src = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  return { type, ...Object.fromEntries(PUSH_DATA_KEYS.filter((k) => typeof src[k] === 'string').map((k) => [k, src[k]])) };
}

@Injectable()
export class NotificationDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Notifications');
  private timer?: NodeJS.Timeout;

  constructor(private prisma: PrismaService, private clock: ClockService, @Inject(PUSH_SENDER) private push: PushSender) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.deliverDue().catch((e) => this.log.error(e.message)), 30_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Muddati kelgan, yuborilmagan bildirishnomalarni push orqali yuboradi (tokeni yo'q foydalanuvchi uchun faqat ilova ichidagi ro'yxat). */
  async deliverDue(limit = 100, onlyUserIds?: string[]): Promise<{ sent: number; failed: number }> {
    const due = await this.prisma.notification.findMany({
      where: { sentAt: null, ...(onlyUserIds ? { userId: { in: onlyUserIds } } : {}), dueAt: { lte: this.clock.now() }, attempts: { lt: MAX_ATTEMPTS } },
      orderBy: { dueAt: 'asc' },
      take: limit,
      include: { user: { select: { locale: true, status: true, pushTokens: { select: { token: true } } } } },
    });
    let sent = 0;
    let failed = 0;
    for (const n of due) {
      const tokens = n.user.status === 'ACTIVE' ? n.user.pushTokens.map((t) => t.token) : [];
      if (tokens.length === 0) {
        await this.prisma.notification.update({ where: { id: n.id }, data: { sentAt: this.clock.now() } });
        sent++;
        continue;
      }
      const tpl = render(n.type, n.user.locale);
      const results = await this.push.send(tokens.map((to) => ({ to, title: tpl.title, body: tpl.body, data: pushData(n.type, n.data) })));
      const dead = results.filter((r) => r.error === 'DeviceNotRegistered').map((r) => r.token);
      if (dead.length) await this.prisma.pushToken.deleteMany({ where: { token: { in: dead } } });
      if (results.some((r) => r.ok) || (results.length > 0 && results.every((r) => r.error === 'DeviceNotRegistered'))) {
        await this.prisma.notification.update({ where: { id: n.id }, data: { sentAt: this.clock.now(), attempts: { increment: 1 } } });
        sent++;
      } else {
        await this.prisma.notification.update({ where: { id: n.id }, data: { attempts: { increment: 1 }, lastError: results[0]?.error?.slice(0, 200) ?? 'failed', ...(n.attempts + 1 >= MAX_ATTEMPTS ? { sentAt: this.clock.now() } : {}) } });
        failed++;
      }
    }
    return { sent, failed };
  }
}
