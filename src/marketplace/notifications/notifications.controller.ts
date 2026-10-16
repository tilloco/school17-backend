import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { ClockService } from '../common/clock';
import { NotificationsService } from './notifications.service';
import { CATEGORIES, formatHm, isDisableable, parseHm } from './categories';
import { render } from './templates';

class PushTokenDto {
  // Expo: "ExponentPushToken[xxxx]" yoki "ExpoPushToken[xxxx]"
  @Matches(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$/) @MaxLength(260) token!: string;
  @IsIn(['android', 'ios']) platform!: string;
}
class PrefsDto {
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsIn(CATEGORIES as unknown as string[], { each: true }) disabled?: string[];
  // "HH:MM" yoki null (tinch soatlar o'chiriladi). Ikkalasi birga beriladi.
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) quietStart?: string | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) quietEnd?: string | null;
}
class TokenOnlyDto {
  @IsString() @MaxLength(260) token!: string;
}

@Controller()
@UseGuards(UserActorGuard)
export class NotificationsController {
  constructor(private notifications: NotificationsService, private prisma: PrismaService, private clock: ClockService) {}

  @Get('notifications') @RequirePermission('account.read.self')
  async list(@CurrentActor() a: Actor, @Query('unread') unread?: string, @Query('take') take?: string) {
    const rows = await this.notifications.listForUser(a.id, Number(take) || 50, unread === 'true');
    return rows.map((n) => ({ id: n.id, type: n.type, ...render(n.type, a.locale), data: n.data, at: n.dueAt, read: !!n.readAt }));
  }

  @Get('notifications/unread-count') @RequirePermission('account.read.self')
  async count(@CurrentActor() a: Actor) {
    return { unread: await this.prisma.notification.count({ where: { userId: a.id, readAt: null, dueAt: { lte: this.clock.now() } } }) };
  }

  @Post('notifications/read-all') @HttpCode(200) @RequirePermission('account.read.self')
  async readAll(@CurrentActor() a: Actor) {
    const r = await this.prisma.notification.updateMany({ where: { userId: a.id, readAt: null }, data: { readAt: this.clock.now() } });
    return { updated: r.count };
  }

  @Post('notifications/:id/read') @HttpCode(200) @RequirePermission('account.read.self')
  read(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.notifications.markRead(a.id, id); }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('push-tokens') @HttpCode(200) @RequirePermission('account.read.self')
  async register(@CurrentActor() a: Actor, @Body() dto: PushTokenDto) {
    // Token bir vaqtda bitta foydalanuvchiga tegishli (qurilma akkaunt almashtirsa yangi egasiga o'tadi)
    await this.prisma.pushToken.upsert({ where: { token: dto.token }, update: { userId: a.id, platform: dto.platform, lastSeenAt: this.clock.now() }, create: { userId: a.id, token: dto.token, platform: dto.platform } });
    // Bitta foydalanuvchida eng ko'pi bilan 10 ta qurilma: eng eskilari o'chiriladi (bazani to'ldirib yuborishdan himoya)
    const all = await this.prisma.pushToken.findMany({ where: { userId: a.id }, orderBy: { lastSeenAt: 'desc' }, select: { id: true } });
    if (all.length > 10) await this.prisma.pushToken.deleteMany({ where: { id: { in: all.slice(10).map((t) => t.id) } } });
    return { ok: true };
  }

  /** Sozlamalar ekranidagi "sinov yuborish": push va tinch soatlar sozlamalari ishlayotganini ko'rsatadi. Soatiga 3 ta. */
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  @Post('notifications/test') @HttpCode(200) @RequirePermission('account.read.self')
  async test(@CurrentActor() a: Actor) {
    await this.notifications.enqueue(a.id, 'push.test', {});
    return { ok: true };
  }

  @Get('notifications/preferences') @RequirePermission('account.read.self')
  async prefs(@CurrentActor() a: Actor) {
    const p = await this.prisma.notificationPreference.findUnique({ where: { userId: a.id } });
    return {
      categories: CATEGORIES.map((id) => ({ id, enabled: !p?.disabled.includes(id), canDisable: isDisableable(id) })),
      quiet: p?.quietStartMin != null && p?.quietEndMin != null ? { start: formatHm(p.quietStartMin), end: formatHm(p.quietEndMin) } : null,
      pushOnServer: process.env.PUSH_PROVIDER === 'expo' && process.env.EXPO_PUSH_ENABLED === 'true',
    };
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Put('notifications/preferences') @RequirePermission('account.read.self')
  async setPrefs(@CurrentActor() a: Actor, @Body() dto: PrefsDto) {
    const disabled = [...new Set((dto.disabled ?? []).filter((c) => isDisableable(c as (typeof CATEGORIES)[number])))];
    const hasStart = dto.quietStart !== undefined && dto.quietStart !== null;
    const hasEnd = dto.quietEnd !== undefined && dto.quietEnd !== null;
    if (hasStart !== hasEnd) throw new BadRequestException('Give both quiet hours or none');
    const start = hasStart ? parseHm(dto.quietStart as string) : null;
    const end = hasEnd ? parseHm(dto.quietEnd as string) : null;
    if (start !== null && start === end) throw new BadRequestException('Quiet hours must not be empty');
    await this.prisma.notificationPreference.upsert({ where: { userId: a.id }, update: { disabled, quietStartMin: start, quietEndMin: end }, create: { userId: a.id, disabled, quietStartMin: start, quietEndMin: end } });
    return this.prefs(a);
  }

  @Delete('push-tokens') @RequirePermission('account.read.self')
  async unregister(@CurrentActor() a: Actor, @Body() dto: TokenOnlyDto) {
    await this.prisma.pushToken.deleteMany({ where: { token: dto.token, userId: a.id } });
    return { ok: true };
  }
}
