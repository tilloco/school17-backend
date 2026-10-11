import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ClockService } from '../common/clock';
import { marketConfig } from '../common/config';
import { ACTIVE_STATUSES } from '../booking/booking-rules';
import { isLanguage, isLevel, isSubject, LANGUAGES, LEVELS, SUBJECTS } from '../catalog';
import { generateSlots } from '../teachers/availability';

export const SORTS = ['rating', 'price_asc', 'price_desc', 'newest'] as const;
export type Sort = (typeof SORTS)[number];

export interface SearchQuery {
  q?: string;
  subjects?: string[];
  levels?: string[];
  languages?: string[];
  minPriceMinor?: number;
  maxPriceMinor?: number;
  minRating?: number;
  availableFrom?: Date;
  availableTo?: Date;
  durationMin?: number;
  sort?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Tartiblash qoidalari ochiq (har bir javobda `ranking` maydoni bor) va PULGA SOTILMAYDI:
 * hech qanday "promoted"/to'lov maydoni yo'q; tartib faqat quyidagilar bilan belgilanadi.
 */
export const RANKING_DOC: Record<Sort, string> = {
  rating: 'Bayesian average rating (desc), then number of reviews (desc), then id. Formula: (priorMean*priorWeight + sum) / (priorWeight + count).',
  price_asc: 'Price per 60 minutes (asc), then Bayesian rating (desc), then id.',
  price_desc: 'Price per 60 minutes (desc), then Bayesian rating (desc), then id.',
  newest: 'Verification date (desc), then id.',
};

const ORDER: Record<Sort, Prisma.TeacherProfileOrderByWithRelationInput[]> = {
  rating: [{ ratingBayes: 'desc' }, { ratingCount: 'desc' }, { id: 'asc' }],
  price_asc: [{ priceMinor: 'asc' }, { ratingBayes: 'desc' }, { id: 'asc' }],
  price_desc: [{ priceMinor: 'desc' }, { ratingBayes: 'desc' }, { id: 'asc' }],
  newest: [{ verifiedAt: 'desc' }, { id: 'asc' }],
};

const MAX_AVAILABILITY_CANDIDATES = 300;

@Injectable()
export class DiscoveryService {
  constructor(private prisma: PrismaService, private clock: ClockService) {}

  catalog() {
    return { subjects: SUBJECTS, levels: LEVELS, languages: LANGUAGES, durationsMin: marketConfig().lessonDurationsMin, sorts: SORTS, ranking: RANKING_DOC };
  }

  async search(excludeUserIds: string[], q: SearchQuery) {
    const cfg = marketConfig();
    const sort = (q.sort ?? 'rating') as Sort;
    if (!SORTS.includes(sort)) throw new BadRequestException('Unknown sort');
    const page = Math.max(1, Math.trunc(q.page ?? 1));
    const pageSize = Math.min(50, Math.max(1, Math.trunc(q.pageSize ?? 20)));
    for (const [list, ok, name] of [[q.subjects, isSubject, 'subject'], [q.levels, isLevel, 'level'], [q.languages, isLanguage, 'language']] as const) {
      if (list?.some((v) => !ok(v))) throw new BadRequestException(`Unknown ${name}`);
    }
    if (q.minPriceMinor != null && q.maxPriceMinor != null && q.minPriceMinor > q.maxPriceMinor) throw new BadRequestException('minPrice > maxPrice');
    if (q.minRating != null && (q.minRating < 0 || q.minRating > 5)) throw new BadRequestException('Bad minRating');
    const wantsAvailability = !!(q.availableFrom && q.availableTo);
    if (wantsAvailability) {
      if (!(q.availableFrom! < q.availableTo!) || q.availableTo!.getTime() - q.availableFrom!.getTime() > 14 * 86_400_000) throw new BadRequestException('Availability range must be 1..14 days');
      if (!cfg.lessonDurationsMin.includes(q.durationMin ?? 60)) throw new BadRequestException('Unsupported duration');
    }
    const text = q.q?.trim().slice(0, 80);

    // Faqat TASDIQLANGAN va faol o'qituvchilar ro'yxatga chiqadi ("verified" filtri shu yerda doim yoqilgan).
    const where: Prisma.TeacherProfileWhereInput = {
      verificationStatus: 'VERIFIED',
      user: { status: 'ACTIVE', ...(excludeUserIds.length ? { id: { notIn: excludeUserIds } } : {}) },
      ...(q.subjects?.length ? { subjects: { hasSome: q.subjects } } : {}),
      ...(q.levels?.length ? { levels: { hasSome: q.levels } } : {}),
      ...(q.languages?.length ? { languages: { hasSome: q.languages } } : {}),
      ...(q.minPriceMinor != null || q.maxPriceMinor != null ? { priceMinor: { ...(q.minPriceMinor != null ? { gte: q.minPriceMinor } : {}), ...(q.maxPriceMinor != null ? { lte: q.maxPriceMinor } : {}) } } : {}),
      ...(q.minRating != null ? { ratingBayes: { gte: q.minRating } } : {}),
      ...(text ? { OR: [{ headline: { contains: text, mode: 'insensitive' } }, { bio: { contains: text, mode: 'insensitive' } }, { user: { name: { contains: text, mode: 'insensitive' } } }] } : {}),
    };
    const include = { user: { select: { name: true, avatarUrl: true, timezone: true } } } satisfies Prisma.TeacherProfileInclude;

    let rows;
    let total: number;
    let nextSlots: Map<string, string> | undefined;
    if (!wantsAvailability) {
      [total, rows] = await Promise.all([
        this.prisma.teacherProfile.count({ where }),
        this.prisma.teacherProfile.findMany({ where, orderBy: ORDER[sort], skip: (page - 1) * pageSize, take: pageSize, include }),
      ]);
    } else {
      // Bo'sh vaqt filtri: avval boshqa filtrlar bilan nomzodlar, so'ng har biri uchun slot hisoblanadi (cheklangan to'plam)
      const candidates = await this.prisma.teacherProfile.findMany({ where, orderBy: ORDER[sort], take: MAX_AVAILABILITY_CANDIDATES, include: { ...include, availability: true } });
      const ids = candidates.map((c) => c.id);
      const [busy, off] = await Promise.all([
        this.prisma.booking.findMany({ where: { teacherId: { in: ids }, status: { in: ACTIVE_STATUSES }, startAt: { lt: q.availableTo }, endAt: { gt: q.availableFrom } }, select: { teacherId: true, startAt: true, endAt: true } }),
        this.prisma.teacherTimeOff.findMany({ where: { teacherId: { in: ids }, startAt: { lt: q.availableTo }, endAt: { gt: q.availableFrom } } }),
      ]);
      const notBefore = new Date(this.clock.now().getTime() + cfg.minNoticeMinutes * 60_000);
      nextSlots = new Map();
      const matching = candidates.filter((c) => {
        const slots = generateSlots({
          rules: c.availability, timezone: c.user.timezone, from: q.availableFrom!, to: q.availableTo!, durationMin: q.durationMin ?? 60, notBefore,
          busy: [...busy.filter((b) => b.teacherId === c.id).map((b) => ({ start: b.startAt, end: b.endAt })), ...off.filter((o) => o.teacherId === c.id).map((o) => ({ start: o.startAt, end: o.endAt }))],
        });
        if (slots.length) nextSlots!.set(c.id, slots[0].toISOString());
        return slots.length > 0;
      });
      total = matching.length;
      rows = matching.slice((page - 1) * pageSize, page * pageSize);
    }

    return {
      page, pageSize, total, hasMore: page * pageSize < total,
      ranking: { sort, description: RANKING_DOC[sort], paid: false },
      items: rows.map((p) => ({
        id: p.id,
        name: p.user.name,
        avatarUrl: p.user.avatarUrl,
        headline: p.headline,
        subjects: p.subjects,
        levels: p.levels,
        languages: p.languages,
        priceMinor: p.priceMinor,
        currency: p.currency,
        instantBooking: p.instantBooking,
        verified: true,
        rating: { count: p.ratingCount, average: p.ratingCount ? p.ratingSum / p.ratingCount : null, bayesian: Math.round(p.ratingBayes * 100) / 100 },
        ...(nextSlots?.has(p.id) ? { nextSlot: nextSlots.get(p.id) } : {}),
      })),
    };
  }
}
