import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { DiscoveryService } from './discovery.service';

const list = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20) : undefined);
function num(v: string | undefined, name: string): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BadRequestException(`Invalid ${name}`);
  return n;
}
function date(v: string | undefined, name: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid ${name}`);
  return d;
}

@Controller()
@UseGuards(UserActorGuard)
export class DiscoveryController {
  constructor(private discovery: DiscoveryService) {}

  @Get('catalog') @RequirePermission('account.read.self')
  catalog() { return this.discovery.catalog(); }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('teachers') @RequirePermission('booking.participate')
  search(@CurrentActor() actor: Actor, @Query() q: Record<string, string>) {
    return this.discovery.search(this.hiddenFor(actor), {
      q: q.q,
      subjects: list(q.subject),
      levels: list(q.level),
      languages: list(q.language),
      minPriceMinor: num(q.minPrice, 'minPrice'),
      maxPriceMinor: num(q.maxPrice, 'maxPrice'),
      minRating: num(q.minRating, 'minRating'),
      availableFrom: date(q.availableFrom, 'availableFrom'),
      availableTo: date(q.availableTo, 'availableTo'),
      durationMin: num(q.duration, 'duration'),
      sort: q.sort,
      page: num(q.page, 'page'),
      pageSize: num(q.pageSize, 'pageSize'),
    });
  }

  /** S9 da bloklangan foydalanuvchilar shu yerdan chiqariladi */
  private hiddenFor(actor: Actor): string[] {
    return [actor.id];
  }
}
