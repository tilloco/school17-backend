import { Injectable, Logger } from '@nestjs/common';

export interface DomainEventMap {
  'booking.cancelled': { bookingId: string };
  'booking.rescheduled': { bookingId: string };
  'booking.completed': { bookingId: string; billableSeconds: number };
  'booking.noshow': { bookingId: string; kind: 'NO_SHOW_STUDENT' | 'NO_SHOW_TEACHER' };
  'booking.failed': { bookingId: string; note: string };
  'booking.declined': { bookingId: string };
  'booking.expired': { bookingId: string };
}

type Handler<K extends keyof DomainEventMap> = (payload: DomainEventMap[K]) => Promise<void> | void;

/**
 * Modullar o'rtasidagi sinxron (ichki) hodisalar: aylanma bog'liqliklarsiz (booking <-> calls <-> earnings).
 * Handler xatosi emitentga yetmaydi (jurnalga yoziladi) — asosiy amal buzilmasligi uchun.
 */
@Injectable()
export class DomainEvents {
  private readonly log = new Logger('DomainEvents');
  private handlers = new Map<string, Handler<any>[]>();

  on<K extends keyof DomainEventMap>(type: K, h: Handler<K>) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), h]);
  }

  async emit<K extends keyof DomainEventMap>(type: K, payload: DomainEventMap[K]) {
    for (const h of this.handlers.get(type) ?? []) {
      try {
        await h(payload);
      } catch (e) {
        this.log.error(`handler for ${type} failed: ${(e as Error).message}`);
      }
    }
  }
}
