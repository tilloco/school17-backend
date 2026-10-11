import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsString, Matches, MaxLength } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { ClockService } from '../common/clock';
import { NotificationsService } from './notifications.service';
import { render } from './templates';

class PushTokenDto {
  // Expo: "ExponentPushToken[xxxx]" yoki "ExpoPushToken[xxxx]"
  @Matches(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$/) @MaxLength(260) token!: string;
  @IsIn(['android', 'ios']) platform!: string;
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
    return { ok: true };
  }

  @Delete('push-tokens') @RequirePermission('account.read.self')
  async unregister(@CurrentActor() a: Actor, @Body() dto: TokenOnlyDto) {
    await this.prisma.pushToken.deleteMany({ where: { token: dto.token, userId: a.id } });
    return { ok: true };
  }
}
