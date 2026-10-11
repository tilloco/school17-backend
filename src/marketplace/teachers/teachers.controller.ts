import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CredentialKind, VerificationStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateIf, ValidateNested,
} from 'class-validator';
import { Actor } from '../common/actor';
import { AdminActorGuard, CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { TeachersService } from './teachers.service';

class ProfileDto {
  @IsOptional() @IsString() @MaxLength(120) headline?: string;
  @IsOptional() @IsString() @MaxLength(2000) bio?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(40, { each: true }) subjects?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(40, { each: true }) levels?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsString({ each: true }) @MaxLength(5, { each: true }) languages?: string[];
  @IsOptional() @IsInt() priceMinor?: number;
  @ValidateIf((_o, v) => v !== undefined) @IsOptional() @IsString() @MaxLength(300) introVideoUrl?: string | null;
  @IsOptional() @IsBoolean() instantBooking?: boolean;
}

class RuleDto {
  @IsInt() weekday!: number;
  @Matches(/^\d{2}:\d{2}$/) start!: string;
  @Matches(/^\d{2}:\d{2}$/) end!: string;
}
class AvailabilityDto {
  @IsArray() @ArrayMaxSize(70) @ValidateNested({ each: true }) @Type(() => RuleDto) rules!: RuleDto[];
}
class TimeOffDto {
  @IsDateString() startAt!: string;
  @IsDateString() endAt!: string;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}
class CredentialDto {
  @IsEnum(CredentialKind) kind!: CredentialKind;
  @IsString() @MaxLength(120) title!: string;
  @IsUUID() fileId!: string;
}
class ReasonDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

@Controller('teachers/me')
@UseGuards(UserActorGuard)
export class TeachersMeController {
  constructor(private teachers: TeachersService) {}

  @Get('profile') @RequirePermission('teacher.profile.manage')
  profile(@CurrentActor() a: Actor) { return this.teachers.getOwn(a); }

  @Put('profile') @RequirePermission('teacher.profile.manage')
  upsert(@CurrentActor() a: Actor, @Body() dto: ProfileDto) { return this.teachers.upsertProfile(a, dto); }

  @Get('availability') @RequirePermission('teacher.availability.manage')
  availability(@CurrentActor() a: Actor) { return this.teachers.getAvailability(a); }

  @Put('availability') @RequirePermission('teacher.availability.manage')
  setAvailability(@CurrentActor() a: Actor, @Body() dto: AvailabilityDto) { return this.teachers.setAvailability(a, dto.rules); }

  @Post('time-off') @RequirePermission('teacher.availability.manage')
  addTimeOff(@CurrentActor() a: Actor, @Body() dto: TimeOffDto) {
    return this.teachers.addTimeOff(a, new Date(dto.startAt), new Date(dto.endAt), dto.reason);
  }

  @Delete('time-off/:id') @RequirePermission('teacher.availability.manage')
  removeTimeOff(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.teachers.removeTimeOff(a, id); }

  @Get('credentials') @RequirePermission('teacher.profile.manage')
  credentials(@CurrentActor() a: Actor) { return this.teachers.listCredentials(a); }

  @Post('credentials') @RequirePermission('teacher.profile.manage')
  addCredential(@CurrentActor() a: Actor, @Body() dto: CredentialDto) { return this.teachers.addCredential(a, dto); }

  @Delete('credentials/:id') @RequirePermission('teacher.profile.manage')
  removeCredential(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.teachers.removeCredential(a, id); }

  @Post('submit') @HttpCode(200) @RequirePermission('teacher.profile.manage')
  submit(@CurrentActor() a: Actor) { return this.teachers.submit(a); }
}

// 'teachers/me' dan KEYIN ro'yxatdan o'tishi shart (":id" "me" ni yutib yubormasligi uchun)
@Controller('teachers')
@UseGuards(UserActorGuard)
export class TeachersPublicController {
  constructor(private teachers: TeachersService) {}

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) { return this.teachers.publicProfile(id); }
}

@Controller('admin/market/teachers')
@UseGuards(AdminActorGuard)
export class TeachersAdminController {
  constructor(private teachers: TeachersService) {}

  @Get('queue') @RequirePermission('teacher.verification.review')
  queue(@Query('status') status?: string, @Query('skip') skip = '0', @Query('take') take = '20') {
    const st = status && (status in VerificationStatus) ? (status as VerificationStatus) : VerificationStatus.PENDING;
    return this.teachers.reviewQueue(st, Math.max(0, Number(skip) || 0), Number(take) || 20);
  }

  @Get(':id') @RequirePermission('teacher.verification.review')
  get(@Param('id', ParseUUIDPipe) id: string) { return this.teachers.adminGet(id); }

  @Post(':id/approve') @HttpCode(200) @RequirePermission('teacher.verification.review')
  approve(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.teachers.adminTransition(a, id, 'approve'); }

  @Post(':id/reject') @HttpCode(200) @RequirePermission('teacher.verification.review')
  reject(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) { return this.teachers.adminTransition(a, id, 'reject', dto.reason); }

  @Post(':id/suspend') @HttpCode(200) @RequirePermission('teacher.verification.review')
  suspend(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) { return this.teachers.adminTransition(a, id, 'suspend', dto.reason); }

  @Post(':id/reinstate') @HttpCode(200) @RequirePermission('teacher.verification.review')
  reinstate(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.teachers.adminTransition(a, id, 'reinstate'); }
}
