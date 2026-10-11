import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ConsentKind } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { GuardianService } from '../guardian/guardian.service';
import { LegalService } from '../legal/legal.service';
import { GUARDIAN_STATEMENT } from '../legal/texts';
import { BlocksService } from './blocks.service';
import { SAFETY_TIPS, SAFETY_TIPS_DRAFT_NOTE, TipAudience } from './tips';

class RedeemDto {
  @IsString() @MaxLength(20) code!: string;
}
class BlockThreadDto {
  @IsUUID() threadId!: string;
}
class BlockTeacherDto {
  @IsUUID() teacherId!: string;
}
class ConsentDto {
  @IsEnum(ConsentKind) kind!: ConsentKind;
  @IsString() @MaxLength(60) version!: string;
  @IsOptional() @IsString() @MaxLength(5) locale?: string;
}

const loc = (l?: string): 'uz' | 'ru' | 'en' => (l === 'ru' || l === 'en' ? l : 'uz');

@Controller('guardian')
@UseGuards(UserActorGuard)
export class GuardianController {
  constructor(private guardians: GuardianService) {}

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('code') @HttpCode(200) @RequirePermission('account.read.self')
  code(@CurrentActor() a: Actor) { return this.guardians.createCode(a); }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('link') @HttpCode(200) @RequirePermission('guardian.manage')
  link(@CurrentActor() a: Actor, @Body() dto: RedeemDto) { return this.guardians.redeem(a, dto.code); }

  @Get('children') @RequirePermission('guardian.manage')
  children(@CurrentActor() a: Actor) { return this.guardians.children(a); }

  @Delete('children/:id') @RequirePermission('guardian.manage')
  revoke(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.guardians.revoke(a, id); }

  @Get('mine') @RequirePermission('account.read.self')
  mine(@CurrentActor() a: Actor) { return this.guardians.guardiansOfMe(a); }
}

@Controller('blocks')
@UseGuards(UserActorGuard)
export class BlocksController {
  constructor(private blocks: BlocksService) {}

  @Get() @RequirePermission('report.create')
  list(@CurrentActor() a: Actor) { return this.blocks.list(a); }

  @Post('thread') @HttpCode(200) @RequirePermission('report.create')
  thread(@CurrentActor() a: Actor, @Body() dto: BlockThreadDto) { return this.blocks.blockFromThread(a, dto.threadId); }

  @Post('teacher') @HttpCode(200) @RequirePermission('report.create')
  teacher(@CurrentActor() a: Actor, @Body() dto: BlockTeacherDto) { return this.blocks.blockTeacher(a, dto.teacherId); }

  @Delete(':id') @RequirePermission('report.create')
  unblock(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.blocks.unblock(a, id); }
}

/** Hujjat matnlari va maslahatlar ochiq (ro'yxatdan o'tishdan oldin ham o'qish mumkin). */
@Controller()
export class PublicLegalController {
  constructor(private legal: LegalService) {}

  @Get('legal/terms')
  terms(@Query('locale') l?: string) { return this.legal.document('terms', loc(l)); }

  @Get('legal/privacy')
  privacy(@Query('locale') l?: string) { return this.legal.document('privacy', loc(l)); }

  @Get('legal/guardian-statement')
  statement(@Query('locale') l?: string) { return { draft: true, text: GUARDIAN_STATEMENT[loc(l)] }; }

  @Get('safety/tips')
  tips(@Query('audience') audience?: string, @Query('locale') l?: string) {
    const a: TipAudience = audience === 'guardian' || audience === 'teacher' ? audience : 'pupil';
    return { audience: a, draft: true, note: SAFETY_TIPS_DRAFT_NOTE[loc(l)], tips: SAFETY_TIPS[a][loc(l)] };
  }
}

@Controller('legal/consents')
@UseGuards(UserActorGuard)
export class ConsentsController {
  constructor(private legal: LegalService) {}

  @Get() @RequirePermission('account.read.self')
  mine(@CurrentActor() a: Actor) { return this.legal.mine(a); }

  @Post() @HttpCode(200) @RequirePermission('account.read.self')
  accept(@CurrentActor() a: Actor, @Body() dto: ConsentDto) { return this.legal.accept(a, dto.kind, dto.version, dto.locale ?? a.locale); }

  @Delete(':kind') @RequirePermission('account.read.self')
  withdraw(@CurrentActor() a: Actor, @Param('kind') kind: string) { return this.legal.withdraw(a, kind as ConsentKind); }
}
