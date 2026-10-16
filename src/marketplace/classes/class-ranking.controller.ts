import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsInt, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { ClassRankingService } from './class-ranking.service';

class BonusDto {
  @IsUUID() pupilId!: string;
  @IsInt() points!: number;
  @IsOptional() @IsString() @MaxLength(140) note?: string;
}

@Controller('classes/:id')
@UseGuards(UserActorGuard)
export class ClassRankingController {
  constructor(private ranking: ClassRankingService) {}

  @Get('ranking') @RequirePermission('class.read')
  get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.ranking.ranking(a, id); }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('bonus') @HttpCode(201) @RequirePermission('class.manage')
  bonus(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: BonusDto) { return this.ranking.giveBonus(a, id, dto.pupilId, dto.points, dto.note); }
}
