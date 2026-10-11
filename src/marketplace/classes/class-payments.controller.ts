import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { ClassPaymentsService } from './class-payments.service';

class MarkDto {
  @IsIn(['received', 'not_received', 'waive']) action!: 'received' | 'not_received' | 'waive';
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID('all', { each: true }) paymentIds!: string[];
}
class RemindDto { @IsOptional() @IsString() @Matches(/^(M:\d{4}-\d{2}|S:[0-9a-f-]{36})$/) period?: string; }
class OverrideDto { @IsUUID() sessionId!: string; @IsUUID() pupilId!: string; }

// DIQQAT: bu yerda pul harakati yo'q. Faqat "to'lagan deb belgilandi / oldim deb tasdiqlandi" belgilari. Administratorga marshrut yo'q.
@Controller()
@UseGuards(UserActorGuard)
export class ClassPaymentsController {
  constructor(private pay: ClassPaymentsService) {}

  @Get('classes/:id/money') @RequirePermission('directpay.confirm')
  board(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Query('period') period?: string) { return this.pay.board(a, id, period); }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('classes/:id/money/mark') @HttpCode(200) @RequirePermission('directpay.confirm')
  mark(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MarkDto) {
    return dto.action === 'received' ? this.pay.markReceived(a, id, dto.paymentIds) : dto.action === 'not_received' ? this.pay.markNotReceived(a, id, dto.paymentIds) : this.pay.waive(a, id, dto.paymentIds);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('classes/:id/money/remind') @HttpCode(200) @RequirePermission('directpay.confirm')
  remind(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RemindDto) { return this.pay.remind(a, id, dto.period); }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('classes/:id/money/export.csv') @RequirePermission('directpay.confirm')
  async csv(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Query('period') period: string | undefined, @Res() res: any) {
    const body = await this.pay.exportCsv(a, id, period);
    res.set({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="class-payments.csv"', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
    res.send(body);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('classes/:id/money/override') @HttpCode(200) @RequirePermission('directpay.confirm')
  override(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OverrideDto) { return this.pay.override(a, id, dto.sessionId, dto.pupilId); }

  @Get('teachers/me/money/class-owed') @RequirePermission('directpay.confirm')
  owed(@CurrentActor() a: Actor) { return this.pay.owed(a); }

  @Get('class-payments/mine') @RequirePermission('directpay.mark')
  mine(@CurrentActor() a: Actor) { return this.pay.mine(a); }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('class-payments/:pid/paid') @HttpCode(200) @RequirePermission('directpay.mark')
  paid(@CurrentActor() a: Actor, @Param('pid', ParseUUIDPipe) pid: string) { return this.pay.pupilPaid(a, pid); }
}
