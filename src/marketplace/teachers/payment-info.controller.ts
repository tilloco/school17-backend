import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength } from 'class-validator';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { PaymentInfoService } from './payment-info.service';

// Faqat shu ikki maydon: boshqa har qanday maydon (cvv, expiry, ...) 400 bilan rad etiladi (forbidNonWhitelisted).
class PaymentInfoDto {
  @IsString() @MaxLength(25) cardNumber!: string;
  @IsString() @MaxLength(60) holderName!: string;
}

@Controller('teachers/me/payment-info')
@UseGuards(UserActorGuard)
export class PaymentInfoMeController {
  constructor(private info: PaymentInfoService) {}

  @Put() @RequirePermission('teacher.profile.manage')
  set(@CurrentActor() a: Actor, @Body() dto: PaymentInfoDto) { return this.info.set(a, dto.cardNumber, dto.holderName); }

  @Get() @RequirePermission('teacher.profile.manage')
  get(@CurrentActor() a: Actor) { return this.info.getOwn(a); }

  @Delete() @RequirePermission('teacher.profile.manage')
  remove(@CurrentActor() a: Actor) { return this.info.remove(a); }
}

@Controller('teachers')
@UseGuards(UserActorGuard)
export class PaymentInfoRevealController {
  constructor(private info: PaymentInfoService) {}

  /** Soatiga 20 marta (foydalanuvchi bo'yicha). POST: kesh/oldindan yuklash bilan ochilib ketmasligi uchun. */
  @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
  @Post(':id/payment-info/reveal') @HttpCode(200) @RequirePermission('payment.pay')
  reveal(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.info.reveal(a, id); }
}
