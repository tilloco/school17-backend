import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Actor } from '../common/actor';
import { AdminActorGuard, CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { EscrowEnabledGuard } from './escrow.guard';
import { PaymentsService } from './payments.service';

class PayDto {
  /** Provayderning o'zi bergan token (kartani provayder sahifasida kiritadi). Karta raqami HECH QACHON bu yerga yuborilmaydi. */
  @IsOptional() @IsString() @MaxLength(100) paymentMethod?: string;
}
class DisputeDto {
  @IsString() @MaxLength(500) reason!: string;
}
class PayoutDto {
  @IsInt() @Min(1) @Max(2_000_000_000) amountMinor!: number;
  @IsString() @MaxLength(40) destination!: string;
}
class ResolveDto {
  @IsIn(['REFUND', 'RELEASE']) outcome!: 'REFUND' | 'RELEASE';
  @IsOptional() @IsInt() @Min(0) refundMinor?: number;
  @IsString() @MaxLength(500) note!: string;
}
class RejectDto {
  @IsString() @MaxLength(300) reason!: string;
}

function key(h?: string): string {
  if (!h) throw new BadRequestException('Idempotency-Key header is required');
  return h;
}

@Controller()
@UseGuards(EscrowEnabledGuard, UserActorGuard)
export class PaymentsController {
  constructor(private payments: PaymentsService) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('bookings/:id/pay') @HttpCode(200) @RequirePermission('payment.pay')
  pay(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Headers('idempotency-key') k: string, @Body() dto: PayDto) {
    return this.payments.pay(a, id, key(k), dto.paymentMethod);
  }

  @Get('payments/mine') @RequirePermission('payment.pay')
  mine(@CurrentActor() a: Actor) { return this.payments.mine(a); }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('bookings/:id/dispute') @HttpCode(200) @RequirePermission('payment.pay')
  dispute(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DisputeDto) { return this.payments.openDispute(a, id, dto.reason); }

  @Get('earnings') @RequirePermission('earnings.view')
  earnings(@CurrentActor() a: Actor) { return this.payments.earnings(a); }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('payouts') @HttpCode(201) @RequirePermission('payout.request')
  payout(@CurrentActor() a: Actor, @Headers('idempotency-key') k: string, @Body() dto: PayoutDto) { return this.payments.requestPayout(a, dto.amountMinor, dto.destination, key(k)); }

  @Get('payouts') @RequirePermission('payout.request')
  payouts(@CurrentActor() a: Actor) { return this.payments.myPayouts(a); }
}

@Controller('admin/market')
@UseGuards(EscrowEnabledGuard, AdminActorGuard)
export class PaymentsAdminController {
  constructor(private payments: PaymentsService) {}

  @Get('payments/review') @RequirePermission('payment.review')
  review() { return this.payments.reviewQueue(); }

  @Post('payments/:id/resolve') @HttpCode(200) @RequirePermission('payment.review')
  resolve(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveDto) { return this.payments.adminResolve(a, id, dto.outcome, dto.refundMinor, dto.note); }

  @Get('payouts') @RequirePermission('payout.review')
  payouts(@Query('status') s?: string) { return this.payments.adminPayouts(s === 'PAID' || s === 'REJECTED' ? s : 'REQUESTED'); }

  @Post('payouts/:id/pay') @HttpCode(200) @RequirePermission('payout.review')
  pay(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.payments.adminPay(a, id); }

  @Post('payouts/:id/reject') @HttpCode(200) @RequirePermission('payout.review')
  reject(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectDto) { return this.payments.adminReject(a, id, dto.reason); }

  @Get('ledger/integrity') @RequirePermission('payment.review')
  integrity() { return this.payments.integrity(); }

  @Get('ledger/trial-balance') @RequirePermission('payment.review')
  trial() { return this.payments.trialBalance(); }
}
