import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsUUID } from 'class-validator';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { DirectPaymentService } from './direct-payment.service';

class PaidDto {
  @IsOptional() @IsUUID() proofFileId?: string;
}

// DIQQAT: admin uchun bu yerda HECH QANDAY marshrut yo'q: administrator pul harakatiga yoki to'lov belgilariga aralasha olmaydi.
@Controller('bookings/:id/direct-payment')
@UseGuards(UserActorGuard)
export class DirectPaymentController {
  constructor(private dp: DirectPaymentService) {}

  @Get() @RequirePermission('booking.participate')
  get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.dp.get(a, id); }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('paid') @HttpCode(200) @RequirePermission('directpay.mark')
  paid(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PaidDto) { return this.dp.markPaid(a, id, dto.proofFileId); }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('received') @HttpCode(200) @RequirePermission('directpay.confirm')
  received(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.dp.confirmReceived(a, id); }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('not-received') @HttpCode(200) @RequirePermission('directpay.confirm')
  notReceived(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.dp.notReceived(a, id); }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('waive') @HttpCode(200) @RequirePermission('directpay.confirm')
  waive(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.dp.waive(a, id); }
}
