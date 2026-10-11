import { ClassRoomService } from '../classes/class-room.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Actor } from '../common/actor';
import { AdminActorGuard, CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { CallsService } from './calls.service';

class QualityDto {
  @IsOptional() @IsNumber() @Min(0) @Max(60_000) rttMs?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) lossPct?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100_000) bitrateKbps?: number;
  @IsOptional() @IsIn(['good', 'fair', 'poor', 'audio_only']) tier?: 'good' | 'fair' | 'poor' | 'audio_only';
  @IsOptional() @IsInt() @Min(0) @Max(600_000) joinMs?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1000) reconnects?: number;
}
class PresenceDto {
  @IsIn(['joined', 'heartbeat', 'left']) event!: 'joined' | 'heartbeat' | 'left';
  @IsOptional() @IsObject() @ValidateNested() @Type(() => QualityDto) quality?: QualityDto;
}
class ConsentDto {
  @IsBoolean() consent!: boolean;
}

@Controller('calls')
@UseGuards(UserActorGuard)
export class CallsController {
  constructor(private calls: CallsService) {}

  @Get(':bookingId/lobby') @RequirePermission('call.join')
  lobby(@CurrentActor() a: Actor, @Param('bookingId', ParseUUIDPipe) id: string) { return this.calls.lobby(a, id); }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':bookingId/token') @HttpCode(200) @RequirePermission('call.join')
  token(@CurrentActor() a: Actor, @Param('bookingId', ParseUUIDPipe) id: string) { return this.calls.issueToken(a, id); }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':bookingId/presence') @HttpCode(200) @RequirePermission('call.join')
  presence(@CurrentActor() a: Actor, @Param('bookingId', ParseUUIDPipe) id: string, @Body() dto: PresenceDto) {
    return this.calls.presence(a, id, dto.event, dto.quality);
  }

  @Post(':bookingId/end') @HttpCode(200) @RequirePermission('call.join')
  end(@CurrentActor() a: Actor, @Param('bookingId', ParseUUIDPipe) id: string) { return this.calls.end(a, id); }

  @Get(':bookingId/summary') @RequirePermission('call.join')
  summary(@CurrentActor() a: Actor, @Param('bookingId', ParseUUIDPipe) id: string) { return this.calls.summary(a, id); }

  @Get(':bookingId/recording') @RequirePermission('call.join')
  recording(@CurrentActor() a: Actor, @Param('bookingId', ParseUUIDPipe) id: string) { return this.calls.recordingStatus(a, id); }

  @Post(':bookingId/recording/consent') @HttpCode(200) @RequirePermission('call.join')
  consent(@CurrentActor() a: Actor, @Param('bookingId', ParseUUIDPipe) id: string, @Body() dto: ConsentDto) {
    return this.calls.setRecordingConsent(a, id, dto.consent);
  }

  @Post(':bookingId/recording/start') @HttpCode(200) @RequirePermission('call.join')
  startRecording(@CurrentActor() a: Actor, @Param('bookingId', ParseUUIDPipe) id: string) { return this.calls.startRecording(a, id); }
}

/** Provayder webhook'i: autentifikatsiya = provayder imzosi (JWT), xom body (express.raw) bo'yicha. */
@Controller('calls/webhook')
export class CallsWebhookController {
  constructor(private calls: CallsService, private classRoom: ClassRoomService) {}

  @Post('provider') @HttpCode(200)
  async provider(@Req() req: any) {
    const raw: string = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    let events;
    try {
      events = this.calls.parseWebhook(raw, req.headers['authorization']);
    } catch (e: any) {
      if (e?.status === 404) throw e;
      throw new UnauthorizedException('Unauthorized');
    }
    await this.calls.handleProviderEvents(events);
    await this.classRoom.handleEvents(events); // sinf xonalari ('class-' prefiksi); 1:1 oqimga tegmaydi
    return { ok: true };
  }
}

@Controller('admin/market/calls')
@UseGuards(AdminActorGuard)
export class CallsAdminController {
  constructor(private calls: CallsService) {}

  @Get(':bookingId/events') @RequirePermission('moderation.review')
  events(@Param('bookingId', ParseUUIDPipe) id: string) { return this.calls.adminEvents(id); }
}
