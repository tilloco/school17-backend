import { Injectable } from '@nestjs/common';

/** Vaqt manbai. Testlarda `set()` bilan vaqtni boshqarish mumkin; productionda doim haqiqiy vaqt. */
@Injectable()
export class ClockService {
  private fixed: Date | null = null;

  now(): Date {
    return this.fixed ? new Date(this.fixed) : new Date();
  }

  /** Faqat testlar uchun */
  set(d: Date | null) {
    this.fixed = d;
  }
}
