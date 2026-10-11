import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsUUID } from 'class-validator';

class RemindDto {
  @IsUUID() bookingId!: string;
}
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

@Controller('teachers/me/money')
@UseGuards(UserActorGuard)
export class TeacherMoneyController {
  constructor(private dp: DirectPaymentService) {}

  @Get('summary') @RequirePermission('directpay.confirm')
  summary(@CurrentActor() a: Actor) { return this.dp.teacherSummary(a); }

  @Get('owed') @RequirePermission('directpay.confirm')
  owed(@CurrentActor() a: Actor) { return this.dp.owed(a); }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('remind') @HttpCode(200) @RequirePermission('directpay.confirm')
  remind(@CurrentActor() a: Actor, @Body() dto: RemindDto) { return this.dp.remind(a, dto.bookingId); }

  @Get('income') @RequirePermission('directpay.confirm')
  income(@CurrentActor() a: Actor, @Query('month') month?: string) { return this.dp.income(a, month); }

  /** CSV: faqat o'qituvchining o'z yozuvlari. Brauzerda ochilmaydi (attachment). */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('export.csv') @RequirePermission('directpay.confirm')
  async export(@CurrentActor() a: Actor, @Res() res: any, @Query('from') from?: string, @Query('to') to?: string) {
    const f = from ? new Date(from) : new Date(Date.now() - 31 * 86_400_000);
    const t = to ? new Date(to) : new Date(Date.now() + 86_400_000);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) throw new BadRequestException('Invalid date');
    const csv = await this.dp.exportCsv(a, f, t);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="school17-lessons.csv"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).end(csv);
  }
}

@Controller('direct-payments')
@UseGuards(UserActorGuard)
export class MyDirectPaymentsController {
  constructor(private dp: DirectPaymentService) {}

  @Get('mine') @RequirePermission('directpay.mark')
  mine(@CurrentActor() a: Actor) { return this.dp.minePupil(a); }
}
