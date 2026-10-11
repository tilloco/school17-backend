import { Body, Controller, Get, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength } from 'class-validator';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { Actor } from '../common/actor';

const DOWN_BYTES = 128 * 1024; // bitta yuklash o'lchovi; mijoz 5 soniya davomida bir necha marta chaqiradi
const PAYLOAD = Buffer.alloc(DOWN_BYTES, 0x61);

class UpDto {
  // JSON tanasi ~64 KiB gacha (standart body limitidan past); mijoz bir necha marta yuboradi
  @IsString() @MaxLength(65_536) pad!: string;
}

/** R4: oldindan tarmoq tekshiruvi (yuklab olish / yuborish tezligi va RTT). Faqat tizimga kirgan foydalanuvchi, tezlik cheklangan. Hech narsa saqlanmaydi. */
@Controller('netcheck')
@UseGuards(UserActorGuard)
export class NetCheckController {
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('down') @RequirePermission('account.read.self')
  down(@Res() res: any) {
    res.set({ 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.send(PAYLOAD);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('up') @HttpCode(200) @RequirePermission('account.read.self')
  up(@CurrentActor() _a: Actor, @Body() dto: UpDto) {
    return { received: dto.pad.length };
  }
}
